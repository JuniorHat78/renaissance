# SCRIPTORIUM-NATIVE-INPUT — N2: input correctness

**Status:** N2a built + CI-validated (2026-06-28); N2b (IME, our-own line breaking) named
and pending. Part of the native-editor umbrella (`SCRIPTORIUM-NATIVE-EDITOR.md`
§7 roadmap, N2). N0 gave us a window + caret + paint; N1 gave us a correct persistent
rope with a *code-point* caret. N2 makes the editor **feel like a real text editor for
real text**: selection, grapheme-cluster motion, word motion, and the clipboard — the
operations a writer does ten times a minute and notices the instant they're wrong.

## 1. Why this node

A code-point caret is a lie on real prose. `é` written as `e`+combining-acute is two code
points; a 👨‍👩‍👧 family emoji is seven; a 🇯🇵 flag is two. Arrowing through them one code
point at a time splits glyphs and parks the caret in the middle of a grapheme — visibly
broken. And without **selection + clipboard** the thing simply isn't an editor: you can't
pick up a sentence and move it. N2 is the "feels right" pass, and the first node we
actually *run* and react to (the feel-loop, umbrella §6).

## 2. Scope (this cut: N2a) and the deferral (N2b)

**In, now (N2a):**
- **Selection model** — an `anchor`/`caret` pair; the selection is the half-open range
  `[min, max)`. Shift+arrows extend; an unshifted motion collapses (to the nearer edge for
  Left/Right, to the moved point otherwise). Select-All.
- **Grapheme-cluster motion** — Left/Right move by a whole grapheme, not a code point. A
  pragmatic UAX #29 subset (see §4) covering what real prose hits: surrogate pairs, CRLF,
  combining marks (Extend), ZWJ sequences, regional-indicator flag pairs, variation
  selectors / emoji modifiers. Backspace deletes a whole grapheme.
- **Word motion** — Ctrl+Left/Right by word; Ctrl+Shift extends.
- **Selection-aware edits** — typing / Enter / Backspace / Paste replace a non-empty
  selection first.
- **Clipboard** — Cut / Copy / Paste via `CF_UNICODETEXT` (hand-rolled Win32 FFI: the
  clipboard + `GlobalAlloc`/`GlobalLock`, consistent with the no-`windows-sys` line).
- **Selection rendering** — fill the selected range's geometry (via
  `IDWriteTextLayout::HitTestTextRange`) behind the text.

**Deferred to N2b (named, not built):**
- **IME composition** (`WM_IME_STARTCOMPOSITION` / `WM_IME_COMPOSITION` /
  `WM_IME_ENDCOMPOSITION`, candidate-window positioning). It's a genuinely large
  sub-system (composition string, clause segmentation, caret-follows-composition) and
  earns its own checkpoint. N2a deliberately lands the Latin-prose feel first; CJK/IME
  is the next slice.
- **Line breaking (UAX #14)** for *our own* wrapping. Today DirectWrite wraps the layout
  for display; we don't yet need our own break opportunities until we own wrapping/virtual
  layout (that's N3 territory). Named here so it isn't forgotten.

## 3. The seam stays clean (umbrella §4)

`app` stays platform-free. The platform layer keeps translating OS events into our own
vocabulary — never the reverse:
- `Motion` gains `Word`-granularity variants; motion calls take an `extend: bool`.
- `win32` reads modifier state (`GetKeyState` for Shift/Ctrl) and maps
  VK + modifiers → `(Motion, extend)`, and Ctrl+C/X/V/A → `app` clipboard/selection calls.
- The clipboard is OS-touching, so it lives behind a tiny `win32::clipboard` seam; `app`
  exposes `selected_text()` / `replace_selection(&[u16])` and the platform moves the bytes.

## 4. Grapheme boundaries — the pragmatic subset

Full UAX #29 needs the grapheme-break property tables from the UCD. We deliberately **do
not** vendor the UCD here; we own the engine and implement the rules that real prose and
common emoji actually exercise, honestly scoped:

1. **Never split a surrogate pair** (already true in N1).
2. **CRLF** is one cluster.
3. **Extend / combining marks** — `U+0300..=036F` and the other common Extend ranges
   (Mn-category combining marks, `U+200D` ZWJ, variation selectors `U+FE00..=FE0F`,
   emoji modifiers `U+1F3FB..=1F3FF`) attach to the preceding base.
4. **Regional indicators** — `U+1F1E6..=1F1FF` pair up (two → one flag).
5. **ZWJ sequences** — a `ZWJ` joins the clusters on either side (family/role emoji).

This is "grapheme-ish": correct for Latin + accents + the common emoji a writer pastes,
and clearly documented as a subset. Upgrading to full UAX #29 (vendoring a compact
break-property table) is a measure-gated follow-up if a real document needs it — the
boundary function is the single choke point to swap.

## 5. Oracles (light — N2 is a feel node)

Geometry/feel is mostly non-oracle-able; we keep the cheap, high-value guards only:
- **Grapheme round-trip** — walking `next_grapheme` from 0 to len and back via
  `prev_grapheme` visits the same boundary set; no boundary lands mid-surrogate.
- **Selection invariants** — `anchor`/`caret` always within `[0, len]` and on grapheme
  boundaries after any op; replace-selection collapses to a caret.
- **Word motion** lands on word/space transitions.
We do **not** try to oracle "the selection looks right" — that's the human half.

## 6. Definition of done

Type/select/cut/copy/paste real prose (accents, an emoji, a flag) and have the caret,
selection, and clipboard all behave; selection paints behind the text; undo/redo still
group sensibly across selection-replacing edits. Then **run it** and start reacting to feel.
