# Transition And Spotlight Sprint

This is the live working document for the Renaissance interaction hardening
sprint. It exists so the transition work is not treated as incidental polish and
so future Codex sessions can recover the taste bar, safety rules, workflow, and
open decisions without guessing from scattered chat context.

The document should change as the sprint teaches us more. It is a compass, not a
contract. Prefer updating notes and checklists over silently carrying new
assumptions in an agent thread.

---

## State Of The Project (LIVE — update every session)

> This block is the dashboard. Read it first; keep it current. When you finish a
> thread, move it from **Up next** to **Shipped** and re-point **Working on now**.
> Detail lives in the dated sections below — this is just the at-a-glance state.

**Last updated:** 2026-06-16 · **Branch:** `sprint/transition-spotlight-oracle`
(open as draft PR #12; pushes auto-run CI + Manual Checks full-chromium +
A11y + CodeQL) · **Main:** `main`.

**One-line status:** The oracle search system, the continuity transition (words
fly from a search result into the reader), and an honest **reading-attention
progress model** are now built and standalone-green. The reader is being turned
into a "reading instrument." Next concrete build is **advanced search**.

**Shipped & green on Actions:**
- Oracle search end-to-end — Spotlight, full `/search`, essay-inline, home/archive
  inline all route through one ranking truth (`search-oracle.js` +
  `oracle-client.js`).
- **Continuity transition** (`continuity.js`) — clicked `<mark>` words FLIP into
  the reader's highlight; fallbacks airtight; reduced-motion safe.
- **Composed arrival** — graceful out + paper veil + content-gated reveal, so the
  flight is wrapped in a seamless navigation (no lock-up flash). `revealMode`
  is `"composed"`; reveal fires `renaissance:page-revealed`.
- Selection copy-chip anchors to the selection's end (was pinning above
  multi-line highlights).

**Shipped & standalone-green (Actions browser-tier confirmation pending):**
- **Reading-attention progress model** — `scripts/reading-attention.js` is a
  pure, DOM-free, dual-export core (unit-tested with synthetic tick streams in
  `reading-attention-regression.js`): per-paragraph dwell vs word-count-derived
  expected time, gated by velocity / reading-zone overlap / presence; outputs
  `progress` (read words / total), `furthestRead`, `frontier`. `reading-state.js`
  persists `attentionProgress` + a compact read-set (+ partial dwell), with
  monotonicity and attention-based completion (scroll-to-end no longer completes
  a section); covered server-free by the new `reading-state-unit-regression.js`.
  A ~250ms heartbeat in `section.js` samples zone/velocity/presence and feeds
  ticks; `archive.js`/`essay.js` show the attention number, falling back to
  scroll progress for legacy records. Visual bar stays scroll-position by design.
  Commits `85b4e46`, `b35a1f3`, `7d6c758`.

**Working on now:** nothing in-flight (clean tree). Two follow-ups are open: the
**`section.js` split is now OVERDUE** — the attention core pushed section.html
past the 336KB ceiling continuity had declared final, so the budget was raised
to 352KB and must not grow again before the split — and the reading-attention
**feel pass** (tune `WPM`/`READ_FRACTION`/velocity thresholds in the live reader;
the math is proven, the constants are taste calls).

