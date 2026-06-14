# Transition And Spotlight Sprint

This is the live working document for the Renaissance interaction hardening
sprint. It exists so the transition work is not treated as incidental polish and
so future Codex sessions can recover the taste bar, safety rules, workflow, and
open decisions without guessing from scattered chat context.

The document should change as the sprint teaches us more. It is a compass, not a
contract. Prefer updating notes and checklists over silently carrying new
assumptions in an agent thread.

## Live Document Rules

This file is a working control room for the sprint. Keep it current enough that
a new session can resume without chat history.

Update this document when:

- a phase starts or ends;
- a test suite is added;
- a GitHub Actions run gives meaningful signal;
- a visual/video/trace artifact is reviewed;
- a transition motif is accepted or rejected;
- ranking behavior changes;
- anchor URL grammar changes;
- generated artifact shape changes;
- a downstream system is replaced;
- a risk becomes real;
- a scope item is deferred;
- a decision would otherwise live only in memory.

Do not update this document for every tiny edit. Update it when the sprint's
map, evidence, or decision record changes.

### Resume Protocol

At the start of a new work session:

1. Read `Live Findings`.
2. Read `Open Decisions`.
3. Read `Active Phase Journal`.
4. Check `Current Sprint State`.
5. Check the latest git status and branch.
6. Check recent relevant GitHub Actions runs.
7. Continue from the next unchecked phase item unless the user redirects.

### Evidence Standard

For subjective UX work, record what was reviewed. "Tests passed" is not enough
when the question is motion, feel, ranking quality, or visual polish.

Useful evidence records include:

- run id;
- suite name;
- branch/ref;
- artifact names;
- route/query tested;
- viewport/theme/motion mode;
- what felt good;
- what felt wrong;
- decision;
- follow-up.

### Current Sprint State

- Status: Phase 0 baseline/evidence started.
- Current branch: `sprint/transition-spotlight-oracle`.
- Implementation started: evidence/diagnostics only; no product behavior changes
  yet.
- Docs committed: yes, `b187651 docs: define transition spotlight sprint`.
- Branch pushed: yes, tracking `origin/sprint/transition-spotlight-oracle`.
- Latest remote run: Manual Checks `check`, run `27505347555`, in progress at
  Phase 0 start.
- Next recommended action: map current transition, router, reader, search, PWA,
  and test surfaces before changing behavior.

### Active Phase Journal

Use this section during implementation. Move completed phase notes into
`Live Findings` when the phase closes.

```text
Phase: 0 - Baseline And Evidence
Started: 2026-06-15
Goal: understand current transition/search/reader behavior before changes.
Current focus: map transition classes, timing, route paths, and existing tests.
Latest run/artifact: Manual Checks check run 27505347555 on sprint branch.
Blockers: none.
Next action: inspect page-transition, router, section reader, search, PWA, and
test surfaces; record findings before implementation.
```

### Run Log Template

```text
Date:
Run:
Suite:
Branch/ref:
Commit:
Result:
Artifacts:
Reviewed:
Notes:
Next:
```

### Artifact Index Template

```text
Artifact:
Run:
Flow:
Viewport/theme/motion:
Why it matters:
Reviewed by:
Decision:
Follow-up:
```

### Decision Record Template

```text
Decision:
Date:
Context:
Options considered:
Chosen path:
Why:
Tradeoffs:
Follow-up:
```

### Risk Register Template

```text
Risk:
Likelihood:
Impact:
Signal:
Mitigation:
Owner:
Status:
```

### Deferred Scope Template

Deferring scope is allowed, but it must be explicit.

```text
Item:
Why deferred:
What remains safe without it:
What would trigger reopening:
Where tracked:
```

## Branch Workflow And Checkpoints

This sprint should run on:

```text
sprint/transition-spotlight-oracle
```

Do not start implementation work on `main`. Small pre-sprint docs/workflow fixes
may exist on `main`, but the transition/oracle/Spotlight implementation should
live on the sprint branch until it is ready to merge.

### Checkpoint Philosophy

Commit in meaningful checkpoints, not giant end-of-sprint dumps and not noisy
micro-commits that cannot be reviewed.

A good checkpoint:

- has one clear purpose;
- can be described in one sentence;
- leaves the repo in a runnable or intentionally documented state;
- includes tests/docs when the change creates or changes a contract;
- is pushed before expensive GitHub Actions validation;
- records meaningful run/artifact findings in this document when useful.

### Checkpoint Types

- **Docs contract checkpoint**: sprint docs, specs, QA notes, no runtime code.
- **Evidence checkpoint**: diagnostics, test harnesses, artifact capture, no
  product behavior change unless unavoidable.
- **Test checkpoint**: failing or expanded tests that define the bar before a
  fix; allowed when the next checkpoint is expected to make them pass.
- **Transition checkpoint**: focused route/motion behavior change with relevant
  tests/artifacts.
- **Oracle checkpoint**: generated index, query parser, ranking, fixtures, or
  search migration work.
- **Anchor checkpoint**: passage IDs, URL grammar, reader resolution, copied
  link behavior, anchor fixtures.
- **Spotlight checkpoint**: shell, keyboard/focus, actions, search results,
  activation, mobile/reduced-motion.
- **Gauntlet checkpoint**: Actions suite expansion, artifact uploads, broad
  hardening tests.
- **Polish checkpoint**: timing, visual refinement, copy, empty/offline states,
  visual baseline updates.

### When To Push

Push after:

- committing the docs contract;
- adding a new Actions suite;
- adding a test harness that should run remotely;
- landing a transition/search/anchor/Spotlight checkpoint;
- before running expensive Manual Checks;
- before asking for broad review or subagent critique.

Do not push only to "save" half-understood churn unless the work is risky and a
remote backup is useful. If a pushed checkpoint is intentionally incomplete,
record that clearly.

### When To Run Actions

Run the narrowest useful suite after each checkpoint.

Examples:

- docs-only checkpoint: no heavy suite required; optional `check`.
- generated artifact/check script checkpoint: `check` or `standalone`.
- transition checkpoint: `browser`, then targeted visual/video artifacts if
  needed.
- reader/anchor checkpoint: `anchors` once implemented, plus `browser`.
- search ranking checkpoint: `oracle-search` once implemented.
- Spotlight interaction checkpoint: `spotlight` once implemented, plus `a11y`
  for focus/keyboard changes.
- PWA/cache checkpoint: `pwa-cache` once implemented.
- phase closeout: relevant gauntlet family.
- sprint closeout: `hardening-full` plus visual beta/cross-browser as needed.

