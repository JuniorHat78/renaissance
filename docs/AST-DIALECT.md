# AST Dialect

Renaissance uses a small, dependency-free authoring dialect rather than a full
Markdown parser. The parser is intentionally conservative: author text is never
treated as raw HTML, and every richer construct must have a fixture before it is
considered supported.

## Supported Blocks

- Paragraphs separated by blank lines.
- Headings with `#`, `##`, or `###`. Deeper heading markers are clamped to
  level 3 with a diagnostic.
- Dividers written as `---` on a line by itself.
- Single-line pull quotes when a whole paragraph is wrapped in matching quote
  punctuation.
- Multi-line blockquotes using consecutive `>` lines.
- Unordered lists using `-` or `+`.
- Ordered lists using `1.` or `1)` style markers.

Leading `*` list markers remain literal prose for compatibility with the
existing corpus fixtures.

## Supported Inline Syntax

- Emphasis: `*quiet emphasis*`.
- Strong text: `**strong text**`.
- Inline code: `` `literal *code*` ``.
- Safe inline links: `[label](notes.html)`, `[label](https://example.com)`,
  `mailto:`, and `tel:` URLs.
- Recursive inline children inside emphasis, strong, and link labels.
- Hard breaks from two trailing spaces before a line break.

Unsafe link protocols such as `javascript:` are rendered as literal text and
produce an `unsafe-link-url` diagnostic.

## Intentionally Plain Text

The dialect still treats these Markdown-like forms as plain text:

- raw HTML tags;
- image syntax;
- tables;
- fenced code blocks;
- automatic bare URL links;
- underscore emphasis;
- nested block continuations inside list items;
- `*` bullet markers.

These can be added later, but each addition should include focused fixtures,
runtime regression tests, and a migration note.

## Schema Notes

AST version `0.2.0` adds `blockquote`, `list`, and `list_item` block nodes plus
`strong`, `code`, and `link` inline nodes. Legacy bridge helpers degrade these
new structures into plain paragraph text when callers still request legacy
blocks.

## Legacy Bridge Boundary

`scripts/content.js` still exposes legacy `blocks` and `contentBlocks` for old
callers and embedded fallback compatibility, but page rendering now prefers
`contentAst`. The remaining bridge calls are isolated at the content loading
boundary:

- `parseBlocks(rawText)` for compatibility callers;
- `loadSection()` legacy `blocks`;
- `loadSection()` legacy `contentBlocks`;
- `Ast.renderBlocks()` normalization for callers that still pass legacy arrays.

The bridge should stay until fallback data and scratch tooling no longer need
legacy arrays. New rendering/search/excerpt work should use AST nodes or AST text
projections directly.
