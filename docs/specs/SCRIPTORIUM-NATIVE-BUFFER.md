# Scriptorium Native — N1: the text buffer

> The second build target of the native editor (`SCRIPTORIUM-NATIVE-EDITOR.md` §7,
> N1; catalog §5 *Text buffer* + *Undo/redo*). N0 stood up the platform/render
> skeleton with a naive `Vec<u16>` buffer and a caret pinned at end-of-text. N1
> replaces that with a **real editable document structure** that supports insert and
> delete at any offset, gives **undo/redo essentially for free**, and re-drives the
> parse on every edit — while staying small enough to be obviously correct.
>
> This is the spec that **makes the rope-vs-piece-table decision** the umbrella left
> open (§9). It commits to a design and the reasoning behind it; build against it.
>
> Status: **spec / not started.** Last refreshed: 2026-06-27.

---

## 1. Goal & exit criteria

N1 is **done** when:

1. The editor holds a **`TextBuffer`** (not a `Vec<u16>`) whose logical content is a
   sequence of UTF-16 code units, supporting `insert(at, units)` and `delete(range)`
   at **any** offset — not just the end.
2. The caret is a **UTF-16 offset** that can move: typing inserts at the caret,
   Backspace deletes the unit (code point) before it, and **Left / Right / Home / End**
   move it (code-point granularity — surrogate-pair-aware; true grapheme movement is N2).
3. **Undo (Ctrl+Z) and Redo (Ctrl+Y)** work, grouping a contiguous typing run into one
   step (so Ctrl+Z removes a word-run, not one letter).
4. Every edit re-drives `parse_document(&[u16])` over the buffer's materialized
   contents and repaints — the N0 loop, now over a real buffer.
5. A **model-based buffer oracle** (a `Vec<u16>` reference vs the `TextBuffer` under
   seeded random insert/delete/undo/redo) passes in CI **on every platform** (the
   buffer is pure logic — no Win32, no DWrite), to heavy fuzz.

The real exit criterion behind those: **the document structure that lets the editor
scale past a toy is in place and proven correct**, and undo is no longer a hole.

## 2. Scope fence

**In:** the `TextBuffer` (piece-table, §3–§5), undo/redo with run-grouping (§6),
a code-point-level movable caret + the input plumbing for it (§7), parse-on-edit over
the buffer, the model-based oracle (§8).

