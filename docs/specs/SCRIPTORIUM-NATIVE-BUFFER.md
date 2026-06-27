# Scriptorium Native — N1: the text buffer

> The second build target of the native editor (`SCRIPTORIUM-NATIVE-EDITOR.md` §7,
> N1; catalog §5 *Text buffer* + *Undo/redo*). N0 stood up the platform/render
> skeleton with a naive `Vec<u16>` buffer and a caret pinned at end-of-text. N1
> replaces that with a **real editable document structure** that supports insert and
> delete at any offset, gives **O(1) undo/redo via structural sharing**, answers
> coordinate queries (offset↔line) from the structure itself, and re-drives the parse
> on every edit.
>
> This is the spec that **makes the rope-vs-piece-table decision** the umbrella left
> open (§9). It commits to a **persistent, augmented, chunked rope** and to the
> reasoning behind choosing it over the piece-table. Build against it.
>
> Status: **spec / building.** Last refreshed: 2026-06-27.

---

## 1. Goal & exit criteria

N1 is **done** when:

1. The editor holds a **`TextBuffer`** (a persistent rope, not a `Vec<u16>`) whose
   logical content is a sequence of UTF-16 code units, supporting `insert(at, units)`
   and `delete(range)` at **any** offset.
2. The caret is a **UTF-16 offset** that can move: typing inserts at the caret,
   Backspace deletes the code point before it, and **Left / Right / Home / End** move it
   (code-point granularity — surrogate-pair-aware; grapheme movement + Up/Down are N2/N3).
3. **Undo (Ctrl+Z) and Redo (Ctrl+Y)** work, grouping a contiguous typing run into one
   step, restoring the caret, and capturing each checkpoint in **O(1)** (an `Arc` clone
   of the rope root — structural sharing, no text copied).
4. The status line shows **Ln / Col**, computed from the rope's **line summary** (an
   augmented O(log n) query) — proof the structure carries coordinates natively.
5. Every edit re-drives `parse_document(&[u16])` over the buffer's materialized
   contents and repaints — the N0 loop, now over a real buffer.
6. A **model-based buffer oracle** (a `Vec<u16>` reference vs the `TextBuffer` under
   seeded random insert/delete/undo/redo) passes in CI **on every platform** (the
   buffer is pure logic — no Win32, no DWrite), to heavy, `SCRIPTORIUM_FUZZ`-scaled fuzz.

The real exit criterion behind those: **the document structure that gives the monument
its async-ready, coordinate-native spine is in place and proven correct**, and undo is
no longer a hole.

## 2. Scope fence

**In:** the `TextBuffer` (persistent chunked rope, §3–§5), O(1) snapshot/restore and
undo/redo with run-grouping (§6), a code-point-level movable caret + the input plumbing
for it (§7), parse-on-edit over the buffer, the augmented line query for Ln/Col, the
model-based oracle (§8).

