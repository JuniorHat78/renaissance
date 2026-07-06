//! The Find/Replace match engine (SCRIPTORIUM-NATIVE-FIND.md §3) — the pure, platform-free
//! heart of find-mode. Given the document's UTF-16 units and a query, it produces the set of
//! match ranges the editor navigates, highlights, and replaces. No Win32, no COM, no `App`:
//! `&[u16]` in, `Range<usize>` out — so it is oracled on every platform (like `buffer`/`grapheme`/
//! `codec`), including a model-based differential fuzz against a trivially-correct reference.
//!
//! **The provider seam (§3).** Matching is expressed as one function shape,
//! `matches(haystack, query, opts) -> Vec<Range>`, so a future regex/fuzzy provider (a named
//! siren, §10) slots in behind the same signature without touching the caller. The one
//! implementation here is a literal forward scan — deliberately the simplest correct thing
//! (measure before optimizing, non-negotiable #5): a substring scan is cheaper than the parse
//! that already fits in a frame, so Two-Way / Boyer-Moore stays parked behind this interface.
//!
//! Match ranges are half-open `[start, end)` UTF-16 offsets into the same `text` the caret and
//! selection index — so a match *is* a selection with no translation.

#![cfg_attr(not(test), allow(dead_code))]

use std::ops::Range;

use crate::grapheme;

/// The two match modifiers the find bar toggles (§4). Regex is out (§10) — a hand-rolled engine
/// is its own landmark, and lives behind this same `matches` seam when it arrives.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct FindOpts {
    /// When `false`, ASCII `A`–`Z` fold to lowercase before comparison (Unicode simple fold is
    /// the named refinement — see `fold_unit`). When `true`, units compare byte-exact.
    pub case_sensitive: bool,
    /// When `true`, a match survives only if both edges sit on a word/non-word boundary — so
    /// "cat" whole-word skips "category" and "scatter" (reuses `grapheme`'s word-class authority).
    pub whole_word: bool,
}

/// Case-fold one UTF-16 unit for a case-insensitive compare. **ASCII fold only** for now
/// (§3): `A`–`Z` → `a`–`z`; everything else is identity. Unicode *simple* fold (decoding
/// surrogates, folding the scalar) is the refinement behind the same call site — a function
/// swap, not a scan rewrite. See the `unicode_fold_is_a_named_todo` oracle stub.
#[inline]
fn fold_unit(u: u16, case_sensitive: bool) -> u16 {
    if !case_sensitive && (0x41..=0x5A).contains(&u) {
        u + 0x20
    } else {
        u
    }
}

/// Whether `query` occurs in `haystack` at unit offset `i`, comparing under the case-fold in
/// `opts`. Assumes `i + query.len() <= haystack.len()`.
#[inline]
fn equals_at(haystack: &[u16], query: &[u16], i: usize, cs: bool) -> bool {
    query
        .iter()
        .enumerate()
        .all(|(k, &q)| fold_unit(haystack[i + k], cs) == fold_unit(q, cs))
}

/// Whether unit index `i` falls *between* a high surrogate (at `i-1`) and a low surrogate (at
/// `i`) — i.e., using `i` as a match edge would split an astral character. Query text is always
/// whole graphemes, but a defensive check keeps every emitted range splice-safe regardless.
#[inline]
fn splits_surrogate(text: &[u16], i: usize) -> bool {
    i > 0
        && i < text.len()
        && (0xDC00..=0xDFFF).contains(&text[i])
        && (0xD800..=0xDBFF).contains(&text[i - 1])
}

/// Whether the raw match `[s, e)` passes the whole-word filter: no word character immediately
/// before `s` and none at `e`. (Reuses `grapheme`'s word-class split, so keyboard word-motion
/// and whole-word find agree on what a "word" is.)
#[inline]
fn is_whole_word(haystack: &[u16], s: usize, e: usize) -> bool {
    !grapheme::is_word_char_before(haystack, s) && !grapheme::is_word_char_at(haystack, e)
}