**Out (named so they don't creep in):** grapheme-cluster movement / line breaking /
IME / selection / click-to-position (all **N2** — N1's caret moves by code point, no
selection); selection rendering + scrolling + hit-testing (**N3**); a balanced
order-statistics tree over pieces (**siren** — N1 uses a linear piece list, §9);
buffer/add-buffer compaction or garbage collection (**siren**); persistent/immutable
undo history, multi-cursor (**later**); save/load to disk (**siren — durability**).
N1 still edits one in-memory section; files are a later phase.

## 3. The decision: a piece-table

**Chosen: a piece-table** (the VS Code "piece-tree" family), with a **linear piece
list** now and a balanced tree deferred as a siren. Reasoning — this is the §9 fork,
resolved:

The editing workload is *load a section of prose, make sparse edits, undo*. Three
candidates:

- **Gap buffer** — what N0's `Vec<u16>` effectively approximated. Dead simple,
  superb for localized typing, but a caret jump forces an O(n) gap move, it scales to
  a book poorly, and it has no natural undo or multi-cursor story. Rejected as the
  primary structure (it is the thing we are replacing).
- **Rope** — a balanced tree of text chunks; uniform O(log n) insert/delete/index
  anywhere; the right tool for *huge* buffers with edits scattered everywhere. But it
  must be a balanced tree from day one to be a rope at all, and its undo wants a
  *persistent* rope (structural sharing) or full snapshots — more allocation, more
  machinery, before we need any of it.
- **Piece-table** — the original text is **immutable**; everything typed is appended
  to a second **append-only** "add" buffer; the document is a sequence of **pieces**,
  each a `(source, start, len)` window into one of the two buffers. Edits mutate only
  the *piece list*, never the text.

The piece-table wins for **this** project on three axes the others lose:

1. **Undo falls out almost free** (the umbrella explicitly wanted this — §5 undo note,
   §9). Because both backing buffers are append-only and never mutated, the *entire*
   mutable state is the piece list (plus `add.len()`). Undo therefore snapshots **only
   the piece index — it never copies a single unit of text.** That is the elegant
   coupling between the buffer and undo, and it is unavailable to a gap buffer and
   costly for a rope.
2. **Best correctness-per-line at our scale.** A piece *list* (a `Vec<Piece>`) with
   append-coalescing (§5) is simple enough to make obviously correct and fuzz to
   exhaustion (§8). The scaling mechanism — a balanced/order-statistics tree over the
   pieces — is a *separable* upgrade we can add later behind the same interface. A
   rope cannot defer its tree.
3. **It is the purpose-built structure for a text editor** (Bravo → Word → VS Code),
   and the umbrella flagged the buffer as "the most fun to reason through." Building
   the right thing for the workload is the monument move.

**When we would reach for a rope instead** (a documented siren-tier "if ever"): if the
unit of editing stops being a section and becomes *a whole book as one buffer* with
edits scattered everywhere, the piece count outgrows a linear list, **and** even a
balanced piece-tree's rebalancing becomes the measured bottleneck — then a rope's
uniform chunking may win. Not now, and not blindly.

## 4. The data structure

```
struct TextBuffer {
    original: Vec<u16>,   // the loaded section; immutable after construction
    add:      Vec<u16>,   // everything typed since load; append-only, never edited
    pieces:   Vec<Piece>, // the document = pieces concatenated, in order
    // derived/cached:
    cached:   Option<Vec<u16>>, // materialized contents, rebuilt lazily when dirty (§5)
    total:    usize,            // sum of piece lens, maintained on edit
}

struct Piece { source: Source, start: usize, len: usize } // window into a buffer
enum Source { Original, Add }
```

**Invariants** (the oracle in §8 enforces these by construction):
- Every `Piece` has `len > 0` (zero-length pieces are never stored; splits that would
  produce one drop it).
- `total == Σ pieces[i].len == cached.map(|c| c.len())`.
- `original` and `add` only ever **grow** (`add`) or stay fixed (`original`); existing
  units are never overwritten. "Deleted" text simply becomes unreferenced (acceptable
  garbage; compaction is a siren).

## 5. Operations

- **`from_units(&[u16]) -> TextBuffer`** — `original = units.to_vec()`, `add` empty,
  `pieces = [Piece{Original,0,len}]` (or empty when `len == 0`). The N1 editor loads a
  section this way (N0's empty-buffer start is just `from_units(&[])`).
- **`len() -> usize`** — returns `total` (O(1)).
- **`insert(at, units)`**:
  1. `add_start = add.len(); add.extend_from_slice(units)`.
  2. **Typing fast-path (coalesce):** if `at` falls exactly at the end of an `Add`
     piece whose `start + len == add_start` (i.e. the previous insert appended here and
     this one is contiguous), just `piece.len += units.len()`. A typed run becomes **one
     piece**, not N — this is what keeps the piece count (and undo granularity) sane.
  3. Otherwise locate the piece + intra-piece offset containing `at` (linear scan
     accumulating lens), **split** it into `[left, newAddPiece, right]` (dropping any
     zero-length side), and splice. Inserting exactly on a piece boundary needs no split.
  4. `total += units.len()`; mark `cached` dirty.
- **`delete(range)`** — locate the start and end pieces; shorten the boundary pieces
  (advance a left piece's `start`+shrink `len`, or shrink a right piece's `len`), drop
  whole pieces fully inside the range, splitting a single straddling piece as needed;
  `total -= range.len()`; mark dirty.
- **`contents(&mut self) -> &[u16]`** — return the cached materialization, rebuilding it
  (walk pieces, `extend_from_slice` each window into a fresh `Vec<u16>`) when dirty. This
  is the **one** contiguous snapshot both the parser (`parse_document(&[u16])`) and the
  renderer (`IDWriteTextLayout` wants a contiguous `*const u16`) consume — built once
  per edit, not once per frame.

Locating an offset is **O(pieces)** (linear scan); the O(log n) order-statistics tree
is the deferred siren. At section scale with typing-coalescing, the piece count stays
small, so this is a non-issue — and §9 records *why* it's allowed to be.

## 6. Undo / redo — the elegant coupling

Because the backing buffers are append-only, **a complete undo checkpoint is just a
clone of `pieces` plus the current `total`** (and `add.len()` is implied — `add` only
grows, and restoring an old piece list simply stops referencing the tail). No text is
ever copied into the history.

- **`UndoStack`**: a `Vec<Checkpoint>` where `Checkpoint { pieces: Vec<Piece>, total,
  caret }`. A matching **redo** stack, **cleared on any fresh edit**.
- **Grouping (the "feels right" minimum):** consecutive single-unit **inserts** (a
  typing run) coalesce into **one** undo step, and consecutive **Backspaces** into one;
  a caret move, an Enter, a delete-after-insert, or a kind-switch **closes** the current
  group (pushes a checkpoint). So Ctrl+Z removes a word-ish run, not one letter — minimal,
  but not maddening.
- **Minimal-first, honestly.** Cloning `pieces` per group is the "minimal" version the
  umbrella undo note calls for. It is *already* elegant here (it copies an index, never
  text); the further-elegant version (store piece-list *deltas*, or a persistent piece
  tree) is a siren we reach for only if undo memory ever matters. The caret is restored
  with each checkpoint so undo/redo move the cursor to where the edit was.

## 7. Caret & integration (the N1 editing model)

`app.rs` swaps its `Vec<u16>` for a `TextBuffer` and grows a real caret:

- **State:** `buffer: TextBuffer`, `caret: usize` (UTF-16 offset), `undo`/`redo` stacks.
- **Edits:** typing → `insert(caret, &[unit]); caret += 1`. Backspace → delete the code
  point before the caret (one unit, or two if it's a low+high surrogate pair) and move
  the caret back. Enter → insert `0x000A`.
- **Movement (code-point granularity):** Left/Right step over a surrogate pair as one
  (never land between a high and low surrogate); Home/End go to line start/end (scan to
  the nearest `0x000A`). **Grapheme clusters, selection, and click-to-position are N2** —
  N1 deliberately stops at code points so the buffer, not Unicode segmentation, is the
  subject.
- **Input plumbing (`win32`):** movement keys arrive as **`WM_KEYDOWN`** virtual-key
  codes (`VK_LEFT/RIGHT/HOME/END`), so N1 adds a `WM_KEYDOWN` arm (N0 only handled
  `WM_CHAR`); undo/redo arrive as the control units **Ctrl+Z = `0x1A`** and
  **Ctrl+Y = `0x19`** already delivered via `WM_CHAR`. No new externs — these messages
  already flow through the existing pump; `win32/sys.rs` only gains the `VK_*` + the
  `WM_KEYDOWN` constants.
- **Parse/render:** unchanged in shape from N0 — on every edit, reparse
  `buffer.contents()` and `InvalidateRect`; the renderer builds its layout from the same
  `contents()` slice. The caret geometry still comes from `HitTestTextPosition` on that
  layout (N0's `caret_geometry`), now at an arbitrary caret offset, not just the end.

**Why the buffer's edit-efficiency doesn't visibly pay off yet (and that's fine).**
N1 still reparses the *whole* section per keystroke (~580µs — `SCRIPTORIUM-WASM-
MARSHALLING.md`) and re-materializes the whole `contents()` (~tens of µs). Both are
O(n), so the piece-table's O(log n)-able edits are *dominated* and invisible for now.
We build the right structure anyway because (a) **undo needs it now** and the
piece-table makes undo nearly free, and (b) it is the substrate the **incremental
parse** and **virtualized layout** sirens require — when those land, the buffer is
already the right shape and the core isn't rewritten. This is the project's
measure-gated discipline, stated plainly: correctness + undo now, the latent perf win
unlocked later without a redo.

## 8. Testing — the buffer oracle

The buffer is **pure logic with no feel component**, so unlike the renderer it is
*fully* oracle-able — and we hold it to the parser's equivalence-oracle standard:

- **Model-based differential fuzz.** A trivially-correct reference model (a `Vec<u16>`
  with `Vec::insert`/`drain`) is mutated in lockstep with the `TextBuffer` under a
  seeded random stream of `insert` / `delete` / `undo` / `redo` ops; after **every** op,
  assert `buffer.contents() == model` (and `len()` agrees). Undo/redo are checked
  against a model-side history stack. Seed-driven and deterministic, so a failure
  reproduces from its seed.
- **Invariant checks** (§4) asserted after each op in the fuzz: no zero-length pieces,
  `total` consistency, append-only buffers.
- **Targeted unit cases:** boundary inserts, splits at piece edges, the typing-coalesce
  fast-path (assert one piece after a run), delete spanning multiple pieces, undo across
  a group boundary, redo-cleared-on-edit.
- **Where it runs:** the buffer module is **not** `#[cfg(windows)]` — it compiles and
  tests on every platform. The oracle runs in the existing `scriptorium-native.yml`
  Linux/macOS stub jobs (which gain a `cargo test --bin` step) *and* the Windows jobs,
  with a `SCRIPTORIUM_FUZZ`-scaled iteration count (maximal-CI: crank it). This is N1's
  real, automatable regression value — and, unlike N0's geometry oracle, it needs no
  DirectWrite, so the Linux runners exercise it too.

## 9. Performance posture & the deferred tree

- **Piece list, not a tree, now.** Offset-location is O(pieces); with typing-coalescing
  the piece count tracks the number of *disjoint edit regions*, not keystrokes, so it
  stays small for real editing. The **order-statistics / red-black tree over pieces**
  (VS Code's actual "piece-tree") is the scaling upgrade — a **siren**, added behind the
  unchanged `TextBuffer` interface only when a measured piece count makes the linear
  scan hurt.
- **No compaction now.** Deleted/overwritten text lingers as unreferenced garbage in
  `original`/`add`. At section scale this is bounded and irrelevant; compaction is a
  siren.
- **`contents()` caching** keeps parse + paint reading one shared materialization per
  edit rather than re-walking pieces per consumer.

## 10. Risks / what could actually bite

- **Off-by-one in split/delete boundary math** → corruption the eye might miss. This is
  exactly what the model-based fuzz (§8) is *for*; it is cheap and merciless. Heavy seed
  count in CI is the mitigation.
- **Surrogate pairs at the caret** — moving or backspacing must treat a high+low pair as
  one code point, or we split a surrogate and write a lone half. Covered by movement unit
  tests with astral characters.
- **Undo grouping that feels wrong** — too coarse (a whole paragraph vanishes) or too
  fine (one letter). The §6 run-grouping is a starting heuristic; it is **feel**, so it
  is tuned in the loop (the author reacts), not gated.
- **Piece-list growth under pathological editing** — bounded by §9's siren upgrade; not
  an N1 correctness risk, only a latent perf one, and named.

## 11. Decisions to feed the umbrella ledger (on completion)

- **Buffer structure = piece-table** (linear piece list now; balanced piece-tree is a
  siren) — resolves the §9 *rope vs piece-tree* fork.
- **Undo = piece-list-snapshot checkpoints with typing-run grouping** (text never
  copied into history) — resolves the §9 *undo model* fork at the minimal-but-elegant
  tier, with the persistent/delta version named as the next escalation.
- The **buffer oracle** (model-based differential fuzz) extends the project's
  equivalence-oracle discipline to the editor core and runs on **all** platforms —
  a data point for how much of the native editor stays oracle-able below the feel line.
