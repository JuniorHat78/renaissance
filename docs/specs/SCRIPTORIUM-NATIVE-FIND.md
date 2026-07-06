# Scriptorium Native Editor — Find / Replace

**Status: SPEC (planned) — 2026-07-06.** The next node after the styling work, and the
last piece of table-stakes standing between the editor and *drafting in it for real*: an
author cannot live in a tool that can't search its own document. Chosen by the author over
two alternatives (undo-granularity polish — queued as the follow-on "Editing polish" node;
and the site-integration through-line — deferred as an open fork, §11 of the umbrella).

Built against the umbrella (`SCRIPTORIUM-NATIVE-EDITOR.md`) — same dependency line (the OS
API, no crate), same seam (`app` platform-free; only `win32`/`render` touch the OS), same
depth discipline (enumerate the edges, oracle what we own, queue only genuine feel). This is
a **reuse node**: nearly every mechanism it needs already exists (the selection model, the
`fill_selection_range` highlight path, the `content_gen` staleness key, the N5 viewport, the
N4 off-thread substrate). Its job is to compose them, not to invent — which is exactly why
it earns a spec: the correctness lives in the *seams* between pieces that already work.

---

## 1. Scope — and the honest boundary

**In:**
- **Find.** A query, matched against the document; match count; next / previous navigation
  with **wrap-around**; the active match revealed (scrolled into view) and selected; all
  matches highlighted in the viewport.
- **Replace.** Replace the active match; **Replace All**. Each is a clean undo transaction
  (one Ctrl+Z reverses a Replace; one Ctrl+Z reverses a whole Replace All).