### Branch Exit Criteria

Before merging the sprint branch:

- docs match shipped behavior;
- implementation phases have run logs or documented exceptions;
- relevant gauntlets have passed or have explicit deferred scope;
- visual/motion artifacts were actually reviewed;
- old URL recovery behavior is known;
- generated artifacts are fresh;
- Actions suite expansion for new risk surfaces exists;
- `main` can receive the merge without hidden local-only assumptions.

Companion specs:

- `docs/specs/ORACLE-SEARCH-SPEC.md`: target AST-native search architecture.
- `docs/specs/AST-ANCHORS-SPEC.md`: stable passage/deep-link anchor model.
- `docs/specs/SPOTLIGHT-UX-SPEC.md`: hidden-index UI and interaction contract.
- `docs/specs/HARDENING-GAUNTLETS-SPEC.md`: post-main hardening passes,
  artifact review, and expanded Actions suites to implement in this sprint.
- `docs/specs/SEARCH-RANKING-SPEC.md`: current legacy search behavior, not a
  compatibility constraint.

## Sprint Objective

Make Renaissance navigation feel immediate, seamless, magical, and reliable
across the archive, essay, reader, search, recovery, cached, offline, reduced
motion, mobile, and GitHub Pages subpath paths. Once the underlying movement
language is trustworthy, build Spotlight Search as the first flagship expression
of that interaction system.

The order matters:

1. Harden page and reader transitions until they feel spotless.
2. Prove that smoothness with automated checks, visual artifacts, and manual
   critique.
3. Build Spotlight on top of the hardened transition system instead of adding
   another interaction layer over rough navigation.

## Product Bar

The sprint target is not "add animation." The target is zero perceived dead
time, no blankness, and a handoff that feels authored.

- A click or tap must acknowledge immediately.
- The current page must stay alive until the destination is ready to carry the
  reader forward.
- The destination must become readable before any flourish finishes.
- Motion must connect states rather than hide latency.
- Slow or uncached conditions must degrade calmly.
- Cached and PWA paths should feel especially fast and book-like.
- The reader should never feel secondary to the interface.

## Non-Negotiables

- No blank frame.
- No full-page fade to an unreadable state.
- No dead wait before visible feedback.
- No stuck transition classes or `aria-busy` state.
- No scroll landing that feels random.
- No focus loss that traps keyboard users.
- No transition that violates `prefers-reduced-motion`.
- No transition that depends on arbitrary timing when a deterministic event is
  available.
- No generic command palette styling for Spotlight.
- No large visual assets or runtime dependencies unless they solve a proven
  problem and survive review.
- No workflow secrets, deploys, or write permissions for manual validation.

## Taste Direction

Renaissance should feel like a precise literary archive rather than a web app
with a page transition library.

Useful motifs:

- marked passage
- index slip
- ledger line
- bookmark
- page rule
- quiet glint
- ink settling
- section turn
- archive card resolving into prose
- hidden index opening

Avoid:

- SaaS command palette defaults
- glass panels
- decorative gradient effects
- oversized motion
- bounce
- game-like flourishes
- animation that competes with prose
- artificial loading screens

## Interaction Principles

### Immediate Acknowledgment

Pointer, keyboard, and touch actions should show a local response immediately.
The user should never wonder whether the action registered.

Examples:

- source link receives an active transition state on pointer down or keyboard
  activation;
- reader section controls acknowledge before content swapping starts;
- Spotlight opens without waiting on a search index rebuild;
- Escape/close actions return focus promptly.

### Alive Source Page

The current page is part of the transition. It should not disappear into a blank
or dimmed shell while waiting for navigation.

The source can:

- mark the activated link;
- draw a line or rule from the action origin;
- soften or shift by a tiny amount;
- keep text readable until commit.

The source should not:

- fade to zero;
- hide `main`;
- expose the canvas without content;
- wait on fetch before showing any feedback.

### Readable Destination First

Destination content should become readable quickly. Arrival animation may settle
afterward, but the prose or target surface should already be usable.

For reader routes, the title/prose should not be hidden behind a decorative
arrival. For search and Spotlight routes, the input and first results should not
wait for a flourish to finish.

### Continuity Over Decoration

Motion is valuable when it explains where the user came from and where they are
going. Decorative motion without spatial or semantic continuity is suspect.

### Native Where Useful

Use normal links, buttons, focus, history, selection, and browser navigation
where possible. Custom behavior is justified only when it improves reader
continuity or site reliability.

## Navigation Paths To Audit

Every path in this section needs at least one explicit decision: covered by an
existing test, needs a new test, needs a manual visual check, or intentionally
out of scope.

- [ ] Home archive -> essay page.
- [ ] Home archive -> section via Continue Reading.
- [ ] Home inline search -> full search.
- [ ] Home inline search -> result target.
- [ ] Essay page -> section reader.
- [ ] Essay inline search -> section result.
- [ ] Section reader -> previous section.
- [ ] Section reader -> next section.
- [ ] Section reader -> essay page.
- [ ] Section reader -> home archive.
- [ ] Section reader -> copied highlight deep link.
- [ ] Full search -> section result.
- [ ] Full search -> highlighted passage.
- [ ] Direct `essay.html?essay=<slug>` load.
- [ ] Direct `section.html?essay=<slug>&section=<n>` load.
- [ ] Direct search URL with query state.
- [ ] Browser back and forward.
- [ ] Reload during or after a transition.
- [ ] App-shell not-found route.
- [ ] Browser-level 404 route.
- [ ] Offline cached navigation.
- [ ] Slow-network first uncached visit.
- [ ] Slow-network cached repeat visit.
- [ ] `/renaissance/` GitHub Pages subpath.
- [ ] Mobile touch navigation.
- [ ] Keyboard-only navigation.
- [ ] Reduced-motion navigation.
- [ ] Forced-colors/high-contrast behavior.

## Spotlight Scope

Spotlight should start only after the transition system is reliable enough that
opening a result feels excellent.

Spotlight is not a wrapper around the current search implementation. It is the
front door to a new oracle-grade search system. Replacing the current search API
is allowed if that produces better ranking, anchors, snippets, tests, and
reader activation.

Initial expectations:

