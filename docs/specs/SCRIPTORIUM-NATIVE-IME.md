# SCRIPTORIUM-NATIVE-IME — N2b: IME composition & line-breaking scope

**Status:** BUILT spec-correct (2026-07-05); **feel NOT implementer-validated** — queued for the
author on a real IME (§8, the deliberate limit). N2b-a (composition state machine) + N2b-b
(`WM_IME_*` + imm32 wiring) + N2b-c (inline splice rendering + candidate window) landed with
pure state-machine/splice oracles + a crash/leak smoke guard on real DirectWrite, ASan-clean.
Part of the native-editor umbrella
(`SCRIPTORIUM-NATIVE-EDITOR.md` §7 roadmap, N2b — the deferred half of N2). N2a made the
editor feel right for **Latin** prose (selection, grapheme/word motion, clipboard); N3 made
it **spatial** (retained-layout geometry, scrolling, mouse). N2b makes it feel right for the
**other half of the world's writers** — anyone who types through an Input Method Editor: CJK,
Vietnamese, Indic, and every keyboard that composes a character from a sequence of keystrokes
before committing it.

This is a deep-mechanics node with an unusual property: **its correctness is partly
un-oracle-able by us.** The composition *state machine* and the inline *display splice* are
deterministic and testable without an IME; the actual IMM round-trip (does a real Microsoft
Pinyin / Japanese / Korean IME drive our handlers correctly, and does it *feel* right) can only
be judged by a human typing CJK on a real IME. That boundary is drawn explicitly in §8, and
per the autonomous mandate **N2b is built to spec-correct only — its feel is queued for the
author, not marked validated by the implementer.**

## 1. Why this node

Without IME, the editor is usable by a fraction of the world and silently broken for the rest.
An IME turns a run of keystrokes (`n` `i` `h` `a` `o`) into a *composition* — provisional text
the user is still editing via a candidate list — which only becomes real text on commit. The
umbrella calls this out as **"the sleeper that decides if it feels right for non-ASCII… the #1
jank tell"** (§5). Getting it wrong has loud, specific failure modes: the composition doesn't
show inline (it floats in a gray OS box detached from the text), the candidate window appears
in the top-left corner instead of under the caret, the committed text gets inserted **twice**,
or the composition text leaks into the undo history as a dozen tiny steps. Each is a tell that
the editor doesn't actually own its input. N2b handles them as first-class (§4).

The one non-negotiable that shapes everything: **the composition is provisional and lives
outside the rope until it commits** (§2). The document model must never contain half-composed
text; a reader/parser must never see it; undo must never step into it.

## 2. The provisional-composition principle (the seam)

The hard design question of N2b: the composition string must be **rendered inline at the
caret** (so the user sees what they're typing in place, in the right font, wrapping with the
surrounding text) — but it is **not yet part of the document**. Where does it live, and how
does it reach the glass without polluting the buffer?

**Decision — the composition is a provisional overlay owned by `App`, spliced into the
*display* layout only, never into the rope.**

- **`App` holds `comp: Option<Composition>`**, where
  `Composition { text: Vec<u16>, caret_units: usize, target: Range<usize> }` — the in-progress
  string, the caret's position *within* it (from `GCS_CURSORPOS`), and the target clause
  (the segment the IME is actively converting, from `GCS_COMPATTR`) for distinct styling.
  It is anchored at the current caret offset; the rope is untouched while it exists.
- **Why `App` and not `WindowState`?** Committing a composition *is* a document edit (one
  undo group), and the renderer already reads `App` for `text` + `selection`. Keeping the
  provisional string next to the model it will fold into — with the offsets it will fold in
  *at* — keeps one source of truth for "what is at the caret." `App` stays logical: it holds
  UTF-16 units and offsets, no pixels, exactly as the seam requires (umbrella §4).
- **The renderer reads `app.composition()`** and builds the display layout from a *spliced*
  view — `text[..off] ++ comp.text ++ text[off..]` — drawing the composition range underlined
  (target clause emphasized) and placing the caret at `off + comp.caret_units`. The buffer,
  the parse feed, and the AST signal all still see the **un-spliced** `text`. The splice is a
  pure display concern (§5).
- **`win32` is the conductor**, as always: it translates the `WM_IME_*` message dance +
  `Imm*` calls into `app.set_composition / commit_composition / clear_composition`, and asks
  the renderer for the caret's screen point to position the candidate window.

