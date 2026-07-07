//! `MiniEdit` — a tiny single-line text input (SCRIPTORIUM-NATIVE-FIND.md §4). The find bar's
//! query and replace fields are each one of these: a short editable string with a caret, a
//! selection, grapheme/word motion, and paste. It is the dividend of owning the text engine —
//! a text input is already solved, so the find bar is a small composition, not a new engine.
//!
//! At `Vec<u16>` scale (a query is short — no rope needed), but it delegates every *boundary*
//! decision to `grapheme`, the one authority N2a's document motion also uses, so the query field
//! moves by grapheme/word exactly like the document. Single-line: newline units never enter.
//!
//! Platform-free (no Win32/COM), so it is oracled on every platform — a slight, deliberate
//! deviation from the spec's "lives in `app`" (that module is Windows-gated); this placement
//! gives the query field cross-platform oracle coverage the document itself doesn't have.

#![cfg_attr(not(test), allow(dead_code))]

use crate::grapheme;

/// A single-line editable string with a caret and selection.
#[derive(Default)]
pub struct MiniEdit {
    text: Vec<u16>,
    /// Caret as a UTF-16 offset (the moving end of a selection).
    caret: usize,
    /// Selection anchor (the fixed end). `anchor == caret` ⇒ no selection.
    anchor: usize,
}

impl MiniEdit {
    pub fn new() -> MiniEdit {
        MiniEdit::default()
    }

    /// A fresh field seeded with `units`, caret at the end, all selected — the "Ctrl+F pre-fills
    /// from the document selection, ready to be replaced by typing" affordance (§4).
    pub fn seeded(units: &[u16]) -> MiniEdit {
        let text: Vec<u16> = units.iter().copied().filter(|&u| u != 0x000A && u != 0x000D).collect();
        let end = text.len();
        MiniEdit { text, caret: end, anchor: 0 }
    }

    pub fn text(&self) -> &[u16] {
        &self.text
    }
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
    pub fn caret(&self) -> usize {
        self.caret
    }