/// All **non-overlapping** matches of `query` in `haystack`, left to right (§3). An empty query
/// yields no matches (not "every position") — the moment the find bar's query clears, the
/// highlight and navigation go inert. Overlapping occurrences resolve non-overlapping by
/// convention (`"aa"` in `"aaaa"` → 0 and 2), the rule that makes Replace All terminate cleanly.
/// Emitted ranges never split a surrogate pair, and — with `opts.whole_word` — sit on word
/// boundaries.
pub fn matches(haystack: &[u16], query: &[u16], opts: FindOpts) -> Vec<Range<usize>> {
    let qlen = query.len();
    let mut out = Vec::new();
    if qlen == 0 || qlen > haystack.len() {
        return out;
    }
    let last_start = haystack.len() - qlen;
    let mut i = 0;
    while i <= last_start {
        let e = i + qlen;
        let hit = !splits_surrogate(haystack, i)
            && !splits_surrogate(haystack, e)
            && equals_at(haystack, query, i, opts.case_sensitive)
            && (!opts.whole_word || is_whole_word(haystack, i, e));
        if hit {
            out.push(i..e);
            i = e; // non-overlapping: resume past this match
        } else {
            i += 1;
        }
    }
    out
}

/// The index of the first match at or after `from`, wrapping to the first match if none is
/// at/after `from` — "Find Next" over a precomputed match set. `None` only when there are no
/// matches. `from` is a unit offset (typically the caret / active-match end).
pub fn next_index(matches: &[Range<usize>], from: usize) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    Some(matches.iter().position(|m| m.start >= from).unwrap_or(0))
}

