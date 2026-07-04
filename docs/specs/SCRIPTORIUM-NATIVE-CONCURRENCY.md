# SCRIPTORIUM-NATIVE-CONCURRENCY — N4: off-thread parse & latency

**Status:** spec (2026-07-05). Part of the native-editor umbrella
(`SCRIPTORIUM-NATIVE-EDITOR.md` §5 "Concurrency / latency" — tagged `need-now`; §7 roadmap N4).
N0–N3 built a single-threaded editor: every keystroke runs materialize → **parse** → layout →
paint inline on the UI thread. N4 lifts the one unbounded step — `parse_document` — off that
thread, so the keystroke-to-photon path never waits on the parser, and installs the structure
(immutable snapshots, a generation gate, input coalescing) that the measure-gated sirens
(incremental parse, virtualized layout) plug into later.

## 1. Why this node — and the measure-gate it must answer first

Non-negotiable #5 (umbrella §2) is **measure before optimizing**, and the record already says the
parser is *not* slow: ~580µs/section, imperceptible, and the JS⇄wasm marshalling boundary was
specced then *refuted* by measurement (`SCRIPTORIUM-WASM-MARSHALLING.md`). So the first thing this
spec owes is honesty: **at section scale there is no latency win to be had.** A full reparse at
<1ms is already inside a single 16ms frame; moving it to a thread cannot make a keystroke that is
already instant feel more instant. If N4 were sold as "make typing faster," it would be exactly the
premature optimization #5 forbids.

N4 is justified on three grounds that are *not* "today's 580µs":

1. **It is architecture, not a speedup — and it was pre-paid.** The rope (N1) was chosen over a
   piece table specifically because its persistence gives **O(1) structural-sharing snapshots**,
   and the N1 ledger names that "the N4 snappiness foundation, API available now." The umbrella
   tags concurrency `need-now`, not `siren`. The decision to build the substrate was made at N1;
   N4 is cashing a cheque already written, not opening a new speculative line.
