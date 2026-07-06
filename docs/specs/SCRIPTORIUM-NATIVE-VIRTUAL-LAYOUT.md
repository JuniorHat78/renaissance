# SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT — N5: virtualized layout

**Status: BUILT + locally validated (2026-07-06, checkpoints N5a `03ea2be` + N5b `f3808e2` + N5c
`c826b11` + this reconcile).** Part of the native-editor umbrella (`SCRIPTORIUM-NATIVE-EDITOR.md` §5
"Virtualized layout" — **promoted from `siren` to `need-now` by measurement**; §7 roadmap N5). This is
the first node whose gate was opened by a number rather than a felt problem: N3 built the retained
`IDWriteTextLayout` as the single geometry authority spanning the whole document, and N4 measured that
**rebuilding it on every edit is the editor's real scaling cliff** — 15–34× the parse cost and
*superlinear*. N5 makes the layout cost depend on the **viewport**, not the document.

**One design deviation from this spec, ledgered (umbrella §8):** §3 chose a *single windowed layout*
as the first cut, deferring per-paragraph layouts. The build went **per-paragraph, transient**
instead — lay out only the one paragraph a query/paint touches; `content-y = para_top(i) + local`.
It maps 1:1 onto the height index (one `GetMetrics` = one measured height), unifies the point-query
and draw coordinate model (no window-local offset juggling, no off-window special-casing — the
likeliest place to hide an off-by-one in a solo landmark change), and paragraphs are newline-isolated
so a standalone paragraph's geometry is identical to its geometry in a whole-doc layout — exactly what
the equivalence oracle pins. The precise edit-locality diff (§6) is **built** (N5d): a paragraph-count-
changing edit splices the height index at only the changed region and keeps every other paragraph's
measured height, so content above and below the caret does not jump. A persistent paragraph-layout cache
(build-per-query today) remains the measure-gated §3 refinement. The **"does scrolling a real manuscript
feel right" verdict is the author's.**

## 1. Why this node — the measurement that promoted it

The umbrella tagged virtualized layout a `siren` gated on "docs get long (100k lines)." The N4
latency investigation measured the actual cliff and it is **~10× closer** than that estimate, and
it is layout — not parse — that hits it. Measured on real DirectWrite (release, forced full-document
shape via `GetMetrics`, this machine), per-edit **DWrite relayout vs parse**:

| units | ~words | parse | **DWrite relayout** | ratio |
|---|---|---|---|---|
| 25K (a section) | 5K | 0.57 ms | **13.3 ms** | 23× |
| 55K | 10K | 1.3 ms | **34 ms** | 26× |
| 100K (a chapter) | 19K | 2.7 ms | **41 ms** | 15× |
| 500K (a novel, 1 MB) | 98K | 12.6 ms | **314 ms** | 25× |
| 1M | 195K | 25 ms | **851 ms** | 34× |
| 2M | 390K | 47 ms | **3,566 ms** | 76× |

Three facts set the whole design:

1. **Layout dominates by ~15–34×.** N4 correctly moved parse off-thread, but parse was never the
   bottleneck — the whole-document `IDWriteTextLayout` rebuild is. Every edit reshapes the entire
   doc (`ensure_layout` → `CreateTextLayout` O(n) copy + `GetMetrics`/`Draw` O(n) shape+break),
   and it runs *on the UI thread* (`ensure_caret_visible`, `update_scrollbar`, `draw` all force it).
2. **The cliff is at short-story scale.** Relayout crosses the 60 fps frame budget (16.67 ms) at
   **~40K units ≈ 8K words** — even the *minimum* at 55K units is 17 ms. Past a long blog post,
   typing drops frames, and it is unrelated to N4's parse cliff (~140K words).
3. **Layout is superlinear; parse is linear.** Parse holds ~23 ns/unit to 5M units. Layout's
   per-unit cost *doubles* from 500K→2M units (0.63 → 1.78 µs/unit): 1M units = 0.85 s, 2M = 3.6 s
   **per keystroke**. A single `IDWriteTextLayout` was never meant to hold a megabyte of text.

