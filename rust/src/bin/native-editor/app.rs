//! Editor state — the platform-independent half of the seam. No Win32, no COM. It owns
//! the rope buffer, a movable caret, undo/redo, and the last parse signal; `win32` feeds
//! it input events (as our own `Motion`/char types, never OS types) and `render` reads it.
//!
//! The rope (`buffer`) and a flat materialization (`text`) coexist on purpose
//! (SCRIPTORIUM-NATIVE-BUFFER.md §7): the rope gives O(1) undo snapshots, O(1) async-ready
//! views, and native coordinates; `text` is the current materialization that the parser
//! and renderer consume (both already O(n), so re-materializing per edit is free relative
//! to the reparse). N2 adds a selection (`anchor`/`caret`), grapheme-cluster + word motion
//! (SCRIPTORIUM-NATIVE-INPUT.md), and selection-aware edits; IME is N2b.

use std::path::{Path, PathBuf};

use crate::buffer::{Snapshot, TextBuffer};
use crate::codec::{encode, Decoded, Encoding, Newline};
use crate::grapheme;
use crate::parse::ParseSignal;
use crate::styles::StyleSpan;

/// A provisional IME composition (SCRIPTORIUM-NATIVE-IME.md §2): the in-progress string the
/// user is composing through an Input Method Editor. It is shown inline by the renderer,
/// spliced over the current selection, but is **never in the rope** until `commit_composition` —
/// so the buffer/parser/undo never see half-composed text, and cancelling is zero-change.
pub struct Composition {
    /// The provisional units, displayed inline (from `GCS_COMPSTR`).
    pub text: Vec<u16>,
    /// The caret's position *within* `text`, in UTF-16 units (from `GCS_CURSORPOS`).
    pub caret_units: usize,
    /// The target clause `[start, end)` within `text` — the segment the IME is actively
    /// converting (from `GCS_COMPATTR`), styled distinctly. `start == end` means no target.
    pub target_start: usize,
    pub target_end: usize,
}

/// A caret motion, expressed in our own terms (the platform layer maps VK codes to these).
/// Left/Right move by a grapheme cluster; WordLeft/WordRight by a word.
#[derive(Clone, Copy, PartialEq)]
pub enum Motion {
    Left,
    Right,
    WordLeft,
    WordRight,
    Home,
    End,
}

#[derive(Clone, Copy, PartialEq)]
enum EditKind {
    Insert,
    Delete,
}

/// One undo/redo checkpoint: an O(1) rope snapshot plus where the caret was.
struct Checkpoint {
    snap: Snapshot,
    caret: usize,
}