This is the same delegation philosophy as the rest of the editor: **the OS's IMM subsystem
owns the *composition logic* (candidate lists, conversion, per-language rules — re-implementing
that is the RichEdit-owns-the-caret mistake in another costume), and we own the *semantics* —
where the provisional text lives, how it renders, when it becomes a document edit.**

## 3. The composition lifecycle (the message dance)

An IME session is a sequence of window messages against a per-window **Input Method Context**
(HIMC, obtained via `ImmGetContext` / released with `ImmReleaseContext`). The choreography:

- **`WM_IME_STARTCOMPOSITION`** — a session begins. We (a) collapse any selection into a
  pending replacement so the composition happens at a single caret (§4), (b) seed an empty
  `Composition`, (c) position the candidate window at the caret (§6), and (d) **return 0
  without calling `DefWindowProc`** — that suppresses the OS's default gray composition box,
  because we draw the composition ourselves inline.
- **`WM_IME_COMPOSITION`** — the composition changed; `lParam` is a bitmask of what's ready:
  - **`GCS_RESULTSTR`** — a finalized string. Read it with
    `ImmGetCompositionStringW(himc, GCS_RESULTSTR, …)` and **commit** it to the rope as one
    normal edit (`commit_composition`), then clear `comp`. This is the *only* path that
    mutates the document.
  - **`GCS_COMPSTR`** — the in-progress composition string. Read it +
    `GCS_CURSORPOS` (caret within it) + `GCS_COMPATTR` (per-unit attributes → the target
    clause range) and store as the provisional `comp` (`set_composition`). Re-position the
    candidate window at the new caret.
  - A single message can carry **both** (an IME can commit one clause while continuing to
    compose the next); handle `GCS_RESULTSTR` **then** `GCS_COMPSTR`.
  - **Return 0 without `DefWindowProc`** when we handled it — see §4's double-insert edge.
- **`WM_IME_ENDCOMPOSITION`** — the session ended. Clear any lingering `comp`
  (`clear_composition`) — a commit already fired via `GCS_RESULTSTR` if there was one; a bare
  end with no result is a cancel. Repaint.
- **`WM_IME_CHAR`** — a fully-composed character delivered as a message. In our design the
  result already arrived via `GCS_RESULTSTR`, so we **swallow this** (return 0) to guarantee no
  double insert (§4).
- **`WM_KILLFOCUS`** (mid-composition) — finalize cleanly: `ImmNotifyIME(himc,
  NI_COMPOSITIONSTR, CPS_COMPLETE, 0)` to force the IME to commit what it has (which arrives as
  a normal `GCS_RESULTSTR`), then clear. Never leave a dangling provisional string when the
  window loses focus.

Regular Latin typing is unaffected: keys the IME doesn't consume still arrive as `WM_CHAR`,
which N2a already handles. The IME only interposes when it's active.

## 4. The edges (each a checkpoint obligation)

The mechanics that separate a real IME editor from a broken one, named as first-class:

- **Result double-insert.** The classic bug: `DefWindowProc(WM_IME_COMPOSITION)` with
  `GCS_RESULTSTR` set will itself synthesize `WM_IME_CHAR` / `WM_CHAR` for the result — so if
  we *also* inserted the result from `GCS_RESULTSTR`, the text lands twice. **Rule: when we
  handle `GCS_RESULTSTR` ourselves, we do not forward `WM_IME_COMPOSITION` to `DefWindowProc`,
  and we swallow `WM_IME_CHAR`.** One committed string, one insert.
- **Composition over a selection.** Starting to compose with a selection active must replace
  it (like typing over a selection). We delete the selection at `WM_IME_STARTCOMPOSITION` (one
  edit), collapsing to a caret; the composition then commits at that caret as a *second* group,
  or — cleaner — the deletion is folded so the whole "replace X by composing Y" is one undo
  step. Spec: the selection deletion and the eventual commit share one undo group.
- **Cancel (Escape).** Escape during composition → the IME ends with **no** `GCS_RESULTSTR`
  → `WM_IME_ENDCOMPOSITION` clears `comp` with zero document change. Typing must be exactly
  where it started; undo must have nothing to undo.
