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
> Status: **building — N0 + N1 shipped.** The platform/render walking skeleton (N0) and
> the persistent-rope text buffer (N1) are built and CI-validated (COM-from-raw-Rust and
> the crate-free rope both proven — §8); N2 (input correctness: grapheme movement, IME,
> selection) is next. Last refreshed: 2026-06-27.

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
| **Virtualized layout** | Lay out only the viewport; estimate + correct scroll geometry | `siren` | Needed the moment docs get long (100k lines). Online height-estimation problem. |
| **Incremental parse** | Reuse unchanged subtrees; reparse only the dirty span (tree-sitter-shaped) | `siren` | The prettiest one — and unnecessary now (580µs/section is imperceptible). Reach for it only if a "section" becomes a novel. |
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
- **N2 — Input correctness.** Grapheme-cluster caret movement, line breaking, IME,
  selection semantics. The "feels right for real text" pass.
- **N3 — Layout/render maturity.** Selection rendering, scrolling, hit-testing on
  `IDWriteTextLayout`; the layout oracle stood up alongside.
- **N4 — Concurrency / latency.** Off-thread IO/heavy work, input coalescing, the
  latency tuning where snappiness is born.
- **N5+ — measure-gated sirens.** Virtualized layout, incremental parse, arenas,
  durability/WAL, search — each only when a number demands it.

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
