# Hardening Gauntlets Spec

This spec defines the post-main hardening passes for the Transition, Oracle
Search, AST Anchors, and Spotlight sprint. It exists so "test it hard" means a
specific evidence-driven process rather than a vague desire for more CI.

The gauntlets should run after the main implementation path works, and also
whenever a large interaction, search, anchor, cache, or routing change creates
new risk.

## Core Rule

Review the evidence, not just the checkmark.

Passing CI is necessary but not sufficient for this sprint. Transitions,
Spotlight, and oracle search must be inspected through logs, screenshots, videos,
traces, generated reports, ranking explanations, and manual critique whenever
those artifacts would teach us something.

## What To Review

Review as much of the available evidence as makes sense for the change.

Always consider:

- Playwright traces;
- screenshots;
- visual diff images;
- short videos when motion is the subject;
- console logs and browser errors;
- accessibility reports;
- Lighthouse reports;
- generated artifact summaries;
- search ranking explanations;
- query fixture output;
- anchor resolution diagnostics;
- service-worker cache logs;
- slow-network timing output;
- failed test attachments;
- GitHub Actions job summaries.

Do not blindly re-run failing jobs. Inspect the artifact first unless the
failure is obviously external infrastructure.

## Artifact Review Contract

Each artifact type has a purpose.

- **Screenshots** prove layout, visible state, clipping, overlap, and obvious
  visual regressions.
- **Videos** prove timing, continuity, perceived lag, blank frames, and motion
  taste.
- **Traces** prove event order, navigation handoff, network timing, console
  errors, focus state, and hard-to-see frame transitions.
- **Visual diffs** prove pixel drift against approved baselines.
- **Ranking reports** prove why search returned a result.
- **Anchor diagnostics** prove how a deep link resolved or failed.
- **Artifact summaries** prove generated files, cache payloads, and search
  indexes stayed within expected shape/size.
- **A11y reports** prove keyboard/focus/semantic issues were not missed.

For any sprint phase that affects motion, search ranking, anchors, or Spotlight
activation, at least one artifact type beyond plain stdout should be reviewed
unless the change is trivially docs-only.

## Review Notes Template

Record meaningful review notes in the sprint doc or commit message when useful:

```text
Run:
Suite:
Artifacts reviewed:
Paths reviewed:
Findings:
Decision:
Follow-ups:
```

Use this especially for subjective motion decisions, visual baseline changes,
search ranking tuning, and slow-network/PWA behavior.

## Gauntlet Families

### Transition Gauntlet

Purpose: prove navigation feels seamless and never blanks or stalls.

Paths:

- home -> essay;
- home -> Continue Reading -> section;
- home inline search -> full search;
- home inline search -> result;
- essay -> section;
- essay inline search -> section;
- section -> previous;
- section -> next;
- section -> essay;
- section -> home;
- full search -> result;
- full search -> highlighted passage;
- browser back;
- browser forward;
- reload after transition;
- direct deep link;
- app-shell not-found;
- browser-level 404;
- `/renaissance/` subpath.

Assertions:

- immediate source feedback;
- no blank frame;
- `main` remains readable;
- destination is readable before flourish ends;
- transition classes clear;
- `aria-busy` clears;
- scroll target is intentional;
- focus target is intentional;
- reduced-motion path works;
- back/forward feels native.

Artifacts to review:

- videos for representative transitions;
- traces for the worst lag paths;
- screenshots before/after arrival;
- console output for stuck state warnings.

### Oracle Search Gauntlet

Purpose: prove search feels like an authored oracle while remaining deterministic.

Query categories:

- exact essay title;
- exact section title;
- section subtitle;
- exact body phrase;
- loose remembered phrase;
- punctuation drift;
- curly quote drift;
- typo rescue;
- motif/concept query;
- current essay context;
- current section context;
- continue/resume intent;
- section number intent;
- roman numeral intent;
- no-result query;
- unpublished-content guard.

Assertions:

- expected top result wins;
- ranking reasons match expectation;
- direct matches beat vague expansions;
- current context boosts correctly;
- fuzzy rescue does not overpower exact structure;
- unpublished content does not leak;
- snippets explain the match;
- debug output is useful when ranking surprises us.

Artifacts to review:

- ranking fixture output;
- score explanation logs;
- top rejected candidates for tricky queries;
- full search screenshots for representative queries;
- Spotlight result screenshots/videos for query flow.

### AST Anchor Stability Gauntlet

Purpose: prove result links, copied links, and reader arrivals survive realistic
content edits.

Scenarios:

