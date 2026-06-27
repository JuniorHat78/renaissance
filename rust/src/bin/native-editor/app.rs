//! Editor state — the platform-independent half of the seam. No Win32, no COM. It owns
//! the rope buffer, a movable caret, undo/redo, and the last parse signal; `win32` feeds
//! it input events (as our own `Motion`/char types, never OS types) and `render` reads it.
//!
//! The rope (`buffer`) and a flat materialization (`text`) coexist on purpose
//! (SCRIPTORIUM-NATIVE-BUFFER.md §7): the rope gives O(1) undo snapshots, O(1) async-ready
//! views, and native coordinates; `text` is the current materialization that the parser
//! and renderer consume (both already O(n), so re-materializing per edit is free relative
//! to the reparse). N1's caret moves by code point; grapheme clusters/IME/selection are N2.

use crate::buffer::{Snapshot, TextBuffer};
use scriptorium_parser::parse_document;
use std::time::Instant;

/// AST-derived signal shown in the status line — proof the parse loop is closed.
pub struct ParseSignal {
    pub blocks: usize,
    pub words: usize,
    pub parse_micros: u128,
}

/// A caret motion, expressed in our own terms (the platform layer maps VK codes to these).
#[derive(Clone, Copy, PartialEq)]
pub enum Motion {
    Left,
    Right,
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
    /// Caret as a UTF-16 offset into `text`.
    pub caret: usize,
    undo: Vec<Checkpoint>,
    redo: Vec<Checkpoint>,
    /// Which kind of edit the current undo group is, if a run is open (for grouping).
    group: Option<EditKind>,
    signal: ParseSignal,
}

fn is_high_surrogate(u: u16) -> bool {
    (0xD800..=0xDBFF).contains(&u)
}
fn is_low_surrogate(u: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&u)
}

impl App {
    pub fn new() -> App {
        let mut app = App {
            buffer: TextBuffer::new(),
            text: Vec::new(),
            caret: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            group: None,
            signal: ParseSignal { blocks: 0, words: 0, parse_micros: 0 },
        };
        app.refresh();
        app
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

    /// Move the caret by one code point (surrogate-pair-aware) or to the line edge. Closes
    /// the current undo group so the next edit starts a fresh checkpoint.
    pub fn move_caret(&mut self, motion: Motion) {
        match motion {
            Motion::Left => {
                if self.caret >= 2
                    && is_low_surrogate(self.text[self.caret - 1])
                    && is_high_surrogate(self.text[self.caret - 2])
                {
                    self.caret -= 2;
                } else if self.caret > 0 {
                    self.caret -= 1;
                }
            }
            Motion::Right => {
                let len = self.text.len();
                if self.caret + 1 < len
                    && is_high_surrogate(self.text[self.caret])
                    && is_low_surrogate(self.text[self.caret + 1])
                {
                    self.caret += 2;
                } else if self.caret < len {
                    self.caret += 1;
                }
            }
            Motion::Home => {
                while self.caret > 0 && self.text[self.caret - 1] != 0x000A {
                    self.caret -= 1;
                }
            }
            Motion::End => {
                let len = self.text.len();
                while self.caret < len && self.text[self.caret] != 0x000A {
                    self.caret += 1;
                }
            }
        }
        self.group = None;
    }

    fn type_unit(&mut self, unit: u16) {
        self.begin_group(EditKind::Insert);
        self.buffer.insert(self.caret, &[unit]);
        self.caret += 1;
        self.refresh();
    }

    fn newline(&mut self) {
        self.begin_group(EditKind::Insert);
        self.buffer.insert(self.caret, &[0x000A]);
        self.caret += 1;
        self.group = None; // break the undo run at line boundaries
        self.refresh();
    }

    fn backspace(&mut self) {
        if self.caret == 0 {
            return;
        }
        self.begin_group(EditKind::Delete);
        let n = if self.caret >= 2
            && is_low_surrogate(self.text[self.caret - 1])
            && is_high_surrogate(self.text[self.caret - 2])
        {
            2
        } else {
            1
        };
        self.buffer.delete(self.caret - n..self.caret);
        self.caret -= n;
        self.refresh();
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
            self.group = None;
            self.refresh();
        }
    }

    fn redo(&mut self) {
        if let Some(cp) = self.redo.pop() {
            self.undo.push(Checkpoint { snap: self.buffer.snapshot(), caret: self.caret });
            self.buffer.restore(&cp.snap);
            self.caret = cp.caret.min(self.buffer.len());
            self.group = None;
            self.refresh();
        }
    }

    /// Re-materialize `text` from the rope and re-drive the parse. Clamps the caret.
    fn refresh(&mut self) {
        self.text = self.buffer.to_units();
        if self.caret > self.text.len() {
            self.caret = self.text.len();
        }
        let start = Instant::now();
        let doc = parse_document(&self.text);
        let parse_micros = start.elapsed().as_micros();
        self.signal = ParseSignal {
            blocks: doc.stats_blocks,
            words: doc.stats_words,
            parse_micros,
        };
    }

    /// The status line: caret Ln/Col (from the rope's line summary) + the AST signal.
    pub fn status_text(&self) -> String {
        let line = self.buffer.line_of_offset(self.caret);
        let col = self.caret - self.buffer.offset_of_line(line);
        format!(
            "Ln {}, Col {}  \u{00B7}  {} blocks \u{00B7} {} words \u{00B7} parsed in {} \u{00B5}s \u{00B7} {} units",
            line + 1,
            col + 1,
            self.signal.blocks,
            self.signal.words,
            self.signal.parse_micros,
            self.text.len()
        )
    }
}
