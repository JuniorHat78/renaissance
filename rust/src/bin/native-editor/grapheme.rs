//! Pragmatic grapheme-cluster + word boundaries over UTF-16 (SCRIPTORIUM-NATIVE-INPUT.md
//! §4). We own the text engine, so rather than vendor the full UCD we implement the
//! UAX #29 rules real prose and common emoji actually exercise: surrogate pairs, CRLF,
//! combining marks (Extend), ZWJ sequences, regional-indicator flag pairs, variation
//! selectors and emoji modifiers. The two `*_boundary` fns are the single choke point to
//! later swap in a full break-property table if a document ever needs it.
//!
//! Pure logic, no Win32 — compiled and tested on every platform (like `buffer`).

#![cfg_attr(not(test), allow(dead_code))]

/// Decode the Unicode scalar starting at unit `i`, returning `(scalar, unit_len)`.
/// A lone/low surrogate decodes as itself with len 1 (we never split a valid pair).
fn scalar_at(text: &[u16], i: usize) -> (u32, usize) {
    let u = text[i];
    if (0xD800..=0xDBFF).contains(&u) && i + 1 < text.len() {
        let lo = text[i + 1];
        if (0xDC00..=0xDFFF).contains(&lo) {
            let c = 0x1_0000 + (((u as u32 - 0xD800) << 10) | (lo as u32 - 0xDC00));
            return (c, 2);
        }
    }
    (u as u32, 1)
}

/// An Extend / joiner scalar that attaches to the preceding base (combining marks, ZWJ,
/// variation selectors, emoji skin-tone modifiers). A pragmatic subset of the UAX #29
/// Extend + ZWJ classes — the ranges real prose and pasted emoji hit.
fn is_extend(c: u32) -> bool {
    matches!(c,
        0x0300..=0x036F |   // combining diacritical marks
        0x0483..=0x0489 |   // Cyrillic combining
        0x0591..=0x05BD | 0x05BF | 0x05C1..=0x05C2 | 0x05C4..=0x05C5 | // Hebrew points
        0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | // Arabic marks
        0x06D6..=0x06DC | 0x06DF..=0x06E4 | 0x06E7..=0x06E8 | 0x06EA..=0x06ED |
        0x0900..=0x0903 | 0x093A..=0x094F | // Devanagari (loose)
        0x1AB0..=0x1AFF |   // combining diacritical marks extended
        0x1DC0..=0x1DFF |   // combining diacritical marks supplement
        0x200D |            // ZERO WIDTH JOINER
        0x20D0..=0x20FF |   // combining marks for symbols
        0xFE00..=0xFE0F |   // variation selectors
        0xFE20..=0xFE2F |   // combining half marks
        0x1F3FB..=0x1F3FF | // emoji skin-tone modifiers
        0xE0100..=0xE01EF   // variation selectors supplement
    )
}

fn is_zwj(c: u32) -> bool {
    c == 0x200D
}

/// Regional-indicator symbols — two in a row form one flag grapheme.
fn is_regional(c: u32) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&c)
}

/// The next grapheme boundary strictly after unit index `i` (which must itself be a
/// boundary), or `text.len()` if `i` is in the last grapheme. Assumes `i <= len`.
pub fn next_boundary(text: &[u16], i: usize) -> usize {
    let len = text.len();
    if i >= len {
        return len;
    }
    let (first, n) = scalar_at(text, i);
    let mut idx = i + n;

    // CRLF is a single grapheme.
    if first == 0x000D && idx < len && text[idx] == 0x000A {
        return idx + 1;
    }

    // A pair of regional indicators forms one flag; a third starts a new cluster.
    if is_regional(first) {
        if idx < len {
            let (c2, n2) = scalar_at(text, idx);
            if is_regional(c2) {
                idx += n2;
            }
        }
        return idx;
    }

    // Absorb a run of Extend/joiners; a ZWJ additionally pulls in the following base
    // cluster (emoji ZWJ sequences like 👨‍👩‍👧).
    loop {
        if idx >= len {
            break;
        }
        let (c, n2) = scalar_at(text, idx);
        if is_extend(c) {
            idx += n2;
            if is_zwj(c) && idx < len {
                let (_base, nb) = scalar_at(text, idx);
                idx += nb;
            }
        } else {
            break;
        }
    }
    idx
}

