# QA

Run the lightweight local check before committing most changes:

```powershell
npm run check
```

This runs:

- JavaScript syntax checks for `scripts/**/*.js`.
- Content validation.
- Embedded fallback data sync check.

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
npm run test:regression -- --base http://127.0.0.1:8000
```

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

GitHub Actions runs on pushes to `main` and pull requests. The workflow validates syntax, content, generated data, regression behavior, visual QA in warning mode, and Lighthouse performance in warning mode.
