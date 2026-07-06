//! The paragraph height index (SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md §4): document content-space
//! `y` synthesized from per-paragraph heights, so the editor never lays out the whole document.
//! `para_top(i) = Σ height(j<i)` and `content_height = Σ height(all)` are prefix sums over a
//! mutable, insertable/deletable array of paragraph heights — each either a **measured** DIP height
//! (`GetMetrics` on a real layout, cached) or an **estimate** (`ceil(chars / chars_per_line) ×
//! line_height`) for paragraphs not yet laid out. As the reader scrolls and paragraphs are measured,
//! the total converges monotonically to the truth (§5).
//!
//! Platform-free and **un-gated** (like `buffer`/`grapheme`/`parse`/`codec`), so the coordinate math
//! is oracled on every CI platform with no DWrite. The index stores whatever heights it is told —
//! the font-metric estimate and the DWrite measurement are the renderer's to supply (N5b); this
//! module owns only the prefix-sum algebra.
//!
//! The renderer wires `reset_estimated`/`measure`/`total`/`para_top`/`locate`/`len` into the
//! geometry service + scroll-anchoring (N5b/N5c). `invalidate`/`insert`/`remove`/`estimate`/
//! `is_measured`/`height` are the **fuzzed substrate for the deferred precise edit-locality diff**
//! (§6): N5c's edit stability uses a count-preserving heuristic in `rebuild_heights` rather than the
//! per-paragraph diff, so these operations are exercised by the model-based oracle but not yet by
//! production — hence the module-level allow (the whole structure is oracle-validated regardless).
#![allow(dead_code)]

/// A mutable prefix-sum over paragraph heights. Queries (`total`/`para_top`/`locate`) take `&mut
/// self` because the prefix cache is rebuilt lazily — a batch of mutations (e.g. measuring a
/// viewport's worth of paragraphs during one paint) costs one rebuild at the next query, not one
/// per mutation.
pub struct HeightIndex {
    /// Per-paragraph height in DIPs (measured or estimated), in document order.
    heights: Vec<f32>,
    /// Whether `heights[i]` is a real measurement (vs. an estimate). A measured height is never
    /// regressed to an estimate (§5, monotone-toward-truth).
    measured: Vec<bool>,
    /// `prefix[i] = Σ heights[..i]`, length `heights.len() + 1` — rebuilt from `heights` when
    /// `dirty`. `prefix[len]` is the total (the scroll extent).
    prefix: Vec<f32>,
    /// A mutation has invalidated `prefix`; the next query rebuilds it.
    dirty: bool,
}

impl HeightIndex {
    pub fn new() -> HeightIndex {
        HeightIndex { heights: Vec::new(), measured: Vec::new(), prefix: vec![0.0], dirty: false }
    }

    pub fn len(&self) -> usize {
        self.heights.len()
    }

    pub fn is_empty(&self) -> bool {
        self.heights.is_empty()
    }

    /// Rebuild the whole index as `char_lens.len()` all-**estimated** paragraphs (Enter/Backspace
    /// aside, this is the initial build and the resize/DPI reflow — a new wrap width invalidates
    /// every measured height, §8.4). One paragraph per entry; empties get one line via the estimate.
    pub fn reset_estimated(&mut self, char_lens: &[usize], chars_per_line: f32, line_height: f32) {
        self.heights.clear();
        self.measured.clear();
        self.heights.reserve(char_lens.len());
        self.measured.reserve(char_lens.len());
        for &chars in char_lens {
            self.heights.push(estimate_paragraph_height(chars, chars_per_line, line_height));
            self.measured.push(false);
        }
        self.dirty = true;
    }

    /// Fold in a real measured height for paragraph `i` (truth replaces the estimate, and never
    /// regresses back — §5). No-op if `i` is out of range.
    pub fn measure(&mut self, i: usize, height: f32) {
        if i < self.heights.len() {
            self.heights[i] = height;
            self.measured[i] = true;
            self.dirty = true;
        }
    }

    /// Set paragraph `i`'s **estimate**, but only while it is still unmeasured — a measured height
    /// is authoritative and must not be clobbered by a later estimate (§5).
    pub fn estimate(&mut self, i: usize, height: f32) {
        if i < self.heights.len() && !self.measured[i] {
            self.heights[i] = height;
            self.dirty = true;
        }
    }

    /// An edit touched paragraph `i`: its cached height is now unknown, so drop back to an estimate
    /// until it is re-laid-out (§6, edit locality). Forces `measured[i]` false.
    pub fn invalidate(&mut self, i: usize, estimate: f32) {
        if i < self.heights.len() {
            self.heights[i] = estimate;
            self.measured[i] = false;
            self.dirty = true;
        }
    }

    /// Insert a new **estimated** paragraph at index `i` (an Enter split adds one; §6). Clamped to
    /// the end.
    pub fn insert(&mut self, i: usize, estimate: f32) {
        let i = i.min(self.heights.len());
        self.heights.insert(i, estimate);
        self.measured.insert(i, false);
        self.dirty = true;
    }