- [ ] `Cmd/Ctrl+K` opens Spotlight.
- [ ] Trigger is discoverable without noisy in-app instruction.
- [ ] Escape closes and restores focus.
- [ ] Enter activates selected item.
- [ ] Arrow keys move selection.
- [ ] Search updates instantly while typing.
- [ ] Continue Reading appears first when relevant.
- [ ] Current essay actions appear before global actions when context exists.
- [ ] Section jumps are available.
- [ ] Full search handoff is available.
- [ ] Mobile presentation is full-screen or otherwise touch-natural.
- [ ] Reduced-motion path is clean.
- [ ] Empty state feels authored.
- [ ] Offline/cached state does not break.
- [ ] Result activation uses the same transition language as the rest of the
      site.

Out of initial scope unless the sprint discovers a strong reason:

- command execution unrelated to reading/search;
- plugin-like action architecture;
- heavy fuzzy-worker architecture;
- decorative generated imagery inside Spotlight;
- persistent user customization.

## Oracle Search Ambition

Search should feel like the archive knows itself without pretending to generate
answers. The user should be able to type a phrase, image, title fragment, motif,
section number, or intent and get a result that feels inevitable.

This likely requires rebuilding search around:

- AST-derived passage records;
- stable passage anchors;
- generated search artifacts;
- deterministic query interpretation;
- contextual ranking;
- curated motif/alias metadata;
- precise snippets;
- robust reader highlight arrival;
- fixtures that assert result order and ranking reasons.

The existing runtime search is a useful reference, not a boundary. If a cleaner
search system needs new modules, generated data, new result shapes, or new URL
grammar, prefer the better system and document migration/recovery behavior.

### Oracle Result Philosophy

The first results should answer "what did the reader probably mean?" without
becoming opaque or fake.

Good top results:

- Continue Reading when the query is empty or resume-like.
- Current essay passages when the user is reading an essay.
- Exact section title when the query names a section.
- Best passage when the query is a remembered image or phrase.
- Section jump when the query is `section 4`, `iv`, or similar.
- Full search handoff when the query needs a broader surface.

Bad top results:

- fuzzy body hit above exact title hit;
- global noise above current essay context;
- many near-identical passage rows;
- a result that exists only because of a vague synonym expansion;
- a row that cannot explain why it matched in debug mode.

### Search Rebuild Workstreams

- [ ] Passage index generator from AST.
- [ ] Search index freshness check.
- [ ] Search artifact size reporting.
- [ ] Stable passage anchor generation.
- [ ] Query parser and normalization.
- [ ] Context/action result generator.
- [ ] Ranking engine with score explanations.
- [ ] Snippet/highlight span generator.
- [ ] Full search page migration.
- [ ] Archive inline search migration.
- [ ] Essay inline search migration.
- [ ] Reader deep-link/highlight migration.
- [ ] Spotlight UI integration.
- [ ] Offline/PWA integration.
- [ ] Fixture suite for oracle behavior.

### No Compatibility Theater

Do not preserve the old search API merely because it exists. Preserve reader
value, public-link recovery, generated artifact discipline, and test confidence.

Allowed changes:

- replace `scripts/search-engine.js`;
- split search into multiple modules;
- change result shapes;
- change search URL parameters;
- replace occurrence-based highlights with AST anchors;
- regenerate data/search artifacts;
- update all search consumers in one coherent sweep.

Required guardrails:

- old reader-facing links degrade gracefully where feasible;
- unpublished essays stay excluded from public search;
- generated artifacts have freshness checks;
- query/ranking behavior has fixtures;
- Spotlight and full search share the same search truth.

## Downstream Perfection Rule

Anything touched by transitions, oracle search, AST anchors, or Spotlight is in
scope for hardening if it affects the final feel. Do not stop at the visible
overlay when the roughness lives downstream.

Downstream surfaces that may be perfected during this sprint:

- full search page layout, controls, ranking, pagination, and empty states;
- archive inline search behavior and handoff to full search;
- essay inline search behavior and current-essay scoping;
- section reader highlight arrival, scroll sightline, focus, and copy tools;
- copied citation and highlight-link URL grammar;
- reading-state Continue Reading actions and resume presentation;
- route parsing/building and query cleanup;
- app-shell recovery suggestions;
- browser-level 404 suggestions where search/anchors intersect recovery;
- generated data, site registry, offline asset manifest, and cache versioning;
- service-worker cached/offline behavior for search data and reader anchors;
- AST text projections, passage IDs, source offsets, and diagnostics;
- visual QA scenarios for search, reader arrival, and Spotlight;
- accessibility behavior across dialog, listbox, focus, keyboard, and reduced
  motion;
- mobile touch layout, viewport behavior, and virtual-keyboard handling;
- docs, fixtures, and debug tooling needed to keep future work precise.

This is permission to pursue quality through the whole chain. It is not
permission for unrelated redesign. The rule is: if the downstream piece makes
Spotlight/search/transitions feel less than excellent, it is eligible for
improvement.

### Downstream Surface Map

Use this map during implementation. Each surface should either be upgraded,
explicitly left alone with a reason, or covered by tests that prove it already
meets the bar.

#### Search Surfaces

- Full search page:
  - result ranking;
  - result grouping;
  - result snippets;
  - pagination or result-window behavior;
  - empty states;
  - search controls;
  - URL state;
  - scope behavior;
  - keyboard focus;
  - mobile layout.
- Archive inline search:
  - instant preview;
  - handoff to full search;
  - current result activation;
  - empty/error copy;
  - consistency with full search ranking.
- Essay inline search:
  - current-essay scope;
  - section/title boosts;
  - passage snippets;
  - result activation into reader anchors;
  - handoff to full search with preserved state.
- Spotlight:
  - default rows;
  - action rows;
  - query result rows;
  - grouping;
  - loading/offline states;
  - activation;
  - focus and keyboard model;
  - mobile sheet.

#### Reader Surfaces

- Section route loading:
  - destination reveal;
  - reader title/meta readiness;
  - content swap behavior;
  - no stale section flashes.
- Search result arrival:
  - scroll target;
  - sightline positioning;
  - highlight timing;
  - highlight styling;
  - focus behavior;
  - recovery if anchor is stale.
- Section prev/next:
  - in-reader section turn feel;
  - no full-page blankness;
  - progress save/restore interaction;
  - source and destination continuity.
- Copy/citation:
  - stable anchor URL;
  - source label;
  - rich text safety;
  - mobile bottom bar;
  - toast/chip feedback.
- Continue Reading:
  - ranking as a Spotlight action;
  - archive presentation;
  - resume target accuracy;
  - completed-section next-step behavior.

#### Routing And Recovery