**The fix is not "move layout off-thread."** The retained layout is the geometry authority the UI
thread queries *synchronously* during input (hit-test, caret, selection) — it cannot live on a
worker the way the parse can. The fix is to **stop handing DirectWrite the whole document**: lay out
only what the viewport needs, and estimate the rest. That is virtualization.

## 2. The core idea, and the invariant it must not break

**Lay out a viewport-sized window of text, not the document.** The editor already scrolls (N3c), so
at any moment only a bounded band of text is visible; everything above and below is off-screen and
needs a *height* (for the scroll extent and coordinate math) but not a *shape*.

The invariant N3 established and N5 must preserve: **there is one geometry authority, and paint +
input never disagree about geometry.** N5 does not weaken this — it changes the authority's
*implementation* from "one whole-doc layout" to "a windowed layout + a height model," behind the
*same* geometry-service API (`hit_test_point` / `caret_xywh` / `content_height` / `line_height` /
selection ranges). The seam to `app` and `win32` (SCRIPTORIUM-NATIVE-LAYOUT.md §2) is **unchanged** —
this is the property that makes N5 a re-implementation behind `ensure_layout`, not a rewrite.

## 3. The virtualization grain — resolved

**Unit of layout = the source paragraph** (text between hard newlines), *not* the AST block. Rationale:

- **Paragraph boundaries are known synchronously and cheaply.** The rope already augments a line
  summary: `line_of_offset` / `offset_of_line` are O(log n) (N1). So "which paragraph contains
  offset X" and "where does paragraph i start" are answered without laying out or parsing.
- **Zero coupling to the async parse.** AST blocks come from `parse_document`, which is now
  off-thread and lags the live text (N4). Keying layout geometry on blocks would make geometry
  depend on a stale, asynchronously-arriving structure — a latency and correctness hazard. The
  rope's newline structure is exact and immediate. (The renderer today lays out *raw text with a
  single format* — no per-run AST styling — so paragraph-grain layout is behaviourally identical to
  what ships now. Per-block styling within a paragraph is a separate, deferred concern — §10.)
- **Edits are paragraph-local.** Typing changes one paragraph; Enter splits one into two; Backspace
  at a boundary merges two. The rope reports the new line count immediately, so the set of
  invalidated paragraphs is known without the parser.

**First cut vs refinement (the one real fork):**
- **First cut — a single *windowed* layout.** Lay out the contiguous text span covering
  `[scroll_y − margin, scroll_y + viewport + margin]` (snapped to paragraph boundaries) as **one**
  `IDWriteTextLayout`. Edit cost becomes O(viewport) — a viewport is ~40–60 wrapped lines ≈ a few
  thousand units ≈ well under 1 ms — which **alone kills the cliff**. Simplest; fewest COM objects.
- **Refinement (measure-gated) — per-paragraph cached layouts.** One retained layout per paragraph,
  built lazily on entering the window, evicted by distance, so an edit re-lays-out *only its
  paragraph* (not the whole viewport window) and scrolling reuses neighbours. Better incremental
  behaviour; more objects + eviction policy to manage.

**Decision:** build the **windowed first cut** (§12 N5a–N5c); promote to per-paragraph caching only
if a measurement shows the viewport-window rebuild itself is felt (it should not be — viewport-sized
layout is sub-millisecond). Both share the height model + coordinate map below, so the refinement is
a localized swap, not a redesign.

## 4. The coordinate model — document space from estimated heights

With no whole-doc layout, document content-space y is **synthesized** from per-paragraph heights:

```
para_top(i)      = Σ height(j) for j < i          // the y of paragraph i's top, in content space
content_height() = Σ height(j) for all j          // the scroll extent
height(j)        = measured(j)  if paragraph j has been laid out and cached
                 = estimate(j)  otherwise
```

- **`measured(j)`** — the true DIP height from `GetMetrics` on paragraph j's layout, cached the
  first (and every) time j is laid out. Correct.
- **`estimate(j)`** — a heuristic for never-yet-laid-out paragraphs: `ceil(chars(j) / chars_per_line)
  × line_height`, where `chars_per_line ≈ wrap_width / avg_char_width` (from the font metrics) and a
  minimum of one line for an empty paragraph. Cheap, O(1) per paragraph from the rope's paragraph
  length. Always an estimate a real layout later corrects.

