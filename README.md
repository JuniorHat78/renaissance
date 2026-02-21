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
- Essay page: `essay.html?essay=<essay-slug>`
- Section reader: `section.html?essay=<essay-slug>&section=<section-number>`
- Full search: `search.html`

Examples:
- `essay.html?essay=etching-god-into-sand`
- `essay.html?essay=shadows`
- `section.html?essay=shadows&section=1`

## Reader Shortcuts

- `Ctrl+Alt+C` / `Cmd+Option+C`: copy highlight link for current selection in section reader.
- Standard copy in section content appends a source footer: `[Source] <url>`.

## Quality Checks

Run these before commit:

```powershell
Get-ChildItem -Recurse scripts\*.js | ForEach-Object { node --check $_.FullName }
node scripts/validate-content.js
node scripts/generate-embedded-data.js --check
node scripts/tests/meta-regression.js --base http://127.0.0.1:8000
npm run test:regression -- --base http://127.0.0.1:8000
```

## Visual QA Routine

Install dev tooling:

```powershell
npm.cmd install
```

Capture current screenshots from your running local server:

```powershell
npm.cmd run visual:capture -- --base http://127.0.0.1:8000
```

Run diff against git-tracked baseline:

```powershell
npm.cmd run visual:diff
```

Approve current screenshots as new baseline (intentional changes only):

```powershell
npm.cmd run visual:approve
```

One-shot warning mode (capture + diff):

```powershell
npm.cmd run visual:check -- --base http://127.0.0.1:8000 --warn-only
```

Visual QA architecture files:
- Scenario registry: `qa/visual/scenarios.json`
- Baseline images: `qa/visual/baseline/`
- Runtime outputs: `qa/visual/current/`, `qa/visual/diff/`, `qa/visual/report.json`, `qa/visual/report.md`

## Content Workflow

1. Edit content:
- `data/essays.json`
- `raw/<essay-slug>/manifest.json`
- `raw/<essay-slug>/<section>.txt`

Example layout:
- `raw/etching-god-into-sand/1.txt`
- `raw/etching-god-into-sand/manifest.json`
- `raw/shadows/1.txt`
- `raw/shadows/manifest.json`
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

`exports/<essay-slug>.txt` (for each essay in `data/essays.json`)

Note:
- Current examples include `exports/etching-god-into-sand.txt` and `exports/shadows.txt`.

5. Optional essay OG card generation:

```powershell
node scripts/og/generate-cards.js
```

Output:

- `assets/og-<essay-slug>.png`
- `assets/og-cards/<essay-slug>.html`

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Runs on every `push` to `main` and on every pull request:
- JS syntax checks (`node --check`)
- Content validation (`scripts/validate-content.js`)
- Embedded data sync check (`scripts/generate-embedded-data.js --check`)
- Anchor/copy regression checks (`npm run test:regression`)
- Visual QA check (`npm run visual:check -- --warn-only`) with artifact upload
- Lighthouse performance audit in warning-only mode (logs warnings, does not fail build)

## Deployment

GitHub Pages project site:

`https://juniorhat78.github.io/renaissance/`