2. **The frame budget is a cliff, and prose grows.** 580µs is section scale. A "section" that
   becomes a novel (the umbrella's own framing for the incremental-parse siren) crosses the 16ms
   frame budget on a full reparse, and the instant it does, an inline parse drops frames *mid-
   keystroke* — the single worst felt jank. Building the off-thread seam *before* that cliff means
   the fix is "the worker was already there," not "rewrite the input path under duress." The cost
   of building it now (one thread, one mailbox, a generation counter we already have) is small and
   bounded; the cost of retrofitting it during a felt stall is not.
3. **It is the load-bearing wall for the sirens.** Incremental parse (reuse unchanged subtrees)
   and virtualized layout both assume a worker consuming immutable snapshots off the UI thread.
   Neither can be built until that consumer exists. N4 is the interface they extend, so building
   it now is what keeps *those* measure-gated — you can reach for them behind a stable seam when a
   number demands, instead of them dragging the threading rewrite in with them.

**The honest resolution:** build the concurrency *architecture* now (it is `need-now` and pre-paid),
but do **not** claim a latency improvement that no section-scale benchmark shows. The *latency win*
is measure-gated exactly like a siren — it materializes only when a document is large enough that a
reparse crosses a frame, and N4b instruments the path so that threshold is *measurable* rather than
asserted. This mirrors N2b: the mechanism is correctness-oracle'd; the *feel* payoff is queued for
the author to judge on real (here, large) content, not certified by the implementer.

## 2. The invariant — never paint a half-updated model

The one law the threading must not break: **the UI thread is the sole owner and mutator of `App`.**
The worker never holds a `&mut App`, never touches the rope, the caret, the selection, or `text`.
It reads an **immutable `Snapshot`** (an O(1) rope clone, valid forever via structural sharing) and
returns a small value (block/word counts + timing). Everything the paint path reads — `text`,
caret, selection, the parse signal — is written only on the UI thread, so a `WM_PAINT` can never
observe a torn model:

- The document (`text`, caret, selection) is mutated only by input handlers, all on the UI thread.
- The parse result is folded into `App` only by the UI thread, in the `WM_APP_PARSE_DONE` handler.
- The worker's entire shared surface is `Snapshot` in (immutable) and a `ParseResult` value out —
  no shared mutable state, so there is nothing to tear and no lock on the paint path.

`Snapshot` is `Send` for free: it is `Option<Arc<Node>>` over a `Node` of `Send + Sync` fields, so
handing one to the worker is a pointer move, and the worker dropping it just decrements a refcount.
This is the whole reason N1 chose a persistent rope; N4 is the first code to exercise it.

## 3. The seam (umbrella §4)

`app` stays platform-free and stays the sole state owner. It gains exactly three things and loses
one:

- **Loses:** `refresh()` no longer parses. It materializes `text`, bumps `content_gen`, and clamps
  the caret/anchor — the fast, synchronous, UI-thread part — and leaves the *last known good*
  `ParseSignal` in place until a fresh one arrives (the status line shows slightly-stale stats for
  the ~1ms the parse is in flight; that staleness is the async contract, not a bug).
- **Gains** `snapshot() -> Snapshot` (hand the worker an immutable view), `apply_parse(gen, signal)`
  (fold a result in, **monotonic-gated** — §5), and a private `signal_gen` tracking which generation
  the currently-displayed signal reflects.

The worker choreography (thread, mailbox, the UI wakeup) lives in a new **`parse` module**, sibling
to `win32`/`render`, on the *platform-orchestration* side of the seam — because its reason for being
is the UI-thread/worker hand-off, and the wakeup (`PostMessage`) is inherently Win32. The *parse
call itself* is already platform-free (`parse_document`). `app` never names a thread; `parse` never
names the caret. `win32` owns the `ParseService`, submits on edits, and drains results.

## 4. Architecture — the parse service

```
UI thread (owns App)                         Worker thread (owns nothing shared)
────────────────────                         ───────────────────────────────────
edit → refresh()                              loop:
  materialize text, gen++                       lock mailbox
  submit(gen, app.snapshot())  ──mailbox──►      wait while empty && !shutdown
  InvalidateRect (paint stale-but-consistent)    take latest job (coalesced)
                                                  unlock
                                                  units = snap.to_units()
                                                  signal = parse_document(&units)
                                                  send ParseResult on channel
              ◄──PostMessage(WM_APP_PARSE_DONE, 0, 0)── nudge (contentless)
WM_APP_PARSE_DONE:
  drain result channel → latest
  app.apply_parse(gen, signal)  (monotonic gate)
  InvalidateRect (repaint status)
```

**The single-slot coalescing mailbox.** The submit side is *not* a queue — it is a **one-slot
mailbox**: `Mutex<{ latest: Option<(u64, Snapshot)>, shutdown: bool }>` + a `Condvar`. `submit`
locks, **overwrites** `latest` (dropping any previous pending snapshot — O(1), it is an `Arc`), and
notifies. So if the user types five characters while the worker is busy with the first, the four
intermediate snapshots are dropped and the worker's next `take` gets only the newest. This is the
literal reading of the umbrella's "coalesce N keystrokes → 1 reparse" and "picks up the latest
pending snapshot, not a queue": bounded to exactly one pending job, never a backlog, the parser
never wastes a cycle on a generation the user has already typed past.

**The worker loop.** Blocks on the `Condvar` while the slot is empty (zero busy-wait, zero CPU at
rest), wakes on `submit`, takes the job, releases the lock *before* parsing (so a `submit` during a
parse just refills the slot, never blocks the UI thread), materializes `snap.to_units()` and runs
`parse_document` off-thread, then sends `ParseResult { gen, signal }` on an `mpsc` channel and
`PostMessage`s a **contentless** `WM_APP_PARSE_DONE` to wake the UI thread's `GetMessage` pump.

**Why a channel + contentless nudge, not a boxed pointer through `lParam`.** The classic Win32
cross-thread pattern boxes the payload and passes `Box::into_raw` as `lParam`. We deliberately do
**not**: a boxed pointer sitting in the message queue when the window is destroyed leaks (and would
trip ASan's still-reachable check in the in-process smoke test). Instead the result travels on an
`mpsc::Sender` (Rust owns it; dropping the `Receiver` at teardown frees any queued results), and the
`PostMessage` carries nothing — so the only Win32 artifact that can outlive the window is a
`(WM_APP_PARSE_DONE, 0, 0)` with no owned resource attached. **Teardown is leak-free by
construction**, which is the property the ASan gate needs.

## 5. The generation gate — discarding a stale parse

`content_gen` (introduced in N3a as the layout-cache key, and named there as the forward-aligned
primitive N4 would use) is the staleness token. Two independent guards use it:

- **Coalescing (worker side):** the mailbox holds only the latest generation, so the worker never
  *starts* a parse for a generation the user has already superseded — intermediate generations are
  discarded before any work is done on them.
- **Monotonic apply (UI side):** `apply_parse(gen, signal)` stores the signal **only if
  `gen > signal_gen`**, then advances `signal_gen`. An out-of-order or older result (e.g. a parse
  that finished after a newer one already landed) is dropped rather than regressing the display.
  With one worker + coalescing, results already arrive in generation order; the gate is
  belt-and-suspenders that also makes the invariant total (no assumption about worker count or
  message ordering).

Note the gate never blocks *displaying* a result whose `gen` is older than the current
`content_gen`: while a parse for gen N is in flight the user may already be at gen N+2, and the
gen-N signal is still the best-available AST stats — showing it (then replacing it when N+2's parse
lands) is the async contract. "Discard stale" means the worker skips intermediate generations and
the UI refuses to *regress*, not that the UI insists on a signal that matches the live text.

## 6. Lifecycle & teardown

`WindowState` owns the `ParseService`; the service owns the worker `JoinHandle`, the `Arc<Mailbox>`,
and the `Receiver<ParseResult>`. The worker closure captures a clone of the `Arc<Mailbox>`, the
`Sender`, and the `HWND` as a `usize` (`PostMessageW` is the documented thread-safe cross-thread
call; posting to an already-destroyed window fails harmlessly).

- **Startup:** the service is created in `run()` (and in the smoke harness) and the first parse is
  submitted so the status line seeds. `App::new` leaves the signal at zeros (an empty document has
  zero blocks/words), correct until the first result lands.
- **Steady state:** each content-mutating handler calls `reparse_if_dirty(state)` — submit iff
  `content_gen != last_submitted_gen` — so the many edit call sites funnel through one guard and a
  no-op edit never submits.
- **Shutdown (`ParseService::drop`, run from `WM_NCDESTROY` dropping the boxed `WindowState`):** set
  `shutdown` under the mailbox lock, notify the `Condvar`, and `join` the worker. Joining blocks the
  UI thread in `WM_NCDESTROY` for at most one in-flight parse (≤~1ms at section scale) — acceptable
  at teardown. The `Receiver` then drops, freeing any queued `ParseResult`. No `PostMessage` payload
  to leak (§4). ASan-clean across create/destroy, including the in-process smoke cycle.

## 7. Edges (handled as first-class)

1. **Submit-during-parse** — the worker released the lock before parsing, so the `submit` just
   refills the one-slot mailbox; the UI thread never blocks on a busy worker.
2. **Five keystrokes, one parse** — intermediate snapshots are dropped by the mailbox overwrite; the
   worker parses only the newest. Verified by the coalescing oracle.
3. **Out-of-order / late result** — the monotonic `signal_gen` gate refuses to regress the display
   (§5). Verified by the monotonic-apply oracle.
4. **Result for a superseded generation** — displayed as best-available, then replaced when the
   newer parse lands (the async contract, §5) — *not* discarded on the UI side.
5. **Window destroyed mid-parse** — the worker's `PostMessage` to the dead `HWND` fails silently;
   the `join` in `drop` reaps the thread; the contentless nudge leaks nothing.
6. **Contentless nudge with an empty channel** — a `WM_APP_PARSE_DONE` can arrive after the handler
   already drained the result it referred to (drain-to-latest); the handler treats an empty
   `try_recv` as a no-op. Harmless and expected.
7. **Idle worker** — blocked on the `Condvar`, zero CPU; no spin, no timer.
8. **Panic in the worker** — a `parse_document` panic must not poison the mailbox mutex and wedge
   the UI thread's next `submit`. The worker catches/contains the parse (or the mutex is only ever
   held across non-panicking sections — the parse runs *after* the lock is released, §4), so a
   worker fault at worst stops producing results; the UI thread keeps editing on stale stats.

## 8. Oracles & the testing limit

The concurrency **mechanism** is deterministic and oracle-able; the latency **feel** is not (and at
section scale there is nothing to feel — §1). Split accordingly:

- **Mailbox coalescing (pure):** submit generations 1..5 without draining; assert the slot holds
  only 5, and that `take` yields 5 then blocks — N intermediate submits collapse to one job.
- **Monotonic apply (pure):** `apply_parse` with an ascending then a descending `gen`; assert the
  older result does not overwrite the newer (`signal_gen` never regresses).
- **Snapshot/parse equivalence (pure):** `parse_document(&snapshot.to_units())` equals
  `parse_document(&live.text)` for the same generation — the worker reads exactly what an inline
  parse would have, so async changes *timing*, never *result*.
- **Smoke (real window):** the existing windowed smoke gains a `ParseService`, submits on its
  synthetic edits, and drives one `WM_APP_PARSE_DONE` round-trip so the post-back FFI
  (`PostMessageW`, the new message id) and the create→submit→result→destroy→join lifecycle run
  crash-free and **ASan-clean** on a live OS. A synthetic run cannot prove the *scheduling feel* —
  only that the machinery holds together.

We do **not** oracle "typing feels snappy under an off-thread parse" — at section scale it is
identical to synchronous, and at book scale it is the author's to judge (§9). Following N2b, N4
ships **mechanism-correct with feel explicitly not implementer-validated.**

## 9. Scope, and what stays measure-gated

**In (N4):** the off-thread parse, the single-slot coalescing mailbox, the generation gate, the
contentless post-back, leak-free teardown, and latency **instrumentation** (N4b) so the frame-budget
threshold is measurable, not asserted.

**Out — named `siren`s (umbrella §5), unchanged by N4:**
- **Incremental parse** (reuse unchanged subtrees) — extends the worker; gate on a book-scale reparse
  crossing a frame. N4's seam is where it plugs in.
- **Virtualized layout** — lay out only the viewport; same trigger, same seam.
- **Off-thread *IO*** (save/load/watch) — N4 threads the *parse*; durable IO is the `siren` in §5's
  "Durability / IO" row, gated separately.
- **A frame-pacing / render thread** — `InvalidateRect` already coalesces paints; a dedicated
  present thread is unmotivated until a measured paint stall demands it.

**Out — the latency *win* itself is measure-gated:** N4 builds the architecture and instruments it;
the claim "async parse reduced felt latency" is only made when N4b's instrumentation shows a reparse
crossing the frame budget on real content. Until then N4 is honest substrate.

## 10. Definition of done

Type into the editor and every keystroke's parse runs on the worker: the status-line AST signal
updates a beat behind the text (the async contract), the UI thread never blocks on the parser, and
no keystroke, scroll, caret move, selection, or IME composition can observe a half-updated model.
Coalescing, the monotonic gate, and snapshot/parse equivalence are oracle-pinned; the smoke test
drives a real post-back round-trip ASan-clean; teardown joins the worker and leaks nothing. N4b
instruments keystroke→parse-applied latency so the frame-budget cliff is measurable. Then the
*feel* under large content is the author's to judge — the mechanism is certified, the payoff is
queued.

## 11. Checkpoints

- **N4a — the off-thread parse spine.** The `parse` module (single-slot coalescing mailbox, the
  worker loop, `ParseService::{new, submit, drop/join}`, `ParseResult`); `app.refresh()` stops
  parsing and gains `snapshot()` / `apply_parse` / `signal_gen`; `win32` creates the service,
  `reparse_if_dirty` on edits, and handles `WM_APP_PARSE_DONE` (drain → monotonic apply →
  invalidate); `PostMessageW` + `WM_APP_PARSE_DONE` added to `sys`. Oracles: coalescing,
  monotonic apply, snapshot/parse equivalence. Smoke extended with a service + one post-back
  round-trip. Debug + release + smoke + ASan.
- **N4b — latency instrumentation & the feel surface.** Measure keystroke→parse-applied latency and
  a "parse in flight" state; surface both in the status line so the frame-budget threshold is
  observable on real content; expose whatever tuning the author will want to react to. Verdict, in
  the N2b mould: mechanism oracle-certified, **feel not implementer-validated** — the latency
  payoff is measure-gated and queued for the author on book-scale content.