pub struct App {
    buffer: TextBuffer,
    /// Current materialization of `buffer` — the render/parse feed, refreshed on edit.
    pub text: Vec<u16>,
    /// Caret as a UTF-16 offset into `text`. The moving end of a selection.
    pub caret: usize,
    /// Selection anchor (the fixed end). When `anchor == caret` there is no selection.
    pub anchor: usize,
    undo: Vec<Checkpoint>,
    redo: Vec<Checkpoint>,
    /// Which kind of edit the current undo group is, if a run is open (for grouping).
    group: Option<EditKind>,
    /// The last parse result folded in (`apply_parse`) — the AST stats shown in the status line.
    /// It reflects `signal_gen`, which lags `content_gen` by the ~1ms a parse is in flight (the
    /// async contract, N4): the status line shows the previous parse until the worker's catches up.
    signal: ParseSignal,
    /// Monotonic content generation, bumped on every edit (`refresh`). The renderer keys its cached
    /// `IDWriteTextLayout` on this so it rebuilds only when the text actually changed (N3 layout
    /// cache); N4 submits it with each snapshot so a stale off-thread parse can be discarded.
    content_gen: u64,
    /// The generation the current `signal` reflects. `apply_parse` folds a worker result in only
    /// when its generation is newer than this (the monotonic staleness gate,
    /// SCRIPTORIUM-NATIVE-CONCURRENCY.md §5), so an out-of-order or late parse can never regress
    /// the displayed stats. `content_gen - signal_gen` is how many edits the parse is behind.
    signal_gen: u64,
    /// The block-level style spans the renderer source-highlights with (SCRIPTORIUM-NATIVE-STYLING.md).
    /// Folded in by `apply_parse` under the same monotonic gate as `signal` and reflecting the same
    /// `signal_gen` — so they lag the live text by the parse-in-flight, and the renderer applies them
    /// as the last-good styling (clamping offsets to each paragraph) until a fresher parse lands.
    styles: Vec<StyleSpan>,
    /// The last measured end-to-end async round-trip in microseconds — from an edit's submit to
    /// its parse landing back and settling the display (thread scheduling + parse + post-back).
    /// Measured by `win32` (the timing is a platform concern) and stored here only to show in the
    /// status line (N4b instrumentation). This — not `parse_micros`, the worker's CPU cost alone —
    /// is the *felt* latency, and the figure that reveals the frame-budget cliff on large content.
    roundtrip_micros: u128,
    /// The provisional IME composition, if a session is active (SCRIPTORIUM-NATIVE-IME.md §2).
    /// `Some` only between `WM_IME_STARTCOMPOSITION` and its end; the rope stays untouched
    /// while it lives. The renderer reads it to splice the inline preview.
    comp: Option<Composition>,
    /// The document's file path, or `None` for an untitled buffer (SCRIPTORIUM-NATIVE-IO.md §4).
    /// Set by a load or a Save As; drives the title bar and whether Save can write without a dialog.
    path: Option<PathBuf>,
    /// The file's encoding, remembered from the load so a save round-trips it byte-faithfully
    /// (§3). New documents default to BOM-less UTF-8.
    encoding: Encoding,
    /// The file's newline convention, remembered from the load so an opened CRLF file stays CRLF
    /// on save (§3). New documents default to LF (coherent with the LF-internal buffer).
    newline: Newline,
    /// The `content_gen` at the last successful load/save — "the generation that's on disk"
    /// (§4). `is_dirty()` is `content_gen != saved_gen`: a generation compare, not a flag, so it
    /// rides the counter the renderer + parser already maintain. Over-reports across undo-to-saved
    /// (undo bumps the generation) but never under-reports — it can prompt to save byte-identical
    /// content, it can never drop unsaved work.
    saved_gen: u64,
}

impl App {
    pub fn new() -> App {
        let mut app = App {
            buffer: TextBuffer::new(),
            text: Vec::new(),
            caret: 0,
            anchor: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            group: None,
            signal: ParseSignal { blocks: 0, words: 0, parse_micros: 0 },
            content_gen: 0,
            signal_gen: 0,
            styles: Vec::new(),
            roundtrip_micros: 0,
            comp: None,
            path: None,
            encoding: Encoding::Utf8,
            newline: Newline::Lf,
            saved_gen: 0,
        };
        app.refresh();
        // The empty untitled document is clean: closing it prompts for nothing (§4). `refresh`
        // just bumped `content_gen`, so pin `saved_gen` to it — nothing to save yet.
        app.saved_gen = app.content_gen;
        app
    }

    /// The current content generation (bumped on every edit). The renderer's layout cache
    /// key — a mismatch means the cached layout is stale and must be rebuilt.
    pub fn content_gen(&self) -> u64 {
        self.content_gen
    }

    /// The selection as a half-open `[start, end)` range of UTF-16 offsets (start ≤ end).
    pub fn selection(&self) -> (usize, usize) {
        (self.caret.min(self.anchor), self.caret.max(self.anchor))
    }

    pub fn has_selection(&self) -> bool {
        self.caret != self.anchor
    }

    /// The selected units (for Copy/Cut). Empty when there's no selection.
    pub fn selected_units(&self) -> Vec<u16> {
        let (s, e) = self.selection();
        self.text[s..e].to_vec()
    }

