# Engineering Sprint Checklist

This sprint is for work that can be done with minimal taste feedback. It should
focus on recovery, offline behavior, generated data, validation, parser/search
hardening, test infrastructure, and docs. Avoid visual redesign work except
where it is required to complete a recovery flow.

## Objective

Harden Renaissance's recovery/offline/generated-data backbone:

- contextual browser-level 404 modes
- matching app-shell recovery states
- cache/version automation
- generated recovery catalogue
- validation and regression coverage
- documentation closeout
- backend-ish foundations for a future Apple-feel interface rewrite

The sprint may overengineer modestly where it reduces future babysitting,
staleness, or route fragility.

## Sprint Run Configuration

These are the current execution rules for the long sprint.

- [x] Start only after the user explicitly says `go`.
- [x] Create a dedicated sprint branch before implementation begins.
- [x] Keep work scoped to this repository.
- [x] Treat this document as the live checklist; update checkboxes and notes as
      phases progress.
- [x] Commit in small, reviewable chunks.
- [x] Push to GitHub often so GitHub Actions can do the heavy verification.
- [ ] Merge the sprint branch only after the sprint is complete and CI is in an
      acceptable state.
- [x] Prefer GitHub Actions over heavy local test loops.
- [x] Use extensive CI, add or strengthen workflows if the sprint creates new
      risk surfaces.
- [x] Do not run local dependency installs unless the user explicitly changes the
      rule.
- [x] Avoid large writes to `C:`; the machine is low on C-drive space.
- [x] Existing Playwright/browser assets may live on `D:`; inspect before using
      during the sprint, but do not install browser bundles locally.
- [ ] Skip a troublesome subtask only if it blocks unrelated work; record the
      skip and continue the sprint.
- [ ] Be aggressive on AST/search work, but protect changes with specs,
      fixtures, and tests.
- [ ] Do not ask for permission mid-sprint unless repo access, credentials, or an
      irreversible external action is genuinely blocked.

## Apple-Feel Foundation

The eventual visual rewrite should not be a pile of one-off CSS. The engineering
foundation should make an Apple-feel possible later: calm hierarchy, consistent
motion, predictable controls, strong accessibility, and fast interactions.

This sprint should therefore favor:

- [ ] canonical route/data registries over duplicated ad hoc lookups
- [ ] generated artifacts with freshness checks
- [ ] stable component/control primitives before new visual flourishes
- [ ] shared interaction semantics for popovers, menus, previews, recovery, and
      future Spotlight
- [ ] performance budgets for generated artifacts and runtime work
- [ ] accessibility helpers and regression journeys for keyboard/reduced motion
- [ ] clear design-token documentation even if the final visual pass happens
      later

## Operating Rules

- [x] Work in phases and keep each phase shippable.
- [x] Use commit style: `<scope>(<area>): <summary>`, lowercase imperative.
- [x] Do not add `Co-Authored-By` trailers.
- [x] Keep all internal links and assets relative/subpath-safe for
      `/renaissance/`.
- [x] Preserve keyboard, touch, reduced-motion, offline, and dark-theme behavior.
- [x] Run only focused local checks during development.
- [x] Let GitHub Actions carry the expensive browser/device/visual matrix.
- [x] Prefer rerunning failed GitHub jobs over pounding the laptop.
- [ ] Keep warning-only visual and Lighthouse results as review signals.
- [ ] Add CI coverage rather than relying on local manual confidence when a new
      backend/recovery/cache/search/parser surface is introduced.
- [ ] Do not start Spotlight Search UI in this sprint unless all recovery/cache
      foundations are complete and only backend registry prep remains.
- [ ] Do not redesign visual taste surfaces unless needed for recovery or shared
      component primitives.

## Phase 0: Checkpoint Current Work

Goal: separate the current docs/interface/404 work from the long sprint.

- [x] Review current diff and group changes by intent.
- [x] Commit documentation cleanup separately if not already committed.
- [x] Commit interface-control polish separately if not already committed.
- [x] Commit initial 404 magic shell/spec separately if not already committed.
- [x] Confirm the working tree is clean before beginning Phase 1.

Suggested commits:

- `docs(roadmap): consolidate planning docs`
- `style(controls): refine archive search controls`
- `feat(404): add magical recovery shell`

## Phase 1: Contextual 404 Modes

Goal: implement the mode system described in `docs/404-MAGIC-SPEC.md`.

- [x] Add route classification inside `404.html`.
- [x] Detect unknown path mode.
- [x] Detect essay-link mode from `essay=<slug>` or essay-like path tokens.
- [x] Detect section-link mode from `essay=<slug>&section=<number>`.
- [x] Detect search-link mode from `q=`, `query=`, `search=`, or old search
      paths.
