# Architecture

Renaissance is a static, frameworkless reading site built with plain HTML, CSS,
and browser-side JavaScript. The runtime site has no bundler or framework build
step. The experience posture is documented in `docs/EXPERIENCE.md`: zero
runtime dependencies are a control strategy for durability, predictable loading,
and precise interaction work rather than a rule against development tooling.

## Runtime Pages

- `index.html`: archive home, published essay list, Continue Reading, and global
  inline search preview.
- `essay.html?essay=<slug>`: essay landing page, section list, and essay-scoped
  inline search preview.
- `section.html?essay=<slug>&section=<n>`: reader page, progress tracking,
  highlight links, source-aware copy behavior, and reader-state restore.
- `search.html`: full search results with scope, match mode, sorting, and
  pagination.
- `404.html`: self-contained not-found recovery page for GitHub Pages misses.
- `chapter.html`: compatibility redirect for older chapter-style links.

## Content Sources

- `data/essays.json` is the essay registry and source of truth for metadata.
- `raw/<essay-slug>/manifest.json` lists available sections.
- `raw/<essay-slug>/<section-number>.txt` contains section text.

The browser loader in `scripts/content.js` reads the registry and raw section
files when served over HTTP.

`published: false` marks an essay as unlisted, not private. Unlisted essays are
omitted from public archive listings, search, feeds, sitemap, and recovery
suggestions, but direct URLs and generated/offline assets may still expose the
content.

## AST Content Pipeline

Essay prose is parsed through the runtime AST module in `scripts/ast/index.js`.
The AST pipeline is intentionally small and safe:

- raw text is normalized and parsed into known block/inline node types;
- generated DOM uses `createElement` / text nodes rather than author-controlled
  HTML strings;
- derived text powers excerpts, word counts, metadata descriptions, and search;
- fixtures and corpus tools live under `scripts/ast-tools/` and
  `test-fixtures/ast/`.

The current grammar is a tiny literary document language, not full Markdown.
The dialect contract lives in `docs/specs/AST-DIALECT.md`; future syntax ideas
are tracked in `docs/IDEAS.md`.

## Derived Artifacts (net-off)

There is one human source of truth — the prose under `raw/` plus
`data/essays.json` — and a single command turns it into every derived artifact:

```powershell
npm run build:artifacts
```

These outputs are **build output, not committed** (gitignored): `scripts/essays-data.js`,
`data/compiled/<slug>.json` (the hydration source), `data/search-index.json`,
`data/offline-assets.json`, `data/site-registry.json`, `sitemap.xml`, `feed.xml`,
and `rss.xml`. Two files stay committed because they hold a generated *region*
inside a hand-authored file: `sw.js` (its cache `VERSION`, hashed from the
precached assets) and `404.html` (its inline recovery catalogue).

The deploy (`.github/workflows/pages.yml`) and the local `predev` hook both run
`build:artifacts`, so the artifacts never need to live in git. Correctness is
gated by `npm run ci:build-verify`, which builds, asserts the committed in-place
files are fresh, then builds again and asserts byte-identical output
(determinism). Content correctness is proven by the regression suite running
against the freshly built artifacts. The full design — including why dropping
the committed copies is safe — lives in `docs/specs/AST-COMPILER.md` (Net-off).

`scripts/artifact-summary.js` gives a compact count/size report for generated
route, cache, content, and recovery artifacts, including service-worker
precache weight, offline asset payload weight, and recovery catalogue size.

## Search

Search is client-side. `scripts/search-engine.js` builds an in-memory index from
published essays through the content API.

Search surfaces:

- inline preview on home and essay pages;
- full results on `search.html`;
- reader deep links using `q`, `occ`, and highlight fallback parameters.

Fuzzy search work is bounded and cached for the current corpus size. The search
regression prints index build timing so growth is visible in CI logs. Larger
archive plans, such as generated search data or Web Worker query execution, live
in `docs/IDEAS.md` and `docs/specs/SEARCH-RANKING-SPEC.md`.

## Reading State

Reader continuity is stored in `localStorage` through `scripts/reading-state.js`.
Each section record keeps progress, max progress, scroll position, paragraph
index, paragraph ratio, and a normalized paragraph text signature.

Restore prefers semantic paragraph data over pixels:

- use the saved paragraph signature if an inserted or removed paragraph makes
  the saved index point at the wrong text;
- use the saved paragraph index and ratio when the signature is absent;
- derive a paragraph ratio from saved `scrollY` when possible;
- fall back to raw `scrollY` only when semantic targets cannot be resolved.

The current restore thresholds are intentionally conservative: restore only
between 3% and 90% progress, show Continue Reading after roughly 4% meaningful
progress, and mark completion at 92%. Tune these only with reader-journey tests,
because short and long sections feel different.

## Routing And Subpath Safety

Internal routes are built through `scripts/router.js`. Runtime links stay
relative so they work both at the origin root and under the GitHub Pages project
subpath `/renaissance/`.

Subpath navigation, custom 404 behavior, and live production smoke tests are CI
guards because this class of bug has broken production before.

`scripts/recovery-engine.js` holds pure recovery scoring/classification helpers
for app-shell failures and tests. `404.html` keeps embedded route-mode logic
because GitHub Pages may serve it from arbitrary missing paths where relative
script URLs are not reliable.

## Shared Helpers

- `scripts/content.js`: content loading, AST parsing, section metadata, and
  rendering.
- `scripts/search-engine.js`: query parsing, matching, ranking, URLs, and result
  caching.
- `scripts/router.js`: route parsing/building, history state, and query cleanup.
- `scripts/recovery-engine.js`: pure not-found mode classification and nearest
  essay/section suggestions.
- `scripts/reading-state.js`: local reader progress and Continue Reading data.
- `scripts/meta.js`: canonical URL, social image, and document metadata helpers.
- `scripts/theme.js`: theme storage and toggle behavior.
- `scripts/pwa.js`: service-worker registration.