- Router:
  - URL grammar for anchors and search;
  - query cleanup;
  - subpath safety;
  - history state;
  - back/forward restore.
- App-shell recovery:
  - invalid essay;
  - invalid section;
  - stale passage anchor;
  - missing generated search index;
  - nearest valid section/essay suggestions.
- Browser-level 404:
  - stale search links;
  - stale section links;
  - missing anchor routes;
  - recovery search prefill;
  - offline mode.

#### AST And Content Pipeline

- AST parser:
  - source offsets;
  - stable block ordering;
  - searchable text projection;
  - snippet text projection;
  - diagnostics for unsupported syntax.
- AST rendering:
  - passage IDs;
  - passage signatures;
  - data attributes needed by reader/search;
  - safe DOM construction.
- Corpus tooling:
  - fixture generation;
  - anchor fixture updates;
  - search index reports;
  - authoring diagnostics.
- Content validation:
  - missing metadata;
  - unpublished exclusion;
  - stale generated data;
  - stale search index;
  - stale cache version.

#### Generated Artifacts And PWA

- Generated search index:
  - freshness;
  - deterministic ordering;
  - size budget;
  - unpublished exclusion;
  - cache behavior.
- Embedded data:
  - fallback compatibility where still useful;
  - possible replacement if search index covers the same need better.
- Offline assets:
  - search index inclusion decision;
  - raw text availability;
  - cached section activation;
  - offline Spotlight actions.
- Service worker:
  - cache version changes when generated search assets change;
  - stale-while-revalidate does not hide broken search data;
  - offline navigation stays readable.

#### Visual, Motion, And Interaction

- Cross-page transition:
  - source feedback;
  - destination readability;
  - no blank frames;
  - no late reveal.
- Reader section transition:
  - distinct book-like turn;
  - no scroll fight;
  - no stale progress writes.
- Search-to-reader transition:
  - result row becomes source;
  - passage arrival feels found, not jumped.
- Spotlight open/close:
  - instant shell;
  - focus certainty;
  - no background scroll leak.
- Reduced motion:
  - equivalent state clarity;
  - no hidden content;
  - no broken activation.
- Mobile:
  - touch feedback;
  - virtual keyboard;
  - viewport height;
  - result row tap targets.

#### Accessibility

- Dialog semantics for Spotlight.
- Combobox/listbox or equivalent active-result semantics.
- Focus return on close and activation.
- Keyboard-only route activation.
- Screen-reader result count/status.
- Reduced-motion compliance.
- Forced-colors visibility.
- No focus trap dead ends.
- No background page interaction while Spotlight is modal.

#### Debug And QA Tooling

- Ranking explanations.
- Anchor resolution debug panel or logs.
- Search index size/timing report.
- Transition timing traces.
- Visual QA scenarios.
- Playwright trace/video artifacts.
- Fixture failure output that explains expected versus actual ranking reasons.
- Artifact summary updates for search index and anchor metadata.

### Downstream Replacement Permission

Replace a downstream subsystem when the existing design makes perfection harder
than replacement.

Replacement is allowed for:

- search engine internals;
- search result object shape;
- search page rendering;
- inline search implementations;
- highlight URL grammar;
- reader anchor resolution;
- copy link construction;
- generated data format;
- route query parsing;
- visual QA scenarios;
- test harness utilities.

Replacement should still respect:

- published/unpublished boundaries;
- safe DOM rendering;
- GitHub Pages subpath behavior;
- offline/PWA expectations;
- accessibility expectations;
- generated artifact freshness;
- deterministic fixtures.

### Downstream Done Criteria

A downstream surface is "perfect enough for this sprint" when:

- it uses the same source of truth as Spotlight or documents why it does not;
- its behavior is deterministic and covered by focused tests or artifacts;
- it has a graceful stale/offline/error path;
- it works on mobile, keyboard, and reduced-motion paths;
- it does not add perceptible latency to the critical interaction;
- it does not leak unpublished content;
- it does not rely on unsafe HTML injection;
- it has a clear debug path for future failures;
- it makes the final interaction feel more seamless rather than merely more
  complex.

### Downstream Audit Checklist

- [ ] Full search uses the same oracle truth as Spotlight.
- [ ] Inline search previews use the same ranking semantics as full search or
      document an intentional simplification.
- [ ] Result activation uses stable anchors where available.
- [ ] Reader highlight arrival feels intentional and does not fight scroll
      restore.
- [ ] Copy links and search links share anchor grammar where practical.
- [ ] Continue Reading actions rank and route correctly.
- [ ] Recovery pages do not contradict the oracle index.
- [ ] Offline/cached search behavior is clear and tested.
- [ ] PWA cache version changes when generated search artifacts change.
- [ ] Visual QA covers the new high-value interaction states.
- [ ] A11y tests cover Spotlight and changed search/reader paths.
- [ ] Debug output exists for ranking or anchor surprises.

## Required Plumbing

This sprint needs explicit plumbing, not only UI and search code. Build these
supports as the systems come online so hardening remains observable,
reversible, and testable.

### Instrumentation

Add timing and state instrumentation where it helps diagnose perceived lag,
blankness, search quality, and anchor resolution.

Measure:

- pointer/key activation -> visible source feedback;
- activation -> route commit;
- route commit -> destination readable;
- destination readable -> arrival flourish complete;
- section prev/next activation -> content swap start;
- section prev/next activation -> content readable;
- search query input -> first result set;
- query input -> oracle ranking complete;
- Spotlight shortcut -> shell visible;
- Spotlight shortcut -> input focused;
- Spotlight activation -> destination route commit;
- reader route load -> anchor resolved;
- anchor resolved -> highlight applied;
- service worker navigation timeout/fallback path.

Instrumentation should be quiet by default and visible through debug flags,
test logs, or artifact summaries.

### Artifact Capture

Screenshots are not enough for motion. The sprint should support first-class
capture of:

- Playwright traces for route and Spotlight flows;
- short videos for transition variants;
- screenshots for stable layout states;
- visual diffs for baseline-managed surfaces;
- timing logs for transition/search/anchor milestones;
- ranking explanation reports;
- anchor resolution reports;
- service-worker/cache logs;
- generated artifact summaries.

Actions artifacts should be named clearly enough that a future session can tell
which flow, viewport, theme, motion setting, and suite produced them.

### Schemas And Validators

Generated search and anchor data need structural contracts.

Add schemas or validators for:

- generated search index;
- generated passage records;
- generated essay/section search records;
- search lexicon/motif metadata;
- passage anchor records;
- ranking fixture files;
- query fixture files;
- artifact summary fields if they grow.