- [x] Detect asset/old-file mode from missing extensions such as `.html`,
      `.txt`, `.png`, `.jpg`, `.svg`, `.pdf`, `.xml`, and `.json`.
- [x] Detect offline mode from `navigator.onLine === false`.
- [x] Swap eyebrow, lead copy, primary suggestion, search prefill, and secondary
      suggestions by mode.
- [x] Keep one physical `404.html`; do not create separate 404 files that
      GitHub Pages cannot route to directly.
- [x] Keep existing recovery hooks stable: `#archive-link`, `#search-link`,
      `#did-you-mean`.

Suggested commit:

- `feat(404): add contextual recovery modes`

## Phase 2: App-Shell Recovery States

Goal: make in-app 200-response not-found states feel like the same archive
system.

- [x] Improve `essay.html?essay=<bad-slug>` recovery copy and links.
- [x] Improve `section.html?essay=<bad-slug>&section=<n>` recovery copy and
      links.
- [x] Improve `section.html?essay=<valid>&section=<bad>` recovery copy and
      links.
- [x] Suggest nearest valid essay or section where deterministic.
- [x] Preserve `meta[name="robots"] content="noindex"` for app-shell failures.
- [x] Keep recovery links under the project subpath.
- [x] Avoid large visual redesign of essay/section shells.

Suggested commit:

- `feat(recovery): align app-shell not-found states`

## Phase 3: Cache And Version Hardening

Goal: reduce stale shell risk from manual service-worker cache versions.

- [x] Audit current `sw.js` cache version behavior.
- [x] Add generated cache metadata or an asset-content-derived version stamp.
- [x] Add a check that fails when generated cache metadata is stale.
- [x] Keep the service worker install path deterministic.
- [x] Consider a bounded network timeout for navigations before falling back to
      cached shell pages on slow/flaky networks.
- [x] Preserve current offline reading guarantees.
- [x] Document the new cache/version workflow in `docs/QA.md` and/or
      `docs/ARCHITECTURE.md`.

Suggested commit:

- `feat(pwa): automate cache version metadata`

## Phase 4: Generated Recovery Catalogue

Goal: stop hand-maintaining 404/recovery suggestion metadata.

- [x] Generate compact published essay/section metadata from `data/essays.json`
      and source manifests.
- [x] Include only published essays in production recovery suggestions.
- [x] Include essay slug, title, summary, section numbers, and section titles.
- [x] Keep browser-level 404 path-depth safe by embedding or otherwise safely
      loading the catalogue.
- [x] Add validation that the generated catalogue is fresh.
- [x] Add tests that unpublished essays do not leak into recovery suggestions.

Suggested commit:

- `feat(recovery): generate not-found catalogue`

## Phase 5: Validation Expansion

Goal: catch content and route mistakes before deployment.

- [x] Detect duplicate essay slugs.
- [x] Validate section order against files and metadata.
- [x] Validate social images exist.
- [x] Validate internal route links resolve.
- [x] Validate no root-absolute links escape `/renaissance/`.
- [x] Validate feed, sitemap, robots, and discoverability outputs stay fresh.
- [x] Add or update standalone regression tests for the new validators.

Suggested commit:

- `test(content): expand validation coverage`

## Phase 6: Canonical Route And Site Registry

Goal: create one source of truth for valid site routes and metadata.

- [x] Generate a route registry from published essays, sections, shell pages,
      feeds, sitemap, manifest, and static recovery routes.
- [x] Use the registry to validate internal links.
- [x] Use the registry to seed 404/recovery suggestions.
- [x] Use the registry to derive sitemap/feed/discoverability expectations where
      practical.
- [x] Use the registry to derive service-worker shell precache expectations where
      practical.
- [x] Add stale-registry checks.
- [x] Document the registry in `docs/ARCHITECTURE.md`.

Suggested commit:

- `feat(routes): generate canonical route registry`

## Phase 7: Build Pipeline And Artifact Discipline

Goal: make generated artifacts predictable and auditable.

- [x] Inventory every generated artifact and its source inputs.
- [x] Add or improve a single build/check command that validates all generated
      artifacts are fresh.
- [x] Add artifact summary output for humans: counts, sizes, published essays,
      sections, routes, cache entries.
- [x] Ensure generated outputs are deterministic across Windows/Linux line
      endings where practical.
- [x] Add size budgets for large generated files.
- [x] Document the content-to-artifact pipeline.

Suggested commit:

- `feat(build): summarize generated artifacts`

## Phase 8: Recovery Engine Module

Goal: move recovery classification/suggestion logic out of ad hoc page code.

- [x] Create a pure recovery helper that accepts route/search/catalogue state and
      returns a mode plus suggestions.