/// The grapheme boundary strictly before unit index `i`, or 0. Implemented by walking
/// boundaries forward from the buffer start until the next one reaches `i` — clusters can
/// straddle newlines (CRLF), so we can't safely anchor the walk to the current line. This
/// is O(i); caret motion is user-paced, and a per-line/virtualized index is the N3+
/// optimization if a huge document ever makes it felt.
pub fn prev_boundary(text: &[u16], i: usize) -> usize {
    if i == 0 {
        return 0;
    }
    let target = i.min(text.len());
    let mut b = 0;
    loop {
        let nb = next_boundary(text, b);
        if nb >= target {
            return b;
        }
        b = nb;
    }
}

#[derive(PartialEq, Clone, Copy)]
enum WordClass {
    Space,
    Word,
    Punct,
}

fn classify(c: u32) -> WordClass {
    // ASCII fast path + a pragmatic Unicode rule: letters/digits/underscore are Word,
    // whitespace is Space, everything else Punct.
    match c {
        0x09 | 0x0A | 0x0D | 0x20 | 0x00A0 | 0x2028 | 0x2029 => WordClass::Space,
        0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A | 0x5F => WordClass::Word,
        _ if c >= 0x00C0 => WordClass::Word, // most non-ASCII scalars: treat as word-ish
        _ => WordClass::Punct,
    }
}

/// Word boundary after `i`: skip the current run of non-space, then any spaces — landing
/// at the start of the next word (the common editor convention for Ctrl+Right).
pub fn next_word(text: &[u16], i: usize) -> usize {
    let len = text.len();
    let mut idx = i;
    // Skip a leading run of spaces first only if we're already on space; otherwise skip
    // the current word/punct run, then trailing spaces.
    if idx < len {
        let (c, _) = scalar_at(text, idx);
        let start_class = classify(c);
        if start_class != WordClass::Space {
            idx = skip_class(text, idx, start_class);
        }
        idx = skip_class(text, idx, WordClass::Space);
    }
    idx
}

/// Word boundary before `i`: skip a run of spaces backward, then the word/punct run —
/// landing at the start of the word to the left (Ctrl+Left).
pub fn prev_word(text: &[u16], i: usize) -> usize {
    let mut idx = i.min(text.len());
    idx = rskip_class(text, idx, WordClass::Space);
    if idx > 0 {
        let (c, _) = scalar_at(text, prev_scalar_start(text, idx));
        let class = classify(c);
        idx = rskip_class(text, idx, class);
    }
    idx
}

/// The half-open range `[start, end)` of the word-class run under `offset` — the unit a
/// double-click selects. Unlike `[prev_word..next_word]` (which, like Ctrl+Arrow motion,
/// swallows the trailing whitespace), this takes only the run *containing* the point, which is
/// the double-click convention. It reuses the same class split, so keyboard and mouse still
/// agree on what a "word" is. At a Word/non-Word boundary it prefers the touching Word run
/// (double-clicking just past a word still selects the word); on a punctuation or space run it
/// selects that run; at end-of-text it takes the run to the left.
pub fn word_at(text: &[u16], offset: usize) -> (usize, usize) {
    let len = text.len();
    if len == 0 {
        return (0, 0);
    }
    let p = offset.min(len);
    let right = (p < len).then(|| classify(scalar_at(text, p).0));
    let left = (p > 0).then(|| classify(scalar_at(text, prev_scalar_start(text, p)).0));
    // Prefer a Word run touching the caret; otherwise take the run at the caret (or, at the
    // end of the text, the run just before it).
    let class = if right == Some(WordClass::Word) || left == Some(WordClass::Word) {
        WordClass::Word
    } else {
        right.or(left).unwrap_or(WordClass::Space)
    };
    let start = rskip_class(text, p, class);
    let end = skip_class(text, p, class);
    (start, end)
}

fn skip_class(text: &[u16], mut idx: usize, class: WordClass) -> usize {
    let len = text.len();
    while idx < len {
        let (c, n) = scalar_at(text, idx);
        if classify(c) == class {
            idx += n;
        } else {
            break;
        }
    }
    idx
}

