# QA

Run the lightweight local check before committing most changes:

```powershell
npm run check
```

This runs:

- JavaScript syntax checks for `scripts/**/*.js`.
- Content validation.
- Embedded fallback data sync check.

For UI behavior or reader-state changes, also run the browser regression suite:

```powershell
npm run test:regression -- --base http://127.0.0.1:8000
```

## Local Server

```powershell
npm run dev
```

Open:

`http://localhost:8000/index.html`

## Regression Checks

With the local server running:

```powershell
node scripts/tests/meta-regression.js --base http://127.0.0.1:8000
npm run test:content-fallback
npm run test:lighthouse-target
npm run test:og-cards
npm run test:regression -- --base http://127.0.0.1:8000
```

`test:regression` covers route redirects, reader anchors, source-copy behavior, and reader continuity. The reader continuity checks assert semantic paragraph/ratio restore geometry across desktop and mobile, stale-state fallback behavior, anchor bypasses, and the debug inspector.

## Reader-State Debugging

Add `debugReadingState=1` to a reader URL to show the local continuity inspector:

```text
section.html?essay=etching-god-into-sand&section=1&debugReadingState=1
```

The panel reports saved paragraph, saved ratio, current reading-line pointer, restore mode, bookmark target, and whether saving is suppressed during restore.

## Visual QA

Install dev tooling once:

```powershell
npm install
```

Capture current screenshots:

```powershell
npm run visual:capture -- --base http://127.0.0.1:8000
```

Diff against the tracked baseline:

```powershell
npm run visual:diff
```

One-shot warning mode:

```powershell
npm run visual:check -- --base http://127.0.0.1:8000 --warn-only
```

Focused resume-state capture:

```powershell
npm run visual:capture -- --base http://127.0.0.1:8000 --only reader-resume-desktop-light,reader-resume-mobile-light
```

Approve current screenshots as the new baseline only for intentional visual changes:

```powershell
npm run visual:approve
```

Visual QA files:

- `qa/visual/scenarios.json`
- `qa/visual/baseline/`
- `qa/visual/current/`
- `qa/visual/diff/`
- `qa/visual/report.json`
- `qa/visual/report.md`

## CI

GitHub Actions runs on pushes to `main` and pull requests.

Required checks:

- Install dependencies with `npm ci`.
- Install Playwright Chromium.
- Run `npm run check`.
- Run standalone regressions that do not need a server.
- Run the full browser regression suite against a local static server.

Warning-only checks:

- Visual QA screenshot diff.
- Lighthouse performance checks for home, essay, and section routes.

Visual and Lighthouse warnings should be treated as review signals while the interface is still being polished. Make them strict only after the relevant baselines and performance thresholds are intentionally stabilized.