Validators should check:

- deterministic ordering;
- required fields;
- stable IDs;
- URL-safe slugs/anchors;
- source offset sanity;
- unpublished exclusion;
- duplicate IDs;
- unsupported lexicon entries;
- size metadata where applicable.

### Freshness Checks

Generated artifacts should fail checks when stale.

Potential generated artifacts:

- `data/search-index.json`;
- `data/search-lexicon.json` if generated or normalized;
- passage anchor metadata;
- offline asset manifest;
- service-worker cache version;
- site registry;
- 404 recovery catalogue;
- discoverability files;
- embedded fallback data if still used.

`npm run check` should eventually include freshness checks for the new generated
search and anchor artifacts.

### Debug Flags

Add debug flags as needed so failures can be diagnosed without editing source.

Candidate flags:

```text
debugTransitions=1
debugSearch=1
debugAnchors=1
debugSpotlight=1
debugPwa=1
```

Debug surfaces may show:

- transition state and timing marks;
- current route parse/build result;
- search index load status;
- parsed query;
- ranking score breakdown;
- top rejected candidates;
- anchor resolution path;
- fallback reason;
- service-worker/cache mode;
- Spotlight active result/focus state.

Debug UI must not ship as noisy visible product UI unless explicitly enabled.

### Feature And Rollback Switches

Large interaction work should have simple rollback levers during the sprint.

Possible switches:

- disable new cross-page transition behavior;
- disable new reader section transition behavior;
- disable Spotlight;
- force legacy/full search route;
- force query occurrence fallback;
- disable generated search index and use runtime fallback if still available;
- disable visual flourish while preserving navigation.

Switches can be query flags, local debug flags, environment-sensitive test
hooks, or small config constants. They should not become a permanent product
settings panel unless there is a real user need.

### Old URL Recovery

Old APIs do not need to survive internally, but old reader-facing URLs should
recover gracefully where feasible.

Recovery paths:

- old `q/occ` search-highlight links;
- copied highlight payload links;
- section URLs without anchors;
- stale paragraph IDs;
- stale generated hit IDs;
- malformed search scope/mode/page parameters;
- old chapter redirect paths;
- GitHub Pages subpath misses.

Recovery should prefer:

1. exact new anchor;
2. signature fallback;
3. payload/text fallback;
4. nearest section/essay;
5. full search prefilled with useful query;
6. archive fallback.

### Actions Suite Expansion

The focused Actions suites in `HARDENING-GAUNTLETS-SPEC.md` are implementation
work for this sprint. Add them as the relevant systems land.

Required suite families:

- oracle search;
- anchors;
- transitions;
- Spotlight;
- PWA/cache;
- visual strict or beta artifacts;
- cross-browser manual;
- a11y deep;
- security/content;
- performance;
- hardening-full.

Each suite should be whitelisted, read-only unless explicitly justified, timed
out, cancellable, and artifact-aware.

### Artifact And Performance Budgets

Track budgets before they become emergencies.

Budget candidates:

- generated search index size;
- generated lexicon size;
- passage anchor metadata size;
- service-worker precache size;
- offline asset payload size;
- shell asset weight;
- Spotlight open timing;
- query response timing;
- fuzzy rescue timing;
- transition source-feedback timing;
- destination-readable timing;
- visual artifact storage size.

Budget tests may start as warning/report-only while values are discovered, then
become gates when the target is stable.

### Decision Log

Record decisions that affect taste, architecture, compatibility, and testing.

Log:

- accepted transition motif;
- rejected transition variants and why;
- Spotlight layout decisions;
- search ranking tradeoffs;
- lexicon/motif expansion rules;
- anchor URL grammar;
- old URL recovery scope;
- generated artifact split/merge decisions;
- performance budget thresholds;
- visual baseline approvals;
- Actions suite additions.

The sprint doc's `Live Findings` and `Open Decisions` sections are the default
home for this log unless a topic deserves its own spec update.

## Testing Strategy

The sprint needs more than unit tests. Smoothness must be tested through a mix
of deterministic assertions, browser artifacts, and human critique.

### Automated Assertions

Use Playwright and focused Node regressions to guard:

- transition classes clear;
- `aria-busy` does not stick;
- body/main opacity remains readable;
- source link feedback appears promptly;
- destination route is correct;
- focus lands predictably;
- scroll position is intentional;
- reduced-motion collapses movement without breaking state;
- slow-network tests do not reveal blank or stuck states;
- service-worker cached paths still navigate;
- subpath routes stay valid;
- search-highlight deep links still resolve.
- oracle search fixtures preserve intended top-result ordering;
- generated passage anchors resolve after controlled content edits;
- Spotlight action rows remain available before the full index finishes loading.

### Visual Artifacts

Use screenshots, traces, and videos when the question is "how does it feel?"
rather than only "did a state bit change?"

Potential artifacts:

- before/after screenshots for each route class;
- Playwright traces for transition timing;
- short videos for section turn and search-result navigation;
- short videos for Spotlight open, type, select, activate, and close;
- visual QA diff report for page surfaces;
- Lighthouse reports as warning signals, not gates.

### Human Critique

Use manual review for taste decisions:

- Does the transition feel like a handoff rather than a delay?
- Does the page feel alive before and after navigation?
- Is the animation too loud for reading?
- Does the section turn feel distinct from archive navigation?
- Does reduced motion still feel intentional?
- Does Spotlight feel like an index, not a generic launcher?

### Subagent Review Passes

If subagents are available, use them after there is code or artifacts to inspect.
Do not use them to replace a coherent owner decision.

Suggested review lanes:

- UX/motion critique: interaction feel, pacing, continuity, taste.
- Accessibility/reduced-motion audit: focus, keyboard, motion preferences,
  screen-reader impact.
- Performance/reliability audit: blank frames, async races, service worker,
  slow network, cache behavior.
- Test coverage audit: missing route paths, weak assertions, artifact gaps.

## Remote Workflow

The local machine has limited disk and should not carry the heavy loop by
default. Prefer GitHub Actions for expensive validation.

This sprint is allowed to hammer GitHub Actions when the feedback is useful.
Use remote runners aggressively for browser, visual, PWA, slow-network,
Lighthouse, dependency, and broad regression checks instead of conserving local
machine resources. The constraint is not "run fewer Actions"; the constraint is
"run intentional suites, read the output, and do not spam identical failures
without learning from them."

### Default Loop