    /// Select the whole document.
    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.caret = self.text.len();
        self.group = None;
    }

    /// A `WM_CHAR` code unit: printable inserts, Backspace/Enter edit, Ctrl+Z/Y undo/redo.
    pub fn input_char(&mut self, unit: u16) {
        match unit {
            0x08 => self.backspace(),    // Backspace
            0x0D => self.newline(),      // Enter (CR)
            0x1A => self.undo(),         // Ctrl+Z
            0x19 => self.redo(),         // Ctrl+Y
            0x0A | 0x7F => {}            // lone LF / DEL — ignore
            c if c >= 0x20 => self.type_unit(c),
            _ => {} // other C0 control units
        }
    }

    /// Move the caret by a grapheme cluster / word / to the line edge. With `extend` the
    /// anchor stays put (growing the selection); without it the selection collapses — and
    /// a plain Left/Right with an active selection jumps to the nearer edge (editor
    /// convention) rather than stepping. Closes the current undo group.
    pub fn move_caret(&mut self, motion: Motion, extend: bool) {
        // Unshifted Left/Right on a selection collapses to the edge instead of moving.
        if !extend && self.has_selection() && matches!(motion, Motion::Left | Motion::Right) {
            let (s, e) = self.selection();
            self.caret = if motion == Motion::Left { s } else { e };
            self.anchor = self.caret;
            self.group = None;
            return;
        }

        let len = self.text.len();
        let c = self.caret;
        self.caret = match motion {
            Motion::Left => grapheme::prev_boundary(&self.text, c),
            Motion::Right => grapheme::next_boundary(&self.text, c),
            Motion::WordLeft => grapheme::prev_word(&self.text, c),
            Motion::WordRight => grapheme::next_word(&self.text, c),
            Motion::Home => {
                let mut p = c;
                while p > 0 && self.text[p - 1] != 0x000A {
                    p -= 1;
                }
                p
            }
            Motion::End => {
                let mut p = c;
                while p < len && self.text[p] != 0x000A {
                    p += 1;
                }
                p
            }
        };
        if !extend {
            self.anchor = self.caret;
        }
        self.group = None;
    }

    /// Place the caret at an absolute UTF-16 `offset` (clamped to the buffer). With
    /// `extend` the anchor stays put (the selection grows to the new caret); without it the
    /// selection collapses. This is the geometry-free primitive the platform layer drives
    /// from spatial input — a click's hit-test result, or the offset one visual line away
    /// for Up/Down (SCRIPTORIUM-NATIVE-LAYOUT.md §2: `app` stays logical, the renderer owns
    /// the geometry). Callers are responsible for clearing/maintaining the goal column.
    pub fn set_caret(&mut self, offset: usize, extend: bool) {
        self.caret = offset.min(self.text.len());
        if !extend {
            self.anchor = self.caret;
        }
        self.group = None;
    }

    /// Set both ends of the selection explicitly (clamped). Used by word/line select
    /// (double/triple-click), where the anchor and caret are both placed at once.
    pub fn set_selection(&mut self, anchor: usize, caret: usize) {
        let len = self.text.len();
        self.anchor = anchor.min(len);
        self.caret = caret.min(len);
        self.group = None;
    }

    // --- IME composition (SCRIPTORIUM-NATIVE-IME.md §2) -----------------------
    // The provisional string is spliced over the current selection by the renderer and never
    // touches the rope until `commit_composition`, so a cancel is guaranteed zero-change and a
    // commit reuses `replace_selection` for one-undo-group semantics.

    /// The active provisional composition, if any — read by the renderer for the inline splice.
    pub fn composition(&self) -> Option<&Composition> {
        self.comp.as_ref()
    }

    /// Begin or update the provisional composition. Purely provisional: the rope is **not**
    /// touched, so this is safe to call on every `WM_IME_COMPOSITION`/`GCS_COMPSTR`. `caret_units`
    /// is the caret within `units`; `target` is the converting clause `[start, end)`.
    pub fn set_composition(&mut self, units: &[u16], caret_units: usize, target: (usize, usize)) {
        let n = units.len();
        let target_start = target.0.min(n);
        let target_end = target.1.clamp(target_start, n);
        self.comp = Some(Composition {
            text: units.to_vec(),
            caret_units: caret_units.min(n),
            target_start,
            target_end,
        });
    }

    /// Commit the finalized composition `units` (from `GCS_RESULTSTR`): replace the selection
    /// (or insert at the caret) as **one** undo step, and clear the provisional string. Forcing
    /// the group closed first keeps the commit from coalescing into prior typing.
    pub fn commit_composition(&mut self, units: &[u16]) {
        self.comp = None;
        if !units.is_empty() {
            self.group = None; // isolate: a committed composition is its own undo step
            self.replace_selection(units, EditKind::Insert);
            self.group = None;
        }
    }

    /// Cancel the composition (Escape / a bare `WM_IME_ENDCOMPOSITION` with no result). The rope
    /// was never touched, so this is zero document change — the selection, if any, is intact.
    pub fn clear_composition(&mut self) {
        self.comp = None;
    }

    /// Replace the current selection (if any) with `units`, as one undo group of `kind`.
    /// The delete + insert land in a single checkpoint so typing-over-a-selection is one
    /// undo step. Collapses to a caret after the replacement.
    fn replace_selection(&mut self, units: &[u16], kind: EditKind) {
        self.begin_group(kind);
        if self.has_selection() {
            let (s, e) = self.selection();
            self.buffer.delete(s..e);
            self.caret = s;
        }
        if !units.is_empty() {
            self.buffer.insert(self.caret, units);
            self.caret += units.len();
        }
        self.anchor = self.caret;
        self.refresh();
    }

    fn type_unit(&mut self, unit: u16) {
        self.replace_selection(&[unit], EditKind::Insert);
    }

    fn newline(&mut self) {
        self.replace_selection(&[0x000A], EditKind::Insert);
        self.group = None; // break the undo run at line boundaries
    }

    fn backspace(&mut self) {
        if self.has_selection() {
            self.replace_selection(&[], EditKind::Delete);
            return;
        }
        if self.caret == 0 {
            return;
        }
        self.begin_group(EditKind::Delete);
        let prev = grapheme::prev_boundary(&self.text, self.caret);
        self.buffer.delete(prev..self.caret);
        self.caret = prev;
        self.anchor = self.caret;
        self.refresh();
    }

    /// Forward delete (the Delete key): remove the selection, else the next grapheme.
    pub fn delete_forward(&mut self) {
        if self.has_selection() {
            self.replace_selection(&[], EditKind::Delete);
            return;
        }
        let len = self.text.len();
        if self.caret >= len {
            return;
        }
        self.begin_group(EditKind::Delete);
        let next = grapheme::next_boundary(&self.text, self.caret);
        self.buffer.delete(self.caret..next);
        self.anchor = self.caret;
        self.refresh();
    }

    /// Clipboard: the selected units (Copy leaves the buffer untouched).
    pub fn copy(&self) -> Vec<u16> {
        self.selected_units()
    }

    /// Clipboard: take the selected units and remove them (Cut).
    pub fn cut(&mut self) -> Vec<u16> {
        let picked = self.selected_units();
        if !picked.is_empty() {
            self.replace_selection(&[], EditKind::Delete);
            self.group = None;
        }
        picked
    }

    /// Clipboard: insert `units` at the caret, replacing any selection (Paste).
    pub fn paste(&mut self, units: &[u16]) {
        if units.is_empty() {
            return;
        }
        self.replace_selection(units, EditKind::Insert);
        self.group = None; // a paste is its own undo step
    }

    /// Open a new undo group (push a pre-edit checkpoint) when the edit kind changes.
    fn begin_group(&mut self, kind: EditKind) {
        if self.group != Some(kind) {
            self.undo.push(Checkpoint { snap: self.buffer.snapshot(), caret: self.caret });
            self.redo.clear();
            self.group = Some(kind);
        }
    }

    fn undo(&mut self) {
        if let Some(cp) = self.undo.pop() {
            self.redo.push(Checkpoint { snap: self.buffer.snapshot(), caret: self.caret });
            self.buffer.restore(&cp.snap);
            self.caret = cp.caret.min(self.buffer.len());
            self.anchor = self.caret;
            self.group = None;
            self.refresh();
        }
    }

    fn redo(&mut self) {
        if let Some(cp) = self.redo.pop() {
            self.undo.push(Checkpoint { snap: self.buffer.snapshot(), caret: self.caret });
            self.buffer.restore(&cp.snap);
            self.caret = cp.caret.min(self.buffer.len());
            self.anchor = self.caret;
            self.group = None;
            self.refresh();
        }
    }

    /// Re-materialize `text` from the rope, clamp caret + anchor, and bump the content generation
    /// so the renderer's layout cache invalidates. This is the fast, synchronous, UI-thread half of
    /// an edit; the **parse no longer runs here** (N4) — `win32` submits `snapshot()` to the
    /// off-thread worker and folds the result back via `apply_parse`. The previous `signal` stays
    /// in place until then (the status line lags one parse behind — the async contract).
    fn refresh(&mut self) {
        self.text = self.buffer.to_units();
        self.content_gen = self.content_gen.wrapping_add(1);
        let len = self.text.len();
        self.caret = self.caret.min(len);
        self.anchor = self.anchor.min(len);
    }

    /// An O(1), immutable view of the buffer at this generation, to hand the off-thread parser
    /// (N4). Structural sharing keeps it valid and cheap; the worker reads it without ever touching
    /// `App` (SCRIPTORIUM-NATIVE-CONCURRENCY.md §2).
    pub fn snapshot(&self) -> Snapshot {
        self.buffer.snapshot()
    }

    /// Fold an off-thread parse result into the status signal — but only if it is **newer** than
    /// what's displayed (`gen > signal_gen`). The monotonic gate (SCRIPTORIUM-NATIVE-CONCURRENCY.md
    /// §5) means an out-of-order or late parse is dropped rather than regressing the stats. Returns
    /// whether it was applied (so the caller knows if a repaint is warranted).
    pub fn apply_parse(&mut self, gen: u64, signal: ParseSignal, styles: Vec<StyleSpan>) -> bool {
        if gen > self.signal_gen {
            self.signal = signal;
            self.styles = styles;
            self.signal_gen = gen;
            true
        } else {
            false
        }
    }

    /// The block-level style spans the renderer source-highlights with (SCRIPTORIUM-NATIVE-STYLING.md).
    /// These lag `content_gen` by the parse-in-flight (they reflect `signal_gen`); the renderer treats
    /// them as last-good and clamps their offsets to each paragraph.
    pub fn styles(&self) -> &[StyleSpan] {
        &self.styles
    }

    /// Record the last measured end-to-end async round-trip (µs), for the status line (N4b). The
    /// measurement (an `Instant` spanning submit→settle) is `win32`'s — this only stores the number.
    pub fn set_roundtrip(&mut self, micros: u128) {
        self.roundtrip_micros = micros;
    }

    // --- file document model (SCRIPTORIUM-NATIVE-IO.md §4) --------------------
    // Identity + the dirty-state machine. Platform-free: a `PathBuf` is std, the dialogs (win32)
    // fill it, and the bytes flow through the pure `codec`. The buffer stays LF-internal; encoding
    // + newline are remembered only to round-trip the file on save.

    /// Has the buffer diverged from what's on disk? A generation compare (§4) — `content_gen`
    /// already bumps on every edit, so this needs no separate bookkeeping.
    pub fn is_dirty(&self) -> bool {
        self.content_gen != self.saved_gen
    }

    /// Does the document have a file path yet (vs. untitled)? Save writes directly when it does;
    /// otherwise it must escalate to Save As for a path.
    pub fn has_path(&self) -> bool {
        self.path.is_some()
    }

    /// The document's file path, if any — so `win32` can write a plain Save without a dialog.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The document's display name — the file's base name, or `Untitled` for an unsaved buffer.
    /// The title bar shows this (plus a dirty marker); the `Scriptorium —` branding is win32's.
    pub fn document_name(&self) -> String {
        match self.path.as_deref().and_then(Path::file_name) {
            Some(name) => name.to_string_lossy().into_owned(),
            None => "Untitled".to_string(),
        }
    }

    /// Replace the whole document with a freshly decoded file (SCRIPTORIUM-NATIVE-IO.md §4): rebuild
    /// the rope from the units, **clear undo/redo** (a loaded file is a new history, not an undoable
    /// edit of the prior one), reset the caret/selection/composition to the top, adopt the file's
    /// identity, and mark it clean. `refresh()` bumps `content_gen` so the renderer relayouts and
    /// `win32` resubmits the parse (N4). Used for Open; `new_document` reuses it with empty content.
    pub fn load_document(&mut self, decoded: Decoded, path: Option<PathBuf>) {
        self.buffer = TextBuffer::from_units(&decoded.units);
        self.undo.clear();
        self.redo.clear();
        self.group = None;
        self.caret = 0;
        self.anchor = 0;
        self.comp = None;
        self.path = path;
        self.encoding = decoded.encoding;
        self.newline = decoded.newline;
        self.refresh();
        self.saved_gen = self.content_gen;
    }

    /// Reset to a clean, empty, untitled document with the default encoding/newline (§4). The
    /// caller runs the discard guard first if the current document is dirty.
    pub fn new_document(&mut self) {
        let empty = Decoded { units: Vec::new(), encoding: Encoding::Utf8, newline: Newline::Lf };
        self.load_document(empty, None);
    }

    /// Record a Save As target: the new path (encoding/newline are unchanged — Save As is "same
    /// document, new location", not an encoding conversion). The write + `mark_saved` follow.
    pub fn set_save_target(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    /// Mark the current generation as the one on disk — called after a successful write (§4).
    pub fn mark_saved(&mut self) {
        self.saved_gen = self.content_gen;
    }

    /// The bytes to write for a save: the buffer re-encoded in the document's encoding + newline
    /// (§3). Pure — `win32` performs the actual `std::fs::write`.
    pub fn bytes_to_save(&self) -> Vec<u8> {
        encode(&self.text, self.encoding, self.newline)
    }

    /// The status line: caret Ln/Col (from the rope's line summary) + selection size when
    /// active + the AST signal.
    pub fn status_text(&self) -> String {
        let line = self.buffer.line_of_offset(self.caret);
        let col = self.caret - self.buffer.offset_of_line(line);
        let sel = if self.has_selection() {
            let (s, e) = self.selection();
            format!(" ({} selected)", e - s)
        } else {
            String::new()
        };
        // The parse runs off-thread (N4), so the AST signal can lag the live text by the edits
        // whose parse hasn't landed yet. Surface the async state honestly (N4b): mid-flight a
        // "parsing…" marker makes it visible; once settled, the end-to-end round-trip (submit→
        // landed — the *felt* latency, not just the worker's CPU `parse_micros`) is what reveals
        // the frame-budget cliff as content grows. `content_gen - signal_gen` = edits in flight.
        let tail = if self.signal_gen < self.content_gen {
            " \u{00B7} parsing\u{2026}".to_string()
        } else if self.roundtrip_micros > 0 {
            format!(" \u{00B7} async {} \u{00B5}s", self.roundtrip_micros)
        } else {
            String::new()
        };
        format!(
            "Ln {}, Col {}{}  \u{00B7}  {} blocks \u{00B7} {} words \u{00B7} parse {} \u{00B5}s \u{00B7} {} units{}",
            line + 1,
            col + 1,
            sel,
            self.signal.blocks,
            self.signal.words,
            self.signal.parse_micros,
            self.text.len(),
            tail,
        )
    }
}

