# Scriptorium — the JS ⇄ WASM marshalling boundary (measured, closed)

> Measure-first investigation of the per-parse boundary between the browser editor
> (JS) and the Rust parser (wasm). **Outcome: not pursued — the boundary is not the
> bottleneck.** This doc is kept as a decision record so the pre-allocation idea is
> not re-proposed without re-reading the numbers.
>
> Status: **CLOSED / resolved (2026-06-27).** Built the step-0 benchmark; it refuted
> the premise. The harness (`scripts/bench/marshalling-bench.js`,
> `npm run bench:marshalling`) lives on as a regression guard.

---

## 1. What this was going to be

The `parse.js` cutover left the Rust core (as wasm) the one parser, reparsing the
whole section buffer on every keystroke. The hypothesis was that the JS⇄wasm
boundary — specifically the per-parse `alloc`/`dealloc` churn — was a meaningful
authoring-latency cost worth removing with a persistent pre-allocated buffer.

The discipline (mandated up front): **measure before optimizing.** Step 0 was a
benchmark harness; nothing was allowed to land without a before/after number.

## 2. What we measured

`scripts/bench/marshalling-bench.js` drives the **real shipped browser glue**
(`scriptorium/wasm-parser.js`, via a `fetch` shim) for the authoritative whole-parse
cost, plus an instrumented mirror of the exact marshalling sequence for a per-phase
breakdown, asserting the two produce byte-identical output. Inputs are real content
sections (`raw/`): tiny (123 ch), realistic (13 KB), large/worst-case (55 KB).

Per-keystroke cost, **realistic 13 KB section (~580 µs whole-parse)**:

| component | µs | share | at the boundary? |
|---|---|---|---|
| parse — the AST build itself | ~514 | ~66% | no — pure algorithm |
| JSON serialize (Rust → string) | ~241 | ~32% of `parse_utf16` | yes |
| JSON.parse (JS) | ~60 | ~10% | yes |
| input-write (char-by-char `setUint16`) | ~38 | ~6% | yes (cheap) |
| copy-out + UTF-8 decode | ~27 | ~5% | yes (cheap) |
| **alloc + dealloc** | **~1.6** | **0.2%** | **yes** |

The parse-vs-serialize split came from a temporary `parse_only` wasm export (parse,
return a checksum, no serialize) subtracted from `parse_utf16`; the export was
removed after measuring. A `render_utf16` (parse → HTML in wasm, no JSON) probe ran
~693 µs realistic — *barely* cheaper than serialize, and *more* expensive on the
55 KB case.

## 3. What the numbers say

1. **The premise is refuted.** `alloc`/`dealloc` is **0.2%** of a parse. The
   persistent pre-allocated buffer (the whole reason for this doc) would reclaim
   ~1 µs out of 580. Not worth a single line of code.
2. **Two-thirds of every keystroke is the parse algorithm itself** — nothing at the
   boundary touches it. Only a faster parser helps, and there is no workload that
   makes that worth doing (see §5).
3. **The only real boundary lever is the JSON round-trip** (~300 µs serialize+parse
   combined, ~40% overlapping). But cashing it means eliminating JSON entirely —
   render-in-wasm or a columnar wire format. The `render_utf16` probe shows
   rendering is *itself* ~as expensive as serializing, so it only wins if JS then
   drops both `JSON.parse` **and** its own AST→DOM render. That is the
   "retire the JS renderer" arc, not a marshalling tweak — a separate spec if ever.
4. **There is no latency problem to solve.** 580 µs/keystroke realistic is
   imperceptible (16 ms frame budget); the 55 KB worst case is 2.3 ms, still under a
   frame. Even at wasm's ~3-5× penalty vs native, fine.

## 4. Decision

**Not pursued.** No pre-allocation, no bulk-write rewrite, no wire-format change.
The valuable output is *knowing the boundary is not the bottleneck* — exactly what
measure-first is for. The benchmark is kept (`npm run bench:marshalling`) as a
standing regression guard so any future change to the glue or wasm surfaces a
per-phase delta.

Why we went Rust still stands and was never about browser keystroke speed: one
parser, native bins for the build/server, no JS-as-authority in the browser, and the
in-process FFI path for the native app (R5) — where Rust's speed actually pays
because it sidesteps marshalling entirely.

## 5. Conditional note: parser perf (do NOT act now)

If parsing ever becomes a *felt* cost — a much larger corpus, or a huge live document
in the native app — profile here first, in priority order:

- `utf16le_units` does a full `.collect()` into a `Vec<u16>` (a whole-input copy
  inside wasm) on every parse, on top of the JS-side write.
- per-node allocations in the parser hot loop (`parser.rs`).
- the JSON serialize (32% of `parse_utf16`) — but this is a *boundary* cost that
  vanishes in the native app, so weigh it against just building the native path.

No current workload is slow (keystroke imperceptible, build corpus ~500 KB, native
app sidesteps the boundary). This is a "where to look if" note, not a TODO.

(Not measured, file-and-move-on: a head-to-head vs the retired `parse.js`. It would
likely show JIT'd native JS was *competitive per-parse* because it had no marshalling
tax — a reality check on the wasm cost we accepted, not a verdict on the cutover.)