**Out (named so they don't creep in):** grapheme-cluster movement / line breaking /
IME / selection / click-to-position (**N2** — N1's caret moves by code point, no
selection); **vertical** caret movement (Up/Down) and scrolling + hit-testing (**N3** —
they need layout-aware geometry); high-fanout B+-tree nodes / SIMD chunk scans
(**siren** — §9, a constant-factor upgrade behind the same interface); off-thread parse
on a snapshot (**N4** — the snapshot API lands now, its *use* is later); incremental
reparse of only the dirty span (**siren**); save/load to disk (**siren — durability**).
N1 still edits one in-memory section; files are a later phase.

## 3. The decision: a persistent, augmented, chunked rope

**Chosen:** a **rope** — a balanced tree whose leaves are chunks of UTF-16 units and
whose internal nodes carry an **augmented summary** (subtree length + newline count) —
built as a **persistent** structure (`Arc` nodes, copy-on-write), so a snapshot is an
O(1) root clone with structural sharing. This resolves the §9 *rope vs piece-tree* fork
**toward the rope**, reversing the earlier lean. The reasoning:

**The hot operation in an editor is not mutation — it is coordinate translation**
(offset↔line↔column, char↔utf-16, logical↔visual), run constantly by caret, scrolling,
hit-testing, decorations. The right structure answers arbitrary coordinate queries
cheaply *and* edits cheaply: an **order-statistics tree with augmented summaries**, where
every translation is one O(log n) descent reading subtree summaries. Adding a coordinate
(graphemes, visual width) later is "add a field to the summary," not a new index.

Two properties make the rope the monument choice over the alternatives:

1. **Persistence buys async for free, and async is where snappiness is born.** Make the
   nodes `Arc` + copy-on-write and a **snapshot is O(1) with structural sharing**: clone
   a root pointer and hand a *frozen, consistent* document to the parser, the saver, the
   search indexer, a background highlighter — **no locks, no copies** — while the UI
   thread mutates a new root. This is xi-editor's thesis and why Zed (latency-obsessed,
   Rust) is built on a `SumTree`/rope, not a piece-table. Our N4 (UI thread sacred,
   off-thread heavy work) is exactly this; the rope is its foundation, available now.
2. **Native coordinates from one mechanism.** Offset↔line falls out of the same
   augmented tree (§5), so the editor's constant coordinate math is O(log n) and uniform,
   not bolted onto a byte-window index.

**Considered and rejected for N1:**

- **Piece-table** (immutable `original` + append-only `add` + a list/tree of windows).
  Its two superpowers are (a) **mmap the original** for instant huge-file open and
  (b) near-free undo from append-only buffers. But **(a) is dead weight for us** — we
  edit in-memory *sections* (13–55 KB), never mmap a 2 GB file — and **(b) the rope
  matches via persistence** (O(1) `Arc`-clone snapshots, *better* than cloning a piece
  list). Meanwhile the piece-table bolts line metadata onto a byte-window structure and
  its "done right" form (balanced piece-tree + line index + delete-splits + node GC +
  two-buffer bookkeeping) has *more interacting parts* than a rope's one recursive
  invariant. Choosing it would have been buying the one feature we don't use while
  giving up the async/coordinate story the north star needs. (This is the reversal of
  the prior draft; the honest case is in `SCRIPTORIUM-NATIVE-EDITOR.md` §8.)
- **Gap buffer** — what N0's `Vec<u16>` approximated. Unbeatable constants and least
  code, but O(n) caret jumps, a bolted-on line index, whole-buffer copy to snapshot, and
  external undo. It is the thing we are replacing.

**The one real cost we accept:** we are **crate-free**, so we hand-roll the rope (no
`Ropey`) — and a correct, balanced, persistent tree is the hardest data structure in
this project. The mitigation is structural: the **model-based fuzz oracle** (§8) makes
hand-rolled-rope risk affordable (fuzz to millions of ops against a trivially-correct
`Vec<u16>` model), and the `TextBuffer` interface makes the structure a **swap point** —
correctness is the oracle's job, not the structure's cleverness.

## 4. The data structure

```
pub struct TextBuffer { root: Link }          // Link = Option<Arc<Node>>; None = empty
pub struct Snapshot   { root: Link }          // an immutable view; clone is O(1)

enum Node {
    Leaf(Vec<u16>),                            // a chunk of UTF-16 units, 1..=MAX_CHUNK
    Branch { left: Arc<Node>, right: Arc<Node>, summary: Summary, height: u8 },
}
struct Summary { len: usize, lines: usize }    // subtree UTF-16 units + newline (0x000A) count
```

- **Persistence.** Every node is shared via `Arc`; edits *path-copy* — they allocate
  O(log n) new nodes along the touched spine and **share every untouched subtree** with
  the old root. So `snapshot()` is `root.clone()` (one `Arc` bump), and an old snapshot
  stays valid and immutable forever (until dropped).
- **Augmentation.** `Summary` is recomputed (cheaply, from children) at every node
  construction; `len` drives offset indexing/splitting, `lines` drives offset↔line.
  Extending it (chars, grapheme estimate, visual width) is a one-field change — the
  `SumTree` property.
