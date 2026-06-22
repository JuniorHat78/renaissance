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
npm run build:artifacts
npm run check
```

Derived artifacts (search index, compiled AST, essay metadata, feeds, sitemap,
the service-worker version) are **build output, not committed** — `build:artifacts`
regenerates them from source, and the deploy does the same. See
[AST compiler design](docs/specs/AST-COMPILER.md) → Net-off.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [QA](docs/QA.md)
- [Roadmap](docs/ROADMAP.md)
- [Ideas](docs/IDEAS.md)
- [Experience](docs/EXPERIENCE.md)
- [Interface Grammar](docs/INTERFACE-GRAMMAR.md)
- [Feature Specs](docs/specs/)
- [Transition And Spotlight Sprint](docs/TRANSITION-SPOTLIGHT-SPRINT.md)
- [Magical 404 Spec](docs/specs/404-MAGIC-SPEC.md)
- [AST Dialect](docs/specs/AST-DIALECT.md)
- [Search Ranking Spec](docs/specs/SEARCH-RANKING-SPEC.md)
- [Oracle Search Spec](docs/specs/ORACLE-SEARCH-SPEC.md)
- [AST Anchors Spec](docs/specs/AST-ANCHORS-SPEC.md)
- [Spotlight UX Spec](docs/specs/SPOTLIGHT-UX-SPEC.md)
- [Hardening Gauntlets Spec](docs/specs/HARDENING-GAUNTLETS-SPEC.md)
- [Engineering Sprint Checklist](docs/ENGINEERING-SPRINT.md)
- [Archived planning docs](docs/archive/)

## Deployment

GitHub Pages project site:

`https://juniorhat78.github.io/renaissance/`
