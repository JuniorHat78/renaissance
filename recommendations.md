# Recommendations Backlog

Date: 2026-02-21
Scope: Multi-essay hardcoding audit and de-hardcode plan.

Status key:
- `[ ]` Not started
- `[-]` In progress
- `[x]` Done

## Critical

- [x] Dynamic metadata for `essay.html`
  - Replace static Etching meta/title/canonical with runtime values from `data/essays.json`.
  - Set `document.title`, `<meta name="description">`, `og:title`, `og:description`, `og:url`, and `twitter:*` after essay load.

- [x] Dynamic metadata for `section.html`
  - Replace static Etching meta/title with section and essay-aware values.
  - Include section title in title, OG, and Twitter fields.

- [x] Remove hardcoded legacy redirect target in `chapter.html`
  - Current redirect always points to `essay=etching-god-into-sand`.
  - Support `?essay=<slug>&chapter=<n>` and a safe default when essay is omitted.

## High Priority

- [x] Parameterize regression tests away from a single slug
  - `scripts/tests/anchor-regression.js` and `scripts/tests/copy-footer-regression.js` should support configurable essay slug and section.
  - Add at least one SHADOWS smoke case.

- [x] Expand visual scenario coverage for multi-essay states
  - Add SHADOWS scenarios (desktop and mobile) in `qa/visual/scenarios.json`.
  - Keep existing Etching baselines, but stop relying on one essay for all checks.

- [x] Make CI Lighthouse targets data-driven
  - Replace fixed URLs for Etching in `.github/workflows/ci.yml`.
  - Resolve target essay and section from `data/essays.json` (first published essay and first section).

## Medium Priority

- [x] Reduce hardcoded fallback identity in `scripts/content.js`
  - Current defaults are Etching-specific.
  - Prefer first embedded essay or first metadata essay as fallback identity.

- [x] Create essay-aware OG card pipeline
  - Keep current home card.
  - Add a script/template flow that can generate per-essay OG cards from metadata.

- [x] Clean doc examples that imply a single canonical essay
  - Keep Etching examples where helpful, but add neutral patterns (`<essay-slug>`, `<section-number>`).

## Nice to Have

- [ ] Add a metadata consistency check for social cards
  - Validate each published essay has title/summary/OG image mapping, or an explicit fallback policy.

- [ ] Add a small router utility for defaults
  - Single source of truth for "default essay" and "default section" behavior shared across pages.

## Verification Checklist

- [x] `node scripts/validate-content.js`
- [x] `node scripts/generate-embedded-data.js --check`
- [x] `node scripts/tests/regression-check.js --base http://127.0.0.1:8000`
- [x] `npm.cmd run visual:check -- --base http://127.0.0.1:8000 --warn-only`

## Suggested Execution Order

1. Dynamic metadata (`essay.html`, `section.html`)
2. `chapter.html` redirect de-hardcode
3. Regression test parameterization
4. Visual scenarios and CI Lighthouse data-driven URLs
5. Fallback/generalization cleanup and docs
