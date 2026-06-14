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

When local disk or CPU is tight, prefer the manual GitHub Actions workflow in
the next section over running browser-heavy suites locally. Local checks are
still useful for focused edits, but remote runners are the normal place for
large TDD loops, Playwright installs, visual capture, Lighthouse, and dependency
PR validation.

Run this before most commits:

```powershell
npm run check
```

This covers syntax, AST runtime/tooling/corpus checks, content validation,
generated embedded data freshness, site-registry freshness, 404 recovery
catalogue freshness, offline asset freshness, discoverability/feed freshness,
and generated service-worker cache version freshness.

For standalone regressions that do not need a browser server:

```powershell
npm run test:standalone
```

For the full non-browser local gate:

```powershell
npm run ci:standalone
```

For a human-readable generated artifact inventory:

```powershell
npm run artifacts:summary
```

The summary reports published essay/section/route counts, service-worker
precache entry count and byte weight, offline asset payload weight, recovery
catalogue count/weight, and major generated file sizes.

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

## Remote One-Off Checks

Use GitHub-hosted runners for expensive or repeatable validation, especially
when the local machine is low on disk space. The `Manual Checks` workflow is
read-only (`contents: read`), accepts only whitelisted suite names, does not run
arbitrary shell input, and does not push generated files.

GitHub exposes manual workflow dispatch after the workflow file exists on the
default branch. Once this workflow has landed on `main`, it can run against a
selected branch/ref.

From the GitHub UI, open **Actions -> Manual Checks -> Run workflow**, choose a
branch/ref, then choose a suite.

From `gh`:

```powershell
gh workflow run manual-checks.yml --ref <branch-name> -f suite=standalone
```

Available suites:

- `check`: syntax, AST, content, and generated-artifact freshness checks.
- `html`: focused `html-validate` run; use this first for `html-validate`
  Dependabot PRs.
- `standalone`: full non-browser gate, equivalent to `npm run ci:standalone`.
- `browser`: Chromium route, reader, transition, subpath, and not-found checks.
- `pwa`: offline reading and service-worker update checks.
- `a11y`: accessibility, focus, and keyboard checks.
- `devices`: device matrix and slow-network checks.
- `visual`: visual QA capture/diff with artifacts.
- `lighthouse`: Lighthouse warning workflow with artifacts.
- `full-chromium`: standalone plus the Chromium-heavy suites.

For agentic/TDD work, prefer small branch commits, trigger the narrowest remote
suite that proves the change, inspect the Actions logs, then iterate. Keep
secrets, deploys, Pages publishing, and write permissions out of manual check
workflows unless a future task explicitly needs them.

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
- search index timing is surfaced in `npm run test:search-engine`
- focus and keyboard regressions
- device matrix
- slow-network journey
- service-worker update flow
- warning-only visual QA
- warning-only Lighthouse
- Firefox/WebKit cross-browser smoke

Additional workflows:

- `Manual Checks`: one-off read-only validation on a selected branch/ref.
- `A11y Ablation Matrix`: theme x motion x viewport x forced-colors matrix.
- `CodeQL`: JavaScript security and quality analysis.
- `Post-Deploy Live Smoke`: exercises the real GitHub Pages deployment after
  Pages publishes.
- `Nightly`: scheduled health checks such as audit/link/prod smoke.

Warning-only checks should still be read as review signals. They do not block
builds because their inputs are noisier than deterministic correctness tests.
