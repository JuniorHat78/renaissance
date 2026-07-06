# Scriptorium Native Editor — AST-styled rendering (source-highlight)

**Status: spec — build queued.** The node that makes the parser *visible*. Every prior node built
the text engine (rope, input, IME, off-thread parse, virtualized layout, file I/O); the editor
reuses the `rust/` parser in-process — but renders every character in one flat format. The AST is
computed and thrown away (only `blocks`/`words` counts reach the UI). This node applies the parsed
structure as real per-run DirectWrite formatting: headings look like headings.

Built against the umbrella (`SCRIPTORIUM-NATIVE-EDITOR.md`): same seam (`app` platform-free, only
`render`/`win32` touch the OS), same depth discipline (new COM slots typed + ABI-asserted +
smoke-exercised — the phantom-slot lesson), same honesty (geometry oracle-able, *feel* the author's).

## 1. The decision, and the finding that shapes it

**Source-highlight, not rendered (decided with the author).** Every markdown marker stays on screen
(`# `, `**`, `` ` ``); we *style the spans* — heading text bigger/bold, the markers dimmed. It stays
a faithful **source editor**: display offsets == buffer offsets, the caret walks real characters,
round-trip is exact, and it sidesteps the display↔source mapping a hide-the-markers (WYSIWYG) model
would need. That mapping — and everything it implies for caret/hit-test/selection — is a separate
future landmark (§11).

**The AST gives block spans but not inline spans.** `ast.rs`: every `Block` carries a
`Position { start, end }` (UTF-16 offsets) + its type (`Heading{level}`, `Paragraph`, `PullQuote`,
`BlockQuote`, `List`, `ListItem`, `Divider`); the `Inline` nodes (`Strong`, `Emphasis`, `Code`,
`Link`) carry **no offsets** — deliberately, to mirror the JS parser's serialized output byte-for-byte
(the same parser the site ships; the equivalence oracle guards it). So block-level styling is a direct
read of the AST; inline styling needs a span *source* we don't have yet. That splits the work cleanly:

- **Wave 1 (this spec) — block-level styling.** Uses the AST exactly as-is. The bulk of the visual
  transformation (structure is what stops it looking like Notepad) **and** all the hard infrastructure:
  the range-formatting COM, the staleness-aware apply against the lagging async AST, per-paragraph
  style slicing inside the virtualized layout, and styled paragraph heights.
- **Wave 2 (deferred, §11) — inline styling.** Bolts onto Wave 1's infra. Settles the span-source
  fork *then*: **(a)** teach the shared parser to emit inline spans (a parity-safe internal field, not
  serialized) vs **(b)** re-tokenize inline markers in the editor. A parser-touching call reserved for
  when it is actually needed — not made blind now.

## 2. Scope

**In (Wave 1):** block-level font styling from the AST — headings sized + weighted by level, block/
pull quotes italicized, the rest left plain — applied inside the virtualized per-paragraph layouts,
against the async AST with a staleness contract; the new `IDWriteTextLayout` range-formatting COM
(ABI-asserted + smoke-exercised); the platform-free style-model derivation with its oracle.

**Out — named deferrals (§11):** inline styling (the fork); **color** (via `SetDrawingEffect` + a
brush-as-drawing-effect — more COM; Wave 1 is size/weight/style only, which needs no per-run brush);
**indentation / drawn rules / list markers** (blockquote indent, a divider's horizontal rule, list
bullet glyphs — these move the paragraph's draw origin / add drawn primitives, a small Wave-1.5);
link affordances (click-to-open); and the rendered/hide-markers model.

## 3. The style model — a compact span list off the AST (`styles.rs`, platform-free)

The worker already builds the whole `Document`; it distills a **flat style-span list** from it and
sends that back (the heavy AST never crosses the thread boundary — only a `Vec<StyleSpan>`). Derivation
is pure — a walk over `Document.children` — so it lives in its own **un-gated** module with an oracle
that runs on every CI platform (like `buffer`/`codec`/`heights`).

```
pub enum StyleKind { Heading(u8), BlockQuote, PullQuote, ListItem, Divider }  // Paragraph = default
pub struct StyleSpan { pub start: usize, pub end: usize, pub kind: StyleKind } // UTF-16 offsets
pub fn styles_of(doc: &Document) -> Vec<StyleSpan>                            // sorted by start
```

- Walk the block tree; **flatten to leaf spans**: a `BlockQuote`/`List` yields spans for its child
  blocks (a quote's paragraphs get `BlockQuote`, a list's items get `ListItem`) — the render styles
  *paragraphs*, so nested container spans are pushed down to the paragraphs they cover. (Wave 1 keeps
  the mapping simple: a block's `Position` → its kind; nested-container refinements are additive.)
- `Paragraph` produces no span (it is the default format) — the list stays sparse.
- Spans are **non-overlapping and sorted by `start`**, so the render can map paragraph→style with a
  binary search.

## 4. The concurrency contract — styling with a lagging AST

The parse is off-thread (N4) and lags the live text by the ~1 ms a parse is in flight. The style spans
therefore reflect a **past** `content_gen`. The contract mirrors N4's `apply_parse` staleness gate:

- The worker's `ParseResult` carries `styles: Vec<StyleSpan>` alongside the existing `signal`, both
  stamped with the generation they reflect.
- `App` gains `styles` + `styles_gen` (folded in by `apply_parse` under the same monotonic gate — a
  late/out-of-order parse never regresses the styling).
- **Apply the last-good styles even when stale.** Block spans are *coarse* (whole paragraphs), so a
  one-keystroke lag almost never misaligns a block's styling visibly; when the fresh parse lands, the
  render re-styles (the layout is rebuilt per paint anyway). Every span offset is **clamped to the
  paragraph's bounds** before use, so a stale offset can never read out of range — worst case a
  paragraph briefly styles as the wrong kind until the next parse (~1 ms), never a crash or a smear.
- **Degrade to plain** when there are no styles yet (first parse in flight) — the editor renders flat,
  exactly as today, until the first `StyleModel` arrives. No flicker: plain → styled once, then stable.

This is the same "never paint a half-updated model" spine as N4 — the UI thread owns `App`, the worker
only reads a snapshot — extended to carry style spans, not just counts.

## 5. The visual mapping (feel knobs — the author's to tune)

`StyleKind` → DirectWrite font attributes, applied to the whole paragraph's range. Wave 1 is font
attributes only (size/weight/style — no per-run brush, so no color yet). Starting values:

| kind | size (× body) | weight | style | note |
|---|---|---|---|---|
| `Heading(1)` | 1.7× | bold (700) | — | the markers (`# `) dim in Wave-1.5 (needs color) |
| `Heading(2)` | 1.45× | bold | — | |
| `Heading(3)` | 1.25× | semibold (600) | — | |
| `Heading(4..=6)` | 1.1× | semibold | — | |
| `BlockQuote` | 1.0× | — | italic | indent is Wave-1.5 |
| `PullQuote` | 1.15× | — | italic | |
| `ListItem` | 1.0× | — | — | bullet/indent is Wave-1.5 (plain in Wave 1) |
| `Divider` | 1.0× | — | — | drawn rule is Wave-1.5 (plain in Wave 1) |

These are constants next to the existing `FONT_SIZE_DIP` — every one a future knob. The point of Wave 1
is that **headings become prominent**; the rest is a coherent, growable table.

## 6. The COM surface (typed, ABI-asserted, smoke-exercised)

`IDWriteTextLayout` range formatting — three slots currently `usize` placeholders in the vtable, now
typed (the slot numbers already mirror the `// N` comments in `sys.rs`):

- `SetFontWeight(weight: u32, range: DWRITE_TEXT_RANGE)` — **slot 32**
- `SetFontStyle(style: u32, range: DWRITE_TEXT_RANGE)` — **slot 33**
- `SetFontSize(size: f32, range: DWRITE_TEXT_RANGE)` — **slot 35**

Plus the by-value range struct (two `u32`, 8 bytes):

```
#[repr(C)] pub struct DWRITE_TEXT_RANGE { pub startPosition: u32, pub length: u32 }
```

ABI-asserted alongside the existing guards (`offset_of!` slots 32/33/35; `size_of::<DWRITE_TEXT_RANGE>()
== 8`). And **smoke-exercised on real DWrite** — the phantom-`draw_mesh` lesson: a newly-typed slot that
has never been *called* is an AV waiting for the first real paint. The smoke test applies weight/size/
style to a range on a live layout and asserts the styled layout still hit-tests coherently (caret x
monotonic, metrics positive). `SetDrawingEffect` (slot 38, for color) stays a placeholder — Wave-1.5.

## 7. Applying styles in the virtualized layout — one authority

Styling lives in **`lay_out_paragraph`** — the single place a paragraph is shaped, shared by paint AND
the point-queries (`caret_xywh`/`hit_test_content`). This is load-bearing: if paint styled but the
geometry path didn't, the caret would land at body-font positions while the glyphs drew heading-sized —
they must agree. Because both go through `lay_out_paragraph`, applying the style there means:

- **Caret/hit-test are automatically style-correct** — they read the styled layout (a heading's wider
  glyphs, taller line) with no extra work. The N3 one-authority invariant holds, virtualized.
- **Styled heights fold for free** — `fold_paragraph_height` measures the *styled* paragraph, so the
  height index (N5) records a heading's real, taller height; scrolling/anchoring stay correct.

Mechanically: `lay_out_paragraph(i)` builds the paragraph layout, looks up paragraph `i`'s `StyleKind`
(map the sorted span list → this paragraph by its start offset, clamped), and if non-default applies
the attribute range `[0, content_len)` (the whole paragraph) before returning. The render already
rebuilds paragraph layouts per paint, so re-styling on a fresh AST is free.

## 8. Edges (first-class)

1. **Stale span offsets** — clamp every span to the paragraph before use; a mismatch styles the wrong
   paragraph for ≤ 1 parse, never reads out of range.
2. **A block spanning multiple paragraphs** (a blockquote of several lines) — each covered paragraph
   gets the kind (the flatten in §3); styling is per-paragraph, so multi-paragraph blocks just style
   each of their paragraphs.
3. **The composition paragraph (IME)** — the paragraph keeps its style; the spliced composition text
   inherits the paragraph's attributes (a heading composed in an IME stays heading-sized). No special
   case — `spliced_paragraph` produces the content, the same style range applies.
4. **Heading height in the index** — a heading is taller; measured on layout, folded, so `para_top`
   and the scroll extent account for it (no special case — §7).
5. **First-parse-in-flight** — no styles yet → plain, then styled once the parse lands (§4).
6. **A styled empty paragraph** (a blank line the AST didn't tag) — default; degenerate, not special.
7. **Selection/underline geometry** — `HitTestTextRange` reads the styled layout, so selection boxes
   and the composition underline track the styled glyph metrics automatically.

## 9. Oracles

- **Style-model derivation (platform-free, every CI platform)** — `styles_of(doc)` over a
  representative document (headings of several levels, a blockquote, a pull-quote, a list, a divider,
  plain paragraphs): asserts the right kinds at the right block spans, sorted + non-overlapping, and
  that plain paragraphs produce none. Uses the real `parse_document` (available on all platforms — the
  parser lib is not windows-gated), so it is a true end-to-end check of AST → spans.
- **Range-formatting COM (smoke, real DWrite, ASan)** — apply `SetFontSize`/`SetFontWeight`/
  `SetFontStyle` to a range on a live layout; assert caret x stays monotonic and metrics positive on
  the *styled* layout (the newly-typed-slot guard) and that a heading-sized paragraph reports a greater
  height than a body one (styling reached the glyphs).
- **Staleness apply (pure, in `app`)** — `apply_parse` folds styles under the monotonic gate; a stale
  style set never regresses a newer one (mirrors the existing `parse_apply_tests`).
- **Equivalence unaffected** — N5's `virtualized_geometry_matches_whole_doc` continues to pass (styling
  is applied identically whether a paragraph is laid out alone or in a whole-doc layout — same range on
  the same text), so the fearless-refactor net still holds.

We do **not** oracle "does the styling *look* right" — the size/weight table is the author's feel knob.

## 10. Checkpoints

- **Style-a — the style model + plumbing (platform-free core + the async carry).** `styles.rs`
  (`StyleKind`/`StyleSpan`/`styles_of`) + its derivation oracle; the worker builds it and `ParseResult`
  carries it; `App` folds `styles`/`styles_gen` under the staleness gate + its oracle. Lands green on
  all three platforms (the derivation is pure). No COM yet.
- **Style-b — the range-formatting COM + the apply.** Type + ABI-assert `SetFontWeight`/`SetFontStyle`/
  `SetFontSize` + `DWRITE_TEXT_RANGE`; the `StyleKind`→attributes table; apply in `lay_out_paragraph`
  (so paint + geometry + heights all see it); the smoke extension (range formatting on real DWrite, the
  styled-height check), ASan-clean. Validate locally (oracles debug+release, smoke, ASan, clippy,
  warning-free) before the push. Then the author's feel pass on the size/weight table with a real doc.

*(Checkpointing note: if `Style-a`'s `App.styles` would be dead code until `Style-b` consumes it — the
bin-crate reality we hit at file I/O and N5b — the two land as one warning-free commit, ledgered. The
platform-free `styles.rs` oracle runs regardless.)*

## 11. Deferred (named)

- **Inline styling (Wave 2)** — `Strong`/`Emphasis`/`Code`/`Link`. Needs inline spans; the fork: (a) a
  parity-safe internal `position` on inline nodes emitted by the Rust parser but not serialized, vs (b)
  re-tokenizing markers in the editor. Decided when built.
- **Color** — `SetDrawingEffect` (slot 38) + a per-run brush (dim the markers, tint code, color links).
- **Indent / rules / bullets (Wave-1.5)** — blockquote/list indent (shift the paragraph draw origin),
  a divider's horizontal rule (a drawn primitive), list bullet glyphs.
- **Marker dimming** — needs color (above); until then markers render in the body attributes.
- **The rendered / hide-markers model** — the display↔source mapping landmark (a different node).
- **Per-run styling *within* a paragraph** beyond inline (mixed sizes mid-line) — falls out of Wave 2.

## 12. Ledger deltas (fold into the umbrella §8 on reconcile)

- AST-styled rendering added as the node after N5; **source-highlight** model chosen (faithful source
  editor; offsets never lie), the rendered/hide-markers model deferred as its own landmark.
- **Block spans exist, inline spans don't** (the parser mirrors JS serialized output) → **Wave 1
  block-level** (AST as-is) now, **Wave 2 inline** later with the parser-touch fork flagged.
- The worker carries a compact `Vec<StyleSpan>` (not the AST) back across the thread; styling folds
  under N4's existing `content_gen` staleness gate — style with the last-good AST, clamp offsets,
  re-style on fresh, degrade to plain.
- Styling lives in `lay_out_paragraph` so paint + caret/hit-test + the height index all share the
  styled layout (the N3 one-authority invariant, virtualized) — styled heights fold for free.
- New COM: `SetFontWeight`/`SetFontStyle`/`SetFontSize` + `DWRITE_TEXT_RANGE`, ABI-asserted +
  smoke-exercised (the phantom-slot lesson); `SetDrawingEffect` stays a placeholder (color = Wave-1.5).