- [x] Support unknown, essay, section, search, asset/old-file, and offline modes.
- [x] Use the helper for browser-level 404 where path-depth safety allows.
- [x] Use the helper for essay/section app-shell failures.
- [x] Unit test mode classification and suggestion ranking without a browser.
- [x] Keep DOM rendering separate from recovery decisions.

Suggested commit:

- `feat(recovery): add route suggestion engine`

## Phase 9: Search Infrastructure And Ranking Redesign

Goal: harden search behavior and prepare scaling without committing to a new UI.

- [x] Decide that the generated site registry is sufficient compact
      search/recovery metadata for this sprint.
- [x] Add size/budget checks for generated search/recovery artifacts.
- [x] Document the threshold for moving from runtime indexing to a generated
      index or Web Worker.
- [x] Keep the current runtime search behavior working.
- [x] Do not redesign the search UI or Spotlight UI in this phase.
- [x] Write a ranking spec: title > section title > exact phrase > body
      occurrence > fuzzy match.
- [x] Add ranking fixtures with deterministic expected order.
- [x] Add query parser fixtures for phrases, punctuation, case sensitivity, and
      empty/noisy input.
- [x] Add field boosts for essay title, section title, headings, and body when
      supported by current data.
- [x] Add tie-break rules that remain stable across browsers.
- [x] Consider a generated lightweight index artifact if it can stay within the
      size budget.
- [x] Consider a Web Worker boundary if runtime indexing grows beyond the
      documented threshold.

Suggested commit:

- `feat(search): harden ranking fixtures`

## Phase 10: AST Dialect And Recursive Parser Track

Goal: make AST evolution safe enough to support richer authoring later.

- [x] Document supported syntax: paragraphs, headings, dividers, emphasis,
      pull-quotes, strong, links, inline code, lists, blockquotes, and recursive
      inline behavior.
- [x] Document intentionally plain-text syntax that still degrades safely.
- [x] Add fixtures for current edge behavior.
- [x] Add tests showing unsupported or unsafe syntax degrades safely.
- [x] Preserve current parser security and dependency-free browser runtime.
- [x] Add an AST version/migration note if behavior changes.
- [x] Build parser fixtures before changing recursive inline behavior.
- [x] Add renderer parity tests for legacy bridge output and AST rendering.
- [x] Add recursive inline parsing for nested emphasis only after fixture parity
      is stable.
- [x] Add strong, inline code, links, lists, and blockquotes only behind explicit
      fixtures and sanitizer-safe rendering.
- [x] Keep unsupported raw HTML inert.
- [x] Avoid importing a full Markdown parser unless the project explicitly
      chooses that dependency trade-off.

Suggested commit:

- `feat(ast): add recursive inline fixtures`

## Phase 11: Legacy Bridge De-Risking

Goal: reduce transitional AST/legacy ambiguity without breaking rendering.

- [ ] Inventory every `astToLegacyBlocks` and `legacyBlocksToAst` call site.
- [ ] Document which render paths still require legacy blocks.
- [ ] Add tests that compare AST render output to legacy render output on corpus
      fixtures.
- [ ] Move call sites toward one normalized AST input boundary where practical.
- [ ] Measure or estimate conversion overhead on current corpus.
- [ ] Decide whether to keep, isolate, or deprecate the legacy bridge.

Suggested commit:

- `test(ast): cover legacy bridge parity`

## Phase 12: Reading-State Restore Hardening

Goal: improve resume behavior without changing the reader design.

- [x] Add paragraph text signatures or stable paragraph IDs as a fallback before
      absolute `scrollY`.
- [x] Add tests for content edits that shift paragraph indices.
- [x] Add tests for mobile/desktop reflow where semantic restore should win over
      pixel restore.
- [x] Document current threshold constants and when to tune them.
- [ ] Consider dynamic completion/restore thresholds based on document length.
- [x] Keep existing reading-state data backward compatible.

Suggested commit:

- `feat(reading): add semantic restore fallback`

## Phase 13: Interaction Primitive Hardening

Goal: make later Apple-feel UI work easier and less ad hoc.

- [ ] Extract or document common open/close behavior for popovers, previews,
      menus, and future Spotlight.
- [ ] Add a reusable keyboard pattern for Escape, outside click, focus restore,
      and roving option focus.
- [ ] Audit custom select/listbox semantics.
- [ ] Add forced-colors and reduced-motion notes for custom controls.
- [ ] Add interaction-state tests where practical.
- [ ] Keep styling changes minimal unless needed to support the primitive.

Suggested commit:

- `feat(ui): standardize popup interactions`

## Phase 14: Design Tokens And Component Grammar Prep