    /// Remove paragraph `i` (a Backspace-at-a-boundary merge drops one; §6). No-op if out of range.
    pub fn remove(&mut self, i: usize) {
        if i < self.heights.len() {
            self.heights.remove(i);
            self.measured.remove(i);
            self.dirty = true;
        }
    }

    pub fn is_measured(&self, i: usize) -> bool {
        self.measured.get(i).copied().unwrap_or(false)
    }

    pub fn height(&self, i: usize) -> f32 {
        self.heights.get(i).copied().unwrap_or(0.0)
    }

    /// The scroll extent: `Σ` all paragraph heights.
    pub fn total(&mut self) -> f32 {
        self.ensure_prefix();
        *self.prefix.last().unwrap()
    }

    /// `para_top(i)` — the content-space y of paragraph `i`'s top (`Σ heights[..i]`). `i == len`
    /// returns the total (the document's bottom).
    pub fn para_top(&mut self, i: usize) -> f32 {
        self.ensure_prefix();
        self.prefix[i.min(self.heights.len())]
    }

    /// The paragraph whose vertical span `[para_top(i), para_top(i+1))` contains content-space `y`,
    /// with its top. Clamped: `y < 0` → paragraph 0; `y` past the end → the last paragraph. An empty
    /// index returns `(0, 0.0)`.
    pub fn locate(&mut self, y: f32) -> (usize, f32) {
        self.ensure_prefix();
        let n = self.heights.len();
        if n == 0 {
            return (0, 0.0);
        }
        let y = y.max(0.0);
        // `partition_point` over the sorted prefix gives the count of boundaries `<= y`; the
        // paragraph is one before that count, clamped to the last paragraph.
        let count = self.prefix.partition_point(|&p| p <= y);
        let para = count.saturating_sub(1).min(n - 1);
        (para, self.prefix[para])
    }

    fn ensure_prefix(&mut self) {
        if !self.dirty {
            return;
        }
        self.prefix.clear();
        self.prefix.reserve(self.heights.len() + 1);
        let mut acc = 0.0;
        self.prefix.push(0.0);
        for &h in &self.heights {
            acc += h;
            self.prefix.push(acc);
        }
        self.dirty = false;
    }
}

/// The estimate for a never-yet-laid-out paragraph (§4): `ceil(chars / chars_per_line) × line_height`,
/// at least one line (an empty paragraph is still a line tall). Pure — the renderer supplies
/// `chars_per_line` (`wrap_width / avg_char_width`) and `line_height` from its font metrics.
pub fn estimate_paragraph_height(chars: usize, chars_per_line: f32, line_height: f32) -> f32 {
    let cpl = chars_per_line.max(1.0);
    let lines = (chars as f32 / cpl).ceil().max(1.0);
    lines * line_height
}

// --- height-index oracles (SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md §9) -----------
// Pure prefix-sum algebra — no DWrite, no window — so the coordinate math is pinned on every CI
// platform. The headline is a model-based differential check against a `Vec<f32>` reference under a
// deterministic op fuzz, à la the rope's oracle: total / para_top / locate must agree after any
// sequence of measure/estimate/invalidate/insert/remove.
#[cfg(test)]
mod tests {
    use super::*;