    /// The selection as a half-open `[start, end)` (start ≤ end).
    pub fn selection(&self) -> (usize, usize) {
        (self.caret.min(self.anchor), self.caret.max(self.anchor))
    }
    pub fn has_selection(&self) -> bool {
        self.caret != self.anchor
    }
    pub fn selected_units(&self) -> Vec<u16> {
        let (s, e) = self.selection();
        self.text[s..e].to_vec()
    }

    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.caret = self.text.len();
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.caret = 0;
        self.anchor = 0;
    }

    /// Replace the selection (or, with none, insert at the caret) with `units`, stripping any
    /// newlines — this is a single-line field. Collapses the selection and lands the caret after
    /// the inserted run.
    pub fn insert(&mut self, units: &[u16]) {
        let ins: Vec<u16> = units.iter().copied().filter(|&u| u != 0x000A && u != 0x000D).collect();
        let (s, e) = self.selection();
        self.text.splice(s..e, ins.iter().copied());
        self.caret = s + ins.len();
        self.anchor = self.caret;
    }

    /// Delete the selection if any; else the grapheme before the caret (Backspace).
    pub fn backspace(&mut self) {
        if self.has_selection() {
            self.insert(&[]);
            return;
        }
        if self.caret > 0 {
            let prev = grapheme::prev_boundary(&self.text, self.caret);
            self.text.drain(prev..self.caret);
            self.caret = prev;
            self.anchor = prev;
        }
    }

    /// Delete the selection if any; else the grapheme at the caret (forward Delete).
    pub fn delete_forward(&mut self) {
        if self.has_selection() {
            self.insert(&[]);
            return;
        }
        if self.caret < self.text.len() {
            let next = grapheme::next_boundary(&self.text, self.caret);
            self.text.drain(self.caret..next);
        }
    }

    /// Move the caret to `to`, extending the selection (Shift held) or collapsing it.
    fn go(&mut self, to: usize, extend: bool) {
        self.caret = to;
        if !extend {
            self.anchor = to;
        }
    }

    /// Place the caret at an absolute unit offset (a mouse click's hit-test), clamped to the text
    /// and collapsing any selection. The hit-tester already returns cluster boundaries, so no
    /// grapheme snap is needed here.
    pub fn place(&mut self, to: usize) {
        self.go(to.min(self.text.len()), false);
    }

    pub fn left(&mut self, extend: bool) {
        // Unshifted with a selection collapses to the near edge (document parity).
        if !extend && self.has_selection() {
            let (s, _) = self.selection();
            self.go(s, false);
            return;
        }
        self.go(grapheme::prev_boundary(&self.text, self.caret), extend);
    }

    pub fn right(&mut self, extend: bool) {
        if !extend && self.has_selection() {
            let (_, e) = self.selection();
            self.go(e, false);
            return;
        }
        self.go(grapheme::next_boundary(&self.text, self.caret), extend);
    }

    pub fn word_left(&mut self, extend: bool) {
        self.go(grapheme::prev_word(&self.text, self.caret), extend);
    }
    pub fn word_right(&mut self, extend: bool) {
        self.go(grapheme::next_word(&self.text, self.caret), extend);
    }
    pub fn home(&mut self, extend: bool) {
        self.go(0, extend);
    }
    pub fn end(&mut self, extend: bool) {
        self.go(self.text.len(), extend);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    fn s(m: &MiniEdit) -> String {
        String::from_utf16_lossy(m.text())
    }

    #[test]
    fn seeded_strips_newlines_and_selects_all() {
        let m = MiniEdit::seeded(&u("line1\nline2"));
        assert_eq!(s(&m), "line1line2");
        assert!(m.has_selection());
        assert_eq!(m.selection(), (0, 10));
        // Typing over a fully-selected seed replaces it (the pre-fill affordance).
        let mut m = m;
        m.insert(&u("x"));
        assert_eq!(s(&m), "x");
        assert!(!m.has_selection());
    }

    #[test]
    fn insert_strips_newlines() {
        let mut m = MiniEdit::new();
        m.insert(&u("a\nb\r\nc"));
        assert_eq!(s(&m), "abc");
        assert_eq!(m.caret(), 3);
    }

    #[test]
    fn backspace_and_delete() {
        let mut m = MiniEdit::seeded(&u("abc"));
        m.end(false); // caret at 3, no selection
        m.backspace();
        assert_eq!(s(&m), "ab");
        m.home(false);
        m.delete_forward();
        assert_eq!(s(&m), "b");
    }

    #[test]
    fn selection_delete_is_one_op() {
        let mut m = MiniEdit::seeded(&u("hello"));
        m.home(false);
        m.right(true);
        m.right(true); // select "he"
        assert_eq!(m.selected_units(), u("he"));
        m.backspace();
        assert_eq!(s(&m), "llo");
    }

    #[test]
    fn grapheme_motion_over_astral() {
        // An emoji is two units but one grapheme — Left/Right step over it whole.
        let mut m = MiniEdit::seeded(&u("a\u{1F600}b"));
        m.end(false); // caret at 4
        m.left(false); // over 'b' -> 3
        assert_eq!(m.caret(), 3);
        m.left(false); // over the emoji (2 units) -> 1
        assert_eq!(m.caret(), 1);
    }

    #[test]
    fn word_motion() {
        let mut m = MiniEdit::seeded(&u("the cat"));
        m.home(false);
        m.word_right(false);
        assert_eq!(m.caret(), 4); // start of "cat"
        m.word_left(false);
        assert_eq!(m.caret(), 0);
    }

    #[test]
    fn place_sets_caret_and_clamps() {
        let mut m = MiniEdit::seeded(&u("hello")); // all selected
        m.place(2);
        assert!(!m.has_selection());
        assert_eq!(m.caret(), 2);
        m.place(999); // past end clamps to len
        assert_eq!(m.caret(), 5);
    }

    #[test]
    fn unshifted_arrow_collapses_selection_to_edge() {
        let mut m = MiniEdit::seeded(&u("hello")); // all selected, caret at 5, anchor 0
        m.left(false); // collapse to near edge (0)
        assert!(!m.has_selection());
        assert_eq!(m.caret(), 0);
    }
}