**Up next (in order):**
1. **Advanced search** — keep the curated default (a couple per section); add an
   exhaustive "show everything" mode (uncapped `perSection`/limit, per-section
   counts, the oracle's self-explaining ranking reasons). Reuse the hidden
   `advancedToggle`. See **Advanced Search Plan** below.
2. **A-phase headline: soft-navigation + magic texture** — the residual
   "tinge of lock-up" is the hard document navigation; the ethereal fix is
   soft-nav (fetch + swap, no reload), which also dovetails with the AST
   compiler and makes continuity same-document-trivial. Bundle the magic-texture
   polish (true spring, veil dissolve, word shimmer, depth) with it. See
   **A-Phase** below.
3. Then the rest of the reading-instrument arc: AST compiler (A), bespoke
   typesetting (B-feel), literary apparatus/concordance (C). See **Sprint
   Direction: The Reading Instrument**.

**Known cuts / decisions:** editorial apparatus (footnotes/sidenotes) is OUT
(essays are continuous prose); never fabricate apparatus; per-passage search
results (not per-occurrence); custom FLIP not native View Transitions (Firefox).

**Process (also in agent memory):** validate on Actions, not the laptop — push
and read the run rather than running local browser suites. Conventional commits,
no Claude attribution. Talk before executing big calls. Site deploys under
`/renaissance/` (relative links). Run `node scripts/generate-cache-version.js`
after changing any precached asset.

---

## Live Document Rules

This file is a working control room for the sprint. Keep it current enough that
a new session can resume without chat history.

Update this document when:

- a phase starts or ends;
- a test suite is added;
- a GitHub Actions run gives meaningful signal;
- a visual/video/trace artifact is reviewed;
- a transition motif is accepted or rejected;
- ranking behavior changes;
- anchor URL grammar changes;
- generated artifact shape changes;
- a downstream system is replaced;
- a risk becomes real;
- a scope item is deferred;
- a decision would otherwise live only in memory.

Do not update this document for every tiny edit. Update it when the sprint's
map, evidence, or decision record changes.

### Resume Protocol

At the start of a new work session:

1. Read `Live Findings`.
2. Read `Open Decisions`.
3. Read `Active Phase Journal`.
4. Check `Current Sprint State`.
5. Check the latest git status and branch.
6. Check recent relevant GitHub Actions runs.
7. Continue from the next unchecked phase item unless the user redirects.

### Evidence Standard

For subjective UX work, record what was reviewed. "Tests passed" is not enough
when the question is motion, feel, ranking quality, or visual polish.

Useful evidence records include:

- run id;
- suite name;
- branch/ref;
- artifact names;
- route/query tested;
- viewport/theme/motion mode;
- what felt good;
- what felt wrong;
- decision;
- follow-up.

### Current Sprint State

- Status: implementation underway and non-linear. Phase 1 evidence harness
  landed; Phase 3, 6, and 8 each have a first production checkpoint. Phases 2,
  4, 5, and 7 have not been worked as discrete phases yet.
- Current branch: `sprint/transition-spotlight-oracle` (8 commits ahead of
  `main`, pushed and in sync).
- Implementation started: yes. Product behavior has changed (Spotlight launcher,
  AST passage anchor routing, section transition warmup) — this is past
  evidence-only.
- Landed since the docs contract (commits after `b187651`):
  - `a2878f6` — transition evidence suite (`test:transition-evidence`,
    `ci:transition-evidence`, Manual Checks wiring). Phase 1.
  - `524a9ab` — section transition warmup hardening in `scripts/section.js`.
    Phase 3 (partial).
  - `2a62156` — search hits routed through AST passage anchors
    (`scripts/ast/index.js`, `search-engine.js`, `router.js`, reader
    resolution, `anchor-regression.js`). Phase 6 (partial).
  - `781bd7b` — Spotlight launcher (`scripts/spotlight.js`, 603 lines;
    `spotlight-regression.js`; wired into all four runtime pages). Phase 8
    (partial).
  - `7302522` — stabilize Spotlight regression waits. Phase 8.
- Phase 5 substantially done (2026-06-15): `data/search-index.json` is generated
  from the AST with per-term passage-frequency stats; `scripts/search-oracle.js`
  ranks it via composable idf-weighted signals (intent parsing, importance gate,
  section-title affinity, blockType/context boosts) where a result's score is
  the sum of its reasons. A curated `data/search-lexicon.json` seam adds synonym
  boosting. Guarded by `test:search-index`, `test:search-oracle`,
  `test:search-lexicon` (all in the standalone gate) and a 512KB size budget.
- Phase 6/8 progress: Spotlight now searches via the oracle + generated index
  (runtime engine retained as offline/fetch-fail fallback), with passage-range
  deep links for precise reader highlighting. Validated green on Actions:
  `spotlight`, `browser`, `pwa`, `a11y`.
- Phase 6 search-surface migration COMPLETE (2026-06-16): every search surface
  (Spotlight, full `/search` page, essay inline, home/archive inline) routes
  through the shared `oracle-client.js` -> `search-oracle.js`. Full search went
  oracle-simple: modes/sort/page-size/counts/pagination dropped, one flat ranked
  list. Browser suites that asserted the old `.result-card` DOM updated to
  `.oracle-result` (a11y, device-matrix, cross-browser, transition-evidence).
  Local standalone green; needs Actions confirmation for the browser tier.
- PARKED for next session: drop the legacy runtime search engine + the
  file://-offline fallback branches entirely (oracle-only). The fallback only
  protects file:// usage, which production (GitHub Pages https) never hits and
  local dev covers with `npm run dev`. Own dedicated commit so the regression
  suites show exactly what the removal breaks. Keep the dual-export
  (Node+browser) pattern — that buys no-build testing, not baggage.
- Not yet done: Phase 2 transition prototypes (no recorded variants), Phase 4
  critique/beta pass, the deferred lexicon build (match-creation + more motif
  easter eggs beyond the shipped "sand" card + essay aliases), Phase 7 Spotlight
  design spec capture, legacy-engine purge (above).
- Docs committed: yes. This document had drifted behind the code and was
  reconciled on 2026-06-15 — see the dated Live Findings note.
- Branch pushed: yes, tracking `origin/sprint/transition-spotlight-oracle`.
- Latest remote runs: Manual Checks suites passed on the sprint branch on
  2026-06-15 (runs `27506490802`–`27506555991`); earlier docs-contract run
  `27505347555` passed on `b187651`.
- Next recommended action (2026-06-16): confirm the search-migration commits
  go green on the Actions browser/full-chromium tier, then take the parked
  legacy-engine purge as its own clean commit. After that, Phase 2/4 transition
  evidence and the deferred lexicon build are the remaining open threads.

### Active Phase Journal

Use this section during implementation. Move completed phase notes into
`Live Findings` when the phase closes.

```text
Phase: 3/6/8 - Production hardening in progress (non-linear)
Started: 2026-06-15
Goal: ship hardened transitions, route reader/search through AST passage
anchors, and stand up the Spotlight launcher on top.
Current focus: the evidence harness (Phase 1) and three production
checkpoints have landed; the next session should reconcile which audited
navigation paths the shipped warmup/anchor/Spotlight work actually covers and
decide between closing Phase 3 or opening Phase 5 (generated oracle index).
Latest run/artifact: Manual Checks suites passed on the sprint branch on
2026-06-15 (runs 27506490802-27506555991).
Blockers: none. Subagents unavailable this session (account/usage limits).
Next action: record Phase 2/4 motif evidence for the transition language that
already shipped, then start the generated oracle search index (Phase 5) so
Spotlight is not riding on runtime search.
```

## Sprint Direction: The Reading Instrument (2026-06-16)

### Thesis

The remaining sprint is no longer "finish a search box." It is to finish a
**hand-built reading instrument**. The search system is done and oracle-native
end to end (Spotlight, full `/search`, essay inline, home/archive inline — one
ranking truth, one look, green on Actions). What's left is the layer that makes
*reading itself* feel inevitable: a continuity motion that carries the reader
from a search result into the prose, a compiler that makes the reader instant
and authoritative, book-grade typesetting to rest the eye in, and a literary
apparatus that orbits the essay. Guiding ethos (from the author, verbatim in
spirit): **always do the harder thing when it is more beautiful, never when it
is merely noisy; not afraid of more code or custom systems as long as they
serve a beautiful purpose and aren't hackneyed in themselves; 200% or nothing.**

A unifying property disciplines everything below: **nothing inline ever
interrupts the reading.** Each piece either *smooths* the reading (continuity,
the compiler) or *surrounds* it (typesetting beautifies the page; the apparatus
lives in a separate contemplative surface). This is why **editorial apparatus
(footnotes/sidenotes) is explicitly rejected** — an essay is continuous argued
prose; margin-notes fracture attention and belong to reference works, not
essays. We will also **never fabricate apparatus** (invented footnotes,
manufactured "scholarly" notes): everything is either *computed from the text*
or *authored by a human*, never invented to look richer.

### Centerpiece: the continuity transition (search result -> reader)

**The soul.** The shared element is **the words, not the card.** The clicked
result shows a `<mark>`ed phrase; the identical substring exists in the reader.
On click, *that phrase physically travels and lands on itself in the paragraph.*
Card-grows-into-detail is the hackneyed framework-demo version (the card is a
generic container); words-travel is specific to a site about text, which is why
it clears the "not hackneyed in itself" bar. The illusion holds because the
matched string is literally identical in both places.

**What's already paved (~70%).** `scripts/page-transition.js` already solves the
hard multi-page (non-SPA) problem of carrying state across a hard document
navigation:

- Source capture: `markSourceAnchor` reads the clicked anchor's
  `getBoundingClientRect`, computes a center point, stashes
  `{motion, sourceX, sourceY, createdAt}` in `sessionStorage` (`STORAGE_KEY`).
- Cross-document handoff with freshness: `readIncomingMotion` reads it on
  arrival, age-gates via `STORED_MOTION_MAX_AGE_MS`, sets `--page-source-x/y`,
  flags `data-page-arrival="navigation"`.
- Reveal choreography (`page-transition-prep/out/ready`), reduced-motion path,
  bfcache `pageshow` handling.
- **Prefetch-on-intent already exists** (`maybePrefetch` on `pointerdown` +
  `focusin`) — the destination is usually warm before the click, which is what
  makes a flight viable instead of janky.

Today that payload carries a *point* and runs a generic directional flourish.
Continuity = **enrich the payload from a point to the mark's rect + text +
type-style + passage identity, and replace the generic flourish with a real
FLIP flight.** It is an evolution of this system, not a parallel one.

**Decisive constraint — custom FLIP, not the View Transitions API.** The author
uses Firefox, where cross-document (MPA) View Transitions are not reliably
available (as of 2026-06). Leaning on native VT would silently break the effect
for the one person judging it, and native VT also gives less art-direction over
the font tween + cross-fade. So the implementation is a **hand-built FLIP**,
identical across browsers. Native VT is, at most, an optional later turbocharger
— and we will *not* mix mechanisms, because two mechanisms = two subtly
different feels = the least-Apple outcome.

**Locked taste calls** (resolved via "harder when more beautiful, never when
noisy"):

- **FLIP on the real mark, not a ghost clone.** The actual rendered words move —
  no clone seam, no cross-fade fudge. The reflow risk is not a reason to dodge
  it; it's the 200% tax: contain the moving element in its own layer / reserve
  its space so the surrounding paragraph never twitches.
- **Only the words travel.** A trailing card-echo is the noise; killed.
- **Luxe, spring-eased (~480ms).** Snapping is for utilities; settling *into*
  text is for reading. The craft is tuning a spring that feels inevitable, not
  floaty.

**Anatomy (FLIP across a navigation):**

1. FIRST / capture (search page, on click): measure the result's `<mark>` rect;
   capture its text + computed font/size/color; capture passage identity
   (already in href). Enrich the existing sessionStorage payload.
2. Leave: existing out-choreography — the list recedes, the clicked words hold.
3. Handoff: existing sessionStorage + age gate.
4. LAST / INVERT / PLAY (reader): build section -> highlight passage (existing
   deep-link machinery) -> **scroll it to the reading sightline** -> measure
   destination mark rect (LAST) -> place the real mark at the source rect
   (INVERT) -> animate to home, tweening position + scale + color (PLAY) ->
   settle into the real highlight -> clean up.

**The 200% hard problems (where half-assing shows):**

- **Scroll-then-measure ordering.** The reader scrolls the highlight to
  `innerHeight * 0.36` (pinned by `anchor-regression`). Measure LAST *after*
  that scroll, or the words land where the text *was* and snap.
- **Reveal-hold without a double-highlight flash.** Current reveal is
  `"immediate"` for tap-latency; continuity needs a new arrival mode where the
  paragraph paints but the highlight's *final settle* arrives via the flight,
  with no FOUC where the real `<mark>` flashes before the words land.
- **Font tween.** Snippet sans -> reader serif, different size. `font-size`
  isn't transformable: scale + cross-fade family. Pixel-accurate or it reads as
  a slide.
- **FLIP-on-real reflow containment.** Move the mark in a layer / reserve its
  footprint so surrounding prose stays still.
- **Fallback safety.** Direct nav, new tab, stale/mismatched/missing payload ->
  fall straight through to the plain highlighted landing. The deep-link
  highlight is the *guarantee*; the flight is *enhancement*; it must never be
  load-bearing.
- **Reduced motion + a11y.** Under `reduce`: no flight, instant highlighted
  landing. Anything decorative is `aria-hidden`; focus management unchanged.

**The keystone insight (sequencing):** Continuity hooks into exactly one seam —
*the moment the reader has highlighted a passage and knows its on-screen rect.*
Building continuity first **forces that seam to be a stable contract**: the
reader emits *"highlight settled at rect X."* When the compiler (A, below) later
rebuilds the reader internals, its job is to *honor that contract*. So the
centerpiece is built first not recklessly but deliberately: **the centerpiece
writes the spec the foundation must preserve.**

**Cost we accept now.** `section.html` is ~312KB against its 320KB asset budget
— the page that already absorbed two cross-page features. Continuity lands here
too. Decision: **do not let the byte-budget veto the centerpiece** — bump the
gate when continuity lands and book the real `section.js` split as a deliberate
refactor immediately after (the budget comment already says "split rather than
grow again"). Continuity is therefore two pieces of work: the effect, and the
split that earns its room. It also needs its own `continuity-regression.js`
(ghost/flight appears, lands on target within tolerance, fallbacks hold,
reduced-motion skips).

### Sub-projects (projects-within-the-project)

Sorted by the axis that matters to the author: **derived (computes itself, ~zero
human labor) vs authored (needs a pen).**

**A) AST compiler — promote the AST from runtime parser to build-time
compiler.** *Derived; zero authoring.* Today the AST parses in the browser on
every section load (`content.js`: `parseDocument -> withoutLeadingHeadings ->
astToLegacyBlocks / toSearchableText / passagesFromDocument`). The sub-project
makes it a build-time compiler emitting finished, hydratable content + an
authoritative passage map. Payoff: total control over rendered output; the
client parser stops shipping (speed + asset budget); and it **dissolves the
entire passage-alignment bug class** (no more "does the client parse match the
index?"). This is the legitimate form of the "custom AST" itch — an *elevation*
of the existing, fixtured toolchain (`ast:doctor/fixtures/corpus/compare/explain
/tree`), not a from-scratch rewrite (which would be hackneyed-in-itself). Human
cost: taste-review of render parity only. This is also where caching becomes
Apple-clean: artifacts derived at the deploy build, not committed and nagged
about.

**B-feel) Bespoke typesetting (algorithmic only).** *Derived; zero authoring.*
Rules applied to existing text: optical margins, hanging punctuation, ligatures,
small-caps, drop-caps, widow/orphan control, and beautifully set
headings/lists/**pull-quotes** (note: `PULL_QUOTE` is already an authored block
type in the source, so it typesets for free). The compiler (A) makes per-passage
typographic rules clean. **The editorial half of typography
(footnotes/sidenotes) is cut** per the thesis above.

**C) Literary apparatus / concordance.** *Derived; near-zero authoring — highest
magic-to-effort ratio on the board.* A concordance is *computed*, not authored:
every occurrence of a motif word across the essay, rarity (idf already exists
for the oracle), co-occurrence, thematic threads, a generated index. The shipped
"sand" motif card is the seed; this is the tree. Only human input: thumbs-up
/down on an auto-seeded motif shortlist (frequency/idf gated, exactly like the
existing motif card). **Open question (decide when we get there): where C lives
— a dedicated index/concordance surface, or woven into the existing motif
card.** Risk is taste-calibration (don't surface junk words), not labor.

### Sequence & banked hygiene

Order: **continuity (centerpiece, defines the contract) -> A (compiler, honors
it) -> B-feel (rides A) -> C (orbits the corpus).** Bank these as cheap hygiene
whenever convenient, not as gates:

- **Legacy-engine purge** (parked, scoped). `window.RenaissanceSearch` is
  **double-duty**: ranking engine (deletable) + the reader's highlight utilities
  (`findOccurrencesInText`, `highlightSnippet`, `normalizeMode`, used by
  `section.js` and `anchor-regression`). Purge only the ranking engine + the
  four oracle-fallback branches; **keep the highlight kit.** Own commit. ~1-2h.
- **Auto-caching.** Apple answer is **derive-at-deploy** (artifacts as build
  output, gitignored, always fresh), which folds into A. The CI
  **generator-bot** (run generators, commit refreshed artifacts back) is the
  pragmatic fallback if the nag needs killing sooner — but it's the engineer's
  answer, not the designer's.
- **CodeQL.** One open alert: `js/trivial-conditional` at `section.js:2013`.
  **Not a bug** — the sole caller pre-guards `paragraphAnchor &&
  passageRangeOffsets`, so the `!anchor || !rangeOffsets` operands are provably
  dead; the *live* operand `anchor.start !== anchor.end` correctly rejects
  multi-passage ranges. Resolution: **dismiss with justification** (defensive
  guard, intentional) rather than delete real null-safety. Advisory-tier; do not
  gate.

### Continuity phase checklist (live)

Landed 2026-06-16 in `scripts/continuity.js` (one file, two roles: capture on
source surfaces, replay in the reader). Local standalone green; local
`test:continuity` green (flight runs + settles clean; reduced-motion and
direct-nav both fall back to a clean highlighted landing). Awaiting Actions
browser-tier confirmation.

- [x] Define the reader's "highlight settled at rect" contract. Implemented as
      a synchronous hook, not an event: `focusHighlight()` calls
      `RenaissanceContinuity.claimArrival(mark, scrollToReadingSightline)`. A
      `true` return means continuity owns scroll + motion; `false` hands back to
      the normal flourish. This is the seam the AST compiler (A) must preserve.
- [x] Enrich the transition payload: `<mark>` rect + colour + text + essay
      /section identity, in `sessionStorage["renaissance:continuity"]` with an
      8s age gate (mirrors the page-transition payload pattern).
- [x] Source capture on result click. Generic: any clicked `a[href]` to
      `section.html` that contains a `<mark>` — covers full search, essay
      inline, home/archive inline, and Spotlight (any surface whose results are
      mark-bearing anchors), no per-surface code. Capture-phase listener so it
      runs before the page-transition navigation.
- [x] Destination replay: scroll-to-sightline (instant) -> measure LAST ->
      INVERT the real mark to the source rect -> PLAY transform+colour to home
      (luxe `cubic-bezier(0.22,1,0.36,1)`, 480ms) -> settle with the reader's
      existing arrival pulse.
- [x] No double-highlight flash: INVERT is applied synchronously in the same
      task the highlight is created (flushed via `offsetWidth`), so the first
      painted frame is already at the source.
- [x] FLIP-on-real reflow containment: motion is pure `transform` (composited,
      no layout); the one layout touch is `display:inline-block` during flight,
      and we bail (clean fallback) when the mark wraps multiple lines
      (`getClientRects().length > 1`), so the paragraph never reflows.
- [x] Fallback safety: stale/missing/mismatched payload, identity mismatch,
      zero-size rect, direct nav, new tab -> plain highlighted landing. The
      deep-link highlight is the guarantee; the flight is never load-bearing.
- [x] Reduced-motion + a11y: `claimArrival` returns false under
      `prefers-reduced-motion` (instant highlighted landing, no flight). The
      mark is real content (not hidden); focus/tabindex handling unchanged.
- [x] `continuity-regression.js` + `test:continuity`/`ci:continuity` (port
      4190), wired into the `browser` and `full-chromium` suites. Three cases:
      flight runs and settles clean, reduced-motion no-flight, direct-nav
      no-flight; all assert a fully-highlighted landing and zero page errors.
- [x] Bumped budgets on landing: `section.html` 320 -> 336, `index.html` 256 ->
      272. **`section.js` split is now booked as the immediate follow-on** — the
      next budget pressure is paid by the split, not another bump.
- [ ] Validate on Actions (browser/full-chromium), not the laptop. (pushed
      2026-06-16; awaiting run.)

### Transition hardening — composed arrival (2026-06-16)

The flight was landing inside a rough navigation (the page "locked up" on click,
then a flash to an empty reader, *then* the flight). Hardened so the flight is
wrapped in a seamless transition, applied to **all click-navigations**:

- [x] **Graceful out**: `OUT_DURATION_MS` 16 -> 120 so the existing exit
      animation (recede + rule sweep) actually plays instead of being guillotined
      — the click now reads as a departure, not a freeze. Tap-latency test caps
      raised 75 -> 200 in page-transition + transition-evidence to match the
      intentional out.
- [x] **Paper veil**: a CSS veil (`main` `visibility:hidden` until
      `page-transition-ready`; excluded during the out-phase and under reduced
      motion; CSS failsafe forces it visible after 1.1s if the script dies) holds
      the content hidden so an arrival never shows an empty shell or a pop. Uses
      `visibility` (not opacity) so computed opacity stays 1 and the existing
      visibility regressions pass.
- [x] **Composed reveal**: `page-transition.js` reveals on
      `renaissance:page-ready` (capped at `REVEAL_CAP_MS = 700`) instead of
      immediately, so the content + the existing transform-based compose-in
      animations land together. `revealMode` is now `"composed"`
      (`"immediate"` under reduced motion).
- [x] **Flight coordinated with the reveal**: `revealPage()` fires
      `renaissance:page-revealed`; continuity defers its INVERT+flight to that
      event so the words are seen flying as the content composes in, never
      animating under the veil. Claiming is still always safe — the deferred
      `start()` always scrolls the highlight into place even if the flight bails.
- [x] Local browser suites green: page-transitions (composed reveal + reduced-
      motion shell), continuity (flight + fallbacks), transition-evidence
      (composed revealMode + graceful-out timing across arrival scenarios).
- [x] essay.html budget 272 -> 280 (shared veil CSS weight). Awaiting Actions.

### Continuity follow-ons (parked)

- **Spotlight polish**: capture already fires for mark-bearing Spotlight result
  anchors; confirm the modal-context source rect reads correctly and the flight
  feels right out of the overlay (vs in-page lists).
- **`section.js` split** (booked above): the real fix for the section.html
  budget; do it before any further reader growth.
- **Scale fidelity**: flight scale is height-ratio uniform; if the snippet vs
  reader type contrast ever feels off mid-flight, switch to a width-aware or
  font-size-explicit tween.

## Next Build Specs (handoff)

These are the three specced-but-unbuilt threads the dashboard points at, in
order. Written to be picked up cold.

### Reading-Attention Progress Model (SHIPPED 2026-06-16 — standalone-green)

**Status.** Built as specced below, in three checkpoints (`85b4e46` pure core +
test, `b35a1f3` persistence contract + node unit test, `7d6c758` heartbeat
wiring + consumers). Full `ci:standalone` green locally; browser-tier
confirmation deferred to the end-of-sprint Actions pass. Deviations from the
spec, all deliberate: the **scroll-based resume pointer is kept** (proven +
tested) rather than resuming off the attention `frontier` — `frontier` is
exposed but informational for now; the **visual progress bar stays
scroll-position** (a progress bar that isn't where you are is wrong); word
counts are **derived from the DOM** (no index change); completion switched to
attention with a maxProgress fallback for legacy records. Open follow-ups: the
**`section.js` split** (now overdue — see the budget note) and a **feel pass**
on the constants (`WPM` 240, `READ_FRACTION` 0.5, velocity thresholds) in the
live reader.

**Problem.** "Continue reading" shows ~1% after real reading. Root cause: it
measures the *scrollbar*, not *reading*. `archive.js renderContinueReading`
reads `target.progress` (current scroll position). `progress` under-reports
(scroll up to re-read → ~0); the obvious "fix", `maxProgress` (furthest
scrolled), over-reports (scrub down to check length → reads as 100%). The user
explicitly rejected both. We want **attention**: how far they actually *read*.

**The model (over-engineered on purpose, but principled + testable):**
- **Unit = paragraph.** Reader paragraphs already carry `data-passage-id` and the
  AST/index already has per-passage **word counts** — use them.
- **Expected read time** per paragraph = `words / WPM` (default **WPM 240**).
- **Dwell accounting.** Accumulate *active reading time* per paragraph; a
  paragraph flips to **read** when dwell ≥ **READ_FRACTION (default 0.5)** of its
  expected time. So a fat paragraph needs real seconds; a heading clears trivially.
- **Three gates decide if a tick counts (the intelligence):**
  1. **Velocity gate** — credit ramps to ~0 as scroll speed rises (a fast scrub
     earns nothing; reading pace earns full). Kills the "scrubbed to check
     length" inflation.
  2. **Reading-zone weighting** — only content near the sightline (the existing
     `READING_LINE_RATIO = 0.36` band) accrues, weighted by overlap with the zone.
     Credit what the eyes were on, not what flew past edges.
  3. **Presence gate** — `document.hidden` (Page Visibility) → pause the clock.
     Don't count time spent in another tab.
- **Outputs (one model, three uses):** `progress` = read words ÷ total words
  (length-weighted); `furthestRead` = honest high-water mark; `frontier` =
  read/unread boundary = the **resume point** (where to land them).

**Architecture (matches the codebase + CI-first testing idiom):**
- **Pure, dual-export core** `scripts/reading-attention.js` — no DOM. API like
  `create(paragraphs)` → `{ tick({ now, zoneParagraphs:[{index,weight}], velocity,
  visible }), summary() → { progress, furthestRead, frontier }, serialize()/
  hydrate() }`. Deterministic → unit-test with synthetic tick streams (assert a
  simulated scrub earns ~0, simulated reading flips paragraphs read). Add
  `scripts/tests/reading-attention-regression.js` to the standalone gate.
- **Thin wiring in `section.js`** — a ~250–300ms heartbeat while visible:
  snapshot zone occupancy + scroll velocity, call `tick()`, persist the compact
  read-set into `reading-state` (extend the per-section record). On load,
  `hydrate()` and resume at `frontier`.
- **`archive.js`** then reads the attention-derived `progress` (replaces the
  reverted `maxProgress` stopgap — do NOT just swap to maxProgress).
- Per-paragraph dwell **capped** (e.g. 2× expected) so leaving the tab open on
  one paragraph can't inflate; "read" is monotonic.
- Reduced motion / no-JS: fall back to the current scroll `progress` (never worse
  than today).
- Knobs to tune by feel: `WPM` (240), `READ_FRACTION` (0.5), velocity threshold,
  zone band, heartbeat interval. All reversible constants.

**Integration map (existing plumbing — reverse-engineered this session, do NOT
re-discover):**
- `scripts/section.js`:
  - `computeReadingProgress()` (~L1032) — the current scroll-fraction measure:
    `(scrollY - start)/(end - start)` against `sectionContent` rect, where
    `start = contentTop - 0.18*vh`, `end = contentBottom - 0.62*vh`. This is what
    the attention model supersedes for persistence (keep it as the fallback).
  - `scheduleReadingProgressSync()` (~L1211) — rAF tick + 180ms debounce that
    calls `saveReadingProgress`. The attention heartbeat sits here / alongside.
  - `saveReadingProgress(progress)` (~L1179) — **gated by `suppressProgressSave`**
    (flag at ~L77; raised by `startRestoreSaveSuppression` ~L1353 and lowered by
    `releaseRestoreSaveSuppressionSoon` ~L1361 during a restore-scroll). Persists
    via `readingState.saveSectionProgress({...})`.
  - Sightline: `READING_LINE_RATIO = 0.36` (~L49), `readingLineY()` (~L1047),
    `scrollToReadingSightline(el, {behavior})` (~L1707).
  - Scroll/resize listeners (~L1247). Resume pointer: `currentResumePointer()`.
  - Paragraph DOM carries `data-passage-id` and `data-paragraph-index`. **Word
    count** per paragraph: derive at wire-time from each `[data-passage-id]`
    element's `textContent` (whitespace split), or extend
    `generate-search-index.js` to emit per-passage `wordCount` (it already has
    the AST `wordCount` helper). Prefer deriving from the DOM to avoid an index
    change.
- `scripts/reading-state.js`:
  - Record fields (`normalizeRecord` ~L69, `saveSectionProgress` ~L182):
    `progress`, `maxProgress`, `scrollY`, `resumeParagraphIndex/Ratio/Signature`,
    `completed`. **Extend the record** with the compact attention read-set (e.g.
    `readParagraphs` + a `frontier` {index, dwellMs}); bump any version/normalize.
  - `continueTarget()` (~L255) returns `{progress, maxProgress, ...}`; **add an
    attention-derived progress** field here and have the home read it.
- `scripts/archive.js`:
  - `renderContinueReading()` (~L64) reads `target.progress` (the reverted
    stopgap was `target.maxProgress` — use the new attention field instead),
    `progressPercent()` (~L60) floors at 1 / caps at 99.

**Advanced-search wiring (for that task):** `scripts/search-page.js`
`executeSearch()` calls `client.search(query, { scope, limit: 60 })` — it does
NOT pass `perSection`, so the oracle default of **2** (`search-oracle.js`
`rank()` ~L241, applied at ~L361 `passageHits.slice(0, perSection)`) caps it.
Advanced mode = pass `perSection: Infinity` + a high `limit`. The
`advancedToggle` is force-hidden in `bindEvents()` (`advancedToggle.hidden =
true`) — repurpose it. Oracle results already carry their `reasons`
(`{label, points}[]`); `oracle-client.js renderResults()` ignores them today —
advanced mode renders them.

**Soft-nav anchor (for the A-phase):** `scripts/page-transition.js` already
intercepts link clicks (`handleLinkClick` ~L217) and owns the out/reveal
choreography; soft-nav extends that path to `fetch` + swap `<main>` + update
history + re-run the page controller, replacing `location.assign`. Continuity
then becomes same-document (no sessionStorage handoff).

**Why it's the right kind of over-engineered:** it's sophisticated *and*
provable in CI (pure core), reuses real signal (word counts, sightline), and is
not a hand-waved probability distribution. It knows reading from scanning and
pauses when you leave.

### Advanced Search Plan

Default `/search` stays curated: a couple per section, relevance-first (the
oracle's `perSection` cap, currently 2). Add a **sexy advanced/exhaustive mode**:
- Uncap: pass a high/`Infinity` `perSection` + `limit` so e.g. "sand" returns all
  ~98 matching passages (index stores `"sand": 98`), ranked then reading-order.
- Per-passage, not per-occurrence (a passage with 3 "sand"s shows once).
- Group by section with **live counts** ("§10 · 37 mentions").
- Reveal the oracle's **self-explaining ranking reasons** (it already attaches
  `{label, points}` per result — "term: sand", "section is about sand", "pull
  quote"). The machinery, shown beautifully.
- Scope/section filters; jump-to-section.
- **Reuse the hidden `advancedToggle`** (it was hidden when the oracle took over
  inline) as the "show me everything" switch. Curated by default, one click to
  exhaustive.

### A-Phase: Soft-Navigation + Magic Texture (the ethereal headline)

The continuity flight is wrapped in a now-composed navigation, but a **residual
"tinge of lock-up" remains — it is the hard document navigation itself** (the
browser tears down one page and builds the next; prefetch warms it, the veil
masks it, but a real beat of work can't be animated across). Firefox has no
reliable cross-document View Transitions, so the honest ethereal lever is:

- **Soft navigation** — intercept the click, `fetch` the destination, swap the
  content into the *current* document (no reload, no teardown). The lock-up
  *disappears*. This is a real architecture shift but it **dovetails with the AST
  compiler (sub-project A)** — once content is prebuilt/hydratable, swapping is
  natural — and it makes continuity **same-document-trivial** (the mark can morph
  in place; no cross-page sessionStorage handoff).
- **Magic texture (bundled with the above, per the user):** a true spring easing
  instead of the cubic-bezier; the veil **dissolving** (soft blur/luminosity
  bloom) not a flat fade; the arriving words **shimmering/glowing** as they
  settle; a touch of depth/parallax so the reader *surfaces* rather than appears.
  None of this removes the lock-up — soft-nav does — but it makes what is there
  feel enchanted, not mechanical.

Sequence the whole reading-instrument arc after these: **A** (AST runtime→build
compiler; soft-nav is its companion), **B-feel** (algorithmic typesetting), **C**
(literary apparatus/concordance). See **Sprint Direction: The Reading Instrument**.

### Run Log Template

```text
Date:
Run:
Suite:
Branch/ref:
Commit:
Result:
Artifacts:
Reviewed:
Notes:
Next:
```

### Artifact Index Template

```text
Artifact:
Run:
Flow:
Viewport/theme/motion:
Why it matters:
Reviewed by:
Decision:
Follow-up:
```

### Decision Record Template

```text
Decision:
Date:
Context:
Options considered:
Chosen path:
Why:
Tradeoffs:
Follow-up:
```

### Risk Register Template

```text
Risk:
Likelihood:
Impact:
Signal:
Mitigation:
Owner:
Status:
```

### Deferred Scope Template

Deferring scope is allowed, but it must be explicit.

```text
Item:
Why deferred:
What remains safe without it:
What would trigger reopening:
Where tracked:
```

## Branch Workflow And Checkpoints

This sprint should run on:

```text
sprint/transition-spotlight-oracle
```

Do not start implementation work on `main`. Small pre-sprint docs/workflow fixes
may exist on `main`, but the transition/oracle/Spotlight implementation should
live on the sprint branch until it is ready to merge.

### Checkpoint Philosophy

Commit in meaningful checkpoints, not giant end-of-sprint dumps and not noisy
micro-commits that cannot be reviewed.

A good checkpoint:

- has one clear purpose;
- can be described in one sentence;
- leaves the repo in a runnable or intentionally documented state;
- includes tests/docs when the change creates or changes a contract;
- is pushed before expensive GitHub Actions validation;
- records meaningful run/artifact findings in this document when useful.

### Checkpoint Types

- **Docs contract checkpoint**: sprint docs, specs, QA notes, no runtime code.
- **Evidence checkpoint**: diagnostics, test harnesses, artifact capture, no
  product behavior change unless unavoidable.
- **Test checkpoint**: failing or expanded tests that define the bar before a
  fix; allowed when the next checkpoint is expected to make them pass.
- **Transition checkpoint**: focused route/motion behavior change with relevant
  tests/artifacts.
- **Oracle checkpoint**: generated index, query parser, ranking, fixtures, or
  search migration work.
- **Anchor checkpoint**: passage IDs, URL grammar, reader resolution, copied
  link behavior, anchor fixtures.
- **Spotlight checkpoint**: shell, keyboard/focus, actions, search results,
  activation, mobile/reduced-motion.
- **Gauntlet checkpoint**: Actions suite expansion, artifact uploads, broad
  hardening tests.
- **Polish checkpoint**: timing, visual refinement, copy, empty/offline states,
  visual baseline updates.

### When To Push

Push after:

- committing the docs contract;
- adding a new Actions suite;
- adding a test harness that should run remotely;
- landing a transition/search/anchor/Spotlight checkpoint;
- before running expensive Manual Checks;
- before asking for broad review or subagent critique.

Do not push only to "save" half-understood churn unless the work is risky and a
remote backup is useful. If a pushed checkpoint is intentionally incomplete,
record that clearly.

### When To Run Actions

Run the narrowest useful suite after each checkpoint.

Examples:

- docs-only checkpoint: no heavy suite required; optional `check`.
- generated artifact/check script checkpoint: `check` or `standalone`.
- transition checkpoint: `browser`, then targeted visual/video artifacts if
  needed.
- reader/anchor checkpoint: `anchors` once implemented, plus `browser`.
- search ranking checkpoint: `oracle-search` once implemented.
- Spotlight interaction checkpoint: `spotlight` once implemented, plus `a11y`
  for focus/keyboard changes.
- PWA/cache checkpoint: `pwa-cache` once implemented.
- phase closeout: relevant gauntlet family.
- sprint closeout: `hardening-full` plus visual beta/cross-browser as needed.

### Branch Exit Criteria

Before merging the sprint branch:

- docs match shipped behavior;
- implementation phases have run logs or documented exceptions;
- relevant gauntlets have passed or have explicit deferred scope;
- visual/motion artifacts were actually reviewed;
- old URL recovery behavior is known;
- generated artifacts are fresh;
- Actions suite expansion for new risk surfaces exists;
- `main` can receive the merge without hidden local-only assumptions.

Companion specs:

- `docs/specs/ORACLE-SEARCH-SPEC.md`: target AST-native search architecture.
- `docs/specs/AST-ANCHORS-SPEC.md`: stable passage/deep-link anchor model.
- `docs/specs/SPOTLIGHT-UX-SPEC.md`: hidden-index UI and interaction contract.
- `docs/specs/HARDENING-GAUNTLETS-SPEC.md`: post-main hardening passes,
  artifact review, and expanded Actions suites to implement in this sprint.
- `docs/specs/SEARCH-RANKING-SPEC.md`: current legacy search behavior, not a
  compatibility constraint.

## Sprint Objective

Make Renaissance navigation feel immediate, seamless, magical, and reliable
across the archive, essay, reader, search, recovery, cached, offline, reduced
motion, mobile, and GitHub Pages subpath paths. Once the underlying movement
language is trustworthy, build Spotlight Search as the first flagship expression
of that interaction system.

The order matters:

1. Harden page and reader transitions until they feel spotless.
2. Prove that smoothness with automated checks, visual artifacts, and manual
   critique.
3. Build Spotlight on top of the hardened transition system instead of adding
   another interaction layer over rough navigation.

## Product Bar

The sprint target is not "add animation." The target is zero perceived dead
time, no blankness, and a handoff that feels authored.

- A click or tap must acknowledge immediately.
- The current page must stay alive until the destination is ready to carry the
  reader forward.
- The destination must become readable before any flourish finishes.
- Motion must connect states rather than hide latency.
- Slow or uncached conditions must degrade calmly.
- Cached and PWA paths should feel especially fast and book-like.
- The reader should never feel secondary to the interface.

## Non-Negotiables

- No blank frame.
- No full-page fade to an unreadable state.
- No dead wait before visible feedback.
- No stuck transition classes or `aria-busy` state.
- No scroll landing that feels random.
- No focus loss that traps keyboard users.
- No transition that violates `prefers-reduced-motion`.
- No transition that depends on arbitrary timing when a deterministic event is
  available.
- No generic command palette styling for Spotlight.
- No large visual assets or runtime dependencies unless they solve a proven
  problem and survive review.
- No workflow secrets, deploys, or write permissions for manual validation.

## Taste Direction

Renaissance should feel like a precise literary archive rather than a web app
with a page transition library.

Useful motifs:

- marked passage
- index slip
- ledger line
- bookmark
- page rule
- quiet glint
- ink settling
- section turn
- archive card resolving into prose
- hidden index opening

Avoid:

- SaaS command palette defaults
- glass panels
- decorative gradient effects
- oversized motion
- bounce
- game-like flourishes
- animation that competes with prose
- artificial loading screens

## Interaction Principles

### Immediate Acknowledgment

Pointer, keyboard, and touch actions should show a local response immediately.
The user should never wonder whether the action registered.

Examples:

- source link receives an active transition state on pointer down or keyboard
  activation;
- reader section controls acknowledge before content swapping starts;
- Spotlight opens without waiting on a search index rebuild;
- Escape/close actions return focus promptly.

### Alive Source Page

The current page is part of the transition. It should not disappear into a blank
or dimmed shell while waiting for navigation.

The source can:

- mark the activated link;
- draw a line or rule from the action origin;
- soften or shift by a tiny amount;
- keep text readable until commit.

The source should not:

- fade to zero;
- hide `main`;
- expose the canvas without content;
- wait on fetch before showing any feedback.

### Readable Destination First

Destination content should become readable quickly. Arrival animation may settle
afterward, but the prose or target surface should already be usable.

For reader routes, the title/prose should not be hidden behind a decorative
arrival. For search and Spotlight routes, the input and first results should not
wait for a flourish to finish.

### Continuity Over Decoration

Motion is valuable when it explains where the user came from and where they are
going. Decorative motion without spatial or semantic continuity is suspect.

### Native Where Useful

Use normal links, buttons, focus, history, selection, and browser navigation
where possible. Custom behavior is justified only when it improves reader
continuity or site reliability.

## Navigation Paths To Audit

Every path in this section needs at least one explicit decision: covered by an
existing test, needs a new test, needs a manual visual check, or intentionally
out of scope.

- [ ] Home archive -> essay page.
- [ ] Home archive -> section via Continue Reading.
- [ ] Home inline search -> full search.
- [ ] Home inline search -> result target.
- [ ] Essay page -> section reader.
- [ ] Essay inline search -> section result.
- [ ] Section reader -> previous section.
- [ ] Section reader -> next section.
- [ ] Section reader -> essay page.
- [ ] Section reader -> home archive.
- [ ] Section reader -> copied highlight deep link.
- [ ] Full search -> section result.
- [ ] Full search -> highlighted passage.
- [ ] Direct `essay.html?essay=<slug>` load.
- [ ] Direct `section.html?essay=<slug>&section=<n>` load.
- [ ] Direct search URL with query state.
- [ ] Browser back and forward.
- [ ] Reload during or after a transition.
- [ ] App-shell not-found route.
- [ ] Browser-level 404 route.
- [ ] Offline cached navigation.
- [ ] Slow-network first uncached visit.
- [ ] Slow-network cached repeat visit.
- [ ] `/renaissance/` GitHub Pages subpath.
- [ ] Mobile touch navigation.
- [ ] Keyboard-only navigation.
- [ ] Reduced-motion navigation.
- [ ] Forced-colors/high-contrast behavior.

## Spotlight Scope

Spotlight should start only after the transition system is reliable enough that
opening a result feels excellent.

Spotlight is not a wrapper around the current search implementation. It is the
front door to a new oracle-grade search system. Replacing the current search API
is allowed if that produces better ranking, anchors, snippets, tests, and
reader activation.

Initial expectations (status as of 2026-06-15 launcher checkpoint `781bd7b`;
verified by reading `scripts/spotlight.js` + `spotlight-regression.js`, not yet
by manual beta review):

- [x] `Cmd/Ctrl+K` opens Spotlight (`metaKey || ctrlKey` + `k`).
- [ ] Trigger is discoverable without noisy in-app instruction.
- [x] Escape closes and restores focus.
- [x] Enter activates selected item.
- [x] Arrow keys move selection (`ArrowDown`/`ArrowUp` + `aria-activedescendant`).
- [x] Search updates instantly while typing.
- [x] Continue Reading appears first when relevant (Continue/Next-section rows).
- [ ] Current essay actions appear before global actions when context exists.
- [x] Section jumps are available.
- [ ] Full search handoff is available.
- [ ] Mobile presentation is full-screen or otherwise touch-natural.
- [ ] Reduced-motion path is clean.
- [ ] Empty state feels authored.
- [ ] Offline/cached state does not break.
- [ ] Result activation uses the same transition language as the rest of the
      site.

Carries `role="dialog" aria-modal="true"`, a `combobox`/`listbox` results
model, and an `aria-live` status region — so dialog/active-result a11y
semantics exist, but the unticked rows above still need verification or work.

Out of initial scope unless the sprint discovers a strong reason:

- command execution unrelated to reading/search;
- plugin-like action architecture;
- heavy fuzzy-worker architecture;
- decorative generated imagery inside Spotlight;
- persistent user customization.

## Oracle Search Ambition

Search should feel like the archive knows itself without pretending to generate
answers. The user should be able to type a phrase, image, title fragment, motif,
section number, or intent and get a result that feels inevitable.

This likely requires rebuilding search around:

- AST-derived passage records;
- stable passage anchors;
- generated search artifacts;
- deterministic query interpretation;
- contextual ranking;
- curated motif/alias metadata;
- precise snippets;
- robust reader highlight arrival;
- fixtures that assert result order and ranking reasons.

The existing runtime search is a useful reference, not a boundary. If a cleaner
search system needs new modules, generated data, new result shapes, or new URL
grammar, prefer the better system and document migration/recovery behavior.

### Oracle Result Philosophy

The first results should answer "what did the reader probably mean?" without
becoming opaque or fake.

Good top results:

- Continue Reading when the query is empty or resume-like.
- Current essay passages when the user is reading an essay.
- Exact section title when the query names a section.
- Best passage when the query is a remembered image or phrase.
- Section jump when the query is `section 4`, `iv`, or similar.
- Full search handoff when the query needs a broader surface.

Bad top results:

- fuzzy body hit above exact title hit;
- global noise above current essay context;
- many near-identical passage rows;
- a result that exists only because of a vague synonym expansion;
- a row that cannot explain why it matched in debug mode.

### Search Rebuild Workstreams

- [ ] Passage index generator from AST.
- [ ] Search index freshness check.
- [ ] Search artifact size reporting.
- [ ] Stable passage anchor generation.
- [ ] Query parser and normalization.
- [ ] Context/action result generator.
- [ ] Ranking engine with score explanations.
- [ ] Snippet/highlight span generator.
- [x] Full search page migration. (2026-06-16) Oracle-native/oracle-simple:
      modes/sort/page-size/counts/pagination dropped, one flat ranked list;
      legacy engine kept only as file://-offline fallback.
- [x] Archive inline search migration. (2026-06-16) Shared oracle client.
- [x] Essay inline search migration. (2026-06-16) Shared oracle client,
      current-essay scoped, advanced toggle hidden when oracle available.
- [x] Reader deep-link/highlight migration. Oracle emits passageId +
      rangeStart/rangeEnd; reader anchor resolution unchanged.
- [x] Spotlight UI integration. Oracle index primary, legacy engine fallback.
- [x] Offline/PWA integration. index/lexicon/oracle/client precached in sw.js.
- [x] Fixture suite for oracle behavior. index/oracle/lexicon/passage-alignment
      regressions wired into standalone + browser gates.

### No Compatibility Theater

Do not preserve the old search API merely because it exists. Preserve reader
value, public-link recovery, generated artifact discipline, and test confidence.

Allowed changes:

- replace `scripts/search-engine.js`;
- split search into multiple modules;
- change result shapes;
- change search URL parameters;
- replace occurrence-based highlights with AST anchors;
- regenerate data/search artifacts;
- update all search consumers in one coherent sweep.

Required guardrails:

- old reader-facing links degrade gracefully where feasible;
- unpublished essays stay excluded from public search;
- generated artifacts have freshness checks;
- query/ranking behavior has fixtures;
- Spotlight and full search share the same search truth.

## Downstream Perfection Rule

Anything touched by transitions, oracle search, AST anchors, or Spotlight is in
scope for hardening if it affects the final feel. Do not stop at the visible
overlay when the roughness lives downstream.

Downstream surfaces that may be perfected during this sprint:

- full search page layout, controls, ranking, pagination, and empty states;
- archive inline search behavior and handoff to full search;
- essay inline search behavior and current-essay scoping;
- section reader highlight arrival, scroll sightline, focus, and copy tools;
- copied citation and highlight-link URL grammar;
- reading-state Continue Reading actions and resume presentation;
- route parsing/building and query cleanup;
- app-shell recovery suggestions;
- browser-level 404 suggestions where search/anchors intersect recovery;
- generated data, site registry, offline asset manifest, and cache versioning;
- service-worker cached/offline behavior for search data and reader anchors;
- AST text projections, passage IDs, source offsets, and diagnostics;
- visual QA scenarios for search, reader arrival, and Spotlight;
- accessibility behavior across dialog, listbox, focus, keyboard, and reduced
  motion;
- mobile touch layout, viewport behavior, and virtual-keyboard handling;
- docs, fixtures, and debug tooling needed to keep future work precise.

This is permission to pursue quality through the whole chain. It is not
permission for unrelated redesign. The rule is: if the downstream piece makes
Spotlight/search/transitions feel less than excellent, it is eligible for
improvement.

### Downstream Surface Map

Use this map during implementation. Each surface should either be upgraded,
explicitly left alone with a reason, or covered by tests that prove it already
meets the bar.

#### Search Surfaces

- Full search page:
  - result ranking;
  - result grouping;
  - result snippets;
  - pagination or result-window behavior;
  - empty states;
  - search controls;
  - URL state;
  - scope behavior;
  - keyboard focus;
  - mobile layout.
- Archive inline search:
  - instant preview;
  - handoff to full search;
  - current result activation;
  - empty/error copy;
  - consistency with full search ranking.
- Essay inline search:
  - current-essay scope;
  - section/title boosts;
  - passage snippets;
  - result activation into reader anchors;
  - handoff to full search with preserved state.
- Spotlight:
  - default rows;
  - action rows;
  - query result rows;
  - grouping;
  - loading/offline states;
  - activation;
  - focus and keyboard model;
  - mobile sheet.

#### Reader Surfaces

- Section route loading:
  - destination reveal;
  - reader title/meta readiness;
  - content swap behavior;
  - no stale section flashes.
- Search result arrival:
  - scroll target;
  - sightline positioning;
  - highlight timing;
  - highlight styling;
  - focus behavior;
  - recovery if anchor is stale.
- Section prev/next:
  - in-reader section turn feel;
  - no full-page blankness;
  - progress save/restore interaction;
  - source and destination continuity.
- Copy/citation:
  - stable anchor URL;
  - source label;
  - rich text safety;
  - mobile bottom bar;
  - toast/chip feedback.
- Continue Reading:
  - ranking as a Spotlight action;
  - archive presentation;
  - resume target accuracy;
  - completed-section next-step behavior.

#### Routing And Recovery

- Router:
  - URL grammar for anchors and search;
  - query cleanup;
  - subpath safety;
  - history state;
  - back/forward restore.
- App-shell recovery:
  - invalid essay;
  - invalid section;
  - stale passage anchor;
  - missing generated search index;
  - nearest valid section/essay suggestions.
- Browser-level 404:
  - stale search links;
  - stale section links;
  - missing anchor routes;
  - recovery search prefill;
  - offline mode.

#### AST And Content Pipeline

- AST parser:
  - source offsets;
  - stable block ordering;
  - searchable text projection;
  - snippet text projection;
  - diagnostics for unsupported syntax.
- AST rendering:
  - passage IDs;
  - passage signatures;
  - data attributes needed by reader/search;
  - safe DOM construction.
- Corpus tooling:
  - fixture generation;
  - anchor fixture updates;
  - search index reports;
  - authoring diagnostics.
- Content validation:
  - missing metadata;
  - unpublished exclusion;
  - stale generated data;
  - stale search index;
  - stale cache version.

#### Generated Artifacts And PWA

- Generated search index:
  - freshness;
  - deterministic ordering;
  - size budget;
  - unpublished exclusion;
  - cache behavior.
- Embedded data:
  - fallback compatibility where still useful;
  - possible replacement if search index covers the same need better.
- Offline assets:
  - search index inclusion decision;
  - raw text availability;
  - cached section activation;
  - offline Spotlight actions.
- Service worker:
  - cache version changes when generated search assets change;
  - stale-while-revalidate does not hide broken search data;
  - offline navigation stays readable.

#### Visual, Motion, And Interaction

- Cross-page transition:
  - source feedback;
  - destination readability;
  - no blank frames;
  - no late reveal.
- Reader section transition:
  - distinct book-like turn;
  - no scroll fight;
  - no stale progress writes.
- Search-to-reader transition:
  - result row becomes source;
  - passage arrival feels found, not jumped.
- Spotlight open/close:
  - instant shell;
  - focus certainty;
  - no background scroll leak.
- Reduced motion:
  - equivalent state clarity;
  - no hidden content;
  - no broken activation.
- Mobile:
  - touch feedback;
  - virtual keyboard;
  - viewport height;
  - result row tap targets.

#### Accessibility

- Dialog semantics for Spotlight.
- Combobox/listbox or equivalent active-result semantics.
- Focus return on close and activation.
- Keyboard-only route activation.
- Screen-reader result count/status.
- Reduced-motion compliance.
- Forced-colors visibility.
- No focus trap dead ends.
- No background page interaction while Spotlight is modal.

#### Debug And QA Tooling

- Ranking explanations.
- Anchor resolution debug panel or logs.
- Search index size/timing report.
- Transition timing traces.
- Visual QA scenarios.
- Playwright trace/video artifacts.
- Fixture failure output that explains expected versus actual ranking reasons.
- Artifact summary updates for search index and anchor metadata.

### Downstream Replacement Permission

Replace a downstream subsystem when the existing design makes perfection harder
than replacement.

Replacement is allowed for:

- search engine internals;
- search result object shape;
- search page rendering;
- inline search implementations;
- highlight URL grammar;
- reader anchor resolution;
- copy link construction;
- generated data format;
- route query parsing;
- visual QA scenarios;
- test harness utilities.

Replacement should still respect:

- published/unpublished boundaries;
- safe DOM rendering;
- GitHub Pages subpath behavior;
- offline/PWA expectations;
- accessibility expectations;
- generated artifact freshness;
- deterministic fixtures.

### Downstream Done Criteria

A downstream surface is "perfect enough for this sprint" when:

- it uses the same source of truth as Spotlight or documents why it does not;
- its behavior is deterministic and covered by focused tests or artifacts;
- it has a graceful stale/offline/error path;
- it works on mobile, keyboard, and reduced-motion paths;
- it does not add perceptible latency to the critical interaction;
- it does not leak unpublished content;
- it does not rely on unsafe HTML injection;
- it has a clear debug path for future failures;
- it makes the final interaction feel more seamless rather than merely more
  complex.

### Downstream Audit Checklist

- [x] Full search uses the same oracle truth as Spotlight. (2026-06-16) All
      surfaces route through the shared oracle-client/search-oracle.
- [x] Inline search previews use the same ranking semantics as full search or
      document an intentional simplification. (2026-06-16) Identical ranking;
      inline surfaces differ only in scope + result cap.
- [ ] Result activation uses stable anchors where available.
- [ ] Reader highlight arrival feels intentional and does not fight scroll
      restore.
- [ ] Copy links and search links share anchor grammar where practical.
- [ ] Continue Reading actions rank and route correctly.
- [ ] Recovery pages do not contradict the oracle index.
- [ ] Offline/cached search behavior is clear and tested.
- [ ] PWA cache version changes when generated search artifacts change.
- [ ] Visual QA covers the new high-value interaction states.
- [ ] A11y tests cover Spotlight and changed search/reader paths.
- [ ] Debug output exists for ranking or anchor surprises.

## Required Plumbing

This sprint needs explicit plumbing, not only UI and search code. Build these
supports as the systems come online so hardening remains observable,
reversible, and testable.

### Instrumentation

Add timing and state instrumentation where it helps diagnose perceived lag,
blankness, search quality, and anchor resolution.

Measure:

- pointer/key activation -> visible source feedback;
- activation -> route commit;
- route commit -> destination readable;
- destination readable -> arrival flourish complete;
- section prev/next activation -> content swap start;
- section prev/next activation -> content readable;
- search query input -> first result set;
- query input -> oracle ranking complete;
- Spotlight shortcut -> shell visible;
- Spotlight shortcut -> input focused;
- Spotlight activation -> destination route commit;
- reader route load -> anchor resolved;
- anchor resolved -> highlight applied;
- service worker navigation timeout/fallback path.

Instrumentation should be quiet by default and visible through debug flags,
test logs, or artifact summaries.

### Artifact Capture

Screenshots are not enough for motion. The sprint should support first-class
capture of:

- Playwright traces for route and Spotlight flows;
- short videos for transition variants;
- screenshots for stable layout states;
- visual diffs for baseline-managed surfaces;
- timing logs for transition/search/anchor milestones;
- ranking explanation reports;
- anchor resolution reports;
- service-worker/cache logs;
- generated artifact summaries.

Actions artifacts should be named clearly enough that a future session can tell
which flow, viewport, theme, motion setting, and suite produced them.

### Schemas And Validators

Generated search and anchor data need structural contracts.

Add schemas or validators for:

- generated search index;
- generated passage records;
- generated essay/section search records;
- search lexicon/motif metadata;
- passage anchor records;
- ranking fixture files;
- query fixture files;
- artifact summary fields if they grow.

Validators should check:

- deterministic ordering;
- required fields;
- stable IDs;
- URL-safe slugs/anchors;
- source offset sanity;
- unpublished exclusion;
- duplicate IDs;
- unsupported lexicon entries;
- size metadata where applicable.

### Freshness Checks

Generated artifacts should fail checks when stale.

Potential generated artifacts:

- `data/search-index.json`;
- `data/search-lexicon.json` if generated or normalized;
- passage anchor metadata;
- offline asset manifest;
- service-worker cache version;
- site registry;
- 404 recovery catalogue;
- discoverability files;
- embedded fallback data if still used.

`npm run check` should eventually include freshness checks for the new generated
search and anchor artifacts.

### Debug Flags

Add debug flags as needed so failures can be diagnosed without editing source.

Candidate flags:

```text
debugTransitions=1
debugSearch=1
debugAnchors=1
debugSpotlight=1
debugPwa=1
```

Debug surfaces may show:

- transition state and timing marks;
- current route parse/build result;
- search index load status;
- parsed query;
- ranking score breakdown;
- top rejected candidates;
- anchor resolution path;
- fallback reason;
- service-worker/cache mode;
- Spotlight active result/focus state.

Debug UI must not ship as noisy visible product UI unless explicitly enabled.

### Feature And Rollback Switches

Large interaction work should have simple rollback levers during the sprint.

Possible switches:

- disable new cross-page transition behavior;
- disable new reader section transition behavior;
- disable Spotlight;
- force legacy/full search route;
- force query occurrence fallback;
- disable generated search index and use runtime fallback if still available;
- disable visual flourish while preserving navigation.

Switches can be query flags, local debug flags, environment-sensitive test
hooks, or small config constants. They should not become a permanent product
settings panel unless there is a real user need.

### Old URL Recovery

Old APIs do not need to survive internally, but old reader-facing URLs should
recover gracefully where feasible.

Recovery paths:

- old `q/occ` search-highlight links;
- copied highlight payload links;
- section URLs without anchors;
- stale paragraph IDs;
- stale generated hit IDs;
- malformed search scope/mode/page parameters;
- old chapter redirect paths;
- GitHub Pages subpath misses.

Recovery should prefer:

1. exact new anchor;
2. signature fallback;
3. payload/text fallback;
4. nearest section/essay;
5. full search prefilled with useful query;
6. archive fallback.

### Actions Suite Expansion

The focused Actions suites in `HARDENING-GAUNTLETS-SPEC.md` are implementation
work for this sprint. Add them as the relevant systems land.

Required suite families:

- oracle search;
- anchors;
- transitions;
- Spotlight;
- PWA/cache;
- visual strict or beta artifacts;
- cross-browser manual;
- a11y deep;
- security/content;
- performance;
- hardening-full.

Each suite should be whitelisted, read-only unless explicitly justified, timed
out, cancellable, and artifact-aware.

### Artifact And Performance Budgets

Track budgets before they become emergencies.

Budget candidates:

- generated search index size;
- generated lexicon size;
- passage anchor metadata size;
- service-worker precache size;
- offline asset payload size;
- shell asset weight;
- Spotlight open timing;
- query response timing;
- fuzzy rescue timing;
- transition source-feedback timing;
- destination-readable timing;
- visual artifact storage size.

Budget tests may start as warning/report-only while values are discovered, then
become gates when the target is stable.

### Decision Log

Record decisions that affect taste, architecture, compatibility, and testing.

Log:

- accepted transition motif;
- rejected transition variants and why;
- Spotlight layout decisions;
- search ranking tradeoffs;
- lexicon/motif expansion rules;
- anchor URL grammar;
- old URL recovery scope;
- generated artifact split/merge decisions;
- performance budget thresholds;
- visual baseline approvals;
- Actions suite additions.

The sprint doc's `Live Findings` and `Open Decisions` sections are the default
home for this log unless a topic deserves its own spec update.

## Testing Strategy

The sprint needs more than unit tests. Smoothness must be tested through a mix
of deterministic assertions, browser artifacts, and human critique.

### Automated Assertions

Use Playwright and focused Node regressions to guard:

- transition classes clear;
- `aria-busy` does not stick;
- body/main opacity remains readable;
- source link feedback appears promptly;
- destination route is correct;
- focus lands predictably;
- scroll position is intentional;
- reduced-motion collapses movement without breaking state;
- slow-network tests do not reveal blank or stuck states;
- service-worker cached paths still navigate;
- subpath routes stay valid;
- search-highlight deep links still resolve.
- oracle search fixtures preserve intended top-result ordering;
- generated passage anchors resolve after controlled content edits;
- Spotlight action rows remain available before the full index finishes loading.

### Visual Artifacts

Use screenshots, traces, and videos when the question is "how does it feel?"
rather than only "did a state bit change?"

Potential artifacts:

- before/after screenshots for each route class;
- Playwright traces for transition timing;
- short videos for section turn and search-result navigation;
- short videos for Spotlight open, type, select, activate, and close;
- visual QA diff report for page surfaces;
- Lighthouse reports as warning signals, not gates.

### Human Critique

Use manual review for taste decisions:

- Does the transition feel like a handoff rather than a delay?
- Does the page feel alive before and after navigation?
- Is the animation too loud for reading?
- Does the section turn feel distinct from archive navigation?
- Does reduced motion still feel intentional?
- Does Spotlight feel like an index, not a generic launcher?

### Subagent Review Passes

If subagents are available, use them after there is code or artifacts to inspect.
Do not use them to replace a coherent owner decision.

Suggested review lanes:

- UX/motion critique: interaction feel, pacing, continuity, taste.
- Accessibility/reduced-motion audit: focus, keyboard, motion preferences,
  screen-reader impact.
- Performance/reliability audit: blank frames, async races, service worker,
  slow network, cache behavior.
- Test coverage audit: missing route paths, weak assertions, artifact gaps.

## Remote Workflow

The local machine has limited disk and should not carry the heavy loop by
default. Prefer GitHub Actions for expensive validation.

This sprint is allowed to hammer GitHub Actions when the feedback is useful.
Use remote runners aggressively for browser, visual, PWA, slow-network,
Lighthouse, dependency, and broad regression checks instead of conserving local
machine resources. The constraint is not "run fewer Actions"; the constraint is
"run intentional suites, read the output, and do not spam identical failures
without learning from them."

### Default Loop

1. Make a small, coherent local change.
2. Run only cheap local checks needed to catch obvious mistakes.
3. Commit.
4. Push to `main` for small safe changes, or a branch for large reversible
   sprint chunks.
5. Trigger the narrowest relevant `Manual Checks` suite.
6. Inspect logs and artifacts.
7. Iterate with another small commit.
8. Periodically run `full-chromium` before declaring a phase done.

### Manual Check Suites

Use:

- `html` for `html-validate` dependency bumps or HTML-only changes.
- `check` for generated artifact freshness and AST/content contracts.
- `standalone` for the non-browser gate.
- `browser` for route, reader, transition, subpath, and not-found behavior.
- `pwa` for offline and service-worker behavior.
- `a11y` for accessibility, focus, and keyboard.
- `devices` for mobile/tablet/slow-network behavior.
- `visual` for screenshot diff review.
- `lighthouse` as a warning signal.
- `full-chromium` for a broad pre-finish sweep.

### Local Discipline

- Do not install new browser bundles locally unless explicitly approved.
- Avoid large writes to the C drive.
- Keep local runs focused.
- Do not rely on local-only behavior for final confidence.
- Keep the working tree clean between phases where possible.

## Branch And Commit Policy

The user is the only contributor and prefers direct `main` commits for small,
reversible changes. Use branches for large sprint chunks that need explanation,
review, or easy rollback.

Good direct-to-main changes:

- docs updates;
- focused test additions;
- tiny workflow hardening;
- narrow bug fixes with obvious scope.

Good branch candidates:

- transition system rewrite;
- Spotlight implementation;
- large `section.js` split;
- visual language overhaul;
- generated asset pipeline changes.

Suggested commit style:

- `docs(ux): define transition sprint bar`
- `test(transitions): guard blank-free navigation`
- `fix(transitions): keep destination readable on arrival`
- `feat(spotlight): add hidden index launcher`
- `refactor(reader): extract highlight link helpers`

## Refactor Rules

Refactoring is allowed, but it should serve the interaction work.

Prefer extraction when:

- duplicated behavior appears across Spotlight/search/archive/reader;
- tests are hard to write because a module has too many concerns;
- a bug is caused by tangled state ownership;
- `section.js` changes become risky due to unrelated behavior sharing scope.

Avoid extraction when:

- it is purely aesthetic;
- it delays transition fixes without reducing risk;
- it creates a new abstraction not used by the sprint;
- it splits files but preserves the same hidden coupling.

Likely extraction candidates:

- section transition state;
- highlight/deep-link resolution;
- selection sharing and citation;
- Spotlight/search result action building;
- shared route/action helpers;
- transition test helpers.

## Asset And Prototype Strategy

The sprint may generate more assets and prototypes, but shipped assets should
remain quiet and light.

Good uses:

- temporary transition prototype pages;
- visual comparison artifacts;
- small texture/rule/glint assets if CSS cannot achieve the right feel;
- generated social/OG assets for published content;
- QA screenshots and videos;
- fixture scenarios for route and motion states.

Risky uses:

- large decorative images;
- heavy animation libraries;
- effects that make prose secondary;
- assets that bloat reader navigation;
- visuals that do not survive reduced-motion or mobile review.

Promotion rule:

Prototype freely, ship sparingly. Keep the final motion language mostly in
timing, spatial continuity, typography, line work, and subtle state changes.

## Beta-Testing Protocol

This sprint should beta-test motion and Spotlight with more care than ordinary
feature work.

For each serious transition or Spotlight variant:

1. Capture the relevant path on desktop.
2. Capture the relevant path on mobile.
3. Capture reduced-motion behavior.
4. Run or inspect slow-network behavior if the path touches loading.
5. Save or upload artifacts when the difference is visual.
6. Record what felt better, worse, or uncertain.
7. Keep the variant only if it improves the product bar.

Questions to answer during beta review:

- Did the action acknowledge immediately?
- Did anything blank, flash, or feel late?
- Did the source and destination feel connected?
- Was the animation beautiful because it helped, or just because it moved?
- Did the reader remain the center?
- Did the result feel oracle-like or merely matched?
- Did keyboard/touch/reduced-motion users get a first-class path?

Use subagents as reviewers when artifacts exist, especially for motion critique,
accessibility, performance, and test coverage. Their job is to find gaps and
taste failures, not to create a fragmented design direction.

## Phase Plan

### Phase 0: Baseline And Evidence

Goal: understand the current transition feel and failure modes before changing
motion.

- [ ] List current transition code paths and state classes.
- [ ] Capture current route transition videos or traces.
- [ ] Identify the worst perceived-lag paths.
- [ ] Check normal, reduced-motion, mobile, slow-network, cached, and subpath
      behavior.
- [ ] Record findings in this document.

Phase 0 evidence to capture:

- current transition state/class diagram;
- current timing constants;
- current route flow notes;
- current worst-lag hypotheses;
- representative screenshots/videos/traces if available;
- current relevant Actions run ids.

Phase 0 exit criteria:

- roughness is described specifically by path;
- test/artifact gaps are known;
- first implementation target is chosen;
- no major transition rewrite has started without evidence.

### Phase 1: Acceptance Tests

Goal: build enough test coverage that animation changes cannot reintroduce
blanking, stuck states, or unreadable transitions.

Status (2026-06-15): `scripts/tests/transition-evidence-regression.js` landed in
`a2878f6` and covers several of these; ticks below reflect what that suite
verifiably asserts. Items left unticked have partial scaffolding (a
reduced-motion context option and a slow-network throttle hook exist) but no
confirmed assertion yet.

- [x] Add or strengthen blank-free navigation assertions (asserts body/main
      opacity > 0.9 and no stuck `aria-busy`).
- [ ] Add source-feedback timing assertions where deterministic (captures
      `clickToReadyMs`, but not yet a strict source-feedback gate).
- [ ] Add section prev/next readability assertions.
- [ ] Add back/forward assertions.
- [x] Add search-result-to-highlight assertions (search-result arrival scenario
      detects `mark[data-auto-highlight="1"]`).
- [ ] Add reduced-motion assertions (context option exists; assertion pending).
- [ ] Add slow-network cached/uncached expectations where useful (throttle hook
      exists; expectations pending).
- [x] Decide which visual artifacts should upload in Actions (suite captures
      trace.zip, video, and failure screenshots under `qa/`).

Phase 1 evidence to capture:

- new/changed test names;
- what each test prevents;
- whether tests are strict gates or warning/artifact checks;
- Actions suite used to prove them.

Phase 1 exit criteria:

- blank/stuck/unreadable regressions have automated guards;
- slow-network and reduced-motion expectations are explicit;
- artifact capture strategy is decided for transition beta work.

### Phase 2: Transition Language Prototypes

Goal: explore several motion treatments quickly before committing to one.

- [ ] Define candidate motifs.
- [ ] Prototype at least one archive/essay transition.
- [ ] Prototype at least one reader section turn.
- [ ] Prototype at least one search-result-to-prose handoff.
- [ ] Compare against the product bar.
- [ ] Keep notes on rejected variants and why.

Phase 2 evidence to capture:

- prototype names;
- route paths tested;
- videos/screenshots/traces reviewed;
- accepted/rejected notes;
- final chosen motif or decision to simplify.

Phase 2 exit criteria:

- chosen transition direction is recorded;
- rejected variants have reasons;
- implementation target is small enough to ship safely.

### Phase 3: Production Transition Hardening

Goal: ship the chosen transition language through real routes.

- [ ] Ensure immediate input acknowledgment.
- [ ] Preserve readable source content until commit.
- [ ] Reveal destination before flourish completes.
- [ ] Tune section prev/next separately from cross-page navigation.
- [ ] Preserve focus and scroll semantics.
- [ ] Keep reduced-motion elegant.
- [ ] Keep cached/offline behavior stable.
- [ ] Run relevant manual suites and record run IDs.

Phase 3 evidence to capture:

- changed files/modules;
- transition timing before/after where measurable;
- routes manually/artifact-reviewed;
- run ids;
- known remaining rough spots.

Phase 3 exit criteria:

- audited navigation paths are blank-free;
- section turn and cross-page transition decisions are documented;
- reduced-motion, mobile, subpath, slow-network, and cached paths are not
  broken;
- relevant gauntlet families pass or have documented exceptions.

### Phase 4: Critique And Beta Pass

Goal: stress the feel before starting Spotlight.

- [ ] Review artifacts manually.
- [ ] Use subagent critique if available.
- [ ] Test desktop and mobile viewports.
- [ ] Test keyboard and touch paths.
- [ ] Test slow-network and cached paths.
- [ ] Tune durations, easing, and visual weight.
- [ ] Update this document with final transition decisions.

Phase 4 evidence to capture:

- reviewed artifact list;
- critique notes;
- subagent findings if used;
- final motion tuning decisions;
- remaining issues accepted or deferred.

Phase 4 exit criteria:

- transition system feels ready to support Spotlight;
- subjective review notes exist;
- no major known motion defect is being carried into Spotlight.

### Phase 5: Oracle Search Foundations

Goal: build the search substrate that makes Spotlight feel like an oracle
instead of a modal around substring matching.

- [ ] Design generated passage index shape.
- [ ] Generate AST-derived passage records.
- [ ] Generate essay and section search records.
- [ ] Add index freshness checks.
- [ ] Add artifact size reporting.
- [ ] Add unpublished-content exclusion checks.
- [ ] Add query parser and normalization fixtures.
- [ ] Add ranking engine with score explanations.
- [ ] Add ranking fixtures for exact, loose, fuzzy, contextual, and concept
      matches.
- [ ] Add debug output for top-result reasoning.
- [ ] Decide whether `data/search-index.json` is one artifact or split by
      concern.

Phase 5 evidence to capture:

- generated artifact shape;
- schema/validator decisions;
- fixture catalog;
- ranking examples;
- artifact size/timing;
- unpublished exclusion proof.

Phase 5 exit criteria:

- generated index exists or a deliberate alternative is documented;
- ranking fixtures prove top-result behavior;
- search debug output can explain surprising results;
- generated artifact freshness is checked.

### Phase 6: AST Anchors And Search Surface Migration

Goal: make existing reader/search surfaces benefit from the oracle engine before
Spotlight becomes the main entry point.

- [ ] Generate stable passage anchors.
- [ ] Render passage anchor metadata in reader content.
- [ ] Teach reader routes to resolve passage anchors.
- [ ] Add range/offset highlight support where needed.
- [ ] Preserve fallback for old query/occurrence links where feasible.
- [x] Upgrade full search to oracle results. (2026-06-16)
- [x] Upgrade archive inline search. (2026-06-16)
- [x] Upgrade essay inline search. (2026-06-16)
- [ ] Update copy/citation links if stable anchors are ready.
- [ ] Update service-worker/offline assets if generated search data is cached.
- [ ] Run remote suites for search, browser, PWA, a11y, and subpath behavior.

Phase 6 evidence to capture:

- anchor URL grammar decision;
- reader resolution order implementation notes;
- old URL recovery behavior;
- full/inline search migration notes;
- copied link behavior;
- PWA/cache decision.

Phase 6 exit criteria:

- existing search surfaces share the oracle truth;
- reader anchors resolve and recover;
- old reader-facing links degrade gracefully where feasible;
- offline/cache behavior is documented and tested.

### Phase 7: Spotlight Design

Goal: specify Spotlight in Renaissance terms before implementation.

- [ ] Define opening/closing behavior.
- [ ] Define result grouping.
- [ ] Define current-context actions.
- [ ] Define Continue Reading presentation.
- [ ] Define keyboard and mobile behavior.
- [ ] Define empty/error/offline states.
- [ ] Define result activation transitions.
- [ ] Define tests.

Phase 7 evidence to capture:

- UI sketch or verbal layout decision;
- default row order;
- grouping decision;
- keyboard model;
- mobile model;
- empty/offline state decision;
- activation transition decision.

Phase 7 exit criteria:

- Spotlight can be implemented without inventing product behavior ad hoc;
- any unresolved design decision is explicitly listed in Open Decisions.

### Phase 8: Spotlight Implementation

Goal: build Spotlight as a production interaction, not a generic overlay.

- [ ] Add shell markup and styling.
- [ ] Add open/close/focus behavior.
- [ ] Add search and action model.
- [ ] Add keyboard navigation.
- [ ] Add mobile layout.
- [ ] Add route activation.
- [ ] Add reduced-motion handling.
- [ ] Add tests.
- [ ] Run manual suites.

Phase 8 evidence to capture:

- open/type/activate/close artifacts;
- keyboard test results;
- mobile screenshots/videos;
- reduced-motion proof;
- oracle result examples;
- activation route proof.

Phase 8 exit criteria:

- Spotlight passes core interaction tests;
- default rows feel useful;
- query rows feel oracle-like;
- activation uses hardened transitions;
- downstream roughness exposed by Spotlight is fixed or explicitly recorded.

### Phase 9: Final Sweep

Goal: leave the repo better documented and easier to resume.

- [ ] Run broad remote validation.
- [ ] Review visual/Lighthouse artifacts.
- [ ] Run the relevant hardening gauntlets from
      `docs/specs/HARDENING-GAUNTLETS-SPEC.md`.
- [ ] Record which screenshots, videos, traces, ranking reports, and anchor
      diagnostics were reviewed.
- [ ] Confirm focused Actions suites exist for the sprint's new risk surfaces:
      oracle search, anchors, transitions, Spotlight, PWA/cache, a11y,
      security/content, performance, and hardening-full.
- [ ] Update docs/architecture/QA if behavior changed.
- [ ] Update roadmap checkboxes.
- [ ] Record final manual run IDs.
- [ ] Record known follow-ups.

Phase 9 evidence to capture:

- final run list;
- artifact review summary;
- accepted visual baseline notes;
- remaining risks;
- deferred scope;
- release/merge notes.

Phase 9 exit criteria:

- sprint docs match shipped behavior;
- gauntlet results are recorded;
- follow-ups are explicit;
- repo is in a clean, reviewable state.

## Acceptance Checklist

Use this before declaring the transition portion done.

- [ ] Every audited navigation path has a pass/fail note.
- [ ] No path blanks the page.
- [ ] No path leaves transition classes stuck.
- [ ] No path hides readable content behind animation.
- [ ] Back/forward feels native.
- [ ] Section prev/next feels faster and more book-like than full navigation.
- [ ] Search-result deep links land cleanly and highlight correctly.
- [ ] Mobile touch feedback is immediate.
- [ ] Keyboard flow is intact.
- [ ] Reduced-motion path is quiet and complete.
- [ ] Slow-network path is calm.
- [ ] Cached/PWA path is excellent.
- [ ] `/renaissance/` subpath remains safe.
- [ ] CI/manual checks cover the risk surfaces.
- [ ] Visual artifacts have been reviewed.

Use this before declaring Spotlight done.

- [ ] Oracle search index is generated from AST.
- [ ] Search freshness checks are part of `npm run check`.
- [ ] Ranking fixtures assert top-result order and reasons.
- [ ] Passage anchors resolve in the reader.
- [ ] Existing full/inline search surfaces use the new search truth.
- [ ] Old reader-facing search links recover where feasible.
- [ ] Unpublished essays remain excluded.
- [ ] Search index/cache behavior is documented.
- [ ] Opens with `Cmd/Ctrl+K`.
- [ ] Closes with Escape and returns focus.
- [ ] Keyboard navigation is predictable.
- [ ] Mobile layout is usable.
- [ ] Results update quickly.
- [ ] Continue Reading and contextual actions are first-class.
- [ ] Search results route correctly.
- [ ] Empty/offline/error states feel authored.
- [ ] Activation uses hardened transitions.
- [ ] Tests cover open/close, keyboard, routing, reduced motion, and mobile.

## Live Findings

Add dated notes here as the sprint proceeds.

### 2026-06-15 (oracle built + wired into Spotlight)

- Built the oracle end-to-end: term stats in the index, idf-weighted signal
  ranking, snippet word-boundary clipping, lexicon synonym seam, fixtures, and
  Spotlight migrated onto it. On the corpus, "omega point" went from 17 rows
  (8 just "point") to 4 clean hits; '"grain of sand"' lifts the Blake epigraph
  in §8 to the top via section-title affinity.
- IMPORTANT GOTCHA for anyone touching the index or anchors: the reader renders
  `withoutLeadingHeadings(ast)` and numbers passages (`data-passage-id`) from
  that content projection, NOT the raw AST. The generated index MUST use the
  same projection (`withoutLeadingHeadings`) or passage IDs/offsets shift by each
  section's leading heading(s) and reader highlight anchors land on the wrong
  text. The `spotlight` browser suite caught this; node fixtures did not, because
  the misalignment only shows up against the rendered DOM.
- Also: any change to `data/search-index.json` (or any precached asset) must be
  followed by `node scripts/generate-cache-version.js`, or the service worker
  serves a stale index offline. `npm run check` gates this.
- KNOWN CAVEAT (deferred fix): hard-break passages (poems/epigraphs, e.g. the
  Blake quote in §8) differ between the index's searchable text (lines joined by
  a space) and the rendered DOM (`<br>` contributes nothing, merging words). A
  range highlight into such a passage is off by the number of preceding breaks,
  and reader copy-paste merges the words. The proper fix is to emit a space text
  node before `<br>` in the AST renderer (also fixes copy). Until then,
  `passage-alignment-regression` compares text whitespace-insensitively so it
  still guards count/ID/heading-shift/content drift. The
  `withoutLeadingHeadings` alignment fix already covers the common case; this is
  the narrow remaining edge. Surfaced by the new browser alignment test.
- Workflow win: dispatching the `standalone` suite remotely surfaced three latent
  Spotlight-launcher failures (dom-sink, precache, asset-budget) that local runs
  and the branch's prior partial suites had never exercised.

### 2026-06-15 (Phase 5 start + latent gate fixes)

- Landed the first Phase 5 checkpoint: `scripts/generate-search-index.js`
  generates `data/search-index.json` (1 essay, 10 sections, 518 passages) from
  the AST, stamped with the grammar version, unpublished essays excluded.
  Wired `validate:search-index:check` into `npm run check` and
  `test:search-index` into the standalone gate.
- Key de-risking finding: the runtime search engine already consumes AST
  `passages` (passageId/index/blockType/source offsets) via `preparePassage` and
  emits anchored hits, so the generated index is a precompute of an existing
  shape, not a new model. Migration is the work; the data model already exists.
- Dispatching the `standalone` suite remotely surfaced three latent failures
  from the Spotlight launcher commit (`781bd7b`) that no prior branch run had
  exercised: an unreviewed `innerHTML` sink set in `spotlight.js`, a missing
  `scripts/spotlight.js` service-worker precache entry, and `section.html`
  exceeding its asset-weight budget. All three fixed in `be0d8a1`. Lesson: run
  `standalone` after any commit that adds a runtime script, not just the browser
  suites.
- Open decision for the user: `section.html` asset budget was raised 264KB ->
  304KB to absorb the cross-page Spotlight weight. If that is too loose, the
  alternative is splitting the 86KB `section.js` rather than growing the budget.

### 2026-06-15 (doc reconciliation)

- This document had drifted behind the code. `Current Sprint State` still read
  "Phase 0 baseline/evidence in progress; no product behavior changes yet"
  while the branch already carried five post-contract commits shipping real
  product behavior. The state, journal, and Spotlight scope have been corrected
  to match the commits below; no code changed during this reconciliation.
- Actual landed work (commits after the docs contract `b187651`):
  - `a2878f6` transition evidence suite — Phase 1.
  - `524a9ab` section transition warmup — Phase 3 (partial).
  - `2a62156` AST passage anchor routing for search/reader — Phase 6 (partial).
  - `781bd7b` Spotlight launcher — Phase 8 (partial).
  - `7302522` Spotlight regression wait stabilization — Phase 8.
- Work proceeded non-linearly: a first Spotlight launcher and anchor routing
  landed before Phase 2 prototypes, Phase 4 critique, Phase 5 generated oracle
  index, and Phase 7 Spotlight design were done as discrete phases. Search is
  still runtime/client-side; only AST anchor routing landed, not a generated
  index. Treat the shipped motifs and Spotlight as a working spike that still
  owes its Phase 2/4/5/7 evidence and design records.
- Process note for future sessions: per this doc's own rules, update
  `Current Sprint State` whenever a phase item ships. The drift here is exactly
  the failure mode the Resume Protocol is meant to prevent.

### 2026-06-14

- Manual `Manual Checks` workflow exists on `main` and the `html` suite passed
  once after landing.
- The next implementation work should begin with transition diagnostics and
  tests, not Spotlight UI.

### 2026-06-15

- Sprint planning expanded from transition + Spotlight into a broader
  transition/oracle-search/AST-anchor/downstream-hardening program.
- Old search API compatibility is not a constraint; public reader-facing
  recovery remains important.
- Expanded Actions suites are part of the sprint implementation, not deferred
  wishlist work.
- Artifact review is mandatory where it teaches something: traces, screenshots,
  videos, ranking reports, anchor diagnostics, and generated artifact summaries.
- Next implementation work should happen on a sprint branch.
- Sprint branch `sprint/transition-spotlight-oracle` created, pushed, and set to
  track `origin/sprint/transition-spotlight-oracle`.
- Phase 0 baseline/evidence started. No product behavior changes yet.
- Manual Checks `check` run `27505347555` passed on the sprint branch at
  commit `b187651`.
- Subagents are unavailable in this session due account/usage limits. Continue
  the sprint locally with remote Actions for independent compute signal.
- Cross-page transitions use `scripts/page-transition.js` plus CSS classes on
  `<html>`. SUPERSEDED 2026-06-16 (continuity hardening): the destination reveal
  is now **composed**, not immediate — a CSS paper veil (`main` visibility:hidden
  until `page-transition-ready`, non-reduced-motion only) holds the content until
  it has rendered (`renaissance:page-ready`), capped at `REVEAL_CAP_MS` so a slow
  load reveals anyway. `OUT_DURATION_MS` raised 16 -> 120 for a perceptible
  graceful out. Reduced motion keeps the immediate, unveiled path. The reveal
  fires `renaissance:page-revealed`, which continuity uses to begin its flight as
  the content composes in.
- Cross-page transition coverage currently asserts no stuck hidden state, no
  delayed destination reveal, reduced-motion shell visibility, back navigation,
  and source geometry preservation. It does not yet record frames, screenshots,
  traces, mobile timing, slow-network timing, or search-result-to-highlight
  arrival.
- Reader section navigation is a separate in-page path in `scripts/section.js`.
  It queues feedback immediately, but waits for `loadSection()` before the
  visible turn starts. On a cold section load this can feel like lag even though
  the click was accepted.
- Reader section turns currently use a 130ms outgoing phase and 260ms incoming
  phase. The new content is inserted between phases, starts at opacity 0 for an
  entering frame, then animates back through the default article transition.
  This is likely the first transition hardening target.
- Section prefetch happens on hover/focus only. Touch/pointerdown does not
  currently prefetch before activation, so mobile next/previous section taps can
  miss the warm-cache path.
- Search is currently runtime/client-side and section-text based. It scans essay
  title, section title, section label, and body fields; occurrence numbers are
  assigned in field-scan order per section. Body highlight resolution later
  searches rendered section text again. That can become ambiguous when title or
  label hits share the same occurrence counter as body hits.
- The AST parser already preserves source positions and the content loader
  already has `contentAst`, but rendering strips AST identity into legacy DOM
  nodes. The sprint should carry passage IDs/signatures from AST into rendered
  DOM and generated search records instead of bolting anchors on after render.
- The reader already supports `p`, `r`, copied highlight payload, `q/occ`, and
  query-only anchor strategies, with precedence in that order. New search and
  Spotlight links should prefer structural/range anchors and keep `q/occ` only
  as fallback/recovery.
- Existing slow-network coverage only proves archive and essay page rendering
  under Slow-3G. It does not exercise section next/previous, search index warmup,
  Spotlight open, or search-result arrival under network throttling.
- Existing device coverage checks archive, essay, section, and search rendering
  across several descriptors. It does not verify Spotlight, transition frame
  continuity, or destination highlight geometry on mobile.

## Run Log

Use the run log for meaningful CI/manual validation runs. Do not record every
tiny local command.

```text
Date: 2026-06-15
Run: 27505347555
Suite: Manual Checks / check
Branch/ref: sprint/transition-spotlight-oracle
Commit: b187651
Result: passed
Artifacts: none expected
Reviewed: run summary and job step conclusions via gh CLI
Notes: branch publication and lightweight remote validation for docs contract
Next: add diagnostic/evidence tests and trigger targeted browser/device suites
```

```text
Date: 2026-06-15
Run: 27506490802-27506555991 (six Manual Checks dispatches)
Suite: Manual Checks (various)
Branch/ref: sprint/transition-spotlight-oracle
Commit: spotlight launcher / anchor / transition-warmup checkpoints
Result: passed (all green)
Artifacts: transition-evidence/spotlight suites produce traces, video, and
screenshots under qa/ when run; not yet reviewed for this log
Reviewed: run conclusions via gh run list
Notes: validated the post-contract feature checkpoints remotely. Artifact
review (Phase 2/4 motion critique) is still outstanding.
Next: review captured transition/Spotlight artifacts and record motif decisions.
```

## Artifact Review Log

Use this when reviewing screenshots, videos, traces, ranking reports, anchor
diagnostics, or visual diffs.

```text
Date:
Artifact:
Run:
Flow/query:
Viewport/theme/motion:
Reviewed:
Decision:
Follow-up:
```

## Decision Log

Use this for decisions that affect implementation direction.

```text
Date: 2026-06-15
Decision: Continue without subagents in this sprint session.
Context: Attempted exploratory subagents failed due account/usage limits before
doing useful work.
Chosen path: main Codex agent keeps the sprint moving locally, with GitHub
Actions providing remote compute, artifact capture, and independent reruns.
Rejected alternatives: wait for subagent quota; narrow sprint scope.
Tradeoffs: less parallel code review, but no blocker to implementation.
Follow-up: use Actions artifacts and run logs as the main external evidence.
```

```text
Date: 2026-06-15
Decision: First implementation checkpoint should be evidence harnesses, not
motion polish.
Context: Current tests prove pages are not hidden, but do not capture frame
continuity, slow-network section transitions, or search result arrival quality.
Chosen path: add targeted transition/search/anchor diagnostics before tuning
CSS/JS timings.
Rejected alternatives: edit transition durations by feel first.
Tradeoffs: slightly slower start, much better feedback loop for the user's
"200ms lag kills the magic" bar.
Follow-up: add remote artifact upload for screenshots/videos/traces once the
harness exists.
```

```text
Date:
Decision:
Context:
Chosen path:
Rejected alternatives:
Tradeoffs:
Follow-up:
```

## Deferred Scope

Anything intentionally deferred from this sprint should be listed here.

```text
Item:
Why deferred:
Safe because:
Reopen when:
Tracking:
```

## Open Decisions

- [ ] Should reader section turns use a separate in-page transition language
      from cross-page navigation?
- [ ] Should cross-page navigation keep the current line/glint motif, replace
      it, or make it more contextual?
- [ ] Should we prototype with a temporary route/motion lab page?
- [ ] Which artifacts should be uploaded for routine transition beta-testing:
      screenshots, videos, traces, or all of them?
- [ ] How strict should slow-network timing assertions be for uncached first
      visits versus cached repeat visits?
- [ ] Should Spotlight ship in one sprint after transitions, or begin as an
      experimental hidden feature behind keyboard access only?
- [ ] Should oracle search use one generated `data/search-index.json` artifact
      or split passage, term, and metadata files?
- [ ] Should public passage URLs expose simple paragraph IDs or opaque generated
      anchor IDs?
- [ ] How much authored lexicon/motif metadata should ship in the first oracle
      version?
- [ ] Should full search keep explicit modes after oracle ranking lands, or
      become simpler and more Spotlight-like?

## Known Risks

- Subjective smoothness cannot be fully automated.
- More animation can easily create more perceived lag.
- Cross-browser motion behavior may differ.
- Service worker cache behavior can hide or reveal transition bugs depending on
  install state.
- Visual artifacts can become noisy if baselines are unstable.
- `section.js` is large and can make reader changes risky.
- Spotlight may tempt broad command-palette scope creep.

## Recovery Plan

If a change makes the site feel worse:

1. Revert the smallest transition-specific commit if possible.
2. Preserve tests that caught a real regression.
3. Record the failed motif or approach in this document.
4. Prefer a simpler readable transition over an impressive fragile one.

If remote Actions fail because of infrastructure:

1. Check whether the suite is too broad for the failure.
2. Retry once if the failure is clearly external.
3. Inspect logs/artifacts before changing code.
4. Narrow the suite and reproduce the specific failure path.

If local disk pressure becomes a blocker:

1. Stop local heavy runs.
2. Commit/push small changes.
3. Use manual checks remotely.
4. Avoid dependency installs or browser downloads locally unless explicitly
   approved.