1. Make a small, coherent local change.
2. Run only cheap local checks needed to catch obvious mistakes.
3. Commit.
4. Push to `main` for small safe changes, or a branch for large reversible
   sprint chunks.
5. Trigger the narrowest relevant `Manual Checks` suite.
6. Inspect logs and artifacts.
7. Iterate with another small commit.
8. Periodically run `full-chromium` before declaring a phase done.

### Manual Check Suites

Use:

- `html` for `html-validate` dependency bumps or HTML-only changes.
- `check` for generated artifact freshness and AST/content contracts.
- `standalone` for the non-browser gate.
- `browser` for route, reader, transition, subpath, and not-found behavior.
- `pwa` for offline and service-worker behavior.
- `a11y` for accessibility, focus, and keyboard.
- `devices` for mobile/tablet/slow-network behavior.
- `visual` for screenshot diff review.
- `lighthouse` as a warning signal.
- `full-chromium` for a broad pre-finish sweep.

### Local Discipline

- Do not install new browser bundles locally unless explicitly approved.
- Avoid large writes to the C drive.
- Keep local runs focused.
- Do not rely on local-only behavior for final confidence.
- Keep the working tree clean between phases where possible.

## Branch And Commit Policy

The user is the only contributor and prefers direct `main` commits for small,
reversible changes. Use branches for large sprint chunks that need explanation,
review, or easy rollback.

Good direct-to-main changes:

- docs updates;
- focused test additions;
- tiny workflow hardening;
- narrow bug fixes with obvious scope.

Good branch candidates:

- transition system rewrite;
- Spotlight implementation;
- large `section.js` split;
- visual language overhaul;
- generated asset pipeline changes.

Suggested commit style:

- `docs(ux): define transition sprint bar`
- `test(transitions): guard blank-free navigation`
- `fix(transitions): keep destination readable on arrival`
- `feat(spotlight): add hidden index launcher`
- `refactor(reader): extract highlight link helpers`

## Refactor Rules

Refactoring is allowed, but it should serve the interaction work.

Prefer extraction when:

- duplicated behavior appears across Spotlight/search/archive/reader;
- tests are hard to write because a module has too many concerns;
- a bug is caused by tangled state ownership;
- `section.js` changes become risky due to unrelated behavior sharing scope.

Avoid extraction when:

- it is purely aesthetic;
- it delays transition fixes without reducing risk;
- it creates a new abstraction not used by the sprint;
- it splits files but preserves the same hidden coupling.

Likely extraction candidates:

- section transition state;
- highlight/deep-link resolution;
- selection sharing and citation;
- Spotlight/search result action building;
- shared route/action helpers;
- transition test helpers.

## Asset And Prototype Strategy

The sprint may generate more assets and prototypes, but shipped assets should
remain quiet and light.

Good uses:

- temporary transition prototype pages;
- visual comparison artifacts;
- small texture/rule/glint assets if CSS cannot achieve the right feel;
- generated social/OG assets for published content;
- QA screenshots and videos;
- fixture scenarios for route and motion states.

Risky uses:

- large decorative images;
- heavy animation libraries;
- effects that make prose secondary;
- assets that bloat reader navigation;
- visuals that do not survive reduced-motion or mobile review.

Promotion rule:

Prototype freely, ship sparingly. Keep the final motion language mostly in
timing, spatial continuity, typography, line work, and subtle state changes.

## Beta-Testing Protocol

This sprint should beta-test motion and Spotlight with more care than ordinary
feature work.

For each serious transition or Spotlight variant:

1. Capture the relevant path on desktop.
2. Capture the relevant path on mobile.
3. Capture reduced-motion behavior.
4. Run or inspect slow-network behavior if the path touches loading.
5. Save or upload artifacts when the difference is visual.
6. Record what felt better, worse, or uncertain.
7. Keep the variant only if it improves the product bar.

Questions to answer during beta review:

- Did the action acknowledge immediately?
- Did anything blank, flash, or feel late?
- Did the source and destination feel connected?
- Was the animation beautiful because it helped, or just because it moved?
- Did the reader remain the center?
- Did the result feel oracle-like or merely matched?
- Did keyboard/touch/reduced-motion users get a first-class path?

Use subagents as reviewers when artifacts exist, especially for motion critique,
accessibility, performance, and test coverage. Their job is to find gaps and
taste failures, not to create a fragmented design direction.

## Phase Plan

### Phase 0: Baseline And Evidence

Goal: understand the current transition feel and failure modes before changing
motion.

- [ ] List current transition code paths and state classes.
- [ ] Capture current route transition videos or traces.
- [ ] Identify the worst perceived-lag paths.
- [ ] Check normal, reduced-motion, mobile, slow-network, cached, and subpath
      behavior.
- [ ] Record findings in this document.

Phase 0 evidence to capture:

- current transition state/class diagram;
- current timing constants;
- current route flow notes;
- current worst-lag hypotheses;
- representative screenshots/videos/traces if available;
- current relevant Actions run ids.

Phase 0 exit criteria:

- roughness is described specifically by path;
- test/artifact gaps are known;
- first implementation target is chosen;
- no major transition rewrite has started without evidence.

### Phase 1: Acceptance Tests

Goal: build enough test coverage that animation changes cannot reintroduce
blanking, stuck states, or unreadable transitions.

- [ ] Add or strengthen blank-free navigation assertions.
- [ ] Add source-feedback timing assertions where deterministic.
- [ ] Add section prev/next readability assertions.
- [ ] Add back/forward assertions.
- [ ] Add search-result-to-highlight assertions.
- [ ] Add reduced-motion assertions.
- [ ] Add slow-network cached/uncached expectations where useful.
- [ ] Decide which visual artifacts should upload in Actions.

Phase 1 evidence to capture:

- new/changed test names;
- what each test prevents;
- whether tests are strict gates or warning/artifact checks;
- Actions suite used to prove them.

Phase 1 exit criteria:

- blank/stuck/unreadable regressions have automated guards;
- slow-network and reduced-motion expectations are explicit;
- artifact capture strategy is decided for transition beta work.

### Phase 2: Transition Language Prototypes

Goal: explore several motion treatments quickly before committing to one.

- [ ] Define candidate motifs.
- [ ] Prototype at least one archive/essay transition.
- [ ] Prototype at least one reader section turn.
- [ ] Prototype at least one search-result-to-prose handoff.
- [ ] Compare against the product bar.
- [ ] Keep notes on rejected variants and why.

Phase 2 evidence to capture:

