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
use crate::minedit::MiniEdit;

/// Where the keyboard goes while the find bar is open (§4). The bar is **non-modal**: it can be
/// open with focus still in the `Document` (you keep typing/undoing in your text, the bar floating
/// over it), or in one of its two fields. Tab toggles the two fields; a click or Ctrl+F moves focus
/// into the bar; a click in the document (or Esc) returns it to `Document`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Focus {
    Document,
    Query,
    Replace,
}

/// The live state of an open find session (§4/§7): the query + replace fields, the options, and a
/// **cached match set keyed on `(content_gen, query, opts)`** — recomputed lazily exactly like the
/// N3 layout cache, so a stale set is never navigated. `App` owns one of these as `Option<FindState>`
/// (`None` ⇒ find-mode closed). Platform-free: it holds no COM and drives no OS — the caret it
/// moves is applied by `App`, the highlight it lists is drawn by `render`.
pub struct FindState {
    pub query: MiniEdit,
    pub replace: MiniEdit,
    pub opts: FindOpts,
    /// Ctrl+H opens with the replace field shown; Ctrl+F without it.
    pub replace_visible: bool,
    pub focus: Focus,
    /// The last navigation wrapped past an end — the quiet flash affordance (§5), read + cleared
    /// by the renderer.
    pub wrapped: bool,
    // ---- the match cache (keyed like the layout cache) ----
    cache: Vec<Range<usize>>,
    cache_gen: u64,
    cache_query: Vec<u16>,
    cache_opts: FindOpts,
    cache_valid: bool,
    /// Index into `cache` of the active match (the one the next Enter/Replace acts on). Only
    /// meaningful when `cache` is non-empty; preserved by offset across a recompute.
    active: usize,
}

impl FindState {
    /// Open a session, seeding the query from the document selection (`seed`) — the universal
    /// "select a word, Ctrl+F, it's pre-filled and selected" affordance (§4).
    pub fn open(seed: &[u16], replace_visible: bool) -> FindState {
        FindState {
            query: MiniEdit::seeded(seed),
            replace: MiniEdit::new(),
            opts: FindOpts::default(),
            replace_visible,
            focus: Focus::Query,
            wrapped: false,
            cache: Vec::new(),
            cache_gen: 0,
            cache_query: Vec::new(),
            cache_opts: FindOpts::default(),
            cache_valid: false,
            active: 0,
        }
    }

    /// The field that currently has focus (for routing input + drawing the caret). `Document` has
    /// no field; callers gate field edits on `field_focused()` first, so it defaults to the query
    /// field here rather than panicking.
    pub fn focused(&mut self) -> &mut MiniEdit {
        match self.focus {
            Focus::Replace => &mut self.replace,
            _ => &mut self.query,
        }
    }

    /// Is a bar *field* focused (vs. the document)? Gates keyboard routing: when false, keystrokes
    /// go to the document even though the bar is open.
    pub fn field_focused(&self) -> bool {
        self.focus != Focus::Document
    }

    /// Recompute the match set if `(content_gen, query, opts)` changed since last time — the lazy,
    /// keyed rebuild (§3). Preserves the active match **by offset** (stay on the same spot as the
    /// set shifts under an edit) rather than by raw index.
    pub fn ensure(&mut self, text: &[u16], content_gen: u64) {
        if self.cache_valid
            && self.cache_gen == content_gen
            && self.cache_opts == self.opts
            && self.cache_query == self.query.text()
        {
            return;
        }
        let old_start = self.cache.get(self.active).map(|r| r.start);
        self.cache = matches(text, self.query.text(), self.opts);
        self.cache_gen = content_gen;
        self.cache_opts = self.opts;
        self.cache_query = self.query.text().to_vec();
        self.cache_valid = true;
        self.active = match old_start {
            Some(o) => self.cache.iter().position(|m| m.start >= o).unwrap_or(0),
            None => 0,
        };
        if self.active >= self.cache.len() {
            self.active = 0;
        }
    }

    /// Mark the cache stale (e.g. after a document edit) so the next `ensure` rebuilds.
    pub fn invalidate(&mut self) {
        self.cache_valid = false;
    }

