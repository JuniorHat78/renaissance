# Scriptorium Native Editor — AST-styled rendering (source-highlight)

**Status: Wave 1 BUILT + locally validated (2026-07-06, commit `cc81115`). Wave 2 (inline) + Wave-1.5
(color/indent/rules) queued.** The node that makes the parser *visible*. Every prior node built the
text engine (rope, input, IME, off-thread parse, virtualized layout, file I/O); the editor reused the
`rust/` parser in-process — but rendered every character in one flat format. This node applies the
parsed structure as real per-run DirectWrite formatting: **headings now render big + bold, block/pull
quotes italic**, source-highlighted from the in-process AST inside the virtualized per-paragraph
layouts. Validated: 66 oracles debug+release, windowed smoke (styled paint), ASan-clean across the new
range-formatting FFI, warning-free. **Two build notes:** the dialect **clamps heading levels to 3**
(`parser.rs`), so §5's `Heading(4..=6)` row never occurs (the `Heading(_)` arm handles it defensively);
and **Style-a + Style-b landed as one commit** — `App.styles` is dead code in a bin crate until the
renderer reads it (the file-I/O / N5b reality), the platform-free `styles.rs` oracle running regardless.
The size/weight table (§5) is the author's feel knob. The `rust/` lib re-exports `Block`/`Inline`/
`Position` (purely additive visibility so the bin can walk a parsed `Document`).

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
- **Apply the last-good styles even when stale**, for paragraphs the edit did not touch. Block spans
  are *coarse* (whole paragraphs), so an unrelated paragraph's styling is unaffected by a keystroke
  elsewhere; when the fresh parse lands the render re-styles (the layout is rebuilt per paint anyway).
  Every span offset is resolved **by paragraph range** (`kind_for_paragraph` — the span whose start
  falls inside the paragraph), so a stale offset can never read out of range.
- **Degrade to plain** when there are no styles yet (first parse in flight) — the editor renders flat
  until the first `StyleModel` arrives.

**The pop-in fix (the paragraph being edited).** "Last-good styles even when stale" is right for
*other* paragraphs but wrong for the one under the caret: type `# ` and the lagging AST still says
"plain", so the line stays plain for the ~1 ms round-trip and then *pops* to a heading — visible, and
worse in reverse (delete the `#` and a heading stays big until the parse lands). So while
`styles_current()` is false (an edit is in flight), the renderer resolves each paragraph's style with
a cheap, parser-free **lexical guess of its own leading markers** (`provisional_style_from_line`:
`#{1,6}` + ws heading, `>` blockquote — the kinds a line's own prefix fully determines in this
fence-free dialect), so the style tracks the keystroke with no lag. For kinds the guess does not own
(pull quote, list) it keeps the last-good AST style, so an edit elsewhere never flickers them off.
When the parse settles (`styles_current()`), the **AST is again the sole authority** (it alone knows
container nesting and context) — the guess never permanently overrides it. The guess is held
byte-rule-faithful to the parser by a differential oracle (`provisional_agrees_with_the_parser`), so
it settles to *itself*: no second resize when the AST lands.

This is the same "never paint a half-updated model" + "show the best available now, correct on settle"
spine as N4 — the UI thread owns `App`, the worker only reads a snapshot — extended to carry style
spans, with the edited paragraph getting an immediate local guess instead of the round-trip-late truth.

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

## 5A. Wave-1.5 — the look (color, dimmed markers, indent, rules)