Goal: prepare for a later Apple-feel surface pass without doing that pass now.

- [ ] Inventory current color, spacing, radius, shadow, typography, and motion
      values.
- [ ] Define a small token scale for spacing, radius, shadow, and motion.
- [ ] Document component roles: primary action, ghost action, search action,
      field, select, checkbox, popover, recovery slip, result row, pagination.
- [ ] Identify one-off CSS that should later fold into component primitives.
- [ ] Add comments sparingly only where tokens need explanation.
- [ ] Avoid broad restyling in this phase.

Suggested commit:

- `docs(ui): define interface token scale`

## Phase 15: Accessibility Infrastructure

Goal: make richer UI safe before Spotlight and future component polish.

- [ ] Add helper patterns or docs for focus management.
- [ ] Add roving tabindex/listbox expectations.
- [ ] Extend keyboard journey tests for custom menus and recovery flows.
- [ ] Extend forced-colors expectations where automated checks are reliable.
- [ ] Keep axe forced-colors limitations documented.
- [ ] Add reduced-motion checks for new animation surfaces.

Suggested commit:

- `test(a11y): extend interaction coverage`

## Phase 16: Performance Budgets And Observability

Goal: make growth visible before it becomes slow.

- [x] Add budgets for generated JS/data artifacts.
- [ ] Add search index build timing instrumentation in dev/test where practical.
- [ ] Add service-worker precache size reporting.
- [ ] Add route/recovery catalogue size reporting.
- [x] Document thresholds that trigger generated index or worker migration.
- [ ] Keep Lighthouse warning-only but record meaningful deltas.

Suggested commit:

- `test(perf): add artifact budget checks`

## Phase 17: Route And Recovery Test Matrix

Goal: make recovery behavior hard to regress.

- [x] Extend not-found regression coverage for every 404 mode.
- [x] Extend app-shell recovery tests for bad essay and bad section routes.
- [x] Add subpath assertions for every new recovery link.
- [ ] Add reduced-motion assertions for 404 animations where practical.
- [ ] Add offline/PWA assertions for cached 404 and recovery behavior where
      practical.
- [ ] Run focused local checks.
- [ ] Push and let GitHub Actions run the full matrix.
- [ ] Read warning-only visual and Lighthouse outputs.
- [ ] Fix real failures and rerun failed jobs.
- [ ] Add CI jobs or split existing jobs if the suite becomes too broad to read
      clearly.
- [ ] Ensure new generated/cache/search/AST checks run in GitHub Actions.
- [ ] Prefer targeted reruns for failed Actions jobs.

Suggested commit:

- `test(recovery): cover contextual not-found routes`

## Phase 18: Documentation Closeout

Goal: leave the next session with a clear map.

- [ ] Update `docs/ROADMAP.md` checkboxes.
- [ ] Update `docs/404-MAGIC-SPEC.md` with any implemented decisions.
- [ ] Update `docs/INTERFACE-GRAMMAR.md` only for stable control/recovery
      language.
- [ ] Update `docs/QA.md` with new generated/cache checks.
- [ ] Update `docs/ARCHITECTURE.md` with recovery/cache architecture notes.
- [ ] Update AST and search docs/specs with implemented decisions.
- [ ] Update any Apple-feel foundation notes that are stable enough to guide a
      later visual rewrite.
- [ ] Leave this sprint checklist updated with completed, skipped, and deferred
      work.
- [ ] Archive or remove any obsolete scratch notes.

Suggested commit:

- `docs(recovery): record sprint outcomes`

## Out Of Scope

- [ ] No broad visual redesign.
- [ ] No full Spotlight Search UI unless backend registry/recovery foundations
      are already complete.
- [ ] No large UI taste pass that needs frequent user feedback.
- [ ] No paid browser/device grid.

## Acceptance Criteria

- [ ] Browser-level 404 has contextual recovery modes.
- [ ] Essay and section app-shell failures share the recovery tone.
- [ ] Cache/version workflow no longer relies only on a remembered manual bump.
- [ ] Recovery suggestions are generated or validated from source content.
- [ ] New validation catches route/content/cache freshness mistakes.
- [ ] Tests cover recovery modes and subpath-safe links.
- [ ] Route/data registries reduce duplicated source-of-truth logic.
- [ ] Search and AST have specs, fixtures, or safe implementation tracks.
- [ ] Reading-state fallback is more semantic before pixel fallback.
- [ ] Interaction and design-token docs make a future Apple-feel rewrite less
      ad hoc.
- [ ] The live sprint checklist reflects the actual final state.
- [ ] GitHub Actions pass or have documented warning-only residuals.
- [ ] Roadmap and architecture docs explain what changed.