// --- IME composition state-machine oracle (SCRIPTORIUM-NATIVE-IME.md §8) ------
// The deterministic half of N2b: the provisional-string lifecycle (commit / cancel / replace)
// and its undo grouping, pinned without any IMM or DWrite. The IMM round-trip + feel are the
// author's to judge (§8) — these guard everything we actually own.
#[cfg(test)]
mod ime_tests {
    use super::*;

    fn s(app: &App) -> String {
        String::from_utf16(&app.text).unwrap()
    }

    fn typed(text: &str) -> App {
        let mut app = App::new();
        for c in text.encode_utf16() {
            app.input_char(c);
        }
        app
    }

    #[test]
    fn set_composition_does_not_touch_the_rope() {
        let mut app = typed("ab");
        let before = app.text.clone();
        app.set_composition(&[0x597D, 0x597E], 2, (0, 2));
        assert!(app.composition().is_some(), "composition should be active");
        // The provisional string is NOT materialized into `text` — the buffer is untouched.
        assert_eq!(app.text, before, "the rope must not change while composing");
    }

    #[test]
    fn commit_composition_inserts_once_as_one_undo_step() {
        let mut app = typed("ab");
        app.set_composition(&[0x597D], 1, (0, 1));
        app.commit_composition(&[0x597D]);
        assert!(app.composition().is_none(), "commit clears the provisional string");
        assert_eq!(s(&app), "ab\u{597D}", "the committed char lands exactly once");
        // One undo removes the whole committed composition (not one-per-keystroke), and does
        // NOT coalesce with the prior "ab" typing.
        app.input_char(0x1A); // Ctrl+Z
        assert_eq!(s(&app), "ab", "commit is its own single undo step");
    }

