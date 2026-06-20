# Oracle Search Spec

This spec defines the target search system for Renaissance Spotlight and the
existing search surfaces. It intentionally goes beyond the current
`scripts/search-engine.js` runtime model. The current API does not need to remain
compatible if replacing it creates a better, safer, more precise search system.

The goal is an oracle-like literary index: deterministic, fast, context-aware,
and precise enough that a half-remembered phrase, motif, section title, or idea
finds the right passage without pretending to be an AI.

## Product Goal

Search should feel like the archive knows itself.

The first results should often feel inevitable:

- exact phrase when the user remembers words;
- section or essay when the user remembers structure;
- passage when the user remembers an image, motif, or idea;
- action when the user asks for a route such as continue, next, section 4, or
  current essay.

The system must never hallucinate. It may expand and interpret queries through
curated metadata, but every returned result must point to real content or a real
action.

## Compatibility Stance

Old search APIs and URL parameters are not sacred.

Preserve only what matters:

- published routes should keep working when practical;
- copied links should degrade gracefully;
- existing tests should be replaced with better tests rather than kept as
  compatibility theater;
- public search URLs can migrate if the new URL grammar is cleaner and recovery
  is documented.

Allowed breaking changes:

- replacing `RenaissanceSearch` internals;
- changing result object shape;
- replacing occurrence-based highlight URLs;
- changing inline-search implementation;
- regenerating search data from AST instead of loading raw text at runtime;
- splitting search modules by index/query/ranking/snippet/routing concerns.

Breaking changes must be accompanied by migration or recovery behavior where a
reader-facing URL could otherwise fail.

## Design Principles

- **Deterministic first**: no generative answers, no hidden network calls, no
  guessed content.
- **AST-native**: passages, snippets, anchors, and highlights come from the
  parsed document structure.
- **Context-aware**: current essay, current section, reading state, and page
  type affect ranking.
- **Fast open**: Spotlight should open instantly even if the full index is still
  warming.
- **Generated when useful**: precompute expensive search metadata into generated
  artifacts if it improves reliability or perceived speed.
- **Explainable in debug mode**: ranking should be inspectable for fixtures and
  future tuning.
- **Offline-capable**: generated search data should be cacheable by the PWA.

## Index Units

The primary index unit should be a passage, not a whole section.

Candidate units:

- essay record;
- section record;
- heading record;
- paragraph/block passage;
- quote/list item passage;
- action record generated from route/context;
- synthetic "continue reading" record;
- synthetic "open full search" record.

Passage records should be small enough for precise snippets but large enough to
carry meaning. A paragraph is the default passage boundary. Very short adjacent
paragraphs may be grouped only if the grouping is deterministic and tested.

## Generated Artifacts

Preferred artifact direction:

```text
data/search-index.json
data/search-lexicon.json
```

Potential future split if size grows:

```text
data/search/passages.json
data/search/terms.json
data/search/metadata.json
data/search/lexicon.json
```

The generated index should be checked for freshness in `npm run check`.

The service worker should precache the search index only when size and offline
behavior justify it. Until then, the shell can lazy-load it and cache through
normal static-asset behavior.

## Passage Record Shape

Target shape, subject to iteration:

```json
{
  "id": "etching-god-into-sand:5:p17",
  "kind": "passage",
  "essaySlug": "etching-god-into-sand",
  "essayTitle": "Etching God into Sand",
  "sectionNumber": 5,
  "sectionLabel": "V",
  "sectionTitle": "Every Possible Book",
  "sectionSubtitle": "the library, the librarians, the madness",
  "blockIndex": 17,
  "paragraphIndex": 17,
  "headingTrail": ["Every Possible Book"],
  "astPath": [17],
  "sourceStart": 12031,
  "sourceEnd": 12492,
  "text": "The searchable passage text...",
  "plain": "Normalized display text...",
  "terms": ["library", "book", "possible"],
  "rareTerms": ["librarians"],
  "anchors": {
    "paragraph": "p17",
    "hit": "etching-god-into-sand:5:p17"
  }
}
```