    pub fn match_count(&self) -> usize {
        self.cache.len()
    }
    pub fn matches(&self) -> &[Range<usize>] {
        &self.cache
    }
    /// The active match's index (`1`-based display is `active_ordinal`), or `None` when empty.
    pub fn active(&self) -> Option<usize> {
        (!self.cache.is_empty()).then_some(self.active)
    }
    /// The active match's range, or `None` when there are no matches.
    pub fn active_range(&self) -> Option<Range<usize>> {
        self.cache.get(self.active).cloned()
    }
    /// The `1`-based ordinal of the active match for the `N / M` counter (`0` when empty).
    pub fn active_ordinal(&self) -> usize {
        if self.cache.is_empty() {
            0
        } else {
            self.active + 1
        }
    }

    /// Seed the active match to the first one at/after `from` (the document caret) — used on open
    /// so the first shown match is where the reader is, not the top of the document (§4).
    pub fn seek_from(&mut self, text: &[u16], content_gen: u64, from: usize) {
        self.ensure(text, content_gen);
        if let Some(i) = next_index(&self.cache, from) {
            self.active = i;
        }
        self.wrapped = false;
    }

    /// Advance to the next match, wrapping (Enter / F3). Sets `wrapped` when it passes the end.
    pub fn next(&mut self, text: &[u16], content_gen: u64) {
        self.ensure(text, content_gen);
        let n = self.cache.len();
        if n == 0 {
            return;
        }
        let nx = (self.active + 1) % n;
        self.wrapped = nx <= self.active;
        self.active = nx;
    }

    /// Retreat to the previous match, wrapping (Shift+Enter / Shift+F3).
    pub fn prev(&mut self, text: &[u16], content_gen: u64) {
        self.ensure(text, content_gen);
        let n = self.cache.len();
        if n == 0 {
            return;
        }
        let pv = if self.active == 0 { n - 1 } else { self.active - 1 };
        self.wrapped = pv >= self.active;
        self.active = pv;
    }
}

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

    // ---- FindState: the stateful find-mode core ----

    #[test]
    fn findstate_seeds_query_and_seeks_from_caret() {
        let text = u("cat dog cat bird cat");
        let mut fs = FindState::open(&u("cat"), false);
        // Caret at 5 (inside "dog"): the first match at/after is the one at 8.
        fs.seek_from(&text, 1, 5);
        assert_eq!(fs.match_count(), 3);
        assert_eq!(fs.active_range(), Some(8..11));
        assert_eq!(fs.active_ordinal(), 2); // "2 / 3"
    }

    #[test]
    fn findstate_next_prev_wrap() {
        let text = u("a a a"); // matches at 0, 2, 4
        let mut fs = FindState::open(&u("a"), false);
        fs.seek_from(&text, 1, 0); // active = 0
        assert_eq!(fs.active_range(), Some(0..1));
        fs.next(&text, 1);
        assert_eq!(fs.active_range(), Some(2..3));
        assert!(!fs.wrapped);
        fs.next(&text, 1);
        assert_eq!(fs.active_range(), Some(4..5));
        fs.next(&text, 1); // wrap
        assert_eq!(fs.active_range(), Some(0..1));
        assert!(fs.wrapped);
        fs.prev(&text, 1); // wrap back to last
        assert_eq!(fs.active_range(), Some(4..5));
        assert!(fs.wrapped);
    }

    #[test]
    fn findstate_cache_is_keyed_and_lazy() {
        let text = u("xx xx");
        let mut fs = FindState::open(&u("xx"), false);
        fs.ensure(&text, 1);
        assert_eq!(fs.match_count(), 2);
        // Same key -> no rebuild would change anything; count stays.
        fs.ensure(&text, 1);
        assert_eq!(fs.match_count(), 2);
        // Change opts -> rebuild (whole-word now excludes... still both are whole words here).
        fs.opts.whole_word = true;
        fs.ensure(&text, 1);
        assert_eq!(fs.match_count(), 2);
        // Empty the query -> no matches.
        fs.query.clear();
        fs.ensure(&text, 1);
        assert_eq!(fs.match_count(), 0);
        assert_eq!(fs.active(), None);
        assert_eq!(fs.active_ordinal(), 0);
    }

    #[test]
    fn findstate_preserves_active_by_offset_across_recompute() {
        // Active on the 3rd "cat" (offset 8); a content bump that keeps the same matches must
        // keep us on the match at offset 8, not snap to index 0.
        let text = u("cat cat cat");
        let mut fs = FindState::open(&u("cat"), false);
        fs.seek_from(&text, 1, 8); // active = match at 8 (index 2)
        assert_eq!(fs.active_range(), Some(8..11));
        // A new generation with an unchanged match set: preserve by offset.
        fs.ensure(&text, 2);
        assert_eq!(fs.active_range(), Some(8..11));
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
