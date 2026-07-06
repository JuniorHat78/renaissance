# Scriptorium — the native desktop editor

> The umbrella vision + architecture for a **true zero-dependency native editor**:
> a Windows app built on hand-rolled Win32 + COM/DirectWrite FFI, where *we own the
> entire text engine* (buffer, layout, caret, input) above the OS line, reusing the
> crate-free `rust/` parser **in-process**. The destination the PWA was always a
> stepping stone toward.
>
> This is the **north star + the living roadmap**. It is strong on the things that
> must not drift — the dependency line, the layer boundaries, the invariants — and
> deliberately *loose* on the thing that can only be discovered: feel. A monument's
> feel cannot be specced up front, so this doc commits to the skeleton and the laws
> and stays humble about the flesh. Per-component design lives in just-in-time
> specs spawned from §5 as we go deep on each.
>
> **Lineage.** Supersedes the Win32 + RichEdit native-shell sketch in
> `SCRIPTORIUM-RUST-PARSER.md` (opposite philosophy — see §3/§8). Assumes
> `SCRIPTORIUM.md`'s spine invariant (§2) and quarantine (§6) as settled law.
> Builds on the shipped `rust/` core (parser cutover complete; `SCRIPTORIUM-RUST-PARSER.md`
> §14). The JS⇄wasm boundary is measured and closed (`SCRIPTORIUM-WASM-MARSHALLING.md`).
>
> Status: **building — N0, N1, N2a, N3, N4 shipped; N2b built spec-correct (feel unvalidated).**
> The platform/render walking skeleton (N0), the persistent-rope text buffer (N1), input
> correctness N2a (selection + grapheme/word motion + clipboard), N3 (layout maturity:
> retained-layout geometry service, vertical motion, scrolling, mouse click/drag/double/triple
> + autoscroll), and **N4** (concurrency: off-thread parse on an O(1) rope snapshot, a single-slot
> coalescing mailbox, a `content_gen` staleness gate, a contentless `WM_APP` post-back, leak-free
> teardown, latency instrumentation) are built and CI-validated (COM-from-raw-Rust, the crate-free
> rope, the geometry oracle, and now the concurrency mechanism all proven — §8). **N2b** (IME
> composition: `WM_IME_*` + imm32, provisional-not-in-rope, inline rendering, candidate window) is
> built to **spec-correct** with pure state-machine/splice oracles + a crash/leak smoke guard — but
> its *feel* is un-oracle-able by the implementer and **queued for the author** to judge on a real
> IME (§8, `SCRIPTORIUM-NATIVE-IME.md`). N4's latency *feel* on book-scale content is likewise
> queued (§8, `SCRIPTORIUM-NATIVE-CONCURRENCY.md`). The roadmap's named nodes N0–N4 are **all built**;
> the N4 latency dig then measured that the **whole-doc DirectWrite relayout — not parse — is the real
> UI-thread cliff** (15–34× parse, superlinear, crosses 60 fps at ~8K words), which **promoted
> virtualized layout from `siren` to `need-now` as N5**, and **N5 is now built** (2026-07-06,
> `SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md`): the whole-doc `IDWriteTextLayout` is gone — geometry is
> synthesized from a per-paragraph height index + per-paragraph transient layouts, behind the
> unchanged N3 seam, with a headline equivalence oracle (virtualized ≡ whole-doc) proving the cliff
> died without moving geometry. Ahead of N5, **file I/O is built** (open/save/dirty-state with a
> preserve-on-save codec + a three-way discard guard — `SCRIPTORIUM-NATIVE-IO.md`), because loading a
> real manuscript is the prerequisite for the author's queued feel verdicts (N2b IME, N3 scroll/caret,
> N4 latency, N5 scrolling). Last refreshed: 2026-07-06.

---

## 1. Why native — and what "feels right" means

Scriptorium already runs as an installable PWA. It works. But it **didn't feel
right**, and the reason is not the chrome — it's the *engine*. A browser engine is
the single largest uncontrolled dependency in software: millions of lines you didn't
write, owning your input pipeline, your layout, your paint timing, your latency.
Wrapping it in an app window (Chrome `--app`, the `scriptorium-server` launch path)
puts it in a costume; it's the same engine underneath, and you still don't own the
pixels or the keystroke-to-photon path.

The goal here is a **monument**: an editor where every layer of the feel is ours.
The working philosophy is *Apple craftsmanship + cracked-engineering rigor* — own
the whole stack, sweat the latency and the caret and the scroll, and let nothing
between the author's intent and the glass be something we didn't build.

"Feels right" is not one thing. It decomposes, and each piece maps to a layer we
will own (§4):