- **Chunked leaves.** Leaves hold up to `MAX_CHUNK` (≈1024) units so the node count is
  ~`total/MAX_CHUNK` (a 55 KB section ≈ ~27 leaves), keeping the tree shallow and scans
  cache-friendly. Adjacent small leaves **merge on concat** (§5) so edits don't shatter
  the rope into one-unit leaves.

**Invariants** (the §8 oracle enforces them by construction): no empty `Leaf`; `Branch`
`summary.len == left.len + right.len` and `summary.lines == left.lines + right.lines`;
`height == 1 + max(child heights)`; the empty document is `root == None`, never a
`Leaf(vec![])`.

## 5. Operations — `split` + `concat`, and everything from them

The rope's whole edit algebra is two functions; insert and delete are one-liners over
them, which is what keeps the correctness surface small.

- **`concat(l, r) -> Arc<Node>`** (sequence: all of `l`, then `r`):
  - **leaf-merge fast path:** if both are leaves and the combined length ≤ `MAX_CHUNK`,
    return a single merged `Leaf` (this is what makes typing at the end/front coalesce
    into one growing chunk rather than a spine of tiny leaves).
  - otherwise build `Branch{l, r}` with a recomputed summary/height, then **rebalance if
    skewed** (§9): if the height exceeds a small multiple of the ideal for its length,
    rebuild that subtree balanced from its in-order leaves (an obviously-correct rebuild;
    balance affects only performance, never content). `concat` of `Link`s threads `None`.
- **`split(n, at) -> (Link, Link)`** at a UTF-16 offset: descend by subtree `len`; at a
  leaf, slice the chunk into `[..at]` / `[at..]` (dropping empty sides to `None`); on a
  `Branch`, recurse into the side containing `at` and `concat` the untouched side back.
- **`insert(at, units)`** = `let (l, r) = split(root, at); root = concat(concat(l,
  leaf(units)), r)`.
- **`delete(a..b)`** = `let (l, rest) = split(root, a); let (_, r) = split(rest, b-a);
  root = concat(l, r)`.
- **`to_units() -> Vec<u16>`** — walk leaves in order, extending a fresh `Vec`. The one
  contiguous materialization the parser (`parse_document(&[u16])`) and renderer
  (`IDWriteTextLayout`) consume; rebuilt once per edit, not per frame (§7).
- **Augmented queries:** `line_of_offset(off)` (newlines before `off`) and
  `offset_of_line(line)` descend reading `summary.lines`/`summary.len` in O(log n) — the
  Ln/Col source, and the seed of the coordinate layer N3 builds on.

Locating/splitting is **O(log n)**; an edit allocates **O(log n)** nodes and shares the
rest. `snapshot()` / `restore()` are **O(1)**.

## 6. Undo / redo — O(1) checkpoints via structural sharing

Persistence makes undo nearly trivial and genuinely cheap:

- **`UndoStack`** = `Vec<Checkpoint>` where `Checkpoint { snap: Snapshot, caret: usize }`
  and `snap` is an **O(1) `Arc`-clone of the rope root** — *no text and no piece list is
  copied*; the old tree is simply kept alive and shared with the live one. A matching
  **redo** stack is **cleared on any fresh edit**.
- **Grouping (the "feels right" minimum):** consecutive single-unit **inserts** (a typing
  run) coalesce into one undo step, and consecutive **Backspaces** into one; a caret
  move, an Enter, or a kind-switch **closes** the group (so the *next* edit pushes a
  fresh pre-edit checkpoint). Ctrl+Z removes a word-ish run, not one letter.
- **Minimal-first, honestly.** This is the minimal tier and it is *already* optimal in
  the dimension that matters (checkpoints are O(1) and share structure). A bounded
  history depth or coalescing of adjacent snapshots is a trivial later refinement; the
  persistent rope means we will never need the piece-table's "store deltas" complexity to
  keep undo cheap.