- paragraph inserted before target;
- paragraph removed before target;
- target paragraph lightly edited;
- target paragraph heavily rewritten;
- repeated paragraph openings;
- duplicated phrase in same section;
- result spanning one paragraph;
- result spanning multiple paragraphs;
- old `q/occ` URL fallback;
- copied payload fallback;
- stale/deleted anchor recovery.

Assertions:

- structural anchor resolves when valid;
- signature fallback recovers when indexes shift;
- offset/range highlight lands correctly;
- stale anchor degrades to a readable section;
- recovery note is quiet and useful;
- copied citation still points somewhere meaningful;
- no unsafe HTML enters highlight/citation output.

Artifacts to review:

- anchor fixture output;
- reader arrival screenshots;
- traces for scroll/highlight timing;
- debug panel/log output when a fallback path is used.

### Spotlight Interaction Gauntlet

Purpose: prove Spotlight feels fast, native, precise, and Renaissance-specific.

Paths:

- open from home;
- open from essay;
- open from section;
- open from search page;
- close with Escape;
- close by route activation;
- type exact query;
- type loose query;
- type action intent;
- activate Continue Reading;
- activate essay;
- activate section;
- activate passage;
- activate full search handoff;
- browser back after activation;
- mobile open/type/activate;
- reduced-motion open/type/activate;
- offline open with cached actions.

Assertions:

- shell opens immediately;
- input receives focus;
- background does not scroll;
- default rows are useful;
- arrow keys move active result;
- Enter activates expected row;
- Escape restores focus;
- result activation uses transition source;
- passage activation lands and highlights;
- mobile layout does not clip behind keyboard;
- no unpublished content appears.

Artifacts to review:

- videos for open/type/activate/close;
- screenshots for default, query, empty, offline, and mobile states;
- trace for focus restoration;
- a11y report for dialog/list semantics.

### PWA And Cache Gauntlet

Purpose: prove generated search/anchor assets do not break offline or update
flows.

Scenarios:

- first uncached load;
- repeat cached load;
- offline after service-worker install;
- offline with search index cached;
- offline without search index cached;
- service-worker update after generated search artifact changes;
- stale cache while new content exists;
- slow-network navigation with cache;
- slow-network navigation without cache.

Assertions:

- cached shell remains readable;
- offline reader still opens cached sections;
- Spotlight offers useful offline actions;
- missing index has an authored fallback;
- cache version changes when required;
- stale-while-revalidate does not mask broken generated data;
- navigation timeout fallback remains bounded.

Artifacts to review:

- PWA test logs;
- service-worker update logs;
- offline screenshots;
- cache artifact summary;
- slow-network traces.

### Accessibility Gauntlet

Purpose: prove the interaction system is excellent for keyboard, screen reader,
reduced-motion, and forced-colors users.

Areas:

- Spotlight dialog semantics;
- search result active descendant or list semantics;
- focus trap and return;
- keyboard-only navigation;
- skip link behavior after route transitions;
- reduced-motion transitions;
- forced-colors visibility;
- screen-reader status updates;
- mobile touch target sizes;
- no hidden unreadable content receiving focus.

Assertions:

- keyboard path completes all major flows;
- focus never disappears;
- Escape always works where expected;
- reduced-motion does not leave stale classes;
- active result is communicated accessibly;
- forced-colors states remain visible;
- axe findings are understood and triaged.

Artifacts to review:

- a11y reports;
- keyboard journey logs;
- focus screenshots where useful;
- forced-colors screenshots if available.

### Security And Safety Gauntlet

Purpose: prove richer search/highlight/citation behavior does not create unsafe
DOM or content leaks.

Checks:

- DOM sink allowlist;
- AST renderer uses DOM/text nodes;
- unsafe links stay literal or blocked;
- snippets escape content;
- highlights do not inject HTML;
- rich clipboard output escapes prose;
- unpublished essays excluded from public search, registry, recovery, feeds,
  sitemap, and Spotlight;
- generated artifacts do not accidentally expose private assumptions beyond the
  documented unlisted-public model;
- workflow permissions remain read-only for manual checks.

Artifacts to review:

- DOM sink regression output;
- unpublished exclusion fixtures;
- generated artifact diff;
- CodeQL results when relevant.

### Visual Beta Gauntlet

Purpose: decide whether the site actually feels good.

Review:

- desktop light;
- desktop dark;
- mobile light;
- mobile dark;
- reader resume;
- section turn;
- search result arrival;
- Spotlight default;
- Spotlight typed query;
- Spotlight empty state;
- Spotlight mobile;
- reduced-motion representative states;
- 404/recovery if touched.

Artifacts:

