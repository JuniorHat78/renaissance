# Recommendations Backlog

Date: 2026-02-18  
Scope: Search, highlighting, sharing, and visual QA follow-ups.

Status key:
- `Planned`: codified, not started
- `In Progress`: currently being implemented
- `Done`: implemented and validated

## Actionables

### R1 `copy-footer-format`
- Status: `Done`
- Priority: `Medium`
- Problem:
  - Source footer copy format is not fully unified across copy surfaces.
- Action:
  - Define one canonical source footer style and use it for:
    - keyboard copy append path
    - explicit highlight-link copy path
- Verification:
  - Copy from each surface and confirm identical source footer format.
  - Automated check: `npm run test:copy-footer -- --base http://127.0.0.1:8000`

### R2 `q-only-cap-note`
- Status: `Done`
- Priority: `Medium`
- Problem:
  - `q`-only highlight mode uses a safety cap, but users are not informed when cap is applied.
- Action:
  - Show subtle UI note only when capping occurs (example: `Showing first N highlights`).
- Verification:
  - High-hit section with `q` only shows note.
  - Low-hit section with `q` only shows no note.
  - Automated check: `npm run test:anchors -- --base http://127.0.0.1:8000`

### R3 `anchor-regression-suite`
- Status: `Done`
- Priority: `High`
- Problem:
  - Anchor/highlight behavior can regress quietly.
- Action:
  - Add focused automated checks for:
    - precedence (`p/r/hl` before `q+occ` before `q`)
    - `q+occ` -> exactly one auto-highlight mark
    - `q` only -> multiple marks (or capped max)
- Verification:
  - Local run passes.
  - CI run configured to run regression suite.
  - Command: `npm run test:anchors -- --base http://127.0.0.1:8000`

### R4 `highlight-perf-metric`
- Status: `Done`
- Priority: `Low`
- Problem:
  - Large multi-highlight operations may regress performance over time.
- Action:
  - Add dev-only timing metric for highlight pass duration.
- Verification:
  - Metric appears in development mode logs.
  - Metric is host-gated to localhost/127.0.0.1/file runtime.
  - Automated check: included in `npm run test:anchors -- --base http://127.0.0.1:8000`

### R5 `visual-qa-routine`
- Status: `Done`
- Priority: `High`
- Problem:
  - UI polish can drift without deterministic screenshot + diff checks.
- Action:
  - Implement codified visual QA architecture:
    - scenario registry
    - capture runner
    - diff runner
    - approve runner
    - CI artifact reporting
- Verification:
  - `visual:check` produces current images, diffs, and reports.
  - CI workflow uploads visual artifacts in warning mode.
  - Commands:
    - `npm run visual:capture -- --base http://127.0.0.1:8000`
    - `npm run visual:diff`
    - `npm run visual:approve`
    - `npm run visual:check -- --base http://127.0.0.1:8000 --warn-only`

## Suggested Execution Order

1. `R3 anchor-regression-suite`
2. `R1 copy-footer-format`
3. `R2 q-only-cap-note`
4. `R5 visual-qa-routine`
5. `R4 highlight-perf-metric`

## Completion Criteria

- [x] All actionables marked `Done`.
- [x] Verification checks documented and reproducible.
- [x] Behavior and visual QA coverage are included in routine pre-merge checks.