- **Options.** Case-sensitive toggle; whole-word toggle. Both reuse machinery we own
  (ASCII/Unicode case fold; the UAX-#29 word boundaries from N2a).
- **A self-drawn find bar** — a small overlay we render and drive with *our own* text engine
  (§4). The query field is a tiny single-line editor instance; the replace field a second.

**Out (named sirens, §10):**
- **Regex.** Hand-rolling a regex engine (no `regex` crate — non-negotiable #1) is its own
  landmark, not a rider on this one. Literal + whole-word covers the drafting need; regex is
  a clean later add behind the same match-provider interface (§3).
- **Off-thread search.** The scan is synchronous first (§3) and only moves to the N4 worker
  if a measurement shows it crossing the frame budget — measure before optimizing
  (non-negotiable #5). The interface is built so the move is behind the seam.
- **Find in files / project-wide search**, incremental "search as a filter" view, search
  history, "highlight all occurrences" as a persistent document decoration outside find-mode.
  None are needed to draft; each is a clean add on this substrate.

**The boundary we can and can't oracle.** The *match engine* and the *replace transactions*
are pure and fully oracled on every platform (they're `&[u16]` in, ranges/edits out — no OS).
The *find bar's rendering and focus* are exercised for crash-freedom by the windowed smoke,
and its **feel** (does typing in the bar feel instant, does the active-match reveal land where
the eye expects) is the author's — but the surface here is small, and correctness is most of it.

---

## 2. Dependency line

**No new crate; no `windows-sys`; and — notably — no new FFI surface.** Everything Find needs
at the OS boundary already exists:
- Highlighting is `fill_rectangle` behind glyphs (`fill_selection_range` today) with a new
  brush — the exact selection/composition path (`render.rs`).
- Revealing a match reuses N3's scroll-to-caret + N5's `para_top`.
- The find bar renders with the `IDWriteTextLayout` + `DrawTextLayout` we already consume,
  and takes input through the `WM_KEYDOWN`/`WM_CHAR` we already route.

So this node adds **zero** hand-rolled bindings — a first for a feature node, and the payoff
of having built the engine. The only new *types* are ours (`FindState`, `MatchProvider`).

---

## 3. The match engine — `find.rs` (platform-free)

A new un-gated module (like `buffer`/`grapheme`/`codec`/`parse`), oracled on every platform.

**The provider interface (the regex seam).** Matching is expressed behind one function shape:

```
fn matches(haystack: &[u16], query: &[u16], opts: FindOpts) -> Vec<Range<usize>>
```

`FindOpts { case_sensitive: bool, whole_word: bool }`. The literal implementation is a plain
forward scan; a future regex/`fuzzy` provider slots in behind the same signature (§10). Ranges
are half-open `[start, end)` UTF-16 offsets into `text` — the same coordinate space as the
caret/selection, so a match *is* a selection with no translation.

**The literal scan.** Naive O(n·m) forward search over `&[u16]`. This is deliberately the
simplest correct thing (non-negotiable #5): parse is already ~sub-ms at section scale and a
substring scan is *cheaper* than a parse, so there is no measured reason to reach for Two-Way /
Boyer-Moore-Horspool yet — that is a named siren (§10) behind the same interface. **Edges the
scan must get right, and oracle:**
- **Empty query → zero matches** (not "every position"); the find bar shows no count, no
  highlight, and next/prev are inert. The moment the query clears, matches clear.
- **Overlapping occurrences.** `"aa"` in `"aaaa"` → non-overlapping by convention (matches at
  0 and 2), the same rule every editor uses, so Replace All terminates cleanly.
- **Surrogate pairs.** The scan is over UTF-16 units, but a match must **not** begin or end
  mid-surrogate — align to grapheme-safe unit boundaries (reuse `grapheme`), so an emoji query
  matches an emoji in the text and a match range is always splice-safe.
- **Case fold.** `case_sensitive: false` folds ASCII A–Z first cut; Unicode *simple* fold
  (per-`char`, decoding surrogates) is a refinement behind the same toggle — folding is a
  function swap, not a scan rewrite. Oracle the ASCII path now; leave a `// TODO Unicode fold`
  anchor with a failing-if-uncommented oracle stub.
- **Whole word.** A match survives only if both edges sit on a UAX-#29 word boundary
  (reuse N2a's boundary predicate) — so "cat" whole-word skips "category". Reuses the engine
  we already own; adds no new Unicode data.

**Recompute discipline (the staleness seam).** The match set is a pure function of
`(content_gen, query, opts)`. It is cached and recomputed lazily on any of those changing —
the *exact* pattern as the N3 layout cache keyed on `content_gen`. After any edit (including a
Replace), `content_gen` bumps and the matches re-scan against the new text; a stale match set is
never navigated. The **active match index** is preserved across a recompute *by offset* where
possible (keep the caret on the same spot), falling back to the nearest match, so typing near a
match doesn't fling the selection across the document.

---

## 4. The find bar — self-drawn, driven by our own engine

**Why not a Win32 `EDIT` child.** Non-negotiable #2: *"The OS provides a window, a surface,
input events — nothing more."* A child edit control is an OS widget that would own its caret,
its input, its IME — the precise thing the RichEdit rejection (§8 ledger) was about. So the
find bar is **ours**, rendered and driven exactly like the document.

**Mechanism — a `MiniEdit`.** The query field is a small, single-line reuse of everything the
document already has: a tiny buffer (a `Vec<u16>` is enough — a query is short; no rope needed),
a caret + anchor, grapheme/word motion, selection, clipboard paste, and — for free — IME (the
query field composes through the same `WM_IME_*` path). Two instances: query and replace. This
is the craftsman payoff: a text input is *already solved*, so the bar is a small
composition, not a new engine. `MiniEdit` lives in `app` (platform-free, oracle-able); the bar's
*geometry* (a strip near the top-right, over the document) and *paint* live in `render`.

**Focus + routing (the input seam).** `App` gains a `focus: Focus { Document, FindQuery,
FindReplace }`. `win32` routes a keystroke to the focused sink. The find bar is a **mode**, not
a window: opening it (Ctrl+F) sets focus to the query and seeds it from the document selection
(the universal "select a word, Ctrl+F, it's pre-filled" affordance); Tab moves query↔replace;
**Esc** closes the bar and returns focus to the document, leaving the caret **on the active
match** (so you close find and start editing exactly where you landed). The document keeps
rendering and reparsing live underneath — find-mode never freezes the editor.

**Keys (in find-mode):**
- **Ctrl+F** open / focus query (seed from selection). **Ctrl+H** open with replace visible.
- **Enter / F3** next match; **Shift+Enter / Shift+F3** previous; both **wrap** (with a
  quiet "wrapped" affordance, §5).
- **Enter in the replace field** (or a Replace button-key) replaces the active match then
  advances; **Ctrl+Alt+Enter** (or Replace-All key) replaces all.
- **Esc** closes, focus → document, caret on the active match.

---

## 5. Rendering — reuse, not new pixels

- **All matches (viewport only).** For each match whose range intersects a *visible* paragraph
  (N5 gives the visible paragraph span), fill its rects with a **match brush** — the identical
  `fill_selection_range` path, a new palette color (a soft highlight, distinct from the blue
  selection). Off-screen matches cost nothing (virtualized — we never shape them).
- **The active match** gets a stronger fill (or an outline) so the one Enter will act on is
  unambiguous, and it is *also* the live selection (§3), so it reads as selected too.
- **Reveal.** Making a match active scrolls it into view via N3's reveal-caret + N5's
  `para_top(i) + local` — the active match's paragraph is ensured and its y computed exactly as
  the caret's is. No new scroll math.
- **The bar itself.** A small rounded strip, self-drawn: the query `MiniEdit`, a match counter
  (`3 / 17`, or `0 / 0` greyed when no match, or `no results` when the query is non-empty and
  unmatched), the option toggles, and (in replace mode) the replace `MiniEdit`. Drawn last, over
  the document, with a subtle shadow/backing so it reads as floating. Colors join the styling
  `Palette`. **Wrap affordance:** when next/prev wraps past an end, a brief non-modal flash on
  the counter (feel knob — the author tunes it), never a dialog.

---

## 6. Replace — the undo contract

Replace routes through the **existing** `replace_selection` + undo grouping (`app`), so it
inherits correct rope edits, caret placement, `content_gen` bump, live reparse, and re-style
for free. The only new logic is *what* to select and *how* to group:

- **Replace (one match).** Select the active match, `replace_selection(replacement, …)` as its
  **own** undo group (`self.group = None` before and after — a replace is never coalesced into
  adjacent typing, exactly as paste isn't), then recompute matches (content changed) and advance
  the active match to the next one at/after the edit. One Ctrl+Z reverses it.
- **Replace All.** **One** undo checkpoint for the entire operation: push a single pre-edit
  snapshot, then apply every match's replacement in **one** pass. Apply **right-to-left** (from
  the last match to the first) so earlier match offsets never shift under the edit — no offset
  bookkeeping, no drift, and the classic "replace changed the length so the next match moved"
  bug is impossible by construction. One Ctrl+Z reverses the whole batch. Report the count
  replaced.
- **Empty replacement** is legal (Replace = delete the match). **Replace with a superstring of
  the query** (e.g. `cat`→`cathedral`) must not re-match its own output — because we compute the
  full match set *once* up front and apply right-to-left over that fixed set, self-matching
  can't happen (a live "match, replace, re-scan, repeat" loop would infinite-loop on
  `a`→`aa`; the snapshot-the-matches-then-apply design is what prevents it — this is the subtle
  correctness heart of the node and gets a dedicated oracle).
- **Interaction with a live composition.** Replace is disabled while an IME composition is
  active in the document (there is provisional text outside the rope — §2 of IME); the find
  bar's own composition is fine (it's the query, not the document).

---

## 7. The seam — what moves where

| Layer | Addition | Stays true to |
|---|---|---|
| `find.rs` (new, platform-free) | `matches()`, `FindOpts`, the literal provider, case-fold + whole-word predicates | Un-gated, oracled every platform (like `buffer`/`codec`) |
| `app` | `FindState` (query/replace `MiniEdit`s, opts, active index, cached match set + its `content_gen`/query key), `focus`, the Ctrl+F/H/Esc/next/prev/replace/replace-all commands, Replace-All-as-one-undo | Platform-free; `win32` calls in with our own event types, never OS types |
| `render` | the match-highlight brush + viewport-match fill, the active-match emphasis, the self-drawn bar + its `MiniEdit` paint, the wrap flash | Reuses `fill_selection_range`, the styling `Palette`, N5 visible-span, N3 reveal |
| `win32` | route keystrokes by `focus`; the find-mode key table; open/close on Ctrl+F/Esc | The sole conductor (as in N3/N4); no new FFI |

`app` stays the platform-independent authority; `win32` stays the only OS toucher; `render`
reads. The N3/N5 geometry seam is unchanged — a match reveal is a caret reveal.

---

## 8. Checkpoints

Bin-crate reality (from IO/styling): `pub` is not reachability in a binary, so a vertical slice
must land warning-free. Planned split (may collapse to fewer commits if the dead-code line
forces it, as IO's two did):

- **F-a — the match engine (`find.rs`).** Literal scan, case-fold, whole-word, surrogate-safe,
  overlap rule, empty-query rule. Pure, fully oracled (including a differential fuzz: our scan
  vs a trivially-correct reference over random haystack/query/opts). No UI yet — dead in the bin
  until F-b wires it, so F-a + F-b likely land together (like IO-a+IO-b).
- **F-b — find-mode + navigation + highlight.** `FindState`, `MiniEdit`, focus routing, Ctrl+F
  seed-from-selection, next/prev/wrap, viewport highlight + active-match reveal, the self-drawn
  bar. The smoke test drives Ctrl+F → type a query → Enter-through-matches → Esc on a real
  window and asserts the caret lands on a match and nothing leaks/crashes.
- **F-c — replace + replace-all.** The one-undo-per-replace and one-undo-for-all transactions,
  right-to-left application, the self-match-safety oracle, count reporting. Smoke drives a
  Replace All on a live window and asserts the byte result + a single Ctrl+Z reversal.

Every checkpoint: debug + release oracles, ASan-clean (there's no new FFI, but the highlight
path touches the render target — run it), clippy clean, warning-free, per-checkpoint commit +
push. Pre-push runs the release oracle suite; the smoke/ASan/wasm-parity matrix stays in CI.

---

## 9. The oracle plan — what's deterministic here

Find is unusually oracle-friendly for a UI node, because the hard part is pure:
- **Match engine:** empty-query, overlap, surrogate boundaries, case-fold (ASCII now,
  Unicode-fold stub), whole-word boundaries, and a **model-based differential fuzz** (scan vs a
  naive reference) — the same discipline that made the rope and codec safe.
- **Replace transactions:** Replace-All right-to-left equals the expected byte string;
  self-matching superstring replacement terminates and is correct; one undo reverses a Replace;
  one undo reverses a whole Replace All; caret/active-index placement after each.
- **`MiniEdit`:** it's a text input — reuse the N2a motion/selection oracles against it
  (grapheme motion, select-all, clipboard) so the query field is as correct as the document.
- **Not oracle-able (author's feel-loop):** the highlight color + active-match emphasis, the bar
  geometry/shadow, the wrap-flash timing, whether reveal lands where the eye expects. Feel knobs,
  tuned in the real exe — flagged, never gated.

---

## 10. Sirens (named, measure- or need-gated)

- **Regex / fuzzy matching** — behind the `matches()` provider seam; a hand-rolled engine is its
  own landmark (no `regex` crate).
- **Off-thread search** — on the N4 worker over the rope snapshot, if a measurement shows a
  full-doc scan crossing the frame budget on book-scale content. The recompute seam (§3) is
  already shaped like the parse gate, so the move is mechanical when a number demands it.
- **Sublinear scan** (Two-Way / BMH) — behind the same provider; only when the linear scan is
  measured slow.
- **Search history, find-in-files, persistent highlight-all, incremental filter view** — clean
  adds on this substrate; none block drafting.

---

## 11. Relationship to the rest

- **Reuses, doesn't fork.** This node is the dividend of owning the engine: selection, undo,
  highlight, reveal, virtualized viewport, IME, clipboard all already exist — Find composes them.
  It adds zero FFI and one platform-free module.
- **Quarantine intact.** Author tooling; never ships to readers (`SCRIPTORIUM.md` §6).
- **The follow-on: "Editing polish" (Lane B).** Queued next, spec'd just-in-time when we start
  it: undo *granularity* (today a continuous typing run is a single undo group — `begin_group`
  only breaks on edit-*kind* change; a word/pause boundary should start a new group so Ctrl+Z
  reverts a word, not a paragraph), plus small status-line richness (word/char count). Coupled to
  the buffer/undo model, so it earns its own short spec at build time.
- **The deferred through-line (Lane C, open fork).** Wiring the native editor to the published
  `/renaissance/` site pipeline (draft → the same `rust/` parser → compiled manuscript) — the move
  that makes the editor *part of* Renaissance rather than a beautiful island. Recorded as an open
  fork in the umbrella (§9); we'll get to it. Not this node.
