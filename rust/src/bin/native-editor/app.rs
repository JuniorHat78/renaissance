//! Editor state — the platform-independent half of the seam. No Win32, no COM:
//! a buffer, a caret, and the last parse signal. `win32` feeds it input events and
//! `render` reads it; neither leaks OS types in here.
//!
//! N0's buffer is a naive `Vec<u16>` of UTF-16 code units. A real text buffer
//! (rope / piece-tree) is N1. The point worth keeping: the buffer is already UTF-16,
//! so it feeds `parse_document(&[u16])` with ZERO conversion — the native ergonomics
//! the in-process path was for (SCRIPTORIUM-NATIVE-SKELETON.md §3).

use scriptorium_parser::parse_document;
use std::time::Instant;

/// The AST-derived signal shown in the status line — the proof the parse loop is
/// closed end to end (buffer -> rust/ core -> pixels), not a real editor surface yet.
pub struct ParseSignal {
    pub blocks: usize,
    pub words: usize,
    pub parse_micros: u128,
}

pub struct App {
    /// UTF-16 code units. N0 only ever appends/pops at `caret` (== end-of-buffer);
    /// caret movement and selection are N2.
    pub buffer: Vec<u16>,
    /// Insertion index into `buffer`. N0 keeps it pinned at `buffer.len()`.
    pub caret: usize,
    pub signal: ParseSignal,
}

impl App {
    pub fn new() -> App {
        let mut app = App {
            buffer: Vec::new(),
            caret: 0,
            signal: ParseSignal { blocks: 0, words: 0, parse_micros: 0 },
        };
        app.reparse();
        app
    }

    /// Translate a `WM_CHAR` code unit into an edit. Printable units are inserted;
    /// Backspace deletes; Enter inserts a newline; other control units are ignored.
    pub fn input_char(&mut self, unit: u16) {
        match unit {
            0x08 => self.backspace(),       // Backspace
            0x0D => self.insert_unit(0x0A), // Enter (CR) -> LF newline
            0x0A => {}                      // lone LF (e.g. Ctrl+Enter) — ignore
            0x7F => {}                      // DEL (Ctrl+Backspace) — ignore for N0
            c if c >= 0x20 => self.insert_unit(c),
            _ => {} // other C0 control units
        }
    }

    fn insert_unit(&mut self, unit: u16) {
        self.buffer.insert(self.caret, unit);
        self.caret += 1;
        self.reparse();
    }

    fn backspace(&mut self) {
        if self.caret > 0 {
            self.caret -= 1;
            self.buffer.remove(self.caret);
            self.reparse();
        }
    }

    /// Reparse the whole buffer through the `rust/` core in-process and refresh the
    /// signal. At ~580µs/section (SCRIPTORIUM-WASM-MARSHALLING.md) a synchronous
    /// reparse-per-keystroke on the UI thread is imperceptible for N0; off-thread is N4.
    fn reparse(&mut self) {
        let start = Instant::now();
        let doc = parse_document(&self.buffer);
        let parse_micros = start.elapsed().as_micros();
        self.signal = ParseSignal {
            blocks: doc.stats_blocks,
            words: doc.stats_words,
            parse_micros,
        };
    }

    /// The status-line text: the AST signal + raw buffer size.
    pub fn status_text(&self) -> String {
        format!(
            "{} blocks \u{00B7} {} words \u{00B7} parsed in {} \u{00B5}s \u{00B7} {} units",
            self.signal.blocks,
            self.signal.words,
            self.signal.parse_micros,
            self.buffer.len()
        )
    }
}