    #[test]
    fn compose_over_selection_replaces_in_one_step() {
        let mut app = typed("abcXYdef");
        app.set_selection(3, 5); // select "XY"
        app.set_composition(&[0x597D], 1, (0, 1));
        app.commit_composition(&[0x597D]);
        assert_eq!(s(&app), "abc\u{597D}def", "the selection is replaced by the commit");
        app.input_char(0x1A); // undo
        assert_eq!(s(&app), "abcXYdef", "delete + insert are one undo step");
    }

    #[test]
    fn cancel_composition_is_zero_change() {
        let mut app = typed("ab");
        let before = app.text.clone();
        app.set_composition(&[0x597D, 0x597E], 2, (0, 2));
        app.clear_composition();
        assert!(app.composition().is_none());
        assert_eq!(app.text, before, "cancel must not change the document");
        // Cancel added no undo step: the only edit on the stack is the "ab" typing.
        app.input_char(0x1A);
        assert_eq!(app.text.len(), 0, "nothing but the original typing was undoable");
    }

    #[test]
    fn composition_clamps_caret_and_target() {
        let mut app = typed("");
        // Out-of-range caret/target from a misbehaving IME must be clamped, not panic.
        app.set_composition(&[0x597D, 0x597E], 99, (5, 1));
        let c = app.composition().unwrap();
        assert_eq!(c.caret_units, 2, "caret clamps to the composition length");
        assert!(c.target_start <= c.target_end && c.target_end <= c.text.len(), "target stays in range");
    }
}