Wave 1 made headings *bigger*; Wave-1.5 makes the editor **read as a styled source document** — the
source-highlight actually looks styled, not just sized. Everything here derives from what we already
have — the block `StyleKind` spans + a per-paragraph **lexical marker scan** — so **no parser change**
(that is Wave 2's job). Five moves, each a feel knob the author tunes.

### 5A.1 Color — `SetDrawingEffect`, consume-only

The mechanism is the key unlock and it stays **consume-only COM** (no custom `IDWriteTextRenderer`
callback, which would mean *implementing* a text renderer). Set an `ID2D1SolidColorBrush` as the
**drawing effect** on a `DWRITE_TEXT_RANGE` of the paragraph layout — `IDWriteTextLayout::
SetDrawingEffect` (**slot 38**, currently a typed placeholder). `ID2D1RenderTarget::DrawTextLayout`
recognises a drawing effect that is an `ID2D1Brush` and paints that range with it automatically. So
color is "attach a brush to a range", symmetric with the Wave-1 `SetFontWeight`/`Size`/`Style` calls.

- **COM:** type slot 38 `set_drawing_effect(*mut IDWriteTextLayout, *mut IUnknown, DWRITE_TEXT_RANGE)
  -> HRESULT` (an `ID2D1SolidColorBrush*` is-a `IUnknown*`). ABI-assert `offset_of` == 38. **Smoke** the
  slot on real DWrite (the phantom-`draw_mesh` lesson — a never-*called* slot AVs on first paint): color
  a range, `DrawTextLayout` it, assert no AV and the layout still hit-tests coherently.
- **Brushes:** the renderer creates a small themed palette of `ID2D1SolidColorBrush`es once, alongside
  the existing text/sel/caret brushes, and recreates them with the target on device-loss. Palette (feel
  knobs, theme-aware): `heading` (accent), `marker_dim` (muted/low-contrast), `quote` (muted), `rule`.

### 5A.2 Dimmed markers — the source-editor tell

The markdown markers stay on screen (source-highlight) but **recede**, so content pops and the file
still reads as its source: dim `#{1,6}` + its trailing space on a heading, the `>` (+ optional space)
on a blockquote, the `-`/`*`/`1.` + space on a list item. Apply the `marker_dim` brush to `[0,
marker_len)`; the content after keeps its color.

- The marker length is computed **lexically per paragraph** (`marker_len_of_line`, platform-free in
  `styles.rs`, sharing the exact rules of `provisional_style_from_line` and the parser). Held
  parser-faithful by an oracle: `marker_len_of_line(line)` equals the parser's `text_offset −
  line_start` for that block (the count of source units the parser skips before the content).

### 5A.3 Indent — blockquotes & list items shift right

A blockquote / list-item paragraph draws at left origin `PAD_DIP + indent(kind)` instead of `PAD_DIP`.
Because geometry is **one authority** (paint and the point-queries share the paragraph's draw origin
and layout), the indent is applied once, at the `ox` used by both — so caret and hit-test stay correct
with no special-casing.

- **Width/height consistency (the load-bearing detail):** an indent reduces the available text width,
  so an indented paragraph must be laid out at width `text_w − indent`, not `text_w`. Otherwise a long
  quote would *paint* wrapped at the narrower width but *measure* its height at the full width — height
  index and paint would disagree. `lay_out_paragraph` therefore takes the paragraph's effective width
  from its kind, and `fold_paragraph_height` records that (still one authority; the N5 index stays
  exact). Horizontal indent never shifts `para_top` — only the reduced width can grow a paragraph's
  height, which folds in normally.
- **Oracle:** the N5 `virtualized_geometry_matches_whole_doc` equivalence is extended to a doc with an
  indented paragraph — its caret x = `ox + local` still matches the whole-doc reference.

### 5A.4 Divider rule — a drawn primitive

A `Divider` paragraph (`---`) draws a real **horizontal rule**: a thin `FillRectangle` (**slot 17**,
already present) across the content width at the line's vertical centre, in the `rule` brush. The `---`
source text stays (source fidelity — you can still edit it) but **dimmed**. No height special-case — the
paragraph is a normal one-line height holding `---`.

### 5A.5 List — dim + indent only (bullets deferred, honestly)

Wave-1.5 gives list items the **dimmed marker** (5A.2) and the **indent** (5A.3). A real bullet *glyph*
(painting `•` where the buffer holds `-`) is a **display ≠ source divergence** — that is the
hide-markers / rendered model, a separate landmark we are deliberately not doing yet. So Wave-1.5 keeps
the literal `-`/`*`/`1.`, just dimmed and indented. (Named deferral, not an omission.)

### 5A.6 Checkpoints — Wave-1.5 BUILT

- **1.5a — color infra + block color + dimmed markers (`500eb11`).** Slot 38 `set_drawing_effect`
  typed + ABI-asserted (offset 38), exercised in the GATED suite (null effect) AND with a real brush in
  the windowed paint smoke; the brush palette (`create_palette`, rebuilt with the target on device
  loss); `SetDrawingEffect` in `lay_out_paragraph` for block color (heading indigo, quote grey) + the
  dimmed leading marker range. `marker_len_of_line` refactored to share `scan_block_marker` with the
  style guess. Oracle: `marker_len_covers_the_leading_marker` (platform-free).
- **1.5b — indent (`a7ffcdb`).** Blockquote/list left indent threaded through the one authority:
  `lay_out_paragraph` lays out at width − indent (height stays exact) and returns the indent; paint,
  caret, hit-test, and the IME composition/display-caret paths all shift by it. Oracles: `indent_for`
  maps blockquote/list only; a narrower indent width can only grow height.
- **1.5c — divider rule (`e047646`).** A drawn `FillRectangle` hairline across the content width +
  dimmed `---`; the windowed smoke paints a divider doc (drives the rule + dimmed-`---` on real D2D),
  ASan-clean.

**List bullet glyphs stay deferred** (a display≠source divergence — the rendered model, §11).

## 5B. Wave 2 — inline styling (teaching the parser)

Wave 1/1.5 styled whole paragraphs; Wave 2 styles spans **inside** a line: **strong**, *emphasis*,
`code`, and links. This needs each inline node's source position — which the AST doesn't carry (inline
nodes mirror the JS parser's offset-less output). **Decision (fork resolved 2026-07-06):** teach the
shared Rust parser to emit the positions, NOT re-tokenize markers in the editor. Re-tokenizing would be
a second, dumber inline parser that drifts on the hard cases (nested emphasis, a code span suppressing
its inner markers, escapes); the real parser already gets them right, and the parser is ours to extend.

### 5B.1 The parser extension — `Document.inline_spans` (internal, non-serialized)

`parse_inline` already walks the source with an absolute base offset (`base + cursor` is the source
offset of every token). So the extension is small and surgical: thread a `&mut Vec<InlineSpan>`
collector through `parse_inline`/`parse_inline_children`, and at each `Strong`/`Emphasis`/`Code`/`Link`
construction push `InlineSpan { start, end, kind }` (the token's **full** source range, markers
included). Because it is the real parse, nesting falls out for free — `*a **b** c*` pushes an Emphasis
span over the outer range AND a Strong span over the inner, so `b` ends up bold-italic; a `` `*x*` ``
code span pushes only a Code span (its inner `*` never becomes emphasis); escapes are already handled.

- `ast.rs`: `pub enum InlineKind { Emphasis, Strong, Code, Link }`, `pub struct InlineSpan { start,
  end, kind }`, and `pub inline_spans: Vec<InlineSpan>` on `Document`.
- **Not serialized.** `json.rs`/`docjson.rs` take `&Document` and emit only `children`/`diagnostics`/
  `stats`, so the JSON is **byte-identical** and the frozen-golden parity oracle stays green with zero
  downstream churn — the Inline enum shape is unchanged, so the two serializers AND the server renderer
  are untouched. This is the "make it ours, but keep the change surgical" path: the website doesn't need
  inline positions yet (only the editor does, in-process), so we don't pay for serializing them. If a
  web feature ever wants them, serialize then + regenerate the golden ([[feedback_parser_extension_freedom]]).

### 5B.2 The editor side — apply inline styles within the paragraph

The worker distills `doc.inline_spans` into per-paragraph editor spans carried back under the same N4
staleness gate as the block styles. In `lay_out_paragraph`, after the block style/color, apply each
inline span that falls in the paragraph (offsets relative to the paragraph start):

| kind | attribute | slot |
|---|---|---|
| `Strong` | `SetFontWeight(bold)` | 32 (have) |
| `Emphasis` | `SetFontStyle(italic)` | 33 (have) |
| `Code` | color tint (a `code` brush) via `SetDrawingEffect` | 38 (have) |
| `Link` | link-color brush + `SetUnderline` | 38 + **36 (new)** |

Inline attributes compose with the block style (a `**bold**` word in a heading is bold-and-heading).
The markers (`**`, `` ` ``, `[...]()`) dim like block markers — a Wave-2 refinement once the spans land.

