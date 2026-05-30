# QA

Renaissance has a broad test surface. Use the smallest check that proves the
change, then let GitHub Actions run the expensive matrix.

## Local Server

```powershell
npm run dev
```

Open:

```text
http://localhost:8000/index.html
```

## Fast Local Confidence

Run this before most commits:

```powershell
npm run check
```

This covers syntax, AST runtime/tooling/corpus checks, content validation,
generated embedded data freshness, offline asset freshness, and
discoverability/feed freshness.

For standalone regressions that do not need a browser server:

```powershell
npm run test:standalone
```

For the full non-browser local gate:

```powershell
npm run ci:standalone
```

## Browser Regressions

With a local server running:

```powershell
npm run test:regression -- --base http://127.0.0.1:8000
```

The browser regression suite covers route redirects, reader anchors,
source-aware copy behavior, hover previews, reduced motion, and reader
continuity. Reader continuity assertions include semantic paragraph/ratio
restore geometry, stale-state fallback behavior, anchor bypasses, and the debug
inspector.

Focused browser checks are available through package scripts, including:

- `npm run test:subpath`
- `npm run test:notfound`
- `npm run test:a11y`
- `npm run test:offline`
- `npm run test:focus`
- `npm run test:devices`
- `npm run test:keyboard`
- `npm run test:slow-network`
- `npm run test:sw-update`

## Reader-State Debugging

Add `debugReadingState=1` to a reader URL to show the local continuity
inspector:

```text
section.html?essay=etching-god-into-sand&section=1&debugReadingState=1
```

The panel reports saved paragraph, saved ratio, current reading-line pointer,
restore mode, bookmark target, and whether saving is suppressed during restore.

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

Focused capture example:

```powershell
npm run visual:capture -- --base http://127.0.0.1:8000 --only reader-resume-desktop-light,reader-resume-mobile-light
```

Approve current screenshots as the new baseline only for intentional visual
changes:

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

## GitHub Actions

Push and pull request CI runs the full project gate:

- `ci:standalone`
- browser regression suite
- subpath regression under `/renaissance/`
- custom 404 regression
- accessibility audit
- offline/PWA regression
- focus and keyboard regressions
- device matrix
- slow-network journey
- service-worker update flow
- warning-only visual QA
- warning-only Lighthouse
- Firefox/WebKit cross-browser smoke

Additional workflows:

- `A11y Ablation Matrix`: theme x motion x viewport x forced-colors matrix.
- `CodeQL`: JavaScript security and quality analysis.
- `Post-Deploy Live Smoke`: exercises the real GitHub Pages deployment after
  Pages publishes.
- `Nightly`: scheduled health checks such as audit/link/prod smoke.

Warning-only checks should still be read as review signals. They do not block
builds because their inputs are noisier than deterministic correctness tests.
