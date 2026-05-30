# Ideas

This is the no-ideas-lost shelf for Renaissance.

Items here are not commitments. They are preserved because they may become
beautiful later, or because they point at a real architectural direction. The
active sequence lives in `docs/ROADMAP.md`.

## Interface Enchantment

- Make buttons feel like engraved labels, bookmarks, tabs, or archive slips
  rather than default rectangles.
- Give selects, checkboxes, search filters, chips, and pagination a shared
  Renaissance control language.
- Keep form controls quiet and legible; this is a reader, not a SaaS dashboard.
- Use motion rarely: a settled bookmark, a discovered passage, a gentle reveal.
- Avoid explaining the magic in the interface itself.

## Magical Recovery States

- Rework the 404 as a lost page from the archive.
- Offer a "did you mean" recovery path for recognizable essay or section slugs.
- Surface archive and search recovery without making the page feel like a plain
  error screen.
- Let app-shell missing states on essay/section pages share the same voice as
  the static 404.
- Consider a tiny self-contained visual moment that works at arbitrary URL
  depths and respects reduced motion.

## Spotlight Search

- Global `Cmd/Ctrl+K` hidden index.
- Contextual actions first:
  - Continue Reading.
  - Search current essay.
  - Jump to section.
  - Open full search.
- Instant results while typing.
- Keyboard-first navigation with Enter and Escape.
- Mobile full-screen variant.
- Ranking that stays predictable and scope-aware.
- A presentation that feels like opening an archive index, not cloning a generic
  command palette.

## Authoring And Publishing

- `new essay` or `new section` helper.
- Content doctor that summarizes:
  - AST diagnostics.
  - generated embedded data freshness.
  - offline asset freshness.
  - discoverability/feed freshness.
  - missing metadata.
- Publish checklist that confirms summaries, social images, `published_at`,
  canonical URLs, feeds, sitemap, and offline assets.
- Preview unpublished essays without accidentally exposing them in feeds/search.
- Confirm the current `published_at` date for `Etching God into Sand`.

## AST And Content Language

The current AST is deliberately small. These are possible grammar expansions only
if real content needs them.

- Strong emphasis / bold syntax.
- Inline links with explicit URL safety rules.
- Lists.
- Multi-line blockquotes.
- Footnotes.
- Epigraphs.
- Internal cross-references.
- Source spans for more inline nodes.
- Fixture coverage mapped to grammar rules.
- Generated AST reports for authoring and review.

## Search Architecture

- Generated compact search index for a larger archive.
- Vocabulary and inverted-index data instead of full runtime scanning.
- Web Worker query execution if searches become heavy.
- Search performance fixtures for pathological short, common, long, and fuzzy
  queries.
- Highlight/search behavior that derives from AST positions where possible.

## Offline And PWA

- Generated service-worker cache version from asset/content hashes.
- A custom offline library showing cached/readable essays and sections.
- A gentle update affordance when new content is available.
- Clearer distinction between shell-cache, raw-content-cache, and visited-content
  states.

## Etching God Into Sand Easter Eggs

- Sand drift idle moment: after about 20 seconds idle in a section, show a
  one-time subtle grain drift in the page margins.
- Hidden marginalia toggle: keyboard `.` toggles sparse side notes.
- Ten taps ritual: tapping the essay title 10 times reveals a tiny "etching
  complete" sigil.
- Query ritual card: searching `sand` on the essay page unlocks a tiny card with
  first use, last use, and total uses.
- End-page hush: near the final paragraph, reduce ambient background motion to
  near-still.

## SHADOWS Easter Eggs

- Penumbra highlight mode: selection highlights use a softer dual-halo effect
  unique to `SHADOWS`.
- Umbra trigger: searching `umbra` briefly deepens contrast, then returns to
  baseline.
- Section sequence key: input sequence `I, II, III, IV, V, VI` reveals a hidden
  section map overlay.
- Eclipse micro-event: optional timed one-line note in a specific `SHADOWS`
  section on first load.

## Cross-Essay Enchantments

- Archive key: typing `renaissance` on home slowly reveals a hidden archive card.
- Constellation links: certain phrases reveal parallel passage links between
  essays.
- Completion state: after finishing published essays, subtly change the home
  subtitle once per user/device.

## Deferred Engineering Polish

- Split `scripts/section.js` by concern once the next behavior change touches it.
- Reduce remaining allowlisted `innerHTML` sinks over time.
- Shared default-route utility.
- Social-card metadata consistency check.
- Strict visual QA after baselines are intentionally stabilized.
