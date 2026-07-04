# SCRIPTORIUM-NATIVE-LAYOUT — N3: layout, geometry & spatial input

**Status:** BUILT + CI-validated (2026-07-05) — N3a–N3d landed across four checkpoints; 28
geometry oracles (debug + release) + windowed smoke on real DirectWrite, ASan-clean. See the
umbrella §7/§8 for the verdict and the one spec'd deviation (`word_at` vs `prev_word..next_word`,
§4). Part of the native-editor umbrella
(`SCRIPTORIUM-NATIVE-EDITOR.md` §7 roadmap, N3). N0 gave a window + caret + paint; N1 a
persistent rope; N2a selection + grapheme/word motion + clipboard. N3 makes the editor
**spatial**: the mouse can place and drag the caret, the wheel scrolls, Up/Down move by
visual line with a sticky goal column — and all of it is driven by the *same* DirectWrite
layout the renderer already paints, so caret math is never re-implemented.

This is a deep-mechanics node (per the engineering-depth directive): the value is in the
**edges**, named here as first-class, not in the happy path. A click that lands one pixel
past the last glyph, an Up-arrow that drifts left a column each press, a drag that stops
scrolling the instant the pointer leaves the window — those are the tells that an editor
was built shallow. They are enumerated below and each is a checkpoint obligation.

## 1. Why this node

After N2 you can type and select with the keyboard, but you still can't **point**. A real
editor is a spatial instrument: you click where you mean, you drag to select, you flick the
wheel, you walk up and down columns of text. Every one of those is a *geometry* operation —
a mapping between a pixel and a text offset — and DirectWrite's `IDWriteTextLayout` already
holds the authoritative mapping (it shaped and wrapped the glyphs). The umbrella's standing
decision (§5) is to **build on that layout object** so hit-testing and caret geometry come
free; N3 is where we cash that in. The risk we accept in return is the same as every COM
node: two new vtable slots typed by hand (`HitTestPoint` 64, `GetMetrics` 60), which means
two new chances to miscount the table — guarded the same way (ABI assert + a smoke test that
*actually calls them* on real DirectWrite; the only guard that caught the `draw_text_layout`
phantom-slot AV, ledger §8).

## 2. The architectural seam (where geometry lives)

The hard design question of N3: hit-testing and Up/Down need geometry **during input
message handling** (WM_LBUTTONDOWN, WM_KEYDOWN), not just during paint. Today the layout is
ephemeral — built and dropped inside `draw()`. So:

**Decision — the layout becomes a retained, cache-invalidated COM object owned by the
Renderer, and the Renderer is the geometry authority.** It exposes a small geometry service
that both `draw()` and the input path call:

```
renderer.hit_test_point(px, py, scroll_y) -> usize        // pixel -> UTF-16 offset
renderer.caret_xywh(offset)               -> (x, y, h)    // offset -> DIP geometry (content space)
renderer.content_height()                 -> f32          // total laid-out text height (DIPs)
renderer.line_height()                    -> f32          // for wheel + Up/Down stepping
```

**The seam stays clean (umbrella §4):**
- `app` stays **logical** — it knows UTF-16 offsets, never pixels. N3 adds exactly one
  primitive to it: `set_caret(offset, extend)` (the geometry-free analogue of `move_caret`).
  Up/Down are **not** `app` motions, because "the column I want to keep" is a pixel quantity
  app must not know.
- **View-space state lives in the view layer (`WindowState`):** `scroll_y` (DIP scroll
  offset) and `goal_x` (the sticky goal column for vertical motion). Both are DIP floats;
  neither belongs in the logical model.
- **The `win32` layer orchestrates** geometry↔logical: on a click it asks the renderer for
  the offset under the pixel, then calls `app.set_caret`; on Up it asks the renderer for the
  offset one line above `goal_x`, then `app.set_caret`. `win32` is the only place that holds
  both a renderer handle and an app handle, so it is the natural conductor.

This keeps the non-negotiable — *own the text engine, don't re-implement caret math* — by
letting DWrite own the **geometry** while we own the **semantics** (what a click means, when
to scroll, how a goal column persists).

### 2.1 The layout cache & its invalidation contract

