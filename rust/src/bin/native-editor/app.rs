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
use scriptorium_parser::parse_document;
use std::time::Instant;

/// AST-derived signal shown in the status line — proof the parse loop is closed.
pub struct ParseSignal {
    pub blocks: usize,
    pub words: usize,
    pub parse_micros: u128,
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
    signal: ParseSignal,
    /// Monotonic content generation, bumped on every edit (`refresh`). The renderer keys
    /// its cached `IDWriteTextLayout` on this so it rebuilds only when the text actually
    /// changed (N3 layout cache), and N4 will use it to discard a stale off-thread parse.
    content_gen: u64,
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

    /// Re-materialize `text` from the rope and re-drive the parse. Clamps caret + anchor,
    /// and bumps the content generation so the renderer's layout cache invalidates.
    fn refresh(&mut self) {
        self.text = self.buffer.to_units();
        self.content_gen = self.content_gen.wrapping_add(1);
        let len = self.text.len();
        self.caret = self.caret.min(len);
        self.anchor = self.anchor.min(len);
        let start = Instant::now();
        let doc = parse_document(&self.text);
        let parse_micros = start.elapsed().as_micros();
        self.signal = ParseSignal {
            blocks: doc.stats_blocks,
            words: doc.stats_words,
            parse_micros,
        };
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
        format!(
            "Ln {}, Col {}{}  \u{00B7}  {} blocks \u{00B7} {} words \u{00B7} parsed in {} \u{00B5}s \u{00B7} {} units",
            line + 1,
            col + 1,
            sel,
            self.signal.blocks,
            self.signal.words,
            self.signal.parse_micros,
            self.text.len()
        )
    }
}