// --- the monotonic parse-apply gate (SCRIPTORIUM-NATIVE-CONCURRENCY.md §5) -----
// The UI-side half of the generation gate: a worker result folds in only when it is newer than
// what's displayed, so a late/out-of-order parse can never regress the shown stats. Pure — no
// thread, no Win32 (the worker + coalescing are oracle'd in `parse`).
#[cfg(test)]
mod parse_apply_tests {
    use super::*;

    fn heading_span() -> Vec<StyleSpan> {
        use crate::styles::StyleKind;
        vec![StyleSpan { start: 0, end: 5, kind: StyleKind::Heading(1) }]
    }

    #[test]
    fn apply_parse_folds_in_a_newer_result() {
        let mut app = App::new();
        assert!(app.apply_parse(3, ParseSignal { blocks: 1, words: 5, parse_micros: 10 }, heading_span()));
        assert_eq!(app.signal.words, 5, "a newer generation updates the signal");
        assert_eq!(app.signal_gen, 3);
        assert_eq!(app.styles().len(), 1, "the style spans fold in with the signal");
    }

    #[test]
    fn apply_parse_refuses_to_regress_on_a_stale_result() {
        let mut app = App::new();
        assert!(app.apply_parse(5, ParseSignal { blocks: 2, words: 9, parse_micros: 20 }, heading_span()));
        // A later-arriving OLDER parse (gen 4 < 5) must be dropped, not overwrite the newer stats/styles.
        assert!(!app.apply_parse(4, ParseSignal { blocks: 0, words: 0, parse_micros: 1 }, Vec::new()));
        assert_eq!(app.signal.words, 9, "the stale result did not regress the display");
        assert_eq!(app.signal_gen, 5, "signal_gen never moves backwards");
        assert_eq!(app.styles().len(), 1, "the stale result did not clear the newer styles");
        // The same generation is also a no-op (idempotent — no duplicate apply).
        assert!(!app.apply_parse(5, ParseSignal { blocks: 0, words: 0, parse_micros: 1 }, Vec::new()));
        assert_eq!(app.signal.words, 9);
    }