- **Input latency** — keystroke → visible change, with no engine in the way.
- **Render smoothness** — no jank, no tearing, frame-paced repaint.
- **Caret & scroll feel** — precise, weighted, predictable motion.
- **Text crispness** — typographic quality (this one we *delegate* to the OS text
  stack; see §3 — it's not where craftsmanship lives).

These are discovered by *using* builds, not by specifying them (§6). The spec's job
is to make sure the architecture doesn't stand in the way of tuning them.

## 2. Non-negotiables

1. **Zero third-party dependencies.** The dependency line is drawn at the OS API
   (§3). No crates — not even binding crates (`windows-sys`). `std` + hand-rolled
   FFI only, the same ethos as the `rust/` core (`Cargo.toml`'s "no `[dependencies]`").
2. **We own the text engine.** Buffer, layout, caret, selection, input, undo are
   ours. The OS provides a window, a surface, input events, and glyph rasterization —
   nothing more. (This is the precise inversion of the old RichEdit plan; §3, §8.)
3. **One parser, reused in-process.** The editor parses author text through the same
   `rust/` core the build uses — no editor-private parse, no wasm, no marshalling.
   The spine invariant (`SCRIPTORIUM.md` §2): the editor cannot preview a lie.
4. **The quarantine holds.** The native editor is *author tooling*. It is never
   shipped to readers, never in the reader precache/budget/gauntlets (`SCRIPTORIUM.md` §6).
5. **Measure before optimizing.** No `need-now` claim without a number. The cool
   systems components (§5) stay parked behind `measure-gated` tags until a benchmark
   demands them. (Precedent: the marshalling boundary, specced then *refuted* by
   measurement — `SCRIPTORIUM-WASM-MARSHALLING.md`.)

## 3. The dependency philosophy — the spine

**The line is drawn at the OS API.** Below it is the platform (kernel, OS
libraries, the GPU/display stack) — the floor every native app stands on. Above it
is everything we build. The line is not "no FFI"; it is "no dependency *in our
graph* — nothing with a lockfile entry, a build script, or a maintainer who isn't
us or the OS vendor."

Two distinctions make this coherent and keep it from collapsing into either
zealotry or hypocrisy:

**Behavior vs. provenance.** The `rust/` core's existing line is *provenance*-zero
(no crates in the graph), not *behavior*-zero — it freely uses `std`, which is a lot
of behavior we didn't write. The OS is one level below `std`: it's the platform, not
a dependency. So FFI-ing to Win32/DirectWrite *honors* the line — we are calling the
floor, exactly as `std` calls the floor — whereas adding `windows-sys` *crosses* it,
because that puts a crate (lockfile line, `build.rs` that executes at compile time) in
our graph. Same OS behavior either way; the crate is the thing we refuse.

**Where hand-rolling is craftsmanship and where it's zealotry.** The test: does
hand-rolling buy *capability/control*, or only *keystrokes*?

| We hand-roll | We delegate to the OS | Why |
|---|---|---|
| FFI **binding declarations** (window, COM vtables, input) | — | Costs only typing; identical capability either way; keeps the graph + build-time code-execution at literal zero. Small surface (~50–100 entry points), declare-only-what-we-call, vendored + auditable in our repo. |
| The **text engine** (buffer, layout, caret, selection, undo, input semantics) | — | This is *where feel lives*. Owning it is the entire point. |
| — | **Glyph rasterization** (DirectWrite) | Hand-rolling = re-implementing TTF parsing + bézier fill the OS already does. Huge cost, zero user-visible gain. Zealotry. The OS turns glyphs into pixels; we own everything *around* the glyphs. |
| — | **The window/compositor/GPU** (Win32/DWM) | The platform floor. |

The supply-chain consequence of hand-rolling the bindings: **zero** crates.io
surface and **zero** foreign `build.rs` executing on the build machine. The one cost
we accept in exchange is *binding correctness* — a wrong `#[repr(C)]` layout or
calling convention is UB, where a generated crate would be correct. Mitigation: the
surface is small and bounded, declared incrementally, and tested as added (§6).

**Concrete decisions (settled — see the ledger, §8):**
- Platform: **Windows-first**, Win32 + COM. A thin platform seam (§4) leaves room
  for other OSes later, but only Win32 is implemented. (Cross-platform: open, §9.)
- Text: **DirectWrite** (shaping + glyph rasterization) via hand-declared COM. Not
  GDI (dated), not RichEdit (it would own the caret — the opposite of non-negotiable #2).
- Bindings: **hand-declared**, no `windows-sys`.
- Rendering surface: **CPU framebuffer / software** to start (Direct2D or GPU is an
  open, measure-gated escalation — §5, §9). Plenty for text; total control; simplest.

## 4. The layer cake

```
┌─────────────────────────────────────────────────────────────┐
│  Document / IO        files, atomic save, encoding, watch     │  new
├─────────────────────────────────────────────────────────────┤
│  Editor core          text buffer · caret/selection model ·   │  new
│                       input semantics · undo · commands       │
├─────────────────────────────────────────────────────────────┤
│  rust/ PARSER + AST   parse_document(&[u16]) -> Document       │  REUSED
│                       (in-process: no wasm, no marshalling)    │  (shipped)
├─────────────────────────────────────────────────────────────┤
│  Render / present     AST -> IDWriteTextLayout -> draw ·       │  new
│                       damage tracking · frame-paced repaint    │
├─────────────────────────────────────────────────────────────┤
│  Platform layer       hand-rolled FFI: window · surface ·      │  new
│                       input events · DirectWrite handles       │  (thin seam)
├─────────────────────────────────────────────────────────────┤
│  OS  (the line)       Win32 · COM · DirectWrite · DWM          │  the floor
└─────────────────────────────────────────────────────────────┘
```

**What is reused vs. new — read this before assuming the hard part is done.** The
*parser* (`rust/`, oracle-validated, shipped) is reused as a plain in-process call —
that's the one big thing already built. **Everything in the presentation stack is
new.** `rust/`'s `render.rs` emits *HTML* for the webview and is **not** reusable
natively; the native render path (AST → layout → draw) is written from scratch. The
parser was the foothills; the editor engine is the mountain.

**The platform seam.** The platform layer is the only place that touches Win32/COM.
Everything above it speaks in our own types (a window handle, a surface to draw on, an
input event, a text-layout handle). Implemented for Win32 only, but expressed behind a
thin internal boundary so a second OS *could* slot in later without rewriting the
editor core. We do **not** build that abstraction speculatively beyond the one seam.

## 5. Component catalog — the growable heart

Each component below gets a just-in-time spec (`SCRIPTORIUM-NATIVE-<COMPONENT>.md`)
when we go deep on it. Status tags keep §2.5 honest:
**`need-now`** = load-bearing for the skeleton/feel/correctness;
**`siren`** = real and beautiful but measure-gated — do not build until a number demands.

| Component | What it is | Status | Notes |
|---|---|---|---|
| **Platform/render skeleton** | Window + DirectWrite text + caret + keyboard, end to end, reusing `rust/` parse | `need-now` | First build target (§7). De-risks COM-from-raw-Rust FFI; unlocks the feel-loop. The deepest single piece. **Spec: `SCRIPTORIUM-NATIVE-SKELETON.md`.** |
| **Text buffer** | Editable document structure (gap buffer · piece table · rope) | `need-now` | The data-structure heart; load-bearing for the "scales to a whole book" story. Naive `Vec<u16>` + whole-section reparse is *measured fine* for now — but the buffer is what keeps it fine as docs grow. Most fun to reason through. **Resolved: a persistent augmented chunked rope (N1) — `SCRIPTORIUM-NATIVE-BUFFER.md`.** |
| **Input correctness** | Grapheme clusters (UAX #29), line breaking (UAX #14), IME (`WM_IME_*`) | `need-now` | Caret moves by *grapheme*, not codepoint. IME is the sleeper that decides if it "feels right" for non-ASCII. The #1 jank tell. |
| **Layout/render maturity** | Selection geometry, scrolling, hit-testing on `IDWriteTextLayout` | `need-now` | Build on DWrite's layout object so hit-testing + caret geometry come *free* (`HitTestPoint`/`HitTestTextPosition`); don't re-implement caret math. |
| **Concurrency / latency** | UI thread sacred; off-thread IO/heavy work; input coalescing | `need-now` | Where snappiness is *born*. Channel/lock-free handoff; never paint a half-updated model; coalesce N keystrokes → 1 reparse+paint. |
| **Layout oracle** | Golden-geometry tests (caret positions, wrap points, hit-tests) | `need-now` | Extends the parser's fearless-refactor rigor to the renderer. Geometry is deterministic; feel is not (§6). Almost nobody does this — it's a signature discipline. |
| **Undo/redo** | Edit history (stack · tree · persistent structure) | `need-now`* | *Minimal first; the *elegant* version (free undo from a piece-table's immutable original) couples to the buffer choice. |
| **Durability / IO** | Atomic save (temp+rename), encoding detection, file watch, maybe mmap/WAL | `siren` | Crash-safety as systems work. A journal so an edit is never lost — gorgeous, but gate on need. |
| **Virtualized layout** | Lay out only the viewport; estimate + correct scroll geometry | **✅ BUILT (N5, 2026-07-06)** | **Promoted from `siren` by measurement (§8, 2026-07-05), then built:** the whole-doc `IDWriteTextLayout` rebuild was the real UI-thread cliff — 15–34× parse, superlinear, crosses 60 fps at ~8K words. Now a per-paragraph height index + per-paragraph transient layouts + scroll-anchoring, behind the unchanged N3 seam; the equivalence oracle proves virtualized ≡ whole-doc geometry. Feel queued. **Spec: `SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md` (BUILT).** |
| **Incremental parse** | Reuse unchanged subtrees; reparse only the dirty span (tree-sitter-shaped) | `siren` | Still parked. Parse is off-thread (N4) and linear — 25 ms at 200K words on the worker, invisible. Reach for subtree-reuse only when a measurement shows the *worker* falling behind the typist. (Layout, not parse, was the cliff — §8.) |
| **Arena allocation** | Bump allocator reset per parse; reuse the input scratch (`utf16le_units` copy) | `siren` | The concrete cash-out of the perf note in `SCRIPTORIUM-WASM-MARSHALLING.md` §5. Invisible until a doc is huge, then decisive. |
| **Search** | In-document find; full-text (hand-rolled, no `regex` crate) | `siren` | The site already has a search-index discipline to borrow from. |

## 6. The feel discipline

**Feel cannot be specced or generated; it is discovered by the author reacting to
builds.** This is the one half that cannot be outsourced to the implementer:

- The implementer builds and *proposes* (candidate easing curves, blink timings,
  scroll weights). The author *reacts* — "worse," "better," "yes, that." Articulation
  is **not** required; reaction is. We generate options; the author points.
- The non-negotiable cadence: there must always be a runnable thing to feel. This is
  why the skeleton comes first (§7) — the feel-loop cannot start before something runs.

**Testing loses its oracle — partly.** The parser had byte-identical equivalence;
fearless refactors. A GUI's *feel* has no such net. But its **geometry does**:

- **Deterministic, oracle-able:** caret positions, line-break points, hit-test
  results, selection rectangles, scroll offsets. → the **layout oracle** (§5):
  golden geometry, snapshot-tested, bringing the parser's rigor to the renderer.
- **Not oracle-able:** smoothness, latency, "rightness." → manual feel-loop + frame-time
  budgets as guards (warn, never gate — consistent with the project's CI philosophy).

## 7. Roadmap / sequencing (living)

Strategy: **breadth-thin-then-depth.** A walking skeleton first — itself the first
deep dive, because the platform/render layer *is* one of the deepest components — then
go deep component-by-component. Rationale: retire the existential FFI/COM risk in week
one; give the feel-loop a substrate immediately; write the deep specs against a real
skeleton, not speculation. Each phase below spawns its own JIT component spec.

- **N0 — Platform/render walking skeleton.** `[BUILT + CI-validated → SCRIPTORIUM-NATIVE-SKELETON.md]`
  A window, a DirectWrite-rendered buffer of text, a blinking caret, keyboard input,
  parsing through `rust/` in-process. Hand-roll exactly the Win32 + COM/DWrite bindings
  this needs. **Exit:** you can type into a real native window and see rendered prose
  with a live AST signal, and the COM-FFI question is answered. Unlocks the feel-loop.
  **Done (2026-06-27):** the bin tree links against real d2d1/dwrite/user32/kernel32 on
  `windows-latest` (stable + beta) and the geometry oracle passes on real DirectWrite —
  **COM-from-raw-Rust is tolerable** (§8). Next: N1.
- **N1 — Text buffer.** `[BUILT + CI-validated → SCRIPTORIUM-NATIVE-BUFFER.md]` The
  buffer decision (rope vs piece-tree) **resolved to a persistent, augmented, chunked
  rope** — async-ready via O(1) structural-sharing snapshots, coordinate-native — with
  edits at any offset, O(1) undo/redo (run-grouped), a code-point caret, Ln/Col from the
  rope's line summary, and the parse re-driven on edit. **Done (2026-06-27):** the
  hand-rolled rope passes a 50k-iteration model-based fuzz oracle on Windows + Ubuntu +
  macOS (content, line queries, undo/redo, and structural-sharing persistence all hold
  against a `Vec<u16>` reference) — the crate-free rope is correct (§8). Next: N2.
- **N2 — Input correctness.** `[N2a + N2b BUILT → SCRIPTORIUM-NATIVE-INPUT.md, SCRIPTORIUM-NATIVE-IME.md]`
  The "feels right for real text" pass. **N2a done (2026-06-28):** a real selection
  (anchor/caret, shift-extend, collapse-to-edge, select-all), grapheme-cluster + word
  motion (a pragmatic UAX #29 subset — surrogates/CRLF/Extend/ZWJ/regional-indicators,
  oracle'd on every platform), selection-aware edits in one undo group, forward Delete,
  a hand-rolled CF_UNICODETEXT clipboard (cut/copy/paste, CRLF→LF), and selection
  rendering via `HitTestTextRange` behind the glyphs. **N2b done spec-correct (2026-07-05 →
  `SCRIPTORIUM-NATIVE-IME.md`):** IME composition — the provisional string lives *outside* the
  rope until commit (§2), the full `WM_IME_*` + imm32 lifecycle with result double-insert
  prevention and focus-loss finalize (§3/§4), inline rendering (spliced display layout,
  composition underline + target-clause emphasis, caret-within-composition) and candidate-window
  placement at the caret (§5/§6). Pure state-machine + splice oracles and a crash/leak smoke
  guard; **its feel is the author's to judge on a real IME — explicitly *not* implementer-
  validated** (§8). Our-own UAX #14 line breaking is resolved as a deferral (DWrite owns wrapping
  and does it correctly — ledger §8). Then run it and feel it.
- **N3 — Layout/render maturity.** `[BUILT + CI-validated → SCRIPTORIUM-NATIVE-LAYOUT.md]`
  The editor becomes **spatial**, all of it driven by the *same* retained `IDWriteTextLayout`
  the renderer paints, so caret math is never re-implemented. **Done (2026-07-05)**, in four
  checkpoints: **N3a** — the layout becomes a retained, cache-invalidated COM object owned by
  the renderer (the geometry authority), keyed on `(content_gen, width)`, feeding paint and
  input through one `ensure_layout` choke point; **N3b** — Up/Down/PageUp/PageDown with a
  sticky goal column (the drift-free vertical mechanic) + doc-edge snap; **N3c** — wheel
  scrolling with fractional accumulation, scroll-follows-caret + caret-follows-scroll, clamp,
  and a real `WS_VSCROLL` scrollbar; **N3d** — mouse click-to-place, drag-select, double-click
  word / triple-click line, and drag-past-the-edge autoscroll (`SetCapture`). Geometry oracle
  extended throughout (point↔position round-trip, goal-column stickiness, scroll invariants,
  drag granularity) + the smoke test drives synthetic click/vertical/wheel/scrollbar through
  the real WndProc on real DirectWrite. Next: N2b, then N4.
- **N4 — Concurrency / latency.** `[BUILT + CI-validated → SCRIPTORIUM-NATIVE-CONCURRENCY.md]`
  `parse_document` lifted off the UI thread onto a single long-lived worker fed an O(1), immutable
  rope `Snapshot`, so a keystroke never waits on the parser. **Done (2026-07-05)**, in two
  checkpoints: **N4a** — the spine: a `parse` module (platform-free; the one OS touch, the UI
  wakeup, is an injected closure) with a **single-slot coalescing mailbox** (N keystrokes → 1
  parse, bounded to one pending job), a worker that parses with the lock released, and a
  `ParseService` whose `Drop` joins the worker; `refresh()` stopped parsing and gained
  `snapshot()` / `apply_parse` gated monotonically on `signal_gen` (a late/out-of-order parse can't
  regress the display); the post-back is a **contentless `WM_APP_PARSE_DONE`** + an `mpsc` channel,
  so teardown is **leak-free by construction** (no boxed pointer through `lParam`); **N4b** —
  latency instrumentation: `win32` times the submit→settled async round-trip and the status line
  shows it (`· async N µs`, distinct from the worker's `parse N µs`) plus a live `parsing…` marker,
  so the frame-budget cliff is *observable* on real content. The invariant held: the UI thread
  stays the sole owner/mutator of `App`; the worker only reads an immutable `Snapshot` (§2 "never
  paint a half-updated model"). `content_gen` (the N3a layout-cache key) served exactly as the
  forward-aligned staleness token, as predicted. 43 oracles (coalescing, snapshot/parse
  equivalence, monotonic apply, a real-worker round-trip, the status transition) + the smoke test
  driving the real post-back, ASan-clean. **Honest scope:** at section scale there is no latency
  win (non-negotiable #5) — N4 is *architecture* (pre-paid by N1's rope, the siren substrate, the
  fix already-there before the book-scale cliff), and its latency *feel* is queued for the author
  like N2b's IME feel.
- **File I/O — open / save / dirty-state.** `[SPEC → SCRIPTORIUM-NATIVE-IO.md, BUILT]` The first
  node outside the named N-roadmap, landed **before N5** because loading a real manuscript is the
  prerequisite for every queued feel verdict (N2b IME, N3 scroll/caret, N4 latency, N5 scrolling).
  Open / Save / Save As / New; a generation-based dirty machine (`content_gen != saved_gen`); a
  three-way discard guard (Yes saves-and-proceeds-only-if-it-succeeded / No discards / Cancel aborts
  — a cancelled or failed save never drops the buffer) on New/Open/close; and a **platform-free
  codec** that preserves an opened file's encoding + newline byte-faithfully (new documents default
  to BOM-less UTF-8 + LF, coherent with the buffer + markdown pipeline; mixed endings normalize on
  save). comdlg32 `GetOpen/SaveFileNameW` (`OPENFILENAMEW` ABI-asserted) + `MessageBoxW` +
  `SetWindowTextW` FFI; bytes via `std::fs`. The codec round-trip is oracled on every platform; the
  modal dialogs are the author's manual pass. Built + locally validated (56 oracles + smoke + ASan).
- **N5 — Virtualized layout. ✅ BUILT (2026-07-06).** `[SPEC → SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md,
  BUILT]` The first `siren` **promoted to `need-now` by a measurement** (§8, 2026-07-05): the N4
  latency dig found the whole-document `IDWriteTextLayout` rebuild — not parse — is the UI-thread cliff
  (15–34× parse, superlinear, crosses 60 fps at ~8K words). Fix, now built: the whole-doc layout is
  **gone**; document geometry is synthesized from a **paragraph height index** (measured heights fold
  in on layout, estimates for the rest) and **per-paragraph transient layouts** (only the paragraph a
  query/paint touches is shaped — grain = the rope's newline paragraphs, synchronous, O(log n), zero
  coupling to the async parse), with **scroll-anchoring** keeping the reader's content still as
  estimates resolve. The geometry-service seam (N3 §2) held — `app` and `win32` didn't move
  (`win32` only threads `&mut scroll_y` for anchoring). Layout cost for a keystroke/paint dropped
  O(document) → O(viewport): the 851 ms-per-keystroke at 1M units is gone. Checkpoints N5a (height
  index, `03ea2be`) → N5b (geometry-authority swap + the equivalence oracle, `f3808e2`) → N5c
  (anchoring, edit stability, flat-cost guard, `c826b11`), all validated (62 oracles + smoke + ASan).
  **The scrolling *feel* on a real long manuscript is queued for the author.** Deviation from the
  spec's single-windowed first cut → per-paragraph transient (ledgered §8).
- **N6+ — measure-gated sirens.** Incremental parse, arenas, durability/WAL, search — each only when
  a number demands it. The `siren` tier stays parked behind measurements; the author's feel-loop
  (N2b IME, N3 scroll/caret, N4 latency + N5 large-doc scrolling) is the live thread alongside N5.

The layout-oracle discipline (§5) is woven in from N0 onward, not a phase.

(The global `docs/ROADMAP.md` carries a one-line pointer here; the native-editor
sequencing lives in this section because it is coupled to the architecture.)

## 8. Decisions ledger (append-only)

| Date | Decision | Why |
|---|---|---|
| 2026-06-27 | Build a **true native** editor, not polish the PWA/webview path | The browser *engine* (not the chrome) is why the PWA "didn't feel right"; the goal is owning the whole feel stack. |
| 2026-06-27 | Dependency line at the **OS API**; **hand-roll FFI bindings**, no `windows-sys` | Provenance-zero (graph + build-time code-execution at literal zero); bindings cost only typing, not capability. §3. |
| 2026-06-27 | **DirectWrite** for text; **own** buffer/layout/caret/input | DWrite rasterizes glyphs (delegating that is not where craft lives); owning the engine is the entire point. *Reverses* the old Win32+RichEdit plan (RichEdit would own the caret). |
| 2026-06-27 | **CPU/software** framebuffer to start | Simplest, total control, plenty for text. GPU/Direct2D is a measure-gated escalation. |
| 2026-06-27 | **Windows-first**, thin platform seam, no speculative cross-platform abstraction | De-risk one platform; leave a seam, don't build the abstraction blind. |
| 2026-06-27 | Reuse `rust/` parser **in-process**; render path is **new** | Parser is shipped + oracle-validated; `render.rs` (HTML) is not reusable natively. |
| 2026-06-27 | **Skeleton first** (breadth-thin-then-depth) | Retires the COM-FFI existential risk early; unlocks the feel-loop; makes deep specs real. |
| 2026-06-27 | **VERDICT — COM-from-raw-Rust is tolerable** (N0 finding) | The hand-rolled vtables (typed only at called slots, IUnknown-first), GUIDs, externs, and by-value `D2D_POINT_2F` link + run correctly on real Windows (stable+beta); the geometry oracle passes on real DirectWrite. The hand-rolled-bindings line (§3) holds in practice. Consume-only COM was the right scope. |
| 2026-06-27 | N0 renders via **Direct2D `DrawTextLayout`** (consume-only); **CPU-framebuffer surface decision re-opened** | The honest CPU-fb + DWrite path needs an `IDWriteTextRenderer` COM *callback* (the deferred hard risk); N0 took the lowest-risk route to validated pixels instead. This **supersedes the "CPU/software framebuffer to start" row above** as the *starting* surface; the CPU-fb-vs-D2D choice now lands informed by COM-callback difficulty around ~N3, not a-priori. |
| 2026-06-27 | Buffer = **persistent, augmented, chunked rope** (N1); **reverses** the brief piece-table lean | The hot op is coordinate translation, not mutation → an augmented order-statistics tree; and **persistence (`Arc`+CoW) gives O(1) structural-sharing snapshots** = lock-free off-thread reads (the N4 snappiness foundation, API available now) + O(1) undo. The piece-table's one unique edge (mmap the immutable original) is dead weight at section scale; the rope's edges (async, native coordinates) match the north star. High-fanout B+-tree/`SumTree` is the measure-gated constant-factor upgrade behind the same interface. Resolves the §9 buffer + undo forks. |
| 2026-06-27 | **VERDICT — the crate-free hand-rolled rope is correct** (N1 finding) | The persistent rope (split/concat algebra, leaf-merge, augmented summaries) passes a 50k-iteration model-based differential fuzz vs a `Vec<u16>` reference on Windows + Ubuntu + macOS, including the structural-sharing persistence guarantee. The model-based oracle is what makes hand-rolling a rope without `Ropey` safe; it runs on every platform (no DWrite). |
| 2026-06-28 | **Windows-FFI hardening pass** — make the scariest FFI bug classes deterministic, not luck-of-the-runtime | Hand-rolled COM/Win32 fails in ways unit oracles miss: a miscounted vtable slot, a panic unwinding into the OS, a lost GPU device, a 0×0 minimize. Five deterministic guards: (1) **ABI layout assertions** — `offset_of!`/`size_of` pin every *called* vtable slot's index + every by-value struct's size, so a slot-count error fails `cargo test`, not a user's machine; (2) **`catch_unwind` at the WndProc** — a Rust panic across `extern "system"` is UB, so dispatch runs inside a catch and degrades to `DefWindowProcW`; (3) **device-loss recovery** — split device-independent (factories/formats) from device-dependent (target/brushes) resources, rebuild the latter on `D2DERR_RECREATE_TARGET` from `EndDraw`; (4) **zero-size resize guard** for the minimize `WM_SIZE`; (5) a **windowed lifecycle smoke test** (`smoke` feature, `#[ignore]`) driving a real window through CREATE→synthetic input→paint→DESTROY. CI gains debug+release oracle runs (panic=abort changes codegen) plus informative smoke / Miri / clippy jobs. |
| 2026-06-28 | **VERDICT — the smoke test catches what assertions can't; ABI asserts ≠ correct slots** (hardening finding) | On its first run the smoke test found a **phantom `draw_mesh` vtable slot** that shifted every render-target method below it down by one → an **access violation on the first real paint**. The ABI assertions could *not* catch it (they encoded the same wrong index); N0's geometry oracle never called the render-*target* slots. Lesson carried into N2: a runtime that **actually calls every newly-typed slot** is the only guard against mis-reading COM order — so when N2 typed `HitTestTextRange` (slot 66), the smoke test was extended to drive select-all + a real paint to exercise it. |
| 2026-06-28 | **Local validation restored** — the MSVC linker works again; Miri + ASan are local dev tools | The "Actions is the only validator" constraint is lifted. `cargo test`/`--features smoke` link and run locally; the FFI/COM/rope is **ASan-clean** (incl. COM teardown). Working rule: validate locally — ASan/Miri on any FFI change — *before* pushing; CI is the backstop, not the babysitter. |
| 2026-06-28 | **N2a input correctness** — selection + grapheme/word motion + clipboard + selection rendering | A code-point caret lies on real prose (accents, emoji, flags). N2a adds: a selection (`anchor`/`caret`, shift-extend, collapse-to-edge, select-all); Left/Right by grapheme + Ctrl-arrows by word via a **pragmatic UAX #29 subset** (we own the engine — implement the rules real prose hits, don't vendor the UCD; the boundary fn is the single swap point); selection-aware edits in one undo group; a hand-rolled **CF_UNICODETEXT clipboard** (no `windows-sys`, CRLF→LF on paste); and **selection rendering** via `HitTestTextRange`. IME (`WM_IME_*`) + our-own UAX #14 line breaking are the named **N2b** follow-ups. `prev_boundary` walks from buffer start (clusters straddle newlines) — O(offset), user-paced; virtualize at N3+ if a huge doc makes it felt. |
| 2026-07-05 | **N3 seam — the retained layout is the geometry authority, owned by the renderer** | Hit-testing and Up/Down need geometry *during input handling*, not just paint, but the layout was ephemeral (built + dropped inside `draw`). Decision: the `IDWriteTextLayout` becomes a **retained, cache-invalidated COM object** owned by the renderer, exposing a small geometry service (`hit_test_point`/`caret_xywh`/`content_height`/`line_height`) that both `draw` and the input path call through one `ensure_layout` choke point — so paint and input can never disagree about geometry, and DWrite owns the *geometry* while we own the *semantics* (what a click means, when to scroll, how a goal column persists). Invalidation key = `(content_gen, layout_width)`; scroll/caret/selection apply at translate time and never re-shape text. The seam stays clean: `app` stays logical (one new primitive, `set_caret(offset, extend)`); view-space state (`scroll_y`, `goal_x`) lives in `WindowState`; `win32` is the sole conductor holding both handles. |
| 2026-07-05 | **N3 stayed on Direct2D `DrawTextLayout`; the CPU-fb-vs-D2D surface decision remains deferred** | The 2026-06-27 row predicted the surface choice would "land informed around ~N3." Finding: N3's whole value (retained-layout geometry service, hit-testing, caret/selection geometry) sits *above* the surface and came free from `IDWriteTextLayout` regardless of how pixels reach the glass — so N3 gave no new reason to pay the `IDWriteTextRenderer` COM-callback cost. Decision: **stay on consume-only Direct2D through N3**; the CPU-framebuffer escalation stays measure-gated (§9, unchanged), now with more evidence that it buys nothing the editor currently needs. |
| 2026-07-05 | **VERDICT — the geometry oracle scales; `content_gen` is the N4 bridge; one spec'd deviation** | N3's four checkpoints landed 28 oracles (debug + release) + the windowed smoke driving synthetic click/vertical/wheel/scrollbar/drag on real DirectWrite, all ASan-clean. The layout-oracle discipline (§6) held: geometry is deterministic and every mechanic got a golden test (point↔position round-trip, sticky-goal-column round trip, scroll clamp/reveal invariants, drag granularity) with the *feel* half (scroll weight, blink, click tolerances) left for the human loop. **`content_gen`** (the N3a layout-cache key) was introduced forward-aligned as the exact primitive N4 needs to discard a stale off-thread parse — not throwaway. **One deliberate deviation from N3's spec (§4):** double-click uses a class-run `word_at` (the word *under* the point, no trailing whitespace) rather than the literal `[prev_word..next_word]`, which — like Ctrl+Arrow motion — swallows the trailing space; the deviation honors the spec's stated intent while keeping keyboard/mouse agreement on what a "word" is. |
| 2026-07-05 | **N2b seam — the IME composition is provisional and lives OUTSIDE the rope until commit** | Half-composed text must never reach the document/parser/undo. Decision (`SCRIPTORIUM-NATIVE-IME.md` §2): `App` holds `comp: Option<Composition>`; the renderer splices it into the *display* layout only (`text[..lo] ++ comp ++ text[hi..]`), the buffer stays untouched until `commit_composition` (`GCS_RESULTSTR`) folds it in as one `replace_selection` undo step. This makes the two headline edges *free*: **cancel = zero document change** (nothing was written, so nothing to undo) and **commit = one undo step** (delete+insert already grouped). The OS's IMM subsystem owns the composition *logic* (candidate lists, conversion); we own the *semantics* (where provisional text lives, how it renders, when it becomes an edit) — the same delegation line as glyph rasterization. The layout cache key gains a `comp_sig` so the spliced layout rebuilds per keystroke and reverts to the committed layout the instant composition ends (`content_gen` is unchanged while composing). |
| 2026-07-05 | **N2b result double-insert prevention; UAX #14 line breaking resolved as a deferral** | The classic IME bug: `DefWindowProc(WM_IME_COMPOSITION)` with `GCS_RESULTSTR` synthesizes a `WM_IME_CHAR`/`WM_CHAR`, so handling the result *and* forwarding inserts it twice. Rule (§4): when we handle `GCS_RESULTSTR` we do **not** forward the message, and we swallow `WM_IME_CHAR`; focus loss finalizes via `ImmNotifyIME(CPS_COMPLETE)`. Separately, N2a named "our-own UAX #14 line breaking" for N2b — **now resolved as a named `siren` deferral (§7):** we do NOT own wrapping, DirectWrite does and does UAX #14 correctly (same delegation as glyph rasterization); a custom wrapper is only needed for a no-wrap/h-scroll mode, virtualized layout, or a felt breaking bug — none present. So N2b is, in practice, the IME node. |
| 2026-07-05 | **VERDICT — IME correctness is oracle-able but its *feel* is not; N2b is spec-correct, NOT feel-validated** | N2b splits cleanly (§8): the composition **state machine** (commit/cancel/replace + undo grouping) and the **display splice** are deterministic and pinned by pure oracles (no IMM/DWrite); the smoke test drives the `WM_IME_*` handlers + composition render on real DirectWrite as a crash/leak guard, ASan-clean. But whether a real Microsoft Pinyin/Japanese/Korean IME drives our handlers as expected — and whether composing *feels* right — cannot be synthesized (a synthetic message doesn't populate the IMC) and is the **author's to judge on a real IME**. Per the autonomous mandate, N2b ships built-to-spec and is **explicitly not marked feel-validated by the implementer** — that verdict is queued for the author's return. This is the first node whose correctness the implementer cannot fully close alone. |
| 2026-07-05 | **N4 confronts the measure-gate before building — N4 is *architecture*, not a section-scale speedup** | Non-negotiable #5 (measure before optimizing) + the record (parse ~580µs, imperceptible; marshalling specced-then-refuted) mean async parse buys **no felt latency at section scale** — a reparse already fits in one frame. N4 was built anyway, on honest grounds (`SCRIPTORIUM-NATIVE-CONCURRENCY.md` §1): (1) it is **pre-paid** — N1 chose the persistent rope *specifically* for O(1) snapshots = "the N4 snappiness foundation"; (2) the **frame budget is a cliff** — a section that becomes a novel crosses 16ms on a full reparse and an inline parse would then drop frames *mid-keystroke*, so build the seam *before* the cliff, not under duress; (3) it is the **load-bearing wall for the sirens** (incremental parse, virtualized layout both assume an off-thread snapshot consumer). The latency *win* itself stays **measure-gated** (N4b instruments submit→settled round-trip so the cliff is measurable, not asserted) — the claim "async cut latency" is only made when a number shows a reparse crossing a frame. |
| 2026-07-05 | **N4 threading model — one worker + a single-slot coalescing mailbox + a contentless `WM_APP` post-back** | Chosen shape (`SCRIPTORIUM-NATIVE-CONCURRENCY.md` §4): a **single long-lived worker** fed a `Mutex<Option<Job>> + Condvar` **one-slot mailbox** (a submit overwrites the slot, dropping the superseded `Arc` snapshot O(1)) — so N keystrokes collapse to one parse, bounded to one pending job, never a backlog; the worker releases the lock *before* parsing (a submit during a parse never blocks the UI). Deliberately **not** the classic `Box::into_raw`-through-`lParam` post-back: the result rides an `mpsc` channel and the `PostMessage` nudge is **contentless**, so a message still in the queue at teardown carries no owned resource → **leak-free by construction** (the property the ASan gate needs, incl. the in-process smoke create/destroy). The UI wakeup is the *only* Win32 touch and is **injected as a closure**, so the mailbox/coalescing/service is platform-free and oracle-tested on every CI platform. The invariant "never paint a half-updated model" is structural: the UI thread is the sole owner/mutator of `App`; the worker only reads an immutable `Snapshot`. |
| 2026-07-05 | **VERDICT — the concurrency mechanism is oracle-certified; the latency feel is queued (all roadmap nodes now built)** | N4's two checkpoints landed 43 oracles (coalescing, `take`-on-shutdown, snapshot/parse equivalence, a bounded real-worker round-trip, supersede, monotonic apply, the status in-flight→settled transition) + the windowed smoke driving the **real worker + `PostMessageW` + `WM_APP_PARSE_DONE` drain** and asserting the async loop closes, ASan-clean across the worker teardown/join. `content_gen` (the N3a layout-cache key) served as the staleness token exactly as forward-predicted at N3 — no throwaway. Like N2b, the split is honest: the **mechanism** is deterministic and certified, but the **latency *feel*** — whether off-thread parse *matters* — only appears on book-scale content where a reparse crosses the frame budget, so it is **queued for the author** (there is nothing to feel at section scale). With N4 done, **every named roadmap node (N0–N4) is built**; the frontier is now the measure-gated `siren` tier (N5+, §5) and the author's feel-loop. |
| 2026-07-05 | **MEASUREMENT — DWrite full-doc relayout is the real scaling cliff (15–34× parse, superlinear); virtualized layout PROMOTED `siren`→`need-now`** | The N4 latency dig measured what actually crosses the frame budget on the UI thread. Per-edit **DWrite relayout** (`CreateTextLayout` + `GetMetrics`, forced full-doc shape, real Renderer, release): 25K units (a section) **13.3 ms** vs parse 0.57 ms (23×); 55K **34 ms** (26×); 500K (a novel) **314 ms** (25×); 1M **851 ms** (34×); 2M **3,566 ms** (76×). Three findings: (1) **layout dominates the UI thread by ~15–34×** — N4 correctly moved parse off-thread but parse was never the bottleneck; (2) the 60 fps cliff is at **~40K units ≈ 8K words** (a long blog post), ~17× sooner than the parse cliff (~140K words) — the umbrella's "100k lines" gate for virtualized layout was ~10× too conservative; (3) layout is **superlinear** (per-unit cost doubles 500K→2M: 0.63→1.78 µs/unit) — a single `IDWriteTextLayout` was never meant to hold a megabyte. The fix is NOT off-thread layout (it is the *synchronous* input geometry authority) but **virtualization** — lay out only the viewport, estimate the rest. This satisfies non-negotiable #5's gate with a number: **virtualized layout becomes the measure-justified next node, N5** (`SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md`). |
| 2026-07-05 | **File I/O — the feel-loop enabler; preserve-on-save / default-on-create; dirty = generation compare; a three-way discard guard** | The first node outside the named N-roadmap, and it lands **before N5** on purpose: every queued feel verdict (N2b IME, N3 scroll/caret, N4 latency, N5 scrolling) needs a *real manuscript* loaded, which needs file I/O (`SCRIPTORIUM-NATIVE-IO.md`). Decisions: (1) **preserve-on-save, default-on-create** — an opened file round-trips its encoding + newline byte-faithfully (a CRLF UTF-8-BOM file stays exactly that; silently rewriting every line ending on first save is a surprise + a noisy diff), while *new* documents default to BOM-less UTF-8 + LF (coherent with the LF-internal buffer and the markdown/AST pipeline the editor feeds); mixed endings normalize to the detected convention on save (standard). (2) **Dirty = `content_gen != saved_gen`** — a generation compare riding the counter the renderer/parser already maintain, not a separate flag; it over-reports across undo-to-saved (undo bumps the generation) but never under-reports, so it can prompt to save byte-identical content but can never drop unsaved work (a content-hash upgrade is a named siren). (3) **A three-way discard guard** (Yes/No/Cancel) on New/Open/close where **Yes-that-fails and Cancel both abort** — a cancelled Save As or a write error must not proceed to drop the buffer. (4) The **codec is platform-free** (`codec.rs`, un-gated like `buffer`/`grapheme`/`parse`) so the byte round-trip is oracled on every CI platform; only the modal dialogs + message box are Windows FFI (comdlg32 `GetOpen/SaveFileNameW` with `OPENFILENAMEW` ABI-asserted at x64 size 152, `MessageBoxW`, `SetWindowTextW`), and bytes move through `std::fs` (no FFI). The two planned checkpoints (IO-a codec+model, IO-b win32) **landed as one commit**: the document model is dead code in a bin crate until the platform layer calls it (`pub` is not reachability in a binary), and a warning-free tree per commit outweighed the split. Validated: 56 oracles debug+release, windowed smoke (live-window load→edit→save→byte round-trip), ASan-clean across the new FFI, clippy adds zero new findings. The modal dialogs are the author's manual pass (there is almost no feel surface — this is correctness plumbing). |
| 2026-07-06 | **VERDICT — virtualized layout built; the cliff is dead; geometry is oracle-equivalent; feel queued** | N5 killed the scaling cliff the N4 dig measured. The whole-doc `IDWriteTextLayout` (the 15–34× superlinear per-edit cost) is **gone**: geometry is synthesized from a per-paragraph **height index** (`heights.rs`, platform-free, fuzz-oracled) + **per-paragraph transient layouts** (only the touched paragraph is shaped). **Design deviation from the spec's §3 single-windowed first cut → per-paragraph transient:** it maps 1:1 onto the height index (one `GetMetrics` = one measured height), unifies the point-query and draw coordinate model (`content-y = para_top(i) + local` everywhere — no window-local offset juggling, no off-window special-casing, the likeliest place to hide an off-by-one in a solo landmark change), and paragraphs are newline-isolated so a standalone paragraph's geometry is identical to its whole-doc geometry — exactly the **headline equivalence oracle**'s claim (`virtualized ≡ whole-doc` caret + content-height across every offset, wrapping + empty paragraphs, on real DWrite): virtualization changed *cost*, not *geometry*, the fearless-refactor net (à la N4's snapshot/parse equivalence). **Scroll-anchoring** (§5) pins the reader's content as estimates resolve (`draw` threads `&mut scroll_y`); **edit stability** preserves measured heights across same-shape edits (no per-keystroke scrollbar wobble) via a count-preserving heuristic — the precise rope-driven paragraph diff + a persistent paragraph-layout cache stay measure-gated refinements. The seam held (N3's point): `app`/`win32` didn't move beyond threading `&mut scroll_y`. The **flat-cost smoke** (8 scroll+paint cycles on a 20k-paragraph doc, generous 3 s bound clearing even ASan-instrumented builds while an O(document) regression — tens of seconds — trips instantly) is the cliff regression guard. Validated: 62 oracles debug + 61 release, smoke green, ASan-clean across the big-doc paint + per-paragraph churn, clippy clean, warning-free. **What's NOT closed by the implementer: the scrolling *feel* on a real long manuscript** — queued for the author (now loadable via file I/O). With N5 the measure-promoted layout node is done; the frontier returns to the `siren` tier (N6+) and the author's feel-loop (N2b IME, N3 scroll/caret, N4 latency, **N5 scrolling**). |

## 9. Open forks (deliberately unresolved)

A monument spec that pretends to know everything up front is lying. These are named,
not forced; each resolves into the ledger (§8) when a reason arrives — usually a
measurement or a felt problem, not an a-priori argument.

- **Fate of the PWA / `scriptorium/`.** Does the webview editor survive as a second
  target, or degrade to legacy/read-only and eventually die? Maintaining both doubles
  presentation work. Leaning toward native-becomes-the-real-thing — but not yet decided.
- **Cross-platform (macOS/Linux) ever?** The seam (§4) leaves the door open; whether
  we walk through it is unanswered. Windows-first regardless.
- **GPU / Direct2D rendering.** CPU framebuffer to start; escalate only if a frame-time
  measurement on real content demands it.
- ~~**Buffer data structure (rope vs piece-tree).**~~ **RESOLVED (N1, §8):** a persistent,
  augmented, chunked rope (`SCRIPTORIUM-NATIVE-BUFFER.md`). High-fanout B+-tree/`SumTree`
  remains the measure-gated constant-factor upgrade behind the same interface.
- ~~**Undo model (stack vs tree vs persistent).**~~ **RESOLVED (N1, §8):** persistent —
  O(1) snapshot checkpoints via the rope's structural sharing, run-grouped. A bounded/
  delta history is a trivial later refinement, never needed for cheap undo.

## 10. Relationship to the existing system

- **Quarantine intact.** This is author tooling; it never ships to readers, never
  enters the reader precache/budget/gauntlets (`SCRIPTORIUM.md` §6). It consumes
  `rust/`; the reader consumes neither.
- **The build pipeline is untouched.** `data/compiled` + the search index still come
  from the `rust/` native bins (`SCRIPTORIUM-RUST-PARSER.md` §14). The native editor is
  a *new front-end* on the same core, not a change to the deploy path.
- **The `scriptorium-server` bin** (`rust/`) and the PWA remain as-is during N0–N4; their
  fate is the open fork in §9.