Generated data should avoid storing redundant text if size becomes a problem.
Size pressure should be measured before optimizing prematurely.

## Metadata Record Shape

Essay and section records should be first-class search targets:

```json
{
  "id": "essay:etching-god-into-sand",
  "kind": "essay",
  "essaySlug": "etching-god-into-sand",
  "title": "Etching God into Sand",
  "summary": "A long-form essay...",
  "terms": ["etching", "god", "sand", "silicon"],
  "published": true
}
```

```json
{
  "id": "section:etching-god-into-sand:5",
  "kind": "section",
  "essaySlug": "etching-god-into-sand",
  "sectionNumber": 5,
  "sectionLabel": "V",
  "title": "Every Possible Book",
  "subtitle": "the library, the librarians, the madness",
  "headingTrail": ["Every Possible Book"],
  "terms": ["every", "possible", "book", "library", "librarians"]
}
```

## Query Interpretation

The query pipeline should produce both search terms and intent signals.

Stages:

1. Raw query capture.
2. Unicode normalization.
3. Quote and punctuation normalization.
4. Tokenization.
5. Phrase extraction.
6. Action intent detection.
7. Section/roman numeral detection.
8. Lexicon expansion.
9. Typo/fuzzy candidate generation.
10. Ranking request assembly.

Supported interpretations:

- exact quoted phrase;
- loose phrase;
- unordered terms;
- title/section intent;
- "section 4", "chapter iv", "part v";
- "continue", "resume", "last";
- "next", "previous" in reader context;
- current essay scope;
- global scope;
- typo/fuzzy rescue;
- curated motif/concept expansion.

## Normalization

Normalize:

- curly quotes to straight quote equivalents for matching;
- em/en dashes to dash spaces where appropriate;
- repeated whitespace;
- case;
- basic possessives;
- roman numerals for section intent;
- punctuation-heavy phrases without losing quoted exactness.

Do not over-normalize:

- theological/proper names;
- code-like text if the AST later supports it;
- punctuation where it matters for exact phrase display.

## Lexicon And Motifs

The oracle feeling should come partly from authored metadata.

`data/search-lexicon.json` can define:

```json
{
  "concepts": {
    "silicon": {
      "aliases": ["sand", "wafer", "chip"],
      "boost": 24
    },
    "attention": {
      "aliases": ["prayer", "focus", "unmixed attention"],
      "boost": 18
    }
  },
  "stopExpansions": ["the", "and", "of"]
}
```

Rules:

- lexicon entries are authored, not inferred by a model at runtime;
- expansion boosts should be lower than direct matches;
- debug output should show when a lexicon expansion affected ranking;
- no result may appear solely because of a vague expansion unless it has a real
  content match.

## Ranking Signals

Ranking should be layered. Exact structural hits should beat body fuzziness.

Primary signals:

- exact essay title match;
- exact section title match;
- section number/roman numeral intent match;
- exact phrase in passage;
- loose phrase in passage;
- all query terms in passage;
- rare term match;
- term proximity;
- term order;
- heading proximity;
- current essay boost;
- current section boost;
- reading-state/continue boost;
- curated concept boost;
- fuzzy rescue penalty;
- result kind priority for action-like queries.

Tie breaks:

1. higher score;
2. exact/direct match over expanded match;
3. current context;
4. reading order;
5. stable id.

## Result Kinds

Spotlight and full search should share a result/action model.

Kinds:

- `action`: continue, open archive, open full search, search current essay;
- `essay`: essay landing page;
- `section`: section reader page;
- `passage`: paragraph/block passage;
- `recovery`: suggestion for malformed query/route if useful;
- `debug`: ranking explanation when explicitly enabled.

Target result shape:

```json
{
  "id": "passage:etching-god-into-sand:5:p17",
  "kind": "passage",
  "title": "Every Possible Book",
  "subtitle": "Etching God into Sand, Section V",
  "snippet": "A highlighted snippet...",
  "url": "section.html?essay=etching-god-into-sand&section=5&p=17",
  "score": 482,
  "reason": ["exact-phrase", "current-essay"],
  "activation": {
    "type": "route",
    "transition": "passage",
    "anchor": "p17"
  }
}
```