/// The start unit-index of the scalar ending just before `idx`.
fn prev_scalar_start(text: &[u16], idx: usize) -> usize {
    if idx >= 2 && (0xDC00..=0xDFFF).contains(&text[idx - 1]) && (0xD800..=0xDBFF).contains(&text[idx - 2])
    {
        idx - 2
    } else {
        idx - 1
    }
}

fn rskip_class(text: &[u16], mut idx: usize, class: WordClass) -> usize {
    while idx > 0 {
        let s = prev_scalar_start(text, idx);
        let (c, _) = scalar_at(text, s);
        if classify(c) == class {
            idx = s;
        } else {
            break;
        }
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// Walking next_boundary 0->len visits a strictly increasing boundary set, and
    /// prev_boundary from each is its predecessor — no boundary splits a surrogate.
    fn boundaries(text: &[u16]) -> Vec<usize> {
        let mut bs = vec![0];
        let mut b = 0;
        while b < text.len() {
            let nb = next_boundary(text, b);
            assert!(nb > b, "next_boundary must advance");
            // Never land between a high and low surrogate.
            if nb < text.len() {
                assert!(
                    !(0xDC00..=0xDFFF).contains(&text[nb]) || !(0xD800..=0xDBFF).contains(&text[nb - 1]),
                    "boundary {nb} splits a surrogate pair"
                );
            }
            bs.push(nb);
            b = nb;
        }
        bs
    }

    #[test]
    fn ascii_is_per_char() {
        let t = u("abc\nde");
        assert_eq!(boundaries(&t), vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn crlf_is_one_grapheme() {
        let t = u("a\r\nb");
        assert_eq!(boundaries(&t), vec![0, 1, 3, 4]);
    }

    #[test]
    fn combining_mark_joins_base() {
        // e + combining acute (U+0301) is one grapheme.
        let t = u("e\u{0301}x");
        assert_eq!(boundaries(&t), vec![0, 2, 3]);
    }

    #[test]
    fn astral_emoji_is_one_grapheme() {
        // U+1F600 is a surrogate pair = one grapheme.
        let t = u("a\u{1F600}b");
        assert_eq!(boundaries(&t), vec![0, 1, 3, 4]);
    }

    #[test]
    fn flag_is_one_grapheme() {
        // 🇯🇵 = two regional indicators (two surrogate pairs) = one grapheme.
        let t = u("\u{1F1EF}\u{1F1F5}!");
        assert_eq!(boundaries(&t), vec![0, 4, 5]);
    }

    #[test]
    fn zwj_family_is_one_grapheme() {
        // 👨‍👩‍👧 — man ZWJ woman ZWJ girl. One cluster.
        let t = u("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}.");
        let bs = boundaries(&t);
        // whole emoji then the dot
        assert_eq!(bs, vec![0, t.len() - 1, t.len()]);
    }

    #[test]
    fn prev_is_inverse_of_next() {
        let t = u("aé\u{1F600}\r\n🇯🇵z");
        let bs = boundaries(&t);
        for w in bs.windows(2) {
            assert_eq!(prev_boundary(&t, w[1]), w[0], "prev_boundary mismatch at {}", w[1]);
        }
    }

    #[test]
    fn word_motion_lands_on_word_starts() {
        let t = u("the quick  fox");
        assert_eq!(next_word(&t, 0), 4); // start of "quick"
        assert_eq!(next_word(&t, 4), 11); // skip two spaces to "fox"
        assert_eq!(prev_word(&t, 14), 11); // back to start of "fox"
        assert_eq!(prev_word(&t, 11), 4); // back to start of "quick"
    }

    #[test]
    fn word_at_selects_the_run_under_the_point() {
        let t = u("the quick  fox!!");
        // Inside "quick" (any interior offset) selects exactly "quick" — no trailing space,
        // unlike prev_word..next_word which would reach the start of "fox".
        assert_eq!(word_at(&t, 5), (4, 9));
        assert_eq!(word_at(&t, 4), (4, 9)); // at the word's leading edge
        assert_eq!(word_at(&t, 9), (4, 9)); // at the trailing edge → prefers the Word to the left
        // Inside the double space selects just the space run.
        assert_eq!(word_at(&t, 10), (9, 11));
        // On the punctuation run "!!" selects the punctuation.
        assert_eq!(word_at(&t, 15), (14, 16));
        // End of text takes the run to the left (the "!!").
        assert_eq!(word_at(&t, 16), (14, 16));
    }
}