    #[test]
    fn status_line_shows_parsing_in_flight_then_the_async_roundtrip() {
        // A fresh App has content_gen 1 but no parse folded in yet (signal_gen 0) — in flight (N4b).
        let mut app = App::new();
        assert!(app.status_text().contains("parsing"), "in flight before the first parse lands");
        // The parse for gen 1 lands: caught up, so the "parsing…" marker clears. No round-trip
        // measured yet (that's win32's to record), so no async figure either.
        app.apply_parse(1, ParseSignal { blocks: 0, words: 0, parse_micros: 5 }, Vec::new());
        assert!(!app.status_text().contains("parsing"), "not in flight once caught up");
        assert!(!app.status_text().contains("async"), "no round-trip shown until one is measured");
        // Once win32 records the settle latency, the status surfaces the felt end-to-end figure.
        app.set_roundtrip(1234);
        let s = app.status_text();
        assert!(s.contains("async 1234"), "settled round-trip is shown: {s}");
    }
}

// --- the file document model + dirty-state machine (SCRIPTORIUM-NATIVE-IO.md §4) --
// The generation-based dirty gate, load/new/save transitions, and the codec hand-off — pinned
// without any dialog or filesystem (those are win32's; the byte round-trip is codec's oracle).
#[cfg(test)]
mod document_tests {
    use super::*;
    use crate::codec::decode;