**The height index.** `para_top(i)` and `content_height()` are prefix sums over a mutable,
insertable/deletable array of paragraph heights. Required operations, all O(log n):
- **prefix-sum(i)** → `para_top(i)` (for content→viewport transforms, scrollbar);
- **locate(y)** → the paragraph index whose span contains content-space y (for hit-testing a point);
- **update(i, h)** → replace paragraph i's height when it is measured or edited;
- **insert(i, h) / delete(i)** → Enter splits / Backspace merges change the paragraph *count*.

A fixed-size Fenwick tree gives prefix-sum + update but not insert/delete. Because paragraph count
changes, the structure is an **augmented balanced tree keyed by paragraph index carrying a
height-sum** — the *same shape as the rope* (N1), and a candidate to literally reuse the rope's
augmentation machinery (a second summary field) rather than hand-roll a new tree. Start with the
**simplest correct structure that passes the oracle** (even a `Vec<f32>` + a lazily-rebuilt prefix
sum is O(n) per edit but O(n) is fine at *paragraph* count, which is ~1 per 60 chars → 200K-word doc
≈ 3–5K paragraphs, a 5K-element scan ≈ microseconds); escalate to the aug-tree only if the
paragraph-count scan is measured to matter. (Measure before optimizing — the same discipline N4
applied to parse.)

## 5. Estimate correction & scroll-anchoring — the subtle part

Estimates are wrong; laying a paragraph out replaces its estimate with truth, which **shifts every
paragraph below it** and the total height. Handled naïvely, the visible text jumps under the reader
as they scroll into un-measured territory. Two rules:

1. **Correction is monotone toward truth.** As the user scrolls, more paragraphs get measured,
   `content_height()` converges to the real height, and the scrollbar thumb settles. Never regress a
   measured height to an estimate.
2. **Scroll-anchoring.** When a paragraph *above the viewport top* has its height corrected by `Δ`,
   add `Δ` to `scroll_y` in the same frame, so the first visible paragraph keeps its screen
   position — the content above grew/shrank, but what the reader is looking at does not move.
   Corrections *at or below* the viewport top need no anchor (they push unseen content). This is the
   classic online-height-estimation + anchoring problem the umbrella named; it is the price of not
   laying out the whole document, and it is contained entirely inside the renderer.

## 6. Edit locality — where the cliff dies

An edit's cost must be independent of document size. On `refresh()` (the synchronous UI-thread edit
step, N4):
- The rope gives the new paragraph structure immediately (line summary). Diff against the prior
  paragraph list: an in-paragraph edit touches **one** paragraph; Enter/Backspace-at-a-boundary
  touches its **two** neighbours (a split or a merge).
- Invalidate only the touched paragraphs' cached heights/layouts; `insert`/`delete`/`update` the
  height index for exactly those (O(log n)). Every untouched paragraph keeps its measured height —
  no reshape.
- The next paint lays out only the viewport window (which contains the edit, since the caret is
  visible — scroll-follows-caret, N3c). **Edit cost = O(viewport + log n)**, flat in document size:
  the 851 ms-per-keystroke at 1M units becomes the viewport-window layout (~sub-ms) plus a
  logarithmic index update.

This is where N5 cashes in N1 and N4: N1's O(log n) line summary makes paragraph structure free;
N4's off-thread parse means the (still whole-doc, still linear, now 25 ms at 200K words) parse is no
longer on the critical path, so once layout is virtualized, **nothing O(document) remains on the UI
thread's per-keystroke path.**

## 7. The seam — unchanged above `ensure_layout`

The geometry service keeps its exact N3 signature; only the body changes:
- `content_height()` → the height index total (measured+estimated), not `GetMetrics` on a whole-doc
  layout.
- `caret_xywh(offset)` → rope maps offset→paragraph i; ensure paragraph i is laid out (it is
  on/near the viewport by construction); `HitTestTextPosition` in i's local layout; add
  `para_top(i)`.
- `hit_test_point(x, y)` → `locate(y)` → paragraph i; ensure i laid out; `HitTestPoint` local;
  add i's start offset.
- selection ranges → union of per-paragraph `HitTestTextRange` over the paragraphs the selection
  spans that intersect the viewport (off-screen selection needs no geometry — it is not painted).
