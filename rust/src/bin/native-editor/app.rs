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
use crate::find::{FindState, Focus};
use crate::grapheme;
use crate::parse::ParseSignal;
use crate::styles::StyleSpan;
use scriptorium_parser::InlineSpan;

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
    /// The inline style spans (strong/emphasis/code/link) — folded in alongside `styles` under the
    /// same gate (§5B); source offsets the renderer clamps into each paragraph.
    inline_spans: Vec<InlineSpan>,
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
    /// The open Find/Replace session, or `None` when find-mode is closed (SCRIPTORIUM-NATIVE-FIND.md).
    /// When `Some`, keystrokes route to a find-bar field (not the document), the renderer draws the
    /// bar + match highlights, and the document selection tracks the active match.
    find: Option<FindState>,
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
            inline_spans: Vec::new(),
            roundtrip_micros: 0,
            comp: None,
            path: None,
            encoding: Encoding::Utf8,
            newline: Newline::Lf,
            saved_gen: 0,
            find: None,
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

    /// Whether the folded-in style spans reflect the live text — `signal_gen == content_gen`, i.e. no
    /// edit is in flight since the last landed parse. When false (the user just typed and the async
    /// parse hasn't returned), the renderer uses a cheap per-paragraph lexical guess for immediacy
    /// instead of the lagging AST styles (SCRIPTORIUM-NATIVE-STYLING.md §4, the style pop-in fix).
    pub fn styles_current(&self) -> bool {
        self.signal_gen == self.content_gen
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

    // --- Find / Replace (SCRIPTORIUM-NATIVE-FIND.md) --------------------------
    // Find-mode is a focus state: while `find` is `Some`, keystrokes route to a bar field (not the
    // document), the renderer draws the bar + match highlights, and the document selection tracks
    // the active match. Every command leaves the match cache fresh (`ensure`), so the renderer reads
    // a set consistent with the current content + query. The take/put-back pattern on `self.find`
    // sidesteps borrowing `self.text` and `self.find` at once.

    /// Whether find-mode is open (the renderer draws the bar; `win32` routes keys to it).
    pub fn is_finding(&self) -> bool {
        self.find.is_some()
    }

    /// Read access to the session — the renderer's source for bar text, matches, active, counter.
    pub fn find_state(&self) -> Option<&FindState> {
        self.find.as_ref()
    }

    /// Open (or refocus) find-mode. `with_replace` shows the replace field (Ctrl+H vs Ctrl+F).
    /// Seeds the query from the document selection, seeks the first match at/after the caret, and
    /// selects it. Re-invoking while open refocuses + reselects the query (standard Ctrl+F feel).
    pub fn find_begin(&mut self, with_replace: bool) {
        if let Some(fs) = &mut self.find {
            fs.focus = Focus::Query;
            fs.replace_visible |= with_replace;
            fs.query.select_all();
            return;
        }
        let seed = self.selected_units();
        let mut fs = FindState::open(&seed, with_replace);
        fs.seek_from(&self.text, self.content_gen, self.caret);
        self.find = Some(fs);
        self.apply_active_match();
    }

    /// Close find-mode, leaving the caret on the active match (already the selection).
    pub fn find_end(&mut self) {
        self.find = None;
    }

    /// Point the document selection at the active match — the highlight + reveal target. No-op with
    /// no match (the query is empty or unmatched); the document selection then simply stays put.
    fn apply_active_match(&mut self) {
        let r = self.find.as_ref().and_then(|fs| fs.active_range());
        if let Some(r) = r {
            self.set_selection(r.start, r.end);
        }
    }

    /// Whether the replace field currently has focus (Enter → Replace vs Find-next).
    pub fn find_focus_is_replace(&self) -> bool {
        matches!(self.find.as_ref().map(|fs| fs.focus), Some(Focus::Replace))
    }

    /// Tab between the query and replace fields (only when the replace field is visible).
    pub fn find_toggle_focus(&mut self) {
        if let Some(fs) = &mut self.find {
            if fs.replace_visible {
                fs.focus = if fs.focus == Focus::Query { Focus::Replace } else { Focus::Query };
            }
        }
    }

    /// Focus a specific field (a mouse click on a field well). The replace field is only focusable
    /// when it's visible.
    pub fn find_set_focus(&mut self, replace: bool) {
        if let Some(fs) = &mut self.find {
            fs.focus = if replace && fs.replace_visible { Focus::Replace } else { Focus::Query };
        }
    }

    /// Place the caret in the focused field at an absolute unit offset — a click's hit-test result.
    /// Collapses any selection; field motion never touches the match set, so no re-run.
    pub fn find_place_field_caret(&mut self, index: usize) {
        if let Some(fs) = &mut self.find {
            fs.focused().place(index);
        }
    }

    /// Advance / retreat the active match, wrapping, and reselect it (Enter/F3, Shift+Enter/F3).
    pub fn find_next(&mut self) {
        let mut fs = match self.find.take() {
            Some(f) => f,
            None => return,
        };
        fs.next(&self.text, self.content_gen);
        self.find = Some(fs);
        self.apply_active_match();
    }
    pub fn find_prev(&mut self) {
        let mut fs = match self.find.take() {
            Some(f) => f,
            None => return,
        };
        fs.prev(&self.text, self.content_gen);
        self.find = Some(fs);
        self.apply_active_match();
    }

    /// Route a typed unit into the focused bar field. When the *query* changes, re-run the match
    /// set (incremental find) and reselect the nearest match. A newline is stripped by the field.
    pub fn find_input(&mut self, unit: u16) {
        self.find_edit(|f| f.insert(&[unit]));
    }
    /// Paste `units` into the focused field (find-mode clipboard).
    pub fn find_paste(&mut self, units: &[u16]) {
        self.find_edit(|f| f.insert(units));
    }
    pub fn find_backspace(&mut self) {
        self.find_edit(|f| f.backspace());
    }
    pub fn find_delete(&mut self) {
        self.find_edit(|f| f.delete_forward());
    }

    /// Apply an edit `op` to the focused field, then — if the query changed — re-run matches and
    /// reselect. The single choke point for "the field's text changed."
    fn find_edit(&mut self, op: impl FnOnce(&mut crate::minedit::MiniEdit)) {
        let mut fs = match self.find.take() {
            Some(f) => f,
            None => return,
        };
        let is_query = fs.focus == Focus::Query;
        op(fs.focused());
        if is_query {
            fs.ensure(&self.text, self.content_gen);
        }
        self.find = Some(fs);
        if is_query {
            self.apply_active_match();
        }
    }

    /// Move the caret within the focused field (arrows/Home/End in the bar). Field motion never
    /// changes the match set, so no re-run.
    pub fn find_field_motion(&mut self, motion: Motion, extend: bool) {
        if let Some(fs) = &mut self.find {
            let f = fs.focused();
            match motion {
                Motion::Left => f.left(extend),
                Motion::Right => f.right(extend),
                Motion::WordLeft => f.word_left(extend),
                Motion::WordRight => f.word_right(extend),
                Motion::Home => f.home(extend),
                Motion::End => f.end(extend),
            }
        }
    }
    pub fn find_field_select_all(&mut self) {
        if let Some(fs) = &mut self.find {
            fs.focused().select_all();
        }
    }
    /// Copy the focused field's selection (find-mode Ctrl+C).
    pub fn find_field_copy(&self) -> Vec<u16> {
        match &self.find {
            Some(fs) => match fs.focus {
                Focus::Query => fs.query.selected_units(),
                Focus::Replace => fs.replace.selected_units(),
            },
            None => Vec::new(),
        }
    }

    pub fn find_toggle_case(&mut self) {
        self.find_retune(|o| o.case_sensitive = !o.case_sensitive);
    }
    pub fn find_toggle_word(&mut self) {
        self.find_retune(|o| o.whole_word = !o.whole_word);
    }
    fn find_retune(&mut self, op: impl FnOnce(&mut crate::find::FindOpts)) {
        let mut fs = match self.find.take() {
            Some(f) => f,
            None => return,
        };
        op(&mut fs.opts);
        fs.ensure(&self.text, self.content_gen);
        self.find = Some(fs);
        self.apply_active_match();
    }

    /// Replace the active match with the replace field's text as **one** undo step, then advance to
    /// the next match at/after the edit (never re-hitting the just-inserted text). Returns whether a
    /// replacement happened (there was an active match).
    pub fn find_replace_current(&mut self) -> bool {
        let mut fs = match self.find.take() {
            Some(f) => f,
            None => return false,
        };
        fs.ensure(&self.text, self.content_gen);
        let range = match fs.active_range() {
            Some(r) => r,
            None => {
                self.find = Some(fs);
                return false;
            }
        };
        let repl = fs.replace.text().to_vec();
        self.group = None;
        self.set_selection(range.start, range.end);
        self.replace_selection(&repl, EditKind::Insert);
        self.group = None; // isolate: a replace is its own undo step (like paste)
        let at = range.start + repl.len();
        fs.invalidate();
        fs.seek_from(&self.text, self.content_gen, at);
        self.find = Some(fs);
        self.apply_active_match();
        true
    }

    /// Replace **every** match in one undo transaction (§6). Snapshots the match set once, then
    /// applies right-to-left so earlier offsets never shift under the edit — which also makes a
    /// self-matching superstring (`a`→`aa`) impossible to loop, since we never re-scan mid-batch.
    /// One Ctrl+Z reverses the whole batch. Returns the number replaced.
    pub fn find_replace_all(&mut self) -> usize {
        let mut fs = match self.find.take() {
            Some(f) => f,
            None => return 0,
        };
        fs.ensure(&self.text, self.content_gen);
        let repl = fs.replace.text().to_vec();
        let ms = fs.matches().to_vec();
        let count = ms.len();
        if count > 0 {
            // One pre-edit checkpoint for the entire batch (begin_group can't express this — it
            // keys on edit *kind*; here we want a single snapshot spanning many edits).
            self.undo.push(Checkpoint { snap: self.buffer.snapshot(), caret: self.caret });
            self.redo.clear();
            self.group = None;
            for m in ms.iter().rev() {
                self.buffer.delete(m.start..m.end);
                if !repl.is_empty() {
                    self.buffer.insert(m.start, &repl);
                }
            }
            // Land the caret at the end of the first replacement (its offset is unshifted, since we
            // applied right-to-left).
            self.caret = ms.first().map(|m| m.start + repl.len()).unwrap_or(self.caret);
            self.anchor = self.caret;
            self.refresh();
            fs.invalidate();
            fs.seek_from(&self.text, self.content_gen, self.caret);
        }
        self.find = Some(fs);
        self.apply_active_match();
        count
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
    pub fn apply_parse(
        &mut self,
        gen: u64,
        signal: ParseSignal,
        styles: Vec<StyleSpan>,
        inline_spans: Vec<InlineSpan>,
    ) -> bool {
        if gen > self.signal_gen {
            self.signal = signal;
            self.styles = styles;
            self.inline_spans = inline_spans;
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

    /// The inline style spans (strong/emphasis/code/link, source offsets) the renderer applies WITHIN
    /// each paragraph (§5B). Like `styles`, they lag by the parse-in-flight and are treated as
    /// last-good, clamped to each paragraph. Inline styling doesn't reflow (unlike a heading's size),
    /// so the ~1 ms lag on the edited paragraph is not jarring — no provisional guess (unlike blocks).
    pub fn inline_spans(&self) -> &[InlineSpan] {
        &self.inline_spans
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

    fn inline_span() -> Vec<InlineSpan> {
        use scriptorium_parser::InlineKind;
        vec![InlineSpan { start: 0, end: 4, kind: InlineKind::Strong }]
    }

    #[test]
    fn apply_parse_folds_in_a_newer_result() {
        let mut app = App::new();
        assert!(app.apply_parse(3, ParseSignal { blocks: 1, words: 5, parse_micros: 10 }, heading_span(), inline_span()));
        assert_eq!(app.signal.words, 5, "a newer generation updates the signal");
        assert_eq!(app.signal_gen, 3);
        assert_eq!(app.styles().len(), 1, "the style spans fold in with the signal");
        assert_eq!(app.inline_spans().len(), 1, "the inline spans fold in too");
    }

    #[test]
    fn apply_parse_refuses_to_regress_on_a_stale_result() {
        let mut app = App::new();
        assert!(app.apply_parse(5, ParseSignal { blocks: 2, words: 9, parse_micros: 20 }, heading_span(), inline_span()));
        // A later-arriving OLDER parse (gen 4 < 5) must be dropped, not overwrite the newer stats/styles.
        assert!(!app.apply_parse(4, ParseSignal { blocks: 0, words: 0, parse_micros: 1 }, Vec::new(), Vec::new()));
        assert_eq!(app.signal.words, 9, "the stale result did not regress the display");
        assert_eq!(app.signal_gen, 5, "signal_gen never moves backwards");
        assert_eq!(app.styles().len(), 1, "the stale result did not clear the newer styles");
        assert_eq!(app.inline_spans().len(), 1, "nor the newer inline spans");
        // The same generation is also a no-op (idempotent — no duplicate apply).
        assert!(!app.apply_parse(5, ParseSignal { blocks: 0, words: 0, parse_micros: 1 }, Vec::new(), Vec::new()));
        assert_eq!(app.signal.words, 9);
    }

    #[test]
    fn status_line_shows_parsing_in_flight_then_the_async_roundtrip() {
        // A fresh App has content_gen 1 but no parse folded in yet (signal_gen 0) — in flight (N4b).
        let mut app = App::new();
        assert!(app.status_text().contains("parsing"), "in flight before the first parse lands");
        // The parse for gen 1 lands: caught up, so the "parsing…" marker clears. No round-trip
        // measured yet (that's win32's to record), so no async figure either.
        app.apply_parse(1, ParseSignal { blocks: 0, words: 0, parse_micros: 5 }, Vec::new(), Vec::new());
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

// --- Find / Replace command oracle (SCRIPTORIUM-NATIVE-FIND.md) ---------------
// The deterministic half: open/seek, incremental query, wrap navigation, the option toggles, and —
// the correctness heart — the Replace transactions (one-undo-per-replace, one-undo-for-all,
// right-to-left batch, self-matching-superstring safety). The bar's *look* is the author's (§9).
#[cfg(test)]
mod find_app_tests {
    use super::*;

    fn s(app: &App) -> String {
        String::from_utf16(&app.text).unwrap()
    }
    fn app_with(text: &str) -> App {
        let mut app = App::new();
        for c in text.encode_utf16() {
            app.input_char(c);
        }
        app
    }
    fn query(app: &mut App, q: &str) {
        for c in q.encode_utf16() {
            app.find_input(c);
        }
    }
    fn into_replace(app: &mut App, r: &str) {
        app.find_toggle_focus(); // requires replace_visible
        for c in r.encode_utf16() {
            app.find_input(c);
        }
    }

    #[test]
    fn open_seeds_from_selection_and_selects_a_match() {
        let mut app = app_with("cat dog cat");
        app.set_selection(0, 3); // select "cat"; caret lands at 3
        app.find_begin(false);
        assert!(app.is_finding());
        // Seeded query "cat"; first match at/after the caret (3) is the one at 8.
        assert_eq!(app.selection(), (8, 11));
    }

    #[test]
    fn incremental_query_tracks_the_first_match() {
        let mut app = app_with("alpha beta alpha");
        app.set_caret(0, false);
        app.find_begin(false);
        query(&mut app, "alpha");
        assert_eq!(app.find_state().unwrap().match_count(), 2);
        assert_eq!(app.selection(), (0, 5)); // the doc selection tracks the active match
    }

    #[test]
    fn next_prev_wrap_and_move_the_selection() {
        let mut app = app_with("x x x");
        app.set_caret(0, false);
        app.find_begin(false);
        query(&mut app, "x");
        assert_eq!(app.selection(), (0, 1));
        app.find_next();
        assert_eq!(app.selection(), (2, 3));
        app.find_next();
        assert_eq!(app.selection(), (4, 5));
        app.find_next(); // wrap to first
        assert_eq!(app.selection(), (0, 1));
        app.find_prev(); // wrap back to last
        assert_eq!(app.selection(), (4, 5));
    }

    #[test]
    fn toggles_refilter_the_match_set() {
        let mut app = app_with("cat Cat category");
        app.set_caret(0, false);
        app.find_begin(false);
        query(&mut app, "cat");
        assert_eq!(app.find_state().unwrap().match_count(), 3); // ci substring
        app.find_toggle_case();
        assert_eq!(app.find_state().unwrap().match_count(), 2); // "cat", "cat"egory
        app.find_toggle_word();
        assert_eq!(app.find_state().unwrap().match_count(), 1); // standalone "cat" only
    }

    #[test]
    fn replace_current_is_one_undo_step_and_advances() {
        let mut app = app_with("cat cat cat");
        app.set_caret(0, false);
        app.find_begin(true);
        query(&mut app, "cat");
        into_replace(&mut app, "dog");
        assert!(app.find_replace_current());
        assert_eq!(s(&app), "dog cat cat");
        // The active match advanced past the edit (to the next "cat").
        assert_eq!(app.selection(), (4, 7));
        // One undo reverses just this replacement.
        app.input_char(0x1A);
        assert_eq!(s(&app), "cat cat cat");
    }

    #[test]
    fn replace_all_is_one_undo_for_the_whole_batch() {
        let mut app = app_with("cat cat cat");
        app.set_caret(0, false);
        app.find_begin(true);
        query(&mut app, "cat");
        into_replace(&mut app, "dog");
        assert_eq!(app.find_replace_all(), 3);
        assert_eq!(s(&app), "dog dog dog");
        app.input_char(0x1A); // a single undo
        assert_eq!(s(&app), "cat cat cat");
    }

    #[test]
    fn replace_all_superstring_terminates_and_is_correct() {
        // The self-match hazard: query "a", replacement "aa". A live match→replace→re-scan loop
        // would never terminate; the snapshot-then-apply-right-to-left design replaces each
        // original 'a' exactly once. "banana" -> b|aa|n|aa|n|aa.
        let mut app = app_with("banana");
        app.set_caret(0, false);
        app.find_begin(true);
        query(&mut app, "a");
        into_replace(&mut app, "aa");
        assert_eq!(app.find_replace_all(), 3);
        assert_eq!(s(&app), "baanaanaa");
    }

    #[test]
    fn replace_all_with_empty_deletes_every_match() {
        let mut app = app_with("a-b-c-");
        app.set_caret(0, false);
        app.find_begin(true);
        query(&mut app, "-");
        // The replace field is left empty.
        assert_eq!(app.find_replace_all(), 3);
        assert_eq!(s(&app), "abc");
    }

    #[test]
    fn replace_all_right_to_left_keeps_offsets_valid() {
        // Different-length replacement across several matches: right-to-left application means no
        // earlier match's offset shifts before it's applied.
        let mut app = app_with("x.x.x");
        app.set_caret(0, false);
        app.find_begin(true);
        query(&mut app, "x");
        into_replace(&mut app, "yyy");
        assert_eq!(app.find_replace_all(), 3);
        assert_eq!(s(&app), "yyy.yyy.yyy");
    }

    #[test]
    fn close_leaves_the_caret_on_the_active_match() {
        let mut app = app_with("find me here");
        app.set_caret(0, false);
        app.find_begin(false);
        query(&mut app, "here");
        assert_eq!(app.selection(), (8, 12));
        app.find_end();
        assert!(!app.is_finding());
        assert_eq!(app.selection(), (8, 12)); // ready to edit exactly where you landed
    }

    #[test]
    fn click_focus_switches_field_and_typing_follows() {
        // A click focuses a field (find_set_focus); subsequent typing lands there. Mirrors the
        // win32 mouse handler's dispatch, minus the geometry hit-test.
        let mut app = app_with("cat dog cat");
        app.set_caret(0, false);
        app.find_begin(true); // replace visible; focus starts on the query field
        query(&mut app, "cat");
        // Click the replace field, then type — it must go to replace, not re-run the query.
        app.find_set_focus(true);
        assert!(app.find_focus_is_replace());
        for c in "x".encode_utf16() {
            app.find_input(c);
        }
        assert_eq!(app.find_state().unwrap().replace.text(), &"x".encode_utf16().collect::<Vec<_>>()[..]);
        assert_eq!(app.find_state().unwrap().query.text(), &"cat".encode_utf16().collect::<Vec<_>>()[..]);
        // Click back to the query field; focus follows.
        app.find_set_focus(false);
        assert!(!app.find_focus_is_replace());
        // With the replace field hidden, a click on "replace" can't steal focus (stays on query).
        app.find_end();
        app.find_begin(false);
        app.find_set_focus(true);
        assert!(!app.find_focus_is_replace());
    }

    #[test]
    fn click_places_the_field_caret() {
        // find_place_field_caret sets the focused field's caret to a hit-tested offset (here fed
        // directly). Collapses the seed's select-all so a later Backspace deletes one grapheme.
        let mut app = app_with("banana");
        app.set_selection(0, 6); // seeds query "banana", fully selected
        app.find_begin(false);
        app.find_place_field_caret(3); // caret between "ban|ana"
        assert!(!app.find_state().unwrap().query.has_selection());
        assert_eq!(app.find_state().unwrap().query.caret(), 3);
        app.find_backspace(); // deletes the 'n' before the caret → "baana"
        assert_eq!(app.find_state().unwrap().query.text(), &"baana".encode_utf16().collect::<Vec<_>>()[..]);
    }
}
