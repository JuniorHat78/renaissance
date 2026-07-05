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

use crate::buffer::{Snapshot, TextBuffer};
use crate::grapheme;
use crate::parse::ParseSignal;

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
    /// The provisional IME composition, if a session is active (SCRIPTORIUM-NATIVE-IME.md §2).
    /// `Some` only between `WM_IME_STARTCOMPOSITION` and its end; the rope stays untouched
    /// while it lives. The renderer reads it to splice the inline preview.
    comp: Option<Composition>,
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
            comp: None,
        };
        app.refresh();
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
    pub fn apply_parse(&mut self, gen: u64, signal: ParseSignal) -> bool {
        if gen > self.signal_gen {
            self.signal = signal;
            self.signal_gen = gen;
            true
        } else {
            false
        }
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
        // whose parse hasn't landed yet. Surface that honestly: at rest the signal is caught up and
        // nothing shows; mid-flight a "· parsing…" marker makes the async visible (and is how you
        // watch N4 working). `content_gen - signal_gen` is the number of edits still in flight.
        let lag = if self.signal_gen < self.content_gen { " \u{00B7} parsing\u{2026}" } else { "" };
        format!(
            "Ln {}, Col {}{}  \u{00B7}  {} blocks \u{00B7} {} words \u{00B7} parsed in {} \u{00B5}s \u{00B7} {} units{}",
            line + 1,
            col + 1,
            sel,
            self.signal.blocks,
            self.signal.words,
            self.signal.parse_micros,
            self.text.len(),
            lag,
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

    #[test]
    fn apply_parse_folds_in_a_newer_result() {
        let mut app = App::new();
        assert!(app.apply_parse(3, ParseSignal { blocks: 1, words: 5, parse_micros: 10 }));
        assert_eq!(app.signal.words, 5, "a newer generation updates the signal");
        assert_eq!(app.signal_gen, 3);
    }

    #[test]
    fn apply_parse_refuses_to_regress_on_a_stale_result() {
        let mut app = App::new();
        assert!(app.apply_parse(5, ParseSignal { blocks: 2, words: 9, parse_micros: 20 }));
        // A later-arriving OLDER parse (gen 4 < 5) must be dropped, not overwrite the newer stats.
        assert!(!app.apply_parse(4, ParseSignal { blocks: 0, words: 0, parse_micros: 1 }));
        assert_eq!(app.signal.words, 9, "the stale result did not regress the display");
        assert_eq!(app.signal_gen, 5, "signal_gen never moves backwards");
        // The same generation is also a no-op (idempotent — no duplicate apply).
        assert!(!app.apply_parse(5, ParseSignal { blocks: 0, words: 0, parse_micros: 1 }));
        assert_eq!(app.signal.words, 9);
    }
}