    /// The reference model: a plain `Vec<f32>` of heights with the obvious O(n) prefix sums.
    struct Model {
        heights: Vec<f32>,
    }
    impl Model {
        fn total(&self) -> f32 {
            self.heights.iter().sum()
        }
        fn para_top(&self, i: usize) -> f32 {
            self.heights[..i.min(self.heights.len())].iter().sum()
        }
    }

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() <= 1e-3 * (1.0 + a.abs().max(b.abs()))
    }

    #[test]
    fn estimate_is_lines_times_height() {
        let lh = 20.0;
        assert_eq!(estimate_paragraph_height(0, 80.0, lh), 20.0, "empty paragraph = one line");
        assert_eq!(estimate_paragraph_height(1, 80.0, lh), 20.0, "a few chars = one line");
        assert_eq!(estimate_paragraph_height(80, 80.0, lh), 20.0, "exactly one line wide = one line");
        assert_eq!(estimate_paragraph_height(81, 80.0, lh), 40.0, "one over wraps to two lines");
        assert_eq!(estimate_paragraph_height(240, 80.0, lh), 60.0, "three lines");
        // A degenerate wrap width can't divide by zero.
        assert_eq!(estimate_paragraph_height(10, 0.0, lh), 200.0, "cpl clamps to >= 1");
    }

    #[test]
    fn prefix_sums_match_the_model() {
        let mut idx = HeightIndex::new();
        let lens = [10usize, 200, 0, 40, 500];
        idx.reset_estimated(&lens, 80.0, 20.0);
        let model = Model {
            heights: lens.iter().map(|&c| estimate_paragraph_height(c, 80.0, 20.0)).collect(),
        };
        assert!(approx(idx.total(), model.total()));
        for i in 0..=lens.len() {
            assert!(approx(idx.para_top(i), model.para_top(i)), "para_top({i})");
        }
    }

    #[test]
    fn locate_round_trips_to_the_paragraph() {
        let mut idx = HeightIndex::new();
        idx.reset_estimated(&[10, 200, 40, 500], 80.0, 20.0);
        for i in 0..idx.len() {
            let top = idx.para_top(i);
            // A point just inside paragraph i's span resolves back to i.
            let (found, found_top) = idx.locate(top + 0.5);
            assert_eq!(found, i, "locate inside paragraph {i}");
            assert!(approx(found_top, top));
        }
        // A y past the bottom clamps to the last paragraph; a negative y to the first.
        let past_end = idx.total() + 1000.0;
        let last = idx.len() - 1;
        assert_eq!(idx.locate(past_end).0, last);
        assert_eq!(idx.locate(-50.0).0, 0);
    }

    #[test]
    fn measured_heights_do_not_regress_to_estimates() {
        let mut idx = HeightIndex::new();
        idx.reset_estimated(&[100], 80.0, 20.0);
        idx.measure(0, 33.0);
        assert!(idx.is_measured(0));
        assert!(approx(idx.height(0), 33.0));
        // A later estimate must NOT clobber the measured truth.
        idx.estimate(0, 99.0);
        assert!(approx(idx.height(0), 33.0), "estimate must not overwrite a measured height");
        // But an explicit invalidate (an edit) drops back to the estimate.
        idx.invalidate(0, 99.0);
        assert!(!idx.is_measured(0));
        assert!(approx(idx.height(0), 99.0));
    }

    #[test]
    fn correcting_an_above_paragraph_shifts_para_top_by_the_delta() {
        // The scroll-anchor invariant (§5): measuring a paragraph *above* the anchor by a height
        // that differs from its estimate shifts `para_top(anchor)` by exactly that delta — the
        // amount the renderer nudges `scroll_y` to keep the anchor paragraph pinned on screen.
        let mut idx = HeightIndex::new();
        idx.reset_estimated(&[40, 40, 40, 40, 40], 80.0, 20.0); // each estimates to one 20-DIP line
        let anchor = 3;
        let before = idx.para_top(anchor);
        idx.measure(1, 55.0); // paragraph 1 (above the anchor) is really 55 DIP, not the 20 estimate
        let after = idx.para_top(anchor);
        assert!(
            approx(after - before, 35.0),
            "para_top(anchor) shifts by the correction delta (55 − 20)"
        );
    }

    #[test]
    fn insert_and_delete_track_the_paragraph_count() {
        let mut idx = HeightIndex::new();
        idx.reset_estimated(&[20.0 as usize, 20, 20], 80.0, 20.0);
        let before = idx.total();
        idx.insert(1, 20.0);
        assert_eq!(idx.len(), 4);
        assert!(approx(idx.total(), before + 20.0), "insert adds its height");
        idx.remove(1);
        assert_eq!(idx.len(), 3);
        assert!(approx(idx.total(), before), "remove restores the total");
    }

    #[test]
    fn model_based_fuzz_keeps_the_index_consistent() {
        // A deterministic LCG drives a random op sequence; the index must match the Vec model on
        // total + every para_top + a locate probe after each op (the rope-oracle discipline).
        let mut idx = HeightIndex::new();
        let mut model = Model { heights: Vec::new() };
        let mut rng: u64 = 0x1234_5678_9abc_def1;
        let mut next = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (rng >> 33) as u32
        };
        for _ in 0..4000 {
            let n = model.heights.len();
            let op = next() % 5;
            match op {
                // insert
                0 => {
                    let i = if n == 0 { 0 } else { (next() as usize) % (n + 1) };
                    let h = (next() % 100) as f32;
                    idx.insert(i, h);
                    model.heights.insert(i.min(n), h);
                }
                // remove
                1 if n > 0 => {
                    let i = (next() as usize) % n;
                    idx.remove(i);
                    model.heights.remove(i);
                }
                // measure
                2 if n > 0 => {
                    let i = (next() as usize) % n;
                    let h = (next() % 100) as f32;
                    idx.measure(i, h);
                    model.heights[i] = h;
                }
                // invalidate (edit → estimate)
                3 if n > 0 => {
                    let i = (next() as usize) % n;
                    let h = (next() % 100) as f32;
                    idx.invalidate(i, h);
                    model.heights[i] = h;
                }
                // estimate (only lands if unmeasured — mirror that in the model via measure state)
                4 if n > 0 => {
                    let i = (next() as usize) % n;
                    let h = (next() % 100) as f32;
                    let was_measured = idx.is_measured(i);
                    idx.estimate(i, h);
                    if !was_measured {
                        model.heights[i] = h;
                    }
                }
                _ => continue,
            }
            // Check consistency after every op.
            assert!(approx(idx.total(), model.total()), "total diverged");
            let m = model.heights.len();
            assert_eq!(idx.len(), m, "length diverged");
            if m > 0 {
                // A representative para_top + a locate round-trip (skip zero-height spans, which a
                // point can't land inside).
                let probe = (next() as usize) % m;
                assert!(approx(idx.para_top(probe), model.para_top(probe)), "para_top diverged");
                if model.heights[probe] > 0.0 {
                    let top = idx.para_top(probe);
                    assert_eq!(idx.locate(top + 0.25).0, probe, "locate diverged");
                }
            }
        }
    }
}