    #[test]
    fn a_fresh_document_is_clean_and_untitled() {
        let app = App::new();
        assert!(!app.is_dirty(), "an empty new buffer has nothing to save");
        assert!(!app.has_path());
        assert_eq!(app.document_name(), "Untitled");
    }

    #[test]
    fn editing_marks_dirty_and_saving_marks_clean() {
        let mut app = App::new();
        app.input_char('x' as u16);
        assert!(app.is_dirty(), "a typed edit diverges from disk");
        app.mark_saved();
        assert!(!app.is_dirty(), "a save reconciles the generation");
        app.input_char('y' as u16);
        assert!(app.is_dirty(), "the next edit is dirty again");
    }

    #[test]
    fn load_document_is_clean_resets_the_caret_and_clears_undo() {
        let mut app = App::new();
        app.input_char('a' as u16); // give it undoable history + a moved caret
        app.input_char('b' as u16);
        let path = PathBuf::from("C:/notes/manuscript.md");
        app.load_document(decode(b"loaded body\r\ntext"), Some(path));

        assert!(!app.is_dirty(), "a freshly loaded file is clean");
        assert_eq!(app.caret, 0, "the caret homes to the top of the loaded doc");
        assert_eq!(app.anchor, 0);
        assert_eq!(app.document_name(), "manuscript.md");
        assert!(app.has_path());
        // The loaded content replaced the buffer, LF-normalized.
        assert_eq!(String::from_utf16(&app.text).unwrap(), "loaded body\ntext");
        // Undo history was cleared: Ctrl+Z can't reach back into the previous document.
        app.input_char(0x1A);
        assert_eq!(
            String::from_utf16(&app.text).unwrap(),
            "loaded body\ntext",
            "undo must not cross a load boundary"
        );
    }

    #[test]
    fn new_document_resets_to_a_clean_untitled_buffer() {
        let mut app = App::new();
        app.load_document(decode(b"something"), Some(PathBuf::from("x.txt")));
        app.new_document();
        assert!(!app.is_dirty());
        assert!(!app.has_path());
        assert_eq!(app.document_name(), "Untitled");
        assert!(app.text.is_empty());
    }

    #[test]
    fn bytes_to_save_reencodes_in_the_files_convention() {
        let mut app = App::new();
        // Load a CRLF UTF-8-BOM file; the buffer is LF-internal but the identity is remembered.
        let original = crate::codec::encode(
            &"line one\nline two".encode_utf16().collect::<Vec<_>>(),
            Encoding::Utf8Bom,
            Newline::Crlf,
        );
        app.load_document(decode(&original), Some(PathBuf::from("doc.txt")));
        // Saving with no further edits reproduces the original bytes (preserve-on-save, §3).
        assert_eq!(app.bytes_to_save(), original, "save round-trips the file's encoding + newline");
    }
}