The retained layout must never be **stale** (drawn from old text) and never be **rebuilt
needlessly** (it's the per-frame cost N4 will coalesce). Invalidation key = `(content_gen,
layout_width)`:

- **`content_gen`**: a monotonic `u64` on `App`, bumped in `refresh()` on every edit. The
  renderer stores the gen its cached layout was built from; a mismatch rebuilds. This counter
  is deliberately the *same* primitive N4 needs to discard a stale off-thread parse — so N3
  introduces it now, forward-aligned, not as throwaway.
- **`layout_width`**: the wrap width in DIPs (client width − 2·padding). Changes on resize /
  DPI change. A mismatch rebuilds.
- Everything else (scroll, caret, selection) is applied at *draw/translate* time and does
  **not** invalidate the layout — scrolling or moving the caret must not re-shape text.

`ensure_layout(text, width)` is the single choke point: returns the cached pointer, rebuilding
only on key mismatch. `draw()`, `hit_test_point`, `caret_xywh`, and `content_height` all go
through it, so the input path and the paint path can never disagree about geometry.

## 3. Coordinate spaces (get this wrong and everything is subtly off)

Four spaces, and every input/output crosses them:

1. **Physical pixels, client-relative** — what `WM_LBUTTONDOWN` lParam carries
   (`GET_X_LPARAM`/`GET_Y_LPARAM`) and what the window is sized in.
2. **DIPs** — Direct2D's coordinate space at our DPI. `dip = px · 96/dpi`. The layout and
   all geometry live here.
3. **Content space** — DIPs with the document origin at the top of the *whole* text, i.e.
   *before* scroll. The layout's hit-test/caret coordinates are content-space.
4. **Viewport space** — content space translated by `−scroll_y` and offset by the padding
   origin; what's actually on glass.

The two conversions that must be exact and inverse:
- **pixel → content (hit-test input):** `content_x = px·96/dpi − PAD`, `content_y = py·96/dpi
  − PAD + scroll_y`.
- **content → pixel (caret/selection draw):** `screen = content − origin`, i.e. add `PAD`,
  subtract `scroll_y` on y.

Padding is applied symmetrically; `scroll_y` only affects y (no horizontal scroll in N3 —
text wraps to the width, ledger). Selection-rectangle and caret drawing already add `PAD`;
N3 additionally subtracts `scroll_y`.

## 4. Hit-testing — the mouse (the trailing-edge heart)

`IDWriteTextLayout::HitTestPoint(x, y, &isTrailingHit, &isInside, &metrics)` maps a
content-space point to a cluster. The **caret offset** is the subtle part:

> `offset = metrics.textPosition + (isTrailingHit ? metrics.length : 0)`

This is the trailing-edge mechanic: clicking the **right half** of a glyph places the caret
*after* it; the left half, before it. `metrics.length` is the cluster's UTF-16 length, so a
trailing hit on an astral emoji or a CRLF lands on the correct side of the *whole* cluster —
hit-testing is grapheme-correct for free because DWrite clusters match our grapheme intent
for the common cases. (Where our pragmatic UAX#29 subset and DWrite's clustering disagree on
an exotic sequence, the click follows DWrite's cluster; acceptable — the boundary fn remains
the single swap point if it ever matters.)

**The edges, each a checkpoint obligation:**
- **Click past end-of-line** (in the blank to the right of the last glyph on a wrapped/short
  line): `isInside == false`, but HitTestPoint still returns the nearest cluster — the line's
  last position, trailing → caret at line end (before the newline). Correct and free.
- **Click below the last line** (in the empty area beneath the text): DWrite clamps y to the
  last line and resolves x *within* it — far-right → line end (document end), far-left → line
  start. (Notepad-style "anywhere-below → document end" would be a deliberate special-case on
  top; we take DWrite's nearest-x-on-the-last-line, which is the honest free behavior and what
  the oracle pins.) Free.
- **Click in the left margin** (`content_x < 0`): nearest is the line-start leading edge →
  caret at line start. Free.
- **Click above the first line / negative content_y** (only reachable mid-drag with autoscroll
  or an over-scroll): clamps to position 0.
- We **honor `isTrailingHit` regardless of `isInside`** — that is what makes all four edges
  land where a user expects without special-casing each.

**Click-to-place (WM_LBUTTONDOWN):**
1. `offset = hit_test_point(px, py, scroll_y)`.
2. Shift held → `app.set_caret(offset, extend=true)` (shift-click selects anchor→click).
   Else → `app.set_caret(offset, extend=false)` (collapse + place).
3. `SetCapture(hwnd)` so the drag is tracked even when the pointer leaves the window.
4. Begin a drag: record we're selecting; `ensure_caret_visible` is **not** called on the
   initial click (clicking visible text shouldn't jolt the view).

**Drag-select (WM_MOUSEMOVE while captured & MK_LBUTTON):**
- `offset = hit_test_point(px, clamp(py, viewport), scroll_y)`; `app.set_caret(offset,
  extend=true)` (anchor fixed, caret follows the pointer).
- **Autoscroll past the edge:** if `py` is above the top or below the bottom of the viewport,
  start (or keep) an autoscroll timer (a second `SetTimer` id). Each tick: scroll one step
  toward the pointer, re-hit-test at the clamped pointer position, extend the selection. Stop
  the timer when the pointer returns in-bounds or the button is released. The clamp keeps the
  hit-test inside the viewport so the selection extends to the visible edge while the view
  catches up — the standard "drag to the bottom and the page rolls under you" feel.

**Release (WM_LBUTTONUP):** `ReleaseCapture()`, kill the autoscroll timer, end the drag.

**Double / triple click (word / line select):**
- Windows sends `WM_LBUTTONDBLCLK` for the second click (the class has `CS_DBLCLKS`... we
  don't set it; instead we track clicks ourselves to also get *triple*). We track a click
  count in `WindowState`: a click within `GetDoubleClickTime()` ms **and** within the
  `SM_CXDOUBLECLK`/`SM_CYDOUBLECLK` pixel tolerance of the previous click increments the
  count; otherwise it resets to 1.
  - count 2 → **select the word** under the point: hit-test → expand to `[prev_word..next_word]`
    (reusing `grapheme`'s word logic, the same boundaries Ctrl+Arrows use, so keyboard and
    mouse agree on what a "word" is). Set `anchor=wordStart, caret=wordEnd`.
  - count 3 → **select the line**: `[lineStart..lineEnd]` (Home/End offsets), newline excluded.
- A drag *after* a double-click extends **by word** (anchor stays at the far end of the
  original word, caret snaps to whole-word boundaries) — a refinement; the first cut may
  extend by character and the word-granular drag lands as a follow-up if time allows. Named so
  it isn't forgotten.

## 5. Vertical caret motion — Up / Down with a sticky goal column

The single most-fumbled keyboard mechanic. Naïve Up/Down re-derives x from the new line each
press and **drifts**: move up through a short line and you lose your column forever. The fix
is a **sticky goal column**:

- `goal_x: Option<f32>` in `WindowState`. It is the x (content-space DIP) the caret *aims*
  for on vertical motion.
- **Any horizontal/word/Home/End/click motion clears `goal_x`** (sets it to `None`).
- **The first Up or Down sets `goal_x`** to the caret's current x (`caret_xywh(caret).0`).
  Subsequent Up/Downs reuse it.
- Each Up/Down:
  1. `(x, y, h) = caret_xywh(caret)`; `gx = goal_x.get_or_insert(x)`.
  2. Target a point one line away: `ty = y + (down ? h : −1)` (a hair into the previous
     line for Up; into the next for Down). Using `h` (the line height from the caret's own
     metrics) makes it robust to mixed line heights.
  3. `offset = hit_test_point_content(gx, ty)` — hit-test in **content space** directly
     (a sibling of `hit_test_point` that skips the pixel→content conversion since we already
     have content coords).
  4. `app.set_caret(offset, extend=shift)`; `ensure_caret_visible`.
- **Edges:** Up on the first line → caret to document start (offset 0), goal_x preserved (so
  Down returns to the column). Down on the last line → caret to document end, goal_x preserved.
- **PageUp / PageDown:** same mechanic with `ty = y ± viewport_height`; the caret keeps
  `goal_x` and the view scrolls to follow. A natural freebie once the goal-column machinery
  exists.

## 6. Scrolling

`scroll_y: f32` (content-space DIP offset of the top of the viewport) in `WindowState`.

- **`max_scroll = max(0, content_height − viewport_height)`.** `scroll_y` is always clamped
  to `[0, max_scroll]`. When the text fits, `max_scroll == 0` and the wheel does nothing.
- **WM_MOUSEWHEEL:** wheel delta is `GET_WHEEL_DELTA_WPARAM` (signed, multiples of 120). Lines
  per notch = `SystemParametersInfoW(SPI_GETWHEELSCROLLLINES)` (default 3; the special value
  `WHEEL_PAGESCROLL` = a viewport page). High-resolution wheels/trackpads send deltas < 120,
  so we **accumulate** a fractional remainder across messages rather than truncating —
  `accum += delta; steps = accum / 120; accum %= 120;` then `scroll_y -= steps · lines ·
  line_height`. Positive delta = wheel up = scroll toward the top (content moves down).
- **Caret-follows-scroll:** the wheel moves the **view only**. The caret keeps its document
  offset and scrolls with the content — it may leave the viewport. (Standard; the caret is a
  position in the text, not on the screen.)
- **Scroll-follows-caret (`ensure_caret_visible`):** after any *caret-moving* op (arrows,
  typing, paste, click, Up/Down), if the caret's content-space y-range `[cy, cy+ch]` falls
  outside `[scroll_y, scroll_y+viewport]`, scroll minimally to reveal it: above → `scroll_y =
  cy`; below → `scroll_y = cy + ch − viewport`. Then clamp.
- **Resize:** re-clamp `scroll_y` to the new `max_scroll` (shrinking the window grows the
  content past the bottom; growing it can leave dead space below — clamp removes it).
- **Scrollbar (WS_VSCROLL):** a real vertical scrollbar via `SetScrollInfo`/`WM_VSCROLL`
  (thumb drag, track click, line/page buttons) gives honest affordance and feel. Worth doing
  for the monument; staged so the wheel + offset land first and the visible bar + `WM_VSCROLL`
  plumbing follow in the same node. If the bar slips, the wheel path stands alone and the bar
  is a small follow-up — named, not dropped.

## 7. Oracles (the layout-oracle discipline, umbrella §5/§6)

Geometry is deterministic; feel is not. N3 extends the golden-geometry net:

- **Point↔position round-trip** (real DWrite, Windows-only like the existing
  `caret_x_is_monotonic`): for a fixed string+format, for each offset, take `caret_xywh`'s
  (x,y), hit-test a point just inside that cluster, and assert it maps back to the same offset
  (modulo the trailing-edge rule at cluster boundaries). The inverse guard to caret geometry.
- **Caret-visible monotonicity:** `ensure_caret_visible` never moves `scroll_y` *away* from
  the caret, and always lands the caret within `[scroll_y, scroll_y+viewport]` when the caret
  fits; idempotent (running it twice is a no-op).
- **Scroll clamp invariants:** `scroll_y ∈ [0, max_scroll]` after every scroll/resize;
  `max_scroll == 0` ⇒ `scroll_y == 0`.
- **Goal-column stickiness** (pure-logic where possible): a sequence Up·Up·Down with a short
  middle line returns to the original column. The geometry half needs DWrite; the
  state-machine half (when `goal_x` is set vs cleared) is unit-testable without it.
- **ABI:** `hit_test_point` at slot 64·P, `get_metrics` at slot 60·P; `DWRITE_TEXT_METRICS`
  size. Asserted in `layout_tests` alongside the existing slots.
- **Smoke:** the windowed smoke test additionally drives a synthetic click (and an Up) so
  `HitTestPoint`/`GetMetrics` are *called on real DirectWrite through the real WndProc* — the
  never-been-called-slot guard, the same that caught the phantom `draw_mesh`.

We do **not** oracle "the scroll feels weighted" or "the drag-select feels right" — that's the
human half of the feel-loop (umbrella §6).

## 8. Scope & deferrals

**In (N3):** retained layout cache + geometry service; mouse click-to-place with trailing-edge
correctness and all four out-of-bounds edges; drag-select with SetCapture + autoscroll;
double-click word / triple-click line; Up/Down/PageUp/PageDown with sticky goal column; wheel
scrolling with fractional accumulation + clamp; caret-follows-scroll & scroll-follows-caret;
the vertical scrollbar; the geometry oracle extensions + smoke coverage.

**Deferred (named):**
- **Horizontal scrolling.** Text wraps to width today; no h-scroll until/unless we add a
  no-wrap mode. Not now.
- **Word-granular drag after double-click** — the refinement in §4; lands if time allows,
  named otherwise.
- **Virtualized layout** (lay out only the viewport). The retained layout is whole-document;
  `prev_boundary`'s O(offset) walk and a whole-doc layout are both fine at section scale and
  both become felt only on a novel-length doc — that's the same `siren` measure-gate
  (umbrella §5), tripped together, not now.
- **Middle-click / selection clipboard, smooth (sub-line animated) scrolling, momentum** —
  feel refinements for the loop, not correctness.

## 9. Definition of done

Click anywhere — including past the end of a line, below the last line, in the margin — and
the caret lands where you pointed; drag to select, drag past the edge and the page scrolls
under you; double-click a word and triple-click a line; walk Up and Down through ragged lines
without losing your column; flick the wheel and the text scrolls smoothly and clamps at both
ends; type at the bottom and the view follows the caret. The geometry oracle + smoke pass in
debug and release on real DirectWrite. Then **run it** and start reacting to the feel
(weight, blink, scroll speed) — the half that can only be discovered, not specced.
