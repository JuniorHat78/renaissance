# Scriptorium — optimizing the JS ⇄ WASM marshalling boundary

> A short, measure-first plan to tighten the per-parse boundary between the
> browser editor (JS) and the Rust parser (wasm), before any native-FFI work.
> Doc-driven: written first, built against, retired into SCRIPTORIUM-RUST-PARSER.md
> when it ships.
>
> Status: **spec / not started.** Last refreshed: 2026-06-27.

---

## 1. Why now, and what this is NOT

The `parse.js` cutover is done (SCRIPTORIUM-RUST-PARSER.md §14): the Rust core is
the one parser, in the browser editor as wasm. The editor reparses the whole
section buffer on **every keystroke**, so the JS⇄wasm boundary is the hot path
for authoring latency. Tighten it while the PWA is the daily driver.

**Scope is the marshalling only.** Not a grammar change, not a new AST. The
byte-identical contract (§4 of the parser spec) is untouched; the equivalence
oracles still gate it.

**Explicit non-goal — the native app sidesteps this entirely.** The future native
desktop editor (R5) calls Rust in-process with no marshalling, so this work pays
off *specifically for the browser/PWA editor*. That is fine — the PWA is the
current daily driver, R5 is unbuilt — but it means this is not on the FFI path.

## 2. The current per-parse cycle (the thing we are optimizing)

Two glue implementations marshal identically (kept in lockstep):
- `scriptorium/wasm-parser.js` — the **browser** glue (the editor's hot path).
- `scripts/ast/parse-wasm.js` — the **Node** build/test path (not latency-critical;
  keep consistent, but the browser glue is the target).

wasm exports today: `alloc`, `dealloc`, `parse_utf16(ptr,len) -> i64`
(packed `(outPtr<<32)|outLen`), `memory`. Per call, JS does:

1. `alloc(byteLen)` — input buffer in wasm linear memory.
2. **char-by-char** `DataView.setUint16` write loop (UTF-16LE).
3. `parse_utf16` → Rust builds the AST, **serializes it to a JSON string** into a
   freshly-allocated output buffer, returns `(ptr,len)`.
4. `new Uint8Array(memory.buffer, outPtr, outLen).slice()` (copy out).
5. `TextDecoder.decode` (UTF-8) → `JSON.parse` (rebuild the JS object tree).
6. `dealloc(outPtr)` + `dealloc(inPtr)`.

Per keystroke: **2 alloc + 2 dealloc, a per-char JS write loop, a slice copy, a
UTF-8 decode, and a full JSON serialize (Rust) + parse (JS) round-trip.**

## 3. Hypothesis (unmeasured — step 0 settles it)

The alloc/dealloc churn is real but probably the *smaller* cost. The likely fat
costs are (a) the **char-by-char UTF-16 write loop** and (b) the **JSON
round-trip** — we pay a full serialize+deserialize to cross an in-process
boundary, every keystroke. Pre-allocation fixes (a-adjacent) churn but not the
round-trip. **So: measure before optimizing.**

## 4. The plan

### Step 0 — Benchmark harness (gate everything on this)
A node script that drives the **real shipped glue** over a realistic section
(~few KB), a large paste (worst case), and a tiny buffer, N iterations, and
reports a per-phase breakdown: input-write, `parse_utf16`, copy-out + decode,
`JSON.parse`, and alloc/dealloc. Print a baseline table. This both directs the
work and becomes a regression guard. **No optimization lands without a before/after
number from this.**

### Step 1 — Persistent buffers, zero per-parse alloc (the cheap, safe win)
- **Input:** one reusable scratch region JS `alloc`s once and reuses; `realloc`
  (or free+bigger-alloc) only when a longer input arrives. Cap discipline: shrink
  back if a giant paste blew it up, so we don't hold megabytes forever. Write via
  a `Uint16Array` view over `memory.buffer`, not `DataView.setUint16` (drops the
  per-char endianness branch; lets the engine optimize the store loop).
- **Output:** a Rust-side reusable `static mut Vec<u8>` (single-threaded wasm, so
  sound) that the parser clears + writes into and returns `(ptr,len)` for. No
  caller buffer, no output alloc/dealloc. JS reads it and must consume before the
  next call (JSON.parse copies anyway). New export, e.g. `parse_utf16_reuse`, kept
  alongside the old one until both glues + oracles are cut over.
- Net after warmup: **zero alloc/dealloc per parse.** Apply to the browser glue;
  mirror in the Node glue.

### Step 2 — Re-measure, then decide the boundary itself
If `JSON.parse` now dominates (expected), that is the real fork:
- **(a)** a leaner wire format — a flat typed-array/columnar AST encoding JS walks
  directly, skipping JSON entirely; or
- **(b)** push more work into wasm so JS stops rebuilding the whole AST object each
  keystroke — wasm emits the preview HTML + diagnostics + outline directly. This
  overlaps the **"renderer → wasm"** frontier (the next "retire the .js" step): if
  wasm renders, the editor barely needs the AST object at all.

Pick based on the step-0/step-1 numbers, not a priori. (b) is the bigger arc and
folds into a separate spec if chosen.

## 5. Safety

The equivalence oracles (`rust-wasm-oracle.js`, `scriptorium-wasm-browser-parity.js`)
drive the **real shipped glue**, so any marshalling refactor is validated
byte-identical against the frozen goldens for free — we can be aggressive. The
benchmark adds the perf-regression guard. Keep the two glues (browser + Node) in
lockstep; the Node one rides the same exports.

## 6. Done when

The browser glue does zero per-parse alloc/dealloc, the input write is bulk, and
the benchmark shows a real improvement on the realistic + worst-case inputs with
the oracles still green. Then either retire this doc into SCRIPTORIUM-RUST-PARSER.md
or, if step 2(b) is chosen, hand off to a renderer-to-wasm spec.
