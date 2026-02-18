# Renaissance

Renaissance is a warm, book-style static website for long-form essays.

Current published essay:
- `Etching God into Sand`

## Quick Start

```powershell
python -m http.server 8000
```

If needed:

```powershell
py -m http.server 8000
```

Open:

`http://localhost:8000/index.html`

## Routes

- Home archive: `index.html`
- Essay page: `essay.html?essay=etching-god-into-sand`
- Section reader: `section.html?essay=etching-god-into-sand&section=1`
- Full search: `search.html`

## Reader Shortcuts

- `Ctrl+Alt+C` / `Cmd+Option+C`: copy highlight link for current selection in section reader.
- Standard copy in section content appends a source link to copied text.

## Quality Checks

Run these before commit:

```powershell
Get-ChildItem scripts\*.js | ForEach-Object { node --check $_.FullName }
node scripts/validate-content.js
node scripts/generate-embedded-data.js --check
```

## Content Workflow

1. Edit content:
- `raw/*.txt`
- `raw/manifest.json`
- `data/essays.json`
2. Validate content:

```powershell
node scripts/validate-content.js
```

3. Regenerate embedded fallback data:

```powershell
node scripts/generate-embedded-data.js
```

4. Optional portable export:

```powershell
node scripts/export-essay-text.js
```

Output:

`exports/etching-god-into-sand.txt`

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Runs on every `push` to `main` and on every pull request:
- JS syntax checks (`node --check`)
- Content validation (`scripts/validate-content.js`)
- Embedded data sync check (`scripts/generate-embedded-data.js --check`)
- Lighthouse performance audit in warning-only mode (logs warnings, does not fail build)

## Deployment

GitHub Pages project site:

`https://juniorhat78.github.io/renaissance/`