- prototype names;
- route paths tested;
- videos/screenshots/traces reviewed;
- accepted/rejected notes;
- final chosen motif or decision to simplify.

Phase 2 exit criteria:

- chosen transition direction is recorded;
- rejected variants have reasons;
- implementation target is small enough to ship safely.

### Phase 3: Production Transition Hardening

Goal: ship the chosen transition language through real routes.

- [ ] Ensure immediate input acknowledgment.
- [ ] Preserve readable source content until commit.
- [ ] Reveal destination before flourish completes.
- [ ] Tune section prev/next separately from cross-page navigation.
- [ ] Preserve focus and scroll semantics.
- [ ] Keep reduced-motion elegant.
- [ ] Keep cached/offline behavior stable.
- [ ] Run relevant manual suites and record run IDs.

Phase 3 evidence to capture:

- changed files/modules;
- transition timing before/after where measurable;
- routes manually/artifact-reviewed;
- run ids;
- known remaining rough spots.

Phase 3 exit criteria:

- audited navigation paths are blank-free;
- section turn and cross-page transition decisions are documented;
- reduced-motion, mobile, subpath, slow-network, and cached paths are not
  broken;
- relevant gauntlet families pass or have documented exceptions.

### Phase 4: Critique And Beta Pass

Goal: stress the feel before starting Spotlight.

- [ ] Review artifacts manually.
- [ ] Use subagent critique if available.
- [ ] Test desktop and mobile viewports.
- [ ] Test keyboard and touch paths.
- [ ] Test slow-network and cached paths.
- [ ] Tune durations, easing, and visual weight.
- [ ] Update this document with final transition decisions.

Phase 4 evidence to capture:

- reviewed artifact list;
- critique notes;
- subagent findings if used;
- final motion tuning decisions;
- remaining issues accepted or deferred.

Phase 4 exit criteria:

- transition system feels ready to support Spotlight;
- subjective review notes exist;
- no major known motion defect is being carried into Spotlight.

### Phase 5: Oracle Search Foundations

Goal: build the search substrate that makes Spotlight feel like an oracle
instead of a modal around substring matching.

- [ ] Design generated passage index shape.
- [ ] Generate AST-derived passage records.
- [ ] Generate essay and section search records.
- [ ] Add index freshness checks.
- [ ] Add artifact size reporting.
- [ ] Add unpublished-content exclusion checks.
- [ ] Add query parser and normalization fixtures.
- [ ] Add ranking engine with score explanations.
- [ ] Add ranking fixtures for exact, loose, fuzzy, contextual, and concept
      matches.
- [ ] Add debug output for top-result reasoning.
- [ ] Decide whether `data/search-index.json` is one artifact or split by
      concern.

Phase 5 evidence to capture:

- generated artifact shape;
- schema/validator decisions;
- fixture catalog;
- ranking examples;
- artifact size/timing;
- unpublished exclusion proof.

Phase 5 exit criteria:

- generated index exists or a deliberate alternative is documented;
- ranking fixtures prove top-result behavior;
- search debug output can explain surprising results;
- generated artifact freshness is checked.

### Phase 6: AST Anchors And Search Surface Migration

Goal: make existing reader/search surfaces benefit from the oracle engine before
Spotlight becomes the main entry point.

- [ ] Generate stable passage anchors.
- [ ] Render passage anchor metadata in reader content.
- [ ] Teach reader routes to resolve passage anchors.
- [ ] Add range/offset highlight support where needed.
- [ ] Preserve fallback for old query/occurrence links where feasible.
- [ ] Upgrade full search to oracle results.
- [ ] Upgrade archive inline search.
- [ ] Upgrade essay inline search.
- [ ] Update copy/citation links if stable anchors are ready.
- [ ] Update service-worker/offline assets if generated search data is cached.
- [ ] Run remote suites for search, browser, PWA, a11y, and subpath behavior.

Phase 6 evidence to capture:

- anchor URL grammar decision;
- reader resolution order implementation notes;
- old URL recovery behavior;
- full/inline search migration notes;
- copied link behavior;
- PWA/cache decision.

Phase 6 exit criteria:

- existing search surfaces share the oracle truth;
- reader anchors resolve and recover;
- old reader-facing links degrade gracefully where feasible;
- offline/cache behavior is documented and tested.

### Phase 7: Spotlight Design

Goal: specify Spotlight in Renaissance terms before implementation.

- [ ] Define opening/closing behavior.
- [ ] Define result grouping.
- [ ] Define current-context actions.
- [ ] Define Continue Reading presentation.
- [ ] Define keyboard and mobile behavior.
- [ ] Define empty/error/offline states.
- [ ] Define result activation transitions.
- [ ] Define tests.

Phase 7 evidence to capture:

- UI sketch or verbal layout decision;
- default row order;
- grouping decision;
- keyboard model;
- mobile model;
- empty/offline state decision;
- activation transition decision.

Phase 7 exit criteria:

- Spotlight can be implemented without inventing product behavior ad hoc;
- any unresolved design decision is explicitly listed in Open Decisions.

### Phase 8: Spotlight Implementation

Goal: build Spotlight as a production interaction, not a generic overlay.

- [ ] Add shell markup and styling.
- [ ] Add open/close/focus behavior.
- [ ] Add search and action model.
- [ ] Add keyboard navigation.
- [ ] Add mobile layout.
- [ ] Add route activation.
- [ ] Add reduced-motion handling.
- [ ] Add tests.
- [ ] Run manual suites.

Phase 8 evidence to capture:

- open/type/activate/close artifacts;
- keyboard test results;
- mobile screenshots/videos;
- reduced-motion proof;
- oracle result examples;
- activation route proof.

Phase 8 exit criteria:

- Spotlight passes core interaction tests;
- default rows feel useful;
- query rows feel oracle-like;
- activation uses hardened transitions;
- downstream roughness exposed by Spotlight is fixed or explicitly recorded.

### Phase 9: Final Sweep

Goal: leave the repo better documented and easier to resume.

- [ ] Run broad remote validation.
- [ ] Review visual/Lighthouse artifacts.
- [ ] Run the relevant hardening gauntlets from
      `docs/specs/HARDENING-GAUNTLETS-SPEC.md`.
- [ ] Record which screenshots, videos, traces, ranking reports, and anchor
      diagnostics were reviewed.
- [ ] Confirm focused Actions suites exist for the sprint's new risk surfaces:
      oracle search, anchors, transitions, Spotlight, PWA/cache, a11y,
      security/content, performance, and hardening-full.