### 5B.3 Checkpoints — Wave 2 BUILT

- **2a — the parser emits `inline_spans` (`224d1d8`).** `ast.rs` `InlineKind`/`InlineSpan` +
  `Document.inline_spans`; `parser.rs` threads a `&mut Vec<InlineSpan>` collector through the inline
  path, with a **joined→source offset map** so spans stay source-accurate across a multi-line paragraph
  join. +5 platform-free oracles; the frozen-golden parity oracle stayed **byte-identical** on every
  AST-consuming surface (rust-parser 2065, rust-render 565, rust-wasm 2065) — surgical, not serialized.
- **2b — the editor applies inline styles.** The worker carries `doc.inline_spans` back under the N4
  staleness gate (`App.inline_spans`, no provisional guess — inline doesn't reflow); `apply_inline_styles`
  in `lay_out_paragraph` intersects each span with the paragraph and applies Strong→`SetFontWeight`,
  Emphasis→`SetFontStyle`, Code→`code` brush, Link→`link` brush + `SetUnderline` (**slot 36** typed +
  ABI-asserted + gated-oracle + real-brush paint smoke), composing with the block style. ASan-clean.
  (The IME composition paragraph pauses inline styling — the splice shifts source offsets; it resumes on
  commit.)

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

1. **Stale span offsets / the edited paragraph** — the paragraph under the caret is styled from the
   immediate lexical guess while a parse is in flight; every AST span is resolved by paragraph range
   (`kind_for_paragraph`), never read out of range (§4).
1b. **A block span that doesn't start at the paragraph's start** — a blockquote's AST span begins
   *after* its `> ` marker (the child-paragraph offset), while the paragraph begins at the marker. The
   resolver matches the span whose start falls *inside* the paragraph range, not one starting at-or-
   before the paragraph start, so blockquotes are styled rather than silently dropped (this was a latent
   Wave-1 miss the pop-in oracle surfaced).
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
- **Provisional-guess parity (platform-free, every CI platform)** — `provisional_agrees_with_the_parser`
  runs the lexical guess and the real `parse_document` on the same single-line sources and asserts they
  agree on the kinds the guess owns (heading, blockquote), so a just-typed marker settles to *itself* —
  no second resize when the AST lands. Plus `provisional_reads_the_leading_markers` (marker rules incl.
  the level-3 clamp and the "needs whitespace + content" heading guard) and
  `kind_for_paragraph_matches_a_span_starting_inside_the_paragraph` (the blockquote-marker-offset fix).
- **Equivalence unaffected** — N5's `virtualized_geometry_matches_whole_doc` continues to pass (styling
  is applied identically whether a paragraph is laid out alone or in a whole-doc layout — same range on
  the same text), so the fearless-refactor net still holds.