- **Caret inside the composition.** The caret is *within* the provisional string
  (`GCS_CURSORPOS`), not after it — e.g. editing an earlier clause of a long Pinyin phrase.
  The rendered caret sits at `off + comp.caret_units`, and `ensure_caret_visible` follows *it*
  (a long composition can push the caret below the fold).
- **Undo granularity.** A committed composition is **one** undo step, not one-per-keystroke.
  The provisional string never entered the rope, so there's nothing to undo about the
  composing; only the final commit is a checkpoint.
- **The parse/AST never sees provisional text.** `refresh()` / `parse_document` run on the
  un-spliced `text`; the status signal (blocks/words) reflects the committed document, not the
  half-typed candidate. The spine invariant (a preview can't be a lie) extends to composition.
- **Focus loss / app switch mid-composition.** Handled in §3 (`CPS_COMPLETE`) — no dangling
  provisional state, no lost keystrokes.

## 5. Rendering the composition (inline splice + clause underline)

The renderer gains a **composition-aware display path**, entirely a view concern:

- When `app.composition()` is `Some((off, comp))`, the layout is built from the spliced units
  `text[..off] ++ comp.text ++ text[off..]` instead of bare `text`. Wrapping, hit-testing, and
  caret geometry then all "just work" through the same retained-layout machinery (N3a) — the
  composition wraps with its surrounding line because it's *in* the layout string.
- The **layout cache key** (N3a's `(content_gen, width)`) must incorporate the composition, or
  a composing keystroke wouldn't rebuild the layout. Add the composition to the key (e.g. a
  per-composition generation, or hash the comp string) so it rebuilds while composing and
  falls back to the plain cached layout the instant composition ends.
- **Underline the composition range** `[off, off + comp.text.len())` with a thin line (the
  universal "this is provisional" affordance), and emphasize the **target clause**
  (`comp.target`, from `GCS_COMPATTR`'s `ATTR_TARGET_CONVERTED`) with a heavier/inverted style
  so the user sees which segment the candidate list is acting on. Underlines are drawn from the
  same `HitTestTextRange` geometry the selection uses.
- The **caret** renders at the composition caret (`off + comp.caret_units`); the normal
  selection highlight is suppressed during composition (there is no selection while composing).

Everything here reads `app`; nothing writes it. The buffer, the parser feed, and the undo
stack are untouched until commit.

## 6. Candidate-window positioning

The IME's candidate list (the popup of character choices) must appear **at the caret**, not the
window origin. After composition starts and whenever the composition caret moves, we set the
composition form:

```
COMPOSITIONFORM { dwStyle: CFS_POINT | CFS_FORCE_POSITION,
                  ptCurrentPos: <caret screen-ish point, client coords>, rcArea: client rect }
ImmSetCompositionWindow(himc, &form)
```

The point is the caret's position in **client pixels** — we already compute the caret in
content-space DIPs (`caret_xywh`), apply the scroll/pad transform (N3 §3) to viewport DIPs, and
scale back to physical client pixels. `CFS_FORCE_POSITION` pins it (some IMEs otherwise
reposition heuristically). Optionally `ImmSetCompositionFont` matches the composition font to
ours, so the inline preview and the candidate window agree typographically.

## 7. Line breaking (UAX #14) — the scope decision

N2a named "our-own UAX #14 line breaking" as N2b's second half, **gated on "when we own
wrapping."** The honest finding, now that N3 is built:

**We do not own wrapping — DirectWrite does, and it does UAX #14 correctly.** The retained
`IDWriteTextLayout` (N3a) is created with a wrap width; DWrite computes break opportunities
(UAX #14: breaks after spaces and hyphens, never inside a word, CJK per-character breaking,
non-breaking spaces, etc.) as part of shaping — the same delegation as glyph rasterization
(umbrella §3: we own the engine, the OS turns text into positioned glyphs). Re-implementing
UAX #14 to feed a *custom* wrapper would mean replacing something correct and free with
something we'd have to build and prove, for **zero** current user-visible gain.

**Decision: our-own UAX #14 stays deferred, and it is `siren` (measure/need-gated), not
`need-now`.** Its trigger is a concrete future need for a *custom wrapper*, of which there are
three named candidates, none present today:
- a **no-wrap / horizontal-scroll** mode (N3 explicitly deferred h-scroll — text wraps),
- **virtualized layout** (laying out only the viewport — the umbrella `siren`; a custom
  wrapper needs its own break logic), or
- a **felt breaking bug** where DWrite's default breaks are wrong for our prose.

Until one arrives, DWrite's line breaking is the right answer, exactly as its glyph
rasterization is. N2b is therefore, in practice, **the IME node**; line breaking is a named
deferral with an explicit trigger, resolved into the ledger.

## 8. Oracles (and the honest limit)

N2b's testability splits cleanly, and the split must be stated plainly:

**Oracle-able without an IME (deterministic, we own it):**
- **Composition state machine** — start → update → commit and start → update → cancel
  transitions; a committed composition mutates the rope exactly once and is one undo group; a
  cancelled composition leaves the rope and undo stack untouched; composition-over-selection
  replaces the selection; the caret lands at `off + caret_units`. Pure `App`-level logic,
  tested like the buffer/grapheme oracles (no DWrite, every platform).
- **Display splice** — for a given `text`, offset, and composition string, the spliced layout
  string and the underline range are exactly `text[..off] ++ comp ++ text[off..]` and
  `[off, off+len)`. Pure; testable against a bare layout for the geometry half (like the N3
  round-trip oracle).

**NOT oracle-able by us (needs a human with a real IME):**
- Whether a real Microsoft Pinyin / Japanese / Korean IME actually drives
  `WM_IME_STARTCOMPOSITION`/`COMPOSITION`/`ENDCOMPOSITION` with the flags and strings we
  expect, whether `ImmGetCompositionStringW` returns what we read, whether the candidate window
  lands under the caret, and — the whole point — whether it **feels right** to compose in.
  Synthetic `WM_IME_*` messages can be *sent* through the WndProc, but `ImmGetCompositionStringW`
  reads the real IMC, which a synthetic message doesn't populate — so the smoke test can prove
  the handlers **link, dispatch, and don't crash / leak** (ASan) when called, and no more.

**What we ship as guards:** the pure state-machine + splice oracles (real coverage), the ABI
assert for `COMPOSITIONFORM`, and a smoke extension that drives the IME message handlers through
the real WndProc (crash/leak guard, the never-called-FFI-slot discipline for `Imm*`). The feel
verdict is explicitly the author's, queued for return — **N2b is not marked feel-validated by
the implementer** (mandate).

## 9. Scope & deferrals

**In (N2b):** the provisional-composition model in `App` (`set/commit/clear_composition`,
selection-replace, one-undo-group commit); the full `WM_IME_*` lifecycle + `Imm*` FFI
(imm32, hand-declared, no `windows-sys`); result double-insert prevention; cancel + focus-loss
handling; inline composition rendering (spliced display layout, composition underline, target-
clause emphasis, caret-within-composition); candidate-window positioning at the caret; the
state-machine + splice oracles + smoke/ASan coverage.

**Deferred (named):**
- **Our-own UAX #14 line breaking** — `siren`, gated on owning wrapping (§7). DWrite wraps
  today and does UAX #14 correctly; trigger = no-wrap mode / virtualized layout / a felt
  breaking bug.
- **Full `GCS_COMPATTR` clause styling** — we style the target clause distinctly; richer
  per-clause coloring (converted vs. unconverted vs. input) is a feel refinement, not
  correctness. Named.
- **Reconversion / `ImmSetCompositionString` round-trips** (select committed text and
  re-open it in the IME) — an advanced affordance, not needed for the core compose loop.
- **Level 3 / TSF (Text Services Framework)** — the modern successor to IMM32. IMM32 is fully
  supported and simpler to hand-declare; TSF is a large COM surface and a `siren` — only if a
  concrete need (advanced input, handwriting) appears.

## 10. Definition of done

Type a CJK phrase through a real IME and watch it compose **inline at the caret**, underlined,
with the target clause emphasized and the candidate window under the caret; pick a candidate and
it commits **once**, as one undo step; press Escape and it vanishes with the document untouched;
switch apps mid-composition and nothing is lost or duplicated; the parser/AST signal only ever
reflects committed text. The state-machine + splice oracles pass on every platform; the smoke
test drives the IME handlers on Windows crash-free and ASan-clean. Then hand it to the author to
**judge the feel** — the half that, for IME above all, only a native typist can settle.