## 7. Caret & integration (the N1 editing model)

`app.rs` swaps its `Vec<u16>` for a `TextBuffer` plus a flat materialization mirror:

- **State:** `buffer: TextBuffer` (the rope — edits + O(1) undo snapshots + coordinate
  queries), `text: Vec<u16>` (the current materialization, refreshed from the rope after
  every edit — the render/parse feed), `caret: usize`, `undo`/`redo` stacks, a `group`
  marker. The rope and the flat mirror coexist *on purpose* (see the perf note below).
- **Edits:** typing → `buffer.insert(caret, &[unit]); caret += 1`. Backspace → delete the
  code point before the caret (one unit, or two for a high+low surrogate pair) and move
  back. Enter → insert `0x000A` (and close the undo group). After every edit:
  `text = buffer.to_units(); reparse(&text); InvalidateRect`.
- **Movement (code-point granularity):** Left/Right step over a surrogate pair as one
  (never land between halves); Home/End go to line start/end (via the `text` mirror).
  **Grapheme clusters, selection, click-to-position, and Up/Down are N2/N3.**
- **Coordinates:** the status line shows `Ln {line+1}, Col {col+1}` using
  `buffer.line_of_offset(caret)` / `offset_of_line` — the augmented query in real use.
- **Input plumbing (`win32`):** movement keys arrive as **`WM_KEYDOWN`** virtual-key
  codes (`VK_LEFT/RIGHT/HOME/END`), so N1 adds a `WM_KEYDOWN` arm (N0 handled only
  `WM_CHAR`); typing/Backspace/Enter and **Ctrl+Z = `0x1A`** / **Ctrl+Y = `0x19`** ride
  `WM_CHAR` as before. No new externs — these messages already flow through the pump;
  `win32/sys.rs` only gains the `WM_KEYDOWN` + `VK_*` constants.
- **Render:** unchanged in shape — builds its `IDWriteTextLayout` from `&app.text` and
  draws the caret via `HitTestTextPosition` at the now-arbitrary caret offset.

**Why a rope *and* a flat mirror, honestly.** N1 still reparses the whole section
(~580µs — `SCRIPTORIUM-WASM-MARSHALLING.md`) and re-materializes `text` (~tens of µs) per
edit; both are O(n), so the rope's O(log n) edits are *dominated and invisible today*.
The rope earns its place now for the three things that are **not** about today's
keystroke latency: **O(1) undo** (needed now), **O(1) immutable snapshots for the coming
off-thread parse/save** (N4 — the API lands now, structurally ready), and **native
coordinates** (Ln/Col now; the substrate N3's selection/scroll geometry builds on). When
incremental parse and virtualized layout (sirens) remove the per-edit full materialization,
the rope is already the right shape and the core is not rewritten. Correctness + the right
spine now; the latent perf win unlocked later without a redo. This is the project's
measure-gated discipline, stated plainly.

## 8. Testing — the buffer oracle

The buffer is **pure logic with no feel component**, so unlike the renderer it is
*fully* oracle-able — held to the parser's equivalence-oracle standard:

- **Model-based differential fuzz.** A trivially-correct reference (a `Vec<u16>` with
  `insert`/`drain`, plus a `Vec<(Vec<u16>, caret)>` history for undo/redo) runs in
  lockstep with the `TextBuffer` under a seeded random stream of `insert` / `delete` /
  `undo` / `redo`; after **every** op, assert `buffer.to_units() == model` and
  `buffer.len() == model.len()`. Seed-driven and deterministic — a failure reproduces
  from its seed.
- **Augmented-query checks:** after random ops, assert `buffer.line_of_offset(k)` equals
  the model's newline count in `[0, k)` for sampled `k`, and `offset_of_line` round-trips.
- **Invariant checks (§4):** no empty leaves, `summary`/`height` consistency, persistence
  (a snapshot taken earlier still materializes to its old contents after later edits —
  the structural-sharing guarantee, tested directly).
- **Targeted unit cases:** boundary inserts/splits at chunk edges, the leaf-merge
  coalesce (a typed run stays few leaves), delete spanning multiple leaves, undo across a
  group boundary, redo-cleared-on-edit, surrogate-pair caret steps over astral chars.
- **Where it runs:** the buffer module is **not** `#[cfg(windows)]` — it compiles and
  tests on **every** platform. The oracle runs in `scriptorium-native.yml` on the
  Linux/macOS jobs (which gain a `cargo test --bin` step) *and* the Windows jobs, with a
  `SCRIPTORIUM_FUZZ`-scaled iteration count (maximal-CI: crank it). Unlike N0's
  DirectWrite geometry oracle, this needs no GPU/DWrite, so every runner exercises it —
  N1's real, automatable regression value. (Local note: this laptop has no MSVC linker,
  so the oracle is validated on Actions, not here; `cargo check --tests` type-checks it.)