We do **not** oracle "does the styling *look* right" — the size/weight table is the author's feel knob.

## 10. Checkpoints — Wave 1 BUILT (landed together, `cc81115`)

- **Style-a — the style model + plumbing (platform-free core + the async carry).** `styles.rs`
  (`StyleKind`/`StyleSpan`/`styles_of` — a walk over the block tree into a sorted, non-overlapping span
  list) + its end-to-end derivation oracle over the real parser (every CI platform); the worker builds
  it and `ParseResult` carries it; `App` folds `styles` under the same monotonic staleness gate as the
  signal (`apply_parse`) + its oracle. (`lib.rs` re-exports `Block`/`Inline`/`Position`.)
- **Style-b — the range-formatting COM + the apply.** `SetFontWeight`(32)/`SetFontStyle`(33)/
  `SetFontSize`(35) + `DWRITE_TEXT_RANGE` (by-value, 8 bytes), ABI-asserted; the `StyleKind`→attributes
  table; applied in `lay_out_paragraph` so paint + geometry + heights all see it; the bare-layout oracle
  (all three slots on real DWrite → heading taller, caret still monotonic) + the windowed styled-paint
  smoke, ASan-clean.

**Landed as one commit** (the checkpointing reality first hit at file I/O / N5b): `App.styles` is dead
code in a bin crate until the renderer reads it, so the two waves' commits merge to keep the tree
warning-free; the platform-free `styles.rs` oracle validates the derivation on all platforms regardless.
The author's feel pass on the size/weight table (§5), on a real manuscript, is what's left of Wave 1.

## 11. Deferred (named)

- **Inline styling (Wave 2)** — `Strong`/`Emphasis`/`Code`/`Link`. Needs inline spans. **Fork resolved
  (2026-07-06):** teach the shared Rust parser to emit an **internal, non-serialized `position`** on
  inline nodes (the editor reads it in-process; the serialized JSON is unchanged, so the frozen-golden
  parity oracle stays green with no downstream churn), NOT a second in-editor tokenizer — the parser is
  ours to extend, and inline markdown is too fiddly to reimplement lexically without drift. Builds on
  the 5A color infra (dim inline markers, tint `Code`, color+underline `Link`).
- **Color / dimmed markers / indent / divider rule (Wave-1.5)** — §5A; **BUILT** (`500eb11`/`a7ffcdb`/
  `e047646`): color via `SetDrawingEffect` slot 38 consume-only, lexical marker dimming, blockquote/list
  indent, a drawn divider rule. List *bullet glyphs* remain deferred (a display≠source divergence).
- **The rendered / hide-markers model** — the display↔source mapping landmark (a different node); real
  bullet glyphs, hidden markers, and mid-line WYSIWYG live here.
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