/// The index of the last match strictly before `from`, wrapping to the last match if none is
/// before `from` — "Find Previous". `None` only when there are no matches.
pub fn prev_index(matches: &[Range<usize>], from: usize) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    Some(
        matches
            .iter()
            .rposition(|m| m.start < from)
            .unwrap_or(matches.len() - 1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn ci() -> FindOpts {
        FindOpts::default()
    }
    fn cs() -> FindOpts {
        FindOpts { case_sensitive: true, whole_word: false }
    }
    fn ww() -> FindOpts {
        FindOpts { case_sensitive: false, whole_word: true }
    }

    #[test]
    fn empty_query_matches_nothing() {
        assert!(matches(&u("anything"), &u(""), ci()).is_empty());
        assert!(matches(&u(""), &u(""), ci()).is_empty());
    }

    #[test]
    fn query_longer_than_haystack_matches_nothing() {
        assert!(matches(&u("ab"), &u("abc"), ci()).is_empty());
    }

    #[test]
    fn plain_occurrences() {
        assert_eq!(matches(&u("the cat sat"), &u("at"), cs()), vec![5..7, 9..11]);
    }

    #[test]
    fn overlaps_resolve_non_overlapping() {
        // "aa" in "aaaa" -> 0 and 2, never 0/1/2 — so Replace All terminates.
        assert_eq!(matches(&u("aaaa"), &u("aa"), cs()), vec![0..2, 2..4]);
        // "aa" in "aaa" -> just 0..2 (the trailing single 'a' can't match).
        assert_eq!(matches(&u("aaa"), &u("aa"), cs()), vec![0..2]);
    }

    #[test]
    fn case_insensitive_folds_ascii_only() {
        assert_eq!(matches(&u("Cat CAT cat"), &u("cat"), ci()), vec![0..3, 4..7, 8..11]);
        // Case-sensitive sees only the exact one.
        assert_eq!(matches(&u("Cat CAT cat"), &u("cat"), cs()), vec![8..11]);
    }

    #[test]
    fn whole_word_respects_boundaries() {
        // "cat" whole-word skips "category" and "scatter", keeps the standalone word.
        let hay = u("cat category scatter cat.");
        let m = matches(&hay, &u("cat"), ww());
        assert_eq!(m, vec![0..3, 21..24]);
    }

    #[test]
    fn whole_word_at_string_edges() {
        assert_eq!(matches(&u("cat"), &u("cat"), ww()), vec![0..3]);
        assert_eq!(matches(&u("cats"), &u("cat"), ww()), Vec::<Range<usize>>::new());
    }

    #[test]
    fn matches_never_split_a_surrogate_pair() {
        // An astral emoji is two units; a query that is only its low-surrogate unit must not
        // match at the mid-pair position (the splice would be invalid).
        let hay = u("a\u{1F600}b");
        let low = vec![hay[2]]; // the low surrogate alone
        for m in matches(&hay, &low, cs()) {
            assert!(!splits_surrogate(&hay, m.start), "match started mid-surrogate");
            assert!(!splits_surrogate(&hay, m.end), "match ended mid-surrogate");
        }
        // The whole emoji matches cleanly.
        assert_eq!(matches(&hay, &u("\u{1F600}"), cs()), vec![1..3]);
    }

    #[test]
    fn next_and_prev_wrap() {
        let m = vec![2..5, 10..13, 20..23];
        // next at/after: from 0 -> first; from 6 -> second; past the last -> wrap to first.
        assert_eq!(next_index(&m, 0), Some(0));
        assert_eq!(next_index(&m, 6), Some(1));
        assert_eq!(next_index(&m, 21), Some(0)); // 21 > every start -> wrap
        // prev strictly-before: from 24 -> last; from 10 -> first (start 10 is not < 10);
        // before the first -> wrap to last.
        assert_eq!(prev_index(&m, 24), Some(2));
        assert_eq!(prev_index(&m, 10), Some(0));
        assert_eq!(prev_index(&m, 0), Some(2)); // nothing before 0 -> wrap to last
        assert_eq!(next_index(&[], 0), None);
        assert_eq!(prev_index(&[], 0), None);
    }

    #[test]
    fn unicode_fold_is_a_named_todo() {
        // ASCII fold is all F-a promises (§3). A non-ASCII case pair (Ä/ä) does NOT fold yet;
        // this pins the current contract so the day we add Unicode simple fold, this oracle
        // flips deliberately (re-blessed), not silently.
        assert!(matches(&u("Ä"), &u("ä"), ci()).is_empty());
    }

    // ---- model-based differential fuzz: the scan vs a trivially-correct reference ----

    /// A deliberately naive, obviously-correct reference (§9): test *every* start position with a
    /// plain loop, collect the ones that equal + pass the filters, then sweep left-to-right
    /// dropping any that overlap a kept one. Structured differently from `matches` (which fuses
    /// the sweep into the scan), so agreement is real signal.
    fn matches_ref(haystack: &[u16], query: &[u16], opts: FindOpts) -> Vec<Range<usize>> {
        let qlen = query.len();
        if qlen == 0 || qlen > haystack.len() {
            return Vec::new();
        }
        let mut cands = Vec::new();
        for i in 0..=haystack.len() - qlen {
            let e = i + qlen;
            let eq = (0..qlen).all(|k| {
                fold_unit(haystack[i + k], opts.case_sensitive) == fold_unit(query[k], opts.case_sensitive)
            });
            if !eq || splits_surrogate(haystack, i) || splits_surrogate(haystack, e) {
                continue;
            }
            if opts.whole_word && !is_whole_word(haystack, i, e) {
                continue;
            }
            cands.push(i..e);
        }
        // Greedy non-overlap sweep.
        let mut out: Vec<Range<usize>> = Vec::new();
        let mut wall = 0;
        for c in cands {
            if c.start >= wall {
                wall = c.end;
                out.push(c);
            }
        }
        out
    }

    /// A tiny xorshift so the fuzz is deterministic + dependency-free (same discipline as the
    /// rope/codec oracles).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn upto(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    #[test]
    fn fuzz_scan_agrees_with_reference() {
        let mut rng = Rng(0x9E3779B97F4A7C15);
        // A small alphabet with case variants + one astral char, so folding, whole-word, and
        // surrogate edges all get exercised.
        let alphabet: Vec<u16> = "aAbB \u{1F600}".encode_utf16().collect();
        for _ in 0..20_000 {
            let hlen = rng.upto(24);
            let haystack: Vec<u16> = (0..hlen).map(|_| alphabet[rng.upto(alphabet.len())]).collect();
            let qlen = 1 + rng.upto(4);
            let query: Vec<u16> = (0..qlen).map(|_| alphabet[rng.upto(alphabet.len())]).collect();
            let opts = FindOpts {
                case_sensitive: rng.next() & 1 == 0,
                whole_word: rng.next() & 1 == 0,
            };
            let got = matches(&haystack, &query, opts);
            let want = matches_ref(&haystack, &query, opts);
            assert_eq!(got, want, "haystack={haystack:?} query={query:?} opts={opts:?}");
            // Every emitted range is splice-safe and non-overlapping + ordered.
            let mut prev_end = 0;
            for m in &got {
                assert!(m.start >= prev_end, "overlap/order: {got:?}");
                assert!(!splits_surrogate(&haystack, m.start));
                assert!(!splits_surrogate(&haystack, m.end));
                prev_end = m.end;
            }
        }
    }
}