## 9. Performance posture & the deferred upgrades

- **Binary chunked rope now; high-fanout B+-tree later.** The architecturally-decisive
  properties — persistence, augmentation, O(log n) edits/queries, O(1) snapshots — are
  fully delivered by a binary chunked rope. A **high-fanout B+-tree / `SumTree`** (better
  cache behavior, fewer nodes) is a **constant-factor** upgrade only — and at section-to-
  book scale the binary rope is asymptotically identical with a far smaller hand-rolled
  correctness surface. So we build the binary rope and name the B+-tree as the
  measure-gated escalation behind the unchanged `TextBuffer` interface. (Honest reversal
  framing: the B-tree is "sheer best" *only* on the constant-factor axis, which is the one
  axis that is a siren for us.)
- **Balance by rebuild-on-imbalance for v1.** `concat` rebuilds a subtree from its leaves
  when height exceeds a small multiple of the ideal — obviously correct, and natural
  editing rarely triggers it (leaf-merge keeps typing shallow). A join-based balanced
  `concat` (worst-case O(log n) with no rebuild) is the refinement, same interface.
- **No leaf compaction / GC beyond merge-on-concat** — unreferenced split fragments are
  bounded at section scale; periodic rebuild is a siren.

## 10. Risks / what could actually bite

- **A bug in `split`/`concat` boundary math** → silent corruption. This is exactly what
  the model-based fuzz (§8) exists to catch; heavy seed counts in CI are the mitigation,
  and it is the reason we can hand-roll a rope at all.
- **Persistence aliasing** — a path-copy that accidentally mutates a shared `Arc` node
  (it must not; nodes are immutable, edits build new ones). Tested directly by the
  "old snapshot still valid after edits" check.
- **Surrogate pairs at the caret** — movement/backspace must treat a high+low pair as one
  code point or write a lone half; covered by astral-char movement tests.
- **Undo grouping feel** — too coarse/fine; it's **feel**, so it's tuned in the loop
  (the author reacts), not gated.
- **Hand-rolled-rope time cost** — the real schedule risk; bounded by leaning on the
  oracle and accepting rebuild-balance for v1 rather than perfecting a join algorithm now.

## 11. Decisions to feed the umbrella ledger (on completion)

- **Buffer structure = persistent augmented chunked rope** (binary now; high-fanout
  B+-tree/`SumTree` is the measure-gated upgrade) — resolves the §9 *rope vs piece-tree*
  fork toward the rope, and **reverses** the prior piece-table lean (the piece-table's
  one unique advantage, mmap-the-original, is unused at section scale; the rope's
  persistence + native coordinates match the snappiness/own-everything north star).
- **Undo = O(1) snapshot checkpoints via structural sharing**, run-grouped — resolves the
  §9 *undo model* fork; persistence makes the minimal tier already optimal in cost.
- The **buffer oracle** (model-based differential fuzz) extends the equivalence-oracle
  discipline to the editor core and runs on **all** platforms — a data point for how much
  of the native editor stays oracle-able below the feel line.
