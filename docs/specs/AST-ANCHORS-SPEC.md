# AST Anchors Spec

This spec defines stable reader anchors for search, Spotlight, copied links,
highlight arrival, and future marginalia/cross-reference work.

The current reader can find text by query occurrence or copied highlight payload.
That is useful, but fragile. Oracle Search needs stronger anchors derived from
the AST and content structure.

## Goals

- Give every meaningful passage a stable identifier.
- Let search results route directly to the right paragraph/block.
- Let copied links survive nearby text edits when possible.
- Let reader arrival highlight the intended passage without scanning the whole
  DOM for ambiguous text.
- Keep anchors deterministic and generated from content, not random IDs.
- Preserve graceful fallback for old links.

## Non-Goals

- Perfect permanence across arbitrary rewrites.
- Server-side redirects.
- Hashing private content for privacy guarantees.
- A complex database of historical anchor migrations.

## Anchor Types

### Structural Anchor

Identifies a passage by essay, section, and AST/block position.

Example:

```text
essay=etching-god-into-sand
section=5
p=17
```

Useful when content edits are append-only or local.

### Signature Anchor

Identifies a passage by normalized text signature.

Example internal field:

```json
{
  "signature": "the-library-the-librarians-the-madness:4f8a"
}
```

Useful when paragraph indexes shift.

### Offset Anchor

Identifies a range inside a passage.

Example:

```text
p=17&start=84&end=132
```

Useful for precise search highlights and copied selections.

### Payload Anchor

Carries selected text plus prefix/suffix fallback, similar to the current copied
highlight strategy.

Useful for external copied links where maximum resilience matters more than URL
brevity.

## Preferred URL Grammar

Target grammar:

```text
section.html?essay=<slug>&section=<n>&p=<paragraph-id>
section.html?essay=<slug>&section=<n>&p=<paragraph-id>&start=<n>&end=<n>
section.html?essay=<slug>&section=<n>&hit=<generated-hit-id>
```

Existing query/occurrence URLs can continue as fallback, but new search and
Spotlight links should prefer structural anchors.

## Anchor Generation

Paragraph/block IDs should be deterministic.

Baseline:

- `p1`, `p2`, `p3` for paragraphs in rendered reading order;
- `b1`, `b2`, `b3` for non-paragraph block targets if needed;
- heading trail stored separately for recovery and snippets.

Enhanced recovery:

- store normalized text signature for each passage;
- if `p17` no longer matches its stored signature, search nearby signatures;
- if signature fails, fall back to text payload or query occurrence.

## Passage Signature

Signature inputs:

- normalized plain text;
- first meaningful words;
- optional last meaningful words;
- short hash to disambiguate repeated openings.

Signature should ignore:

- case;
- repeated whitespace;
- curly quote differences;
- common punctuation drift.

Signature should preserve:

- word order;
- meaningful terms;
- enough uniqueness to avoid false anchors.

## Reader Resolution Order

When loading a reader URL:

1. Resolve explicit section route.
2. If `hit` exists, look up generated hit record if available.
3. If `p` exists, find structural paragraph/block anchor.
4. If `signature` exists, find best matching passage.
5. If `start/end` exists, highlight range inside resolved passage.
6. If old `q/occ` exists, use query occurrence fallback.
7. If copied highlight payload exists, use payload matching.
8. If all anchor methods fail, show the section and a quiet recovery note.

## DOM Requirements

Rendered content should expose stable target attributes:

```html
<p data-passage-id="p17" data-passage-signature="...">...</p>
```

Avoid exposing large raw payloads in the DOM if not needed. A compact signature
or ID is enough for normal operation.

## Search Integration

Search index passage records should include:

- structural anchor;
- signature;
- source offsets;
- snippet offsets;
- URL builder data.

Search activation should:

1. route to the section URL with anchor;
2. mark the selected result as transition source;
3. reveal destination reader content quickly;
4. scroll to passage sightline;
5. apply arrival highlight.

## Copy/Citation Integration

When copying selected prose:

- if selection maps cleanly to one passage, use `p/start/end`;
- if selection spans multiple passages, use a range anchor or payload fallback;
- include source citation as today;
- keep rich text safe and escaped;
- do not clone unsafe author HTML.

## Downstream Consumers

AST anchors are not only for search. A good anchor system should become the
shared contract for:

- Spotlight passage activation;
- full search result links;
- inline search result links;
- copied highlight links;
- citation source URLs;
- reader arrival highlights;
- reading-state debug output where useful;
- recovery suggestions for stale links;
- future marginalia and cross-reference work.

If any consumer needs a separate anchor grammar, document why. Prefer one shared
anchor language.

## Edit Resilience

Expected behavior after content edits:

- paragraph insertion before target: signature fallback should recover;
- small text edits inside target: structural anchor should land nearby, signature
  may still match if normalized terms survive;
- large rewrite: anchor may degrade to section-level recovery;
- deleted passage: show section and quiet note.

## Fixtures

Add fixtures for:

- stable IDs from AST blocks;
- insertion before target;
- repeated paragraph openings;
- range offsets;
- old query occurrence fallback;
- copied payload fallback;
- deleted target recovery.

## Open Decisions

- Should public URLs expose `p=17` or a more opaque `a=<id>`?
- Should generated hit IDs be stable across builds?
- Should signatures be included in public URLs or only generated index records?
- How much quiet recovery UI should appear when an anchor fails?