- visual QA current screenshots;
- visual diff images;
- videos for motion variants;
- notes on accepted/rejected variants.

Rule:

Do not approve a visual baseline just because the diff is expected. Approve it
because the new state is better and matches the sprint bar.

### Performance Gauntlet

Purpose: keep the site fast while making it richer.

Measurements:

- Spotlight open perceived time;
- index load time;
- query response time;
- fuzzy rescue time;
- generated index size;
- service-worker precache size;
- offline payload size;
- page asset weight;
- slow-network route timing;
- transition source-feedback timing.

Assertions:

- Spotlight shell opens before index work can block it;
- query stays responsive on mobile;
- generated search artifacts are size-tracked;
- expensive work is cached, generated, idle, bounded, or deferred;
- no heavy runtime dependency is added casually;
- performance regression is explained before being accepted.

Artifacts to review:

- artifact summary;
- timing logs;
- Lighthouse reports;
- slow-network traces;
- search debug timing.

## Expanded GitHub Actions Suites To Implement

The existing `Manual Checks` workflow is only the starting point. This sprint
should add focused suites for the new risk surfaces instead of treating them as
future nice-to-haves or relying on one giant run.

Suites to implement during this sprint as their underlying systems come online:

- `oracle-search`: generated index, query parser, ranking fixtures, snippets,
  unpublished guards.
- `anchors`: AST anchor generation, reader resolution, copied-link fallback,
  edit-resilience fixtures.
- `transitions`: route motion checks, blank-frame guards, videos/traces for
  representative flows.
- `spotlight`: open/close, keyboard, mobile, reduced-motion, result activation.
- `pwa-cache`: offline, service-worker update, generated search index cache,
  slow-network cache behavior.
- `visual-strict`: non-warning visual diffs once baselines stabilize.
- `crossbrowser-manual`: Chromium, Firefox, and WebKit on demand.
- `a11y-deep`: axe, keyboard journey, focus, forced-colors, reduced-motion.
- `security-content`: DOM sinks, unsafe links, unpublished leaks, generated
  public artifact boundaries.
- `performance`: asset budgets, generated index sizes, query timings,
  transition timing logs.
- `hardening-full`: expensive everything suite for phase closeout.

Safety rules for new suites:

- read-only `contents: read` unless a future workflow explicitly needs more;
- no arbitrary command input;
- whitelist suite names;
- no secrets for PR or manual validation;
- no deploy or Pages publish in hardening workflows;
- `persist-credentials: false` for checkout where practical;
- timeout every job;
- cancel duplicate in-progress runs;
- upload only useful artifacts;
- name artifacts so later sessions know what they contain.

Artifact upload guidance:

- transition suites should upload videos/traces for representative failures and
  optionally for beta-review runs;
- visual suites should upload current/diff/report files;
- oracle suites should upload ranking summaries when fixtures fail;
- anchor suites should upload resolution reports when fixtures fail;
- PWA suites should upload service-worker/cache logs when failures occur;
- performance suites should upload timing and artifact-size summaries.

## Gauntlet Phase Timing

Run gauntlets at increasing intensity:

1. During implementation: narrow suite only.
2. After a workstream lands: relevant family gauntlet.
3. Before Spotlight beta: transition, oracle, anchors, PWA, a11y.
4. Before final declaration: hardening-full, visual beta, cross-browser manual.
5. After merge/deploy: post-deploy smoke and selected live checks.

Do not wait until the end to run every gauntlet. Expensive late failures are
usually a sign that a narrower suite should have existed earlier.

## Failure Triage

When a gauntlet fails:

1. Identify whether it is product behavior, test weakness, environment flake, or
   artifact noise.
2. Inspect artifacts before rerunning.
3. If product behavior is wrong, fix behavior.
4. If the test is weak, improve the test while preserving the real signal.
5. If the artifact is noisy, stabilize capture before approving baselines.
6. If infrastructure flakes, retry once and record it if repeated.
7. If the failure reveals a missing spec decision, update docs before continuing
   implementation.

## Done Criteria

The hardening program is complete when:

- every gauntlet family has either passed or has documented deferred scope;
- key visual/motion artifacts were actually reviewed;
- oracle query fixtures explain ranking decisions;
- anchor fixtures prove realistic edit resilience;
- Spotlight passes keyboard, mobile, reduced-motion, offline, and activation
  checks;
- PWA/cache behavior is understood;
- downstream surfaces share the same search/anchor truth;
- expanded Actions suites exist for the new risk surfaces implemented in this
  sprint;
- known risks and follow-ups are recorded in the sprint doc.