- [ ] Update docs/architecture/QA if behavior changed.
- [ ] Update roadmap checkboxes.
- [ ] Record final manual run IDs.
- [ ] Record known follow-ups.

Phase 9 evidence to capture:

- final run list;
- artifact review summary;
- accepted visual baseline notes;
- remaining risks;
- deferred scope;
- release/merge notes.

Phase 9 exit criteria:

- sprint docs match shipped behavior;
- gauntlet results are recorded;
- follow-ups are explicit;
- repo is in a clean, reviewable state.

## Acceptance Checklist

Use this before declaring the transition portion done.

- [ ] Every audited navigation path has a pass/fail note.
- [ ] No path blanks the page.
- [ ] No path leaves transition classes stuck.
- [ ] No path hides readable content behind animation.
- [ ] Back/forward feels native.
- [ ] Section prev/next feels faster and more book-like than full navigation.
- [ ] Search-result deep links land cleanly and highlight correctly.
- [ ] Mobile touch feedback is immediate.
- [ ] Keyboard flow is intact.
- [ ] Reduced-motion path is quiet and complete.
- [ ] Slow-network path is calm.
- [ ] Cached/PWA path is excellent.
- [ ] `/renaissance/` subpath remains safe.
- [ ] CI/manual checks cover the risk surfaces.
- [ ] Visual artifacts have been reviewed.

Use this before declaring Spotlight done.

- [ ] Oracle search index is generated from AST.
- [ ] Search freshness checks are part of `npm run check`.
- [ ] Ranking fixtures assert top-result order and reasons.
- [ ] Passage anchors resolve in the reader.
- [ ] Existing full/inline search surfaces use the new search truth.
- [ ] Old reader-facing search links recover where feasible.
- [ ] Unpublished essays remain excluded.
- [ ] Search index/cache behavior is documented.
- [ ] Opens with `Cmd/Ctrl+K`.
- [ ] Closes with Escape and returns focus.
- [ ] Keyboard navigation is predictable.
- [ ] Mobile layout is usable.
- [ ] Results update quickly.
- [ ] Continue Reading and contextual actions are first-class.
- [ ] Search results route correctly.
- [ ] Empty/offline/error states feel authored.
- [ ] Activation uses hardened transitions.
- [ ] Tests cover open/close, keyboard, routing, reduced motion, and mobile.

## Live Findings

Add dated notes here as the sprint proceeds.

### 2026-06-14

- Manual `Manual Checks` workflow exists on `main` and the `html` suite passed
  once after landing.
- The next implementation work should begin with transition diagnostics and
  tests, not Spotlight UI.

### 2026-06-15

- Sprint planning expanded from transition + Spotlight into a broader
  transition/oracle-search/AST-anchor/downstream-hardening program.
- Old search API compatibility is not a constraint; public reader-facing
  recovery remains important.
- Expanded Actions suites are part of the sprint implementation, not deferred
  wishlist work.
- Artifact review is mandatory where it teaches something: traces, screenshots,
  videos, ranking reports, anchor diagnostics, and generated artifact summaries.
- Next implementation work should happen on a sprint branch.
- Sprint branch `sprint/transition-spotlight-oracle` created, pushed, and set to
  track `origin/sprint/transition-spotlight-oracle`.
- Phase 0 baseline/evidence started. No product behavior changes yet.

## Run Log

Use the run log for meaningful CI/manual validation runs. Do not record every
tiny local command.

```text
Date: 2026-06-15
Run: 27505347555
Suite: Manual Checks / check
Branch/ref: sprint/transition-spotlight-oracle
Commit: b187651
Result: in progress at Phase 0 start
Artifacts: none expected
Reviewed: pending run completion
Notes: branch publication and lightweight remote validation for docs contract
Next: inspect result after baseline mapping begins
```

## Artifact Review Log

Use this when reviewing screenshots, videos, traces, ranking reports, anchor
diagnostics, or visual diffs.

```text
Date:
Artifact:
Run:
Flow/query:
Viewport/theme/motion:
Reviewed:
Decision:
Follow-up:
```

## Decision Log

Use this for decisions that affect implementation direction.

```text
Date:
Decision:
Context:
Chosen path:
Rejected alternatives:
Tradeoffs:
Follow-up:
```

## Deferred Scope

Anything intentionally deferred from this sprint should be listed here.

```text
Item:
Why deferred:
Safe because:
Reopen when:
Tracking:
```

## Open Decisions

- [ ] Should reader section turns use a separate in-page transition language
      from cross-page navigation?
- [ ] Should cross-page navigation keep the current line/glint motif, replace
      it, or make it more contextual?
- [ ] Should we prototype with a temporary route/motion lab page?
- [ ] Which artifacts should be uploaded for routine transition beta-testing:
      screenshots, videos, traces, or all of them?
- [ ] How strict should slow-network timing assertions be for uncached first
      visits versus cached repeat visits?
- [ ] Should Spotlight ship in one sprint after transitions, or begin as an
      experimental hidden feature behind keyboard access only?
- [ ] Should oracle search use one generated `data/search-index.json` artifact
      or split passage, term, and metadata files?
- [ ] Should public passage URLs expose simple paragraph IDs or opaque generated
      anchor IDs?
- [ ] How much authored lexicon/motif metadata should ship in the first oracle
      version?
- [ ] Should full search keep explicit modes after oracle ranking lands, or
      become simpler and more Spotlight-like?

## Known Risks

- Subjective smoothness cannot be fully automated.
- More animation can easily create more perceived lag.
- Cross-browser motion behavior may differ.
- Service worker cache behavior can hide or reveal transition bugs depending on
  install state.
- Visual artifacts can become noisy if baselines are unstable.
- `section.js` is large and can make reader changes risky.
- Spotlight may tempt broad command-palette scope creep.

## Recovery Plan

If a change makes the site feel worse:

1. Revert the smallest transition-specific commit if possible.
2. Preserve tests that caught a real regression.
3. Record the failed motif or approach in this document.
4. Prefer a simpler readable transition over an impressive fragile one.

If remote Actions fail because of infrastructure:

1. Check whether the suite is too broad for the failure.
2. Retry once if the failure is clearly external.
3. Inspect logs/artifacts before changing code.
4. Narrow the suite and reproduce the specific failure path.

If local disk pressure becomes a blocker:

1. Stop local heavy runs.
2. Commit/push small changes.
3. Use manual checks remotely.
4. Avoid dependency installs or browser downloads locally unless explicitly
   approved.