## Snippet Generation

Snippets should feel literary and precise.

Rules:

- prefer full sentence or clause windows when possible;
- preserve enough context to identify why the result appeared;
- highlight only meaningful terms/phrases;
- avoid making every common word glow;
- never inject raw HTML from content;
- derive highlight spans from normalized text back to source/display offsets;
- keep snippets short enough for Spotlight rows and richer for full search.

Snippet contexts:

- Spotlight row: compact excerpt.
- Full search: larger excerpt with metadata.
- Reader arrival: direct highlight or paragraph arrival treatment.

## Stable Anchors

Search should move toward AST-based stable anchors. See
`AST-ANCHORS-SPEC.md`.

Occurrence-based URLs are fragile. The new system should prefer paragraph or
block anchors with text-offset fallback:

```text
section.html?essay=<slug>&section=<n>&p=<paragraph-id>
section.html?essay=<slug>&section=<n>&hit=<generated-hit-id>
```

## Runtime API Direction

The new API can replace the current one.

Potential modules:

- `scripts/search-index.js`: load/generated-index access.
- `scripts/search-query.js`: query parsing and normalization.
- `scripts/search-rank.js`: scoring and sorting.
- `scripts/search-results.js`: result shaping and snippets.
- `scripts/search-actions.js`: context action generation.
- `scripts/spotlight.js`: UI surface.

Potential browser API:

```js
window.RenaissanceOracleSearch = {
  loadIndex,
  warm,
  parseQuery,
  search,
  actionsForContext,
  explain
};
```

The API should be designed around Spotlight and full search needs, not around
preserving the existing runtime search object.

## Integration Points

Search touches:

- `data/essays.json`;
- raw essay text;
- AST parser and text projections;
- generated embedded data;
- generated offline assets;
- service worker cache version;
- archive inline search;
- essay inline search;
- full search page;
- section highlight/deep-link logic;
- reader copy/citation links;
- router query grammar;
- 404/recovery suggestions;
- visual QA scenarios;
- regression tests.

## Downstream Quality Scope

The oracle search system should improve every surface it touches. Do not keep a
weak downstream behavior merely because Spotlight can work around it.

In scope for redesign or replacement:

- full search result rendering;
- full search controls and mode semantics;
- inline preview grouping and snippets;
- reader highlight/arrival behavior;
- copied highlight URL shape;
- citation source URL generation;
- route query parsing and cleanup;
- recovery suggestions that rely on searchable metadata;
- generated artifact freshness checks;
- offline/PWA cache behavior;
- visual QA scenarios;
- accessibility semantics for result lists and active results.

Quality bar:

- one search truth;
- consistent ranking reasons;
- consistent URL builders;
- consistent snippet/highlight spans;
- consistent unpublished-content exclusion;
- consistent offline degradation.

If a downstream module cannot support those qualities cleanly, replacing it is
allowed.

## Offline And Cache Behavior

Target behavior:

- Spotlight opens offline with cached action/context results.
- If search index is cached, passage results work offline.
- If search index is unavailable, Spotlight still offers navigation actions and
  a clear authored empty/offline state.
- Service-worker cache version updates when generated search data changes if the
  index is precached.

## Performance Budget

Search should feel instant.

Targets:

- Spotlight shell opens under 50ms perceived time.
- Actions render immediately.
- Warm index loads on idle where possible.
- Query update stays responsive on mobile.
- Fuzzy rescue is bounded and cancellable/debounced.
- Generated index size is tracked.
- Full index work never blocks initial reader rendering.

## Debug And Tuning

Add debug-only tools when useful:

- show parsed query;
- show ranking reasons;
- show score breakdown;
- show matched spans;
- show index load time;
- print top rejected candidates for fixture tuning.

Debug UI can be hidden behind URL flags such as:

