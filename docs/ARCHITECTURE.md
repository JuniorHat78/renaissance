# Architecture

Renaissance is a static site built with plain HTML, CSS, and browser-side JavaScript. There is no framework build step for the runtime site.

## Runtime Pages

- `index.html`: archive home, published essay list, global inline search preview.
- `essay.html?essay=<slug>`: essay landing page, section list, essay-scoped inline search preview.
- `section.html?essay=<slug>&section=<n>`: reader page, highlight links, source-copy behavior.
- `search.html`: full search results with scope, match mode, sorting, and pagination.
- `chapter.html`: compatibility redirect for older chapter-style links.

## Content Sources

- `data/essays.json` is the essay registry and source of truth for metadata.
- `raw/<essay-slug>/manifest.json` lists available sections.
- `raw/<essay-slug>/<section-number>.txt` contains section text.

The browser loader in `scripts/content.js` reads the registry and raw section files when served over HTTP.

## Embedded Fallback Data

The site also supports `file://` and degraded fetch contexts by embedding generated fallback data:

- `scripts/essays-data.js`
- `scripts/chapters-data.js`

Regenerate these files after content changes:

```powershell
node scripts/generate-embedded-data.js
```

Check they are current:

```powershell
npm run validate:embedded:check
```

## Search

Search is client-side. `scripts/search-engine.js` builds an in-memory index from published essays through the content API.

Search surfaces:

- Inline preview on home and essay pages.
- Full results on `search.html`.
- Reader deep links using `q`, `occ`, and highlight fallback parameters.

## Shared Helpers

- `scripts/content.js`: content loading, parsing, section metadata, rendering.
- `scripts/search-engine.js`: query parsing, matching, ranking, URLs.
- `scripts/meta.js`: canonical URL, social image, and document metadata helpers.
- `scripts/theme.js`: theme storage and toggle behavior.