- `line_height()` → unchanged (font-derived / first-paragraph local).

`app` (logical, offset-only) and `win32` (`scroll_y`, `goal_x`, the conductor) do **not change** —
they already speak only through this service (N3's whole point). Vertical motion, scroll-follows-
caret, the scrollbar, mouse hit-testing, IME candidate placement all keep working because they call
the same methods.

## 8. Edges (first-class)

1. **Caret/selection off-screen** (e.g. Ctrl+End into un-measured territory) — ensure the *target*
   paragraph is laid out on demand even if outside the window; `set_caret` + scroll-follows-caret
   pull the window to it. A motion's target paragraph is always laid out before its geometry is read.
2. **A paragraph taller than the viewport** (a huge unbroken paragraph) — the window may contain a
   single paragraph; layout still bounded by that paragraph, and intra-paragraph scrolling falls out
   of the same content-space math (the paragraph's local layout spans multiple screens).
3. **Very last paragraph / document end** — `content_height()` uses the measured last-paragraph
   height once seen; the scroll clamp (N3c) stays correct as the estimate converges.
4. **Resize / DPI change** — the wrap width changes, invalidating *all* measured heights (wrapping
   differs). Drop to all-estimated and re-measure lazily as paragraphs re-enter the window; anchor
   on the top visible paragraph so a resize doesn't teleport the reader.
5. **Estimate vs truth divergence on the scrollbar** — the thumb size/position is derived from
   `content_height()`, so it visibly settles as the reader explores; acceptable and expected
   (every virtualized editor does this), bounded by anchoring so the *content* never jumps.
6. **Empty document / single empty paragraph** — one paragraph, one estimated line height; degenerate
   but not special-cased.
7. **IME composition** (N2b) — the provisional splice happens within the *caret's* paragraph layout
   (spliced into that paragraph's display text), `comp_sig` keying that paragraph's layout only.

## 9. Oracles — extending the layout-oracle discipline

Geometry stays deterministic, so the golden-geometry net (umbrella §6) extends to the virtualized
path. The headline is an **equivalence oracle**:

- **Virtualized ≡ whole-doc for documents that fit.** For a small doc laid out both ways (one
  whole-doc layout vs the paragraph/window path), `caret_xywh`, `hit_test_point`, `content_height`,
  and selection rectangles must **match within tolerance**. This is the "fearless refactor" net —
  it proves virtualization changed *cost*, not *geometry*, exactly as N4's snapshot/parse
  equivalence proved async changed timing, not result.
- **Height-index prefix sums** — `para_top(i) == Σ heights[<i]`; `locate(para_top(i)+ε) == i`;
  update/insert/delete keep the total consistent (a model-based check against a `Vec<f32>`
  reference, à la the rope's fuzz oracle).
- **Estimate convergence** — as paragraphs are measured, `content_height()` moves monotonically
  toward the true whole-doc height and never regresses.
- **Edit locality** — an in-paragraph edit invalidates exactly one paragraph's height; Enter/
  Backspace-at-boundary exactly two; nothing else's measured height changes.
- **Scroll-anchor** — correcting an above-viewport estimate by Δ leaves the first visible
  paragraph's screen y unchanged (adjust `scroll_y` by Δ).
- **Smoke (real DWrite)** — the windowed test scrolls a large synthetic document and edits within
  it, exercising the windowed layout + height index on real DirectWrite crash/leak-free, ASan-clean,
  and (the point of the whole node) **the per-edit time stays flat as the document grows** — a
  regression guard on the cliff itself, using the N4b instrumentation.

We do **not** oracle "scrolling *feels* smooth" — that is the author's half (§6 umbrella).

## 10. Scope & deferrals

**In (N5):** windowed viewport layout; the paragraph height index (measured + estimated) with
prefix-sum/locate/update/insert/delete; estimate correction + scroll-anchoring; the geometry service
re-pointed at the virtualized path with the seam unchanged; the equivalence + index + locality +
anchor oracles + a large-doc scrolling/edit smoke with a flat-per-edit-time guard.

**Out — named deferrals:**
- **Per-paragraph cached layouts + eviction** — the §3 refinement; measure-gated on whether the
  viewport-window rebuild is felt (it should not be).
- **Per-run AST styling** (headings/emphasis inside a paragraph) — the renderer is single-format
  today; when styling lands it applies *within* a paragraph layout via `SetFontWeight`/range
  attributes, and couples to the (async) AST — a separate node. N5 assumes plain-format paragraphs,
  matching current behaviour.
- **Incremental parse** — parse is off-thread (N4) and linear; at 200K words it is 25 ms on the
  worker, invisible. Reach for subtree-reuse only when a measurement shows the *worker* falling
  behind the typist — not now.
- **A worker-thread layout pass** — rejected in §1 (the layout is the synchronous input authority);
  virtualization removes the need.

## 11. Definition of done

Open a book-scale document (≥ 200K words) and type: the per-edit time is **flat and sub-frame**,
indistinguishable from typing in a one-paragraph note — the 851 ms-per-keystroke cliff is gone.
Scroll from top to bottom: the scrollbar settles as estimates resolve, and the content under the
reader never jumps (anchoring). Caret motion, selection, mouse hit-testing, and IME all behave
exactly as before (the geometry service is equivalent). The equivalence / index / locality / anchor
oracles pin the geometry; the large-doc smoke guards the flat-per-edit-time property on real
DirectWrite, ASan-clean. Then run it on a real manuscript and hand the *feel* of scrolling a long
document to the author.

## 12. Checkpoints — all BUILT

- **N5a — the paragraph height index (`03ea2be`).** `heights.rs`, un-gated + platform-free: the
  mutable prefix-sum structure (measured + estimated heights; `reset_estimated`/`measure`/`estimate`/
  `invalidate`/`insert`/`remove` + `total`/`para_top`/`locate`) + its model-based fuzz oracle (à la
  the rope's), on every CI platform, no DWrite. Landed alone (with a one-commit `dead_code` allow) so
  the coordinate math was validated before the risky COM swap.
- **N5b — the geometry-authority swap (`f3808e2`).** The whole-doc `IDWriteTextLayout` is gone;
  `content_height`/`caret_xywh`/`hit_test_content`/`display_caret_xywh`/`draw` all synthesize geometry
  from the height index + per-paragraph transient layouts (the deviation above). Measured heights fold
  in on layout so the total converges. **Headline equivalence oracle** (`virtualized_geometry_matches_
  whole_doc`) on real DWrite: per-paragraph + `para_top` caret geometry and Σ-heights content-height
  match the whole-doc layout within tolerance across every offset (wrapping paragraphs + an empty one).
- **N5c — correction, anchoring & the flat-cost guard (`c826b11`).** Scroll-anchoring (`draw` takes
  `&mut scroll_y`, pins the top visible paragraph across estimate corrections); edit stability
  (`rebuild_heights` preserves measured heights across a same-width, same-count edit — no per-keystroke
  scrollbar wobble); the large-doc smoke (8 scroll+paint cycles on a 20k-paragraph doc, flat-cost
  bound) as the cliff regression guard. Resize/DPI re-measure falls out of the width-change reset +
  anchoring. N5c's edit stability covered the **same-count** edit (typing within a paragraph); the
  **count-changing** edit still fell back to a whole-index reset, which is where N5d picks up.
- **N5d — the precise edit-locality diff (§6).** A paragraph-count-changing edit (Enter, Backspace at a
  boundary, paste) no longer resets the whole index to estimates. `rebuild_heights` keeps the previous
  per-paragraph char-lengths and, at the same wrap width, calls `HeightIndex::splice_to`, which diffs
  old vs new for a common prefix + suffix and replaces only the differing middle with estimates —
  **preserving the measured heights of every paragraph outside the edit**. The changed paragraphs (which
  hold the caret, hence on-screen) re-measure on the same paint, so nothing above or below the caret
  jumps. This closes the visible "judder" the reset caused. Built on the already-fuzzed `insert`/`remove`
  substrate; three focused `splice_to` oracles (middle split, merge, paste; + a "matches a fresh reset on
  content but keeps measured truth" check) join the height-index model fuzz, and the headline
  `virtualized_geometry_matches_whole_doc` equivalence oracle still holds. **The feel verdict on a real
  long manuscript is queued for the author.**
