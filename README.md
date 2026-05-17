# Renaissance

Renaissance is a warm, book-style static website for long-form essays.

Current public essay:
- `Etching God into Sand`

## Quick Start

```powershell
npm run dev
```

Open:

`http://localhost:8000/index.html`

If Python is not available through `npm run dev`, run:

```powershell
py -m http.server 8000
```

## Common Commands

```powershell
npm run check
npm run test:regression -- --base http://127.0.0.1:8000
npm run visual:check -- --base http://127.0.0.1:8000 --warn-only
```

## Routes

- Home archive: `index.html`
- Essay page: `essay.html?essay=<essay-slug>`
- Section reader: `section.html?essay=<essay-slug>&section=<section-number>`
- Full search: `search.html`

Examples:
- `essay.html?essay=etching-god-into-sand`
- `section.html?essay=etching-god-into-sand&section=1`
- `search.html?q=sand`

## Content Workflow

Edit:
- `data/essays.json`
- `raw/<essay-slug>/manifest.json`
- `raw/<essay-slug>/<section-number>.txt`

Then run:

```powershell
node scripts/generate-embedded-data.js
npm run check
```

Generated fallback data lives in:
- `scripts/essays-data.js`
- `scripts/chapters-data.js`

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [QA](docs/QA.md)
- [Roadmap](docs/ROADMAP.md)
- [Archived planning docs](docs/archive/)

## Deployment

GitHub Pages project site:

`https://juniorhat78.github.io/renaissance/`