```text
search.html?debugSearch=1
section.html?...&debugSearch=1
```

## Fixture Strategy

Create deterministic fixtures for:

- exact title;
- exact section title;
- exact phrase;
- loose phrase;
- punctuation-heavy query;
- curly quote query;
- typo/fuzzy rescue;
- concept expansion;
- current essay boost;
- continue/resume intent;
- section number and roman numeral intent;
- no-result empty state;
- unpublished essay exclusion;
- stable anchor generation.

Fixtures should assert result order and ranking reasons, not only result count.

## Canonical Query Fixture Catalog

Start with a curated query catalog. Each query should record the expected first
result, acceptable alternates, and ranking reasons.

Example fixture shape:

```json
{
  "query": "unmixed attention",
  "context": {
    "view": "archive"
  },
  "top": {
    "kind": "section",
    "essaySlug": "etching-god-into-sand",
    "sectionNumber": 6
  },
  "reasons": ["section-title", "exact-phrase"]
}
```

Initial fixture categories:

- **Exact title**: full essay title, section title, distinctive subtitle.
- **Partial title**: two or three words from a title.
- **Remembered phrase**: exact phrase from body text.
- **Loose memory**: phrase with punctuation/quote differences.
- **Image/motif**: sand, library, amber, wafer, prayer, omega.
- **Typo rescue**: plausible misspellings of distinctive terms.
- **Action intent**: continue, resume, next, previous, section 4.
- **Roman intent**: iv, v, section vi.
- **Current context**: same query on archive versus inside current essay.
- **No result**: nonsense query with useful fallback action.
- **Unpublished guard**: query that would match unpublished text must not leak
  on public surfaces.

Fixture review rule:

If a fixture expectation feels wrong during manual review, update the expected
behavior and explain why. Do not blindly preserve old rankings.

## Oracle Quality Ladder

Use this ladder to decide whether search is good enough for Spotlight.

1. **Finds literal text**: exact phrase and title search work.
2. **Finds structure**: section numbers, roman numerals, headings, and essays
   work.
3. **Finds remembered fragments**: punctuation, case, and partial phrase drift
   work.
4. **Finds concepts**: curated motifs and aliases help without overpowering
   direct matches.
5. **Finds intent**: Continue Reading, current essay, and route actions appear
   when the query implies them.
6. **Explains itself**: debug ranking reasons make surprising results
   understandable.
7. **Activates perfectly**: result opens the right passage with the right
   transition and highlight.

## Phased Implementation

### Phase 1: Index Generator

- [ ] Generate passage records from AST.
- [ ] Generate essay and section records.
- [ ] Add freshness check.
- [ ] Add artifact summary size reporting.
- [ ] Add unpublished exclusion tests.

### Phase 2: Query And Ranking Core

- [ ] Build query parser.
- [ ] Build ranking engine.
- [ ] Add score explanations.
- [ ] Add ranking fixtures.
- [ ] Replace old search engine where useful.

### Phase 3: Anchors And Reader Activation

- [ ] Generate stable passage anchors.
- [ ] Teach reader to route to anchors.
- [ ] Add highlight fallback.
- [ ] Update copy/citation link strategy where appropriate.

### Phase 4: Existing Search Surfaces

- [ ] Upgrade full search page.
- [ ] Upgrade archive inline search.
- [ ] Upgrade essay inline search.
- [ ] Preserve or recover important old URLs.

### Phase 5: Spotlight

- [ ] Build UI shell.
- [ ] Add action results.
- [ ] Add oracle passage results.
- [ ] Activate through hardened transitions.
- [ ] Add keyboard/mobile/reduced-motion tests.

## Done Criteria

- Search is AST/passage-aware.
- Spotlight opens instantly and shows useful results before typing.
- Result ranking has deterministic fixtures.
- Passage activation uses stable anchors or robust fallback.
- Existing search pages benefit from the new system.
- Offline/cached behavior is documented and tested.
- Generated artifacts are fresh and size-tracked.
- No unpublished essays leak into public search surfaces.
