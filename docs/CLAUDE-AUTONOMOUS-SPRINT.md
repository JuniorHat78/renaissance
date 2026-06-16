# Claude Autonomous Sprint Brief

This document is the operating brief for a one-shot unattended Claude Code run.
It is intentionally explicit. The goal is not only to give Claude the next task;
the goal is to keep a long autonomous session productive, bounded, recoverable,
and aligned with the project's taste bar even if the session runs until quota
exhaustion.

Read this file first, then read `docs/TRANSITION-SPOTLIGHT-SPRINT.md`, then
inspect the actual code before editing. The sprint document is the broader
control room. This file is the overnight execution contract.

## Non-Negotiable Mission

Continue the `sprint/transition-spotlight-oracle` branch from the current HEAD
and push useful work in small, recoverable checkpoints.

The target branch is:

```text
sprint/transition-spotlight-oracle
```

This branch is expected to back draft PR #12. Pushing commits to the branch will
update the draft PR automatically. When meaningful checkpoints land, also keep
the PR readable for the human waking up later:

```bash
gh pr view 12 --repo JuniorHat78/renaissance
gh pr edit 12 --repo JuniorHat78/renaissance --body-file <updated-body-file>
gh pr comment 12 --repo JuniorHat78/renaissance --body "<checkpoint summary>"
```

Do not spam the PR after every tiny commit. Use PR comments or body updates for
phase-level checkpoints, remote validation results, blockers, and final resume
notes. If editing the PR body, preserve useful existing context rather than
replacing it with a shallow summary.

The expected starting HEAD when this brief was written is:

```text
2943b52 refactor: carve essay + section controllers into mountable views (A-phase, 1/4)
```

If the branch has moved, do not panic. Read the new commits, update your mental
state, and continue from the newest remote branch state. Do not reset or discard
work.

## Repository Context

Renaissance is a static long-form essay site. It is not a generic app shell. It
is a book-like reader with search, passage anchors, reading state, transitions,
offline support, and a growing "reading instrument" direction.

Important routes:

```text
index.html
essay.html?essay=<essay-slug>
section.html?essay=<essay-slug>&section=<section-number>
search.html?q=<query>
```

Current public essay:

```text
Etching God into Sand
```

Deployment path:

```text
/renaissance/
```

Assume relative links and GitHub Pages subpath behavior matter.

## Current State Summary

The following systems are already built and should not be re-litigated:

- Oracle search end-to-end.
- Full search, Spotlight, essay-inline search, and archive/home inline search
  route through the shared oracle path.
- Continuity transition: clicked words from search results can fly into the
  reader highlight.
- Composed arrival: page reveal is gated by content readiness under a paper veil.
- Reading-attention progress model: attention, not scroll-to-end, drives archive
  progress, resume, and completion.
- Advanced search: "Show everything" exposes uncapped per-passage results and
  ranking reasons.
- First A-phase groundwork: `scripts/essay.js` and `scripts/section.js` now
  expose mountable view controllers.

The latest completed checkpoint is the A-phase view-controller carve-out:

- `scripts/essay.js` exports `window.RenaissanceEssayView = { mount, unmount }`.
- `scripts/section.js` exports `window.RenaissanceSectionView = { mount, unmount }`.
- Both views still self-mount once at page load.
- The soft-navigation reading shell has not yet been implemented.

## Important Files

Read these before changing behavior:

```text
docs/TRANSITION-SPOTLIGHT-SPRINT.md
docs/CLAUDE-AUTONOMOUS-SPRINT.md
package.json
section.html
essay.html
scripts/page-transition.js
scripts/continuity.js
scripts/router.js
scripts/essay.js
scripts/section.js
scripts/reading-state.js
scripts/reading-attention.js
scripts/oracle-client.js
scripts/search-oracle.js
styles/main.css
sw.js
```

Read relevant tests before adding or changing behavior:

```text
scripts/tests/page-transition-regression.js
scripts/tests/continuity-regression.js
scripts/tests/passage-alignment-regression.js
scripts/tests/spotlight-regression.js
scripts/tests/reading-attention-regression.js
scripts/tests/reading-state-unit-regression.js
scripts/tests/cross-browser-regression.js
scripts/tests/a11y-regression.js
scripts/tests/device-matrix-regression.js
scripts/tests/slow-network-regression.js
```

## Workflow Rules

Commit and push frequently. This is mandatory.

The unattended run may be stopped by quota, timeout, runner failure, or a test
failure. A checkpoint is only useful if it has been pushed.

Prefer small banked commits over a large private diff. If a coherent unit of
work is complete, commit it even if the larger phase is not done yet. Good
commit boundaries include:

- one pure helper or module plus its focused tests;
- one view-lifecycle refactor;
- one soft-nav behavior slice;
- one regression test addition;
- one bug fix found while wiring a larger feature;
- one docs/evidence update after a validation result;
- one generated-artifact/cache-version update paired with the source change
  that required it.

As a rough rule, do not carry more than 30-45 minutes of useful work uncommitted
unless you are in the middle of an indivisible edit. If in doubt, checkpoint.

Use conventional commits. Examples:

```text
feat: add soft-navigation reading shell
test: cover same-document reader navigation
fix: preserve reader state across soft-nav swaps
docs: record A-phase soft-nav evidence
```

Do not include Claude attribution, "generated by Claude", co-author trailers, or
AI provenance text in commits, docs, UI, or PR comments.

Before any commit:

1. Run the narrowest relevant validation.
2. Inspect `git diff`.
3. Ensure the commit is focused.
4. Commit.
5. Push to `origin/sprint/transition-spotlight-oracle`.

After phase-level checkpoints, update draft PR #12 with the current state:

- latest completed checkpoint;
- validation commands and GitHub Actions run IDs;
- known failures or flakes;
- exact next task if the run stops;
- any risky decisions deferred for human review.

After any change to a precached asset, run:

```bash
node scripts/generate-cache-version.js
```

Precaching touches are likely when editing:

```text
section.html
essay.html
index.html
search.html
404.html
scripts/*.js
styles/*.css
sw.js
```

Do not treat the current asset budget as real. The section budget was parked at
an intentionally absurd value so sprint work could continue. The real follow-up
is the physical `section.js` split.

## Validation Philosophy

Use GitHub Actions aggressively when it helps. The Linux runner is the better
authority for browser-heavy suites than the local laptop, and this unattended run
is allowed to spend Actions runs to get signal.

Still run focused local commands inside the runner before committing. Prefer the
smallest suite that proves the checkpoint.

Useful commands:

```bash
npm run check
npm run ci:standalone
npm run test:reading-attention
npm run test:reading-state-unit
npm run ci:page-transitions
npm run ci:continuity
npm run ci:passage-alignment
npm run ci:regression
npm run ci:a11y
npm run ci:devices
npm run ci:slow-network
```

If browser dependencies are missing on the runner, install Chromium:

```bash
npx playwright install --with-deps chromium
```

Do not burn time trying to make every broad suite green after every tiny edit.
Use focused tests per checkpoint, then broader suites after behavior-changing
milestones.

When a checkpoint changes navigation, transitions, service-worker behavior,
route parsing, rendering, focus, or accessibility, it is acceptable and expected
to hammer the existing Actions workflows for evidence. Use `gh` if available.

Useful remote validation flow:

```bash
git push origin sprint/transition-spotlight-oracle
gh workflow run "Manual Checks" --ref sprint/transition-spotlight-oracle -f suite=standalone
gh workflow run "Manual Checks" --ref sprint/transition-spotlight-oracle -f suite=browser
gh workflow run "Manual Checks" --ref sprint/transition-spotlight-oracle -f suite=transition-evidence
gh workflow run "Manual Checks" --ref sprint/transition-spotlight-oracle -f suite=spotlight
gh workflow run "Manual Checks" --ref sprint/transition-spotlight-oracle -f suite=a11y
gh workflow run "Manual Checks" --ref sprint/transition-spotlight-oracle -f suite=devices
```

Choose the suites that match the change. For a large A-phase checkpoint,
`standalone`, `browser`, `transition-evidence`, `spotlight`, `a11y`, and
`devices` are all fair game. If the change touches offline or precache behavior,
include `pwa`.

After dispatching remote runs:

1. Use `gh run list` to find the run IDs.
2. Use `gh run watch <run-id>` when it is worth waiting.
3. Use `gh run view <run-id> --log-failed` for failures.
4. Fix real failures in follow-up commits.
5. Record meaningful remote results in `docs/TRANSITION-SPOTLIGHT-SPRINT.md`.

Do not let remote validation become passive waiting if there is useful local
work that can proceed safely. Start a remote suite, then continue with the next
independent doc/test/refactor slice if the tree is clean and the next work will
not invalidate the run's signal.

## Locked Decisions

Do not change these without explicit user direction:

- The reader's visual progress bar remains scroll-position. It answers "where
  am I on the page?"
- Archive/resume/completion progress remains attention-based. It answers "what
  did I actually read?"
- Do not add footnotes, sidenotes, editorial apparatus, or fabricated scholarly
  scaffolding. The essays are continuous prose.
- Use custom FLIP / project-native transition logic, not native View
  Transitions, because Firefox support matters.
- Search results stay passage-oriented, not occurrence-spam-oriented.
- Keep the oracle path as the ranking source of truth.
- Keep Node+browser dual-export patterns for pure modules where this project
  already uses them.
- Do not introduce a build step.
- Do not turn the site into a dashboard or generic SaaS interface.

## Taste Bar

The standard is not "more animation." The standard is less perceived lock-up,
more continuity, more legibility, and a reader that feels physically coherent.

When choosing between a simpler transition that always reads clearly and a more
impressive transition that risks lag or confusion, choose the simpler one.

Only add texture when it helps the continuity story. Texture that merely calls
attention to itself is wrong for this site.

## A-Phase Goal

The next concrete work is the A-phase:

1. Soft-navigation reading shell.
2. Same-document continuity.
3. Magic texture polish.
4. Evidence, tests, docs, and checkpoint commits.

The residual "tinge of lock-up" is caused by hard document navigation. The fix
is to make essay-to-section and section-to-essay navigation soft where it can be
done safely: fetch or otherwise obtain the target document, swap the relevant
reader shell DOM, update history, remount the correct view controller, and keep
the continuity transition in one document.

## A-Phase Checkpoint 1 Already Done

Checkpoint 1 is already complete at the expected starting HEAD:

```text
2943b52 refactor: carve essay + section controllers into mountable views (A-phase, 1/4)
```

Do not redo it. Verify it, then build on it.

What it established:

- Essay page controller is mountable/unmountable.
- Section reader controller is mountable/unmountable.
- DOM refs are re-queried per mount.
- Global listeners are tied to `AbortController` lifecycle signals.
- Timers, selection state, reading attention heartbeat, and progress state are
  cleaned up on unmount.

## A-Phase Checkpoint 2: Soft-Navigation Reading Shell

Implement a small, explicit soft-navigation shell for the reading journey.

Target behavior:

- Same-origin navigation among `essay.html` and `section.html` can be intercepted.
- The shell fetches or otherwise loads the destination document.
- It extracts the compatible page body / main shell.
- It swaps the current document's relevant DOM.
- It updates `document.title`, canonical/meta tags where needed, and browser
  history.
- It dispatches a route event so the correct view remounts.
- It falls back to hard navigation on any uncertainty.

Suggested name:

```text
scripts/reading-shell.js
window.RenaissanceReadingShell
```

Do not make this a broad SPA framework. It should be a narrow reading-shell
adapter for the existing static pages.

Likely shell responsibilities:

1. Detect eligible links.
2. Ignore modified clicks, downloads, external links, new-tab targets, and
   elements with explicit opt-out.
3. Fetch the destination HTML.
4. Parse it with `DOMParser`.
5. Extract the destination main/page content needed for `essay.html` or
   `section.html`.
6. Swap the current DOM with minimal churn.
7. Call the current view's `unmount()`.
8. Mount the destination view via `RenaissanceEssayView.mount()` or
   `RenaissanceSectionView.mount()`.
9. Dispatch `renaissance:route`.
10. Dispatch `renaissance:page-ready` at the right time for composed arrival.
11. Preserve back/forward using `popstate`.
12. On failure, assign `window.location.href` to the destination URL.

Be conservative about what gets swapped. The existing page scripts are loaded
by the original document. Do not rely on re-executing script tags from fetched
HTML. The point of the mounted view exports is to avoid script re-execution.

You may need a common shell wrapper in both `essay.html` and `section.html`.
Keep it small.

If the destination route is not `essay` or `section`, let existing hard
navigation handle it unless a safe route is obvious.

Validation for Checkpoint 2:

```bash
npm run check
npm run ci:page-transitions
npm run ci:regression
```

Add or extend a focused regression if current coverage cannot prove:

- essay -> section does not do a hard reload;
- section -> essay does not do a hard reload;
- back/forward work;
- title/meta/canonical update;
- focus lands somewhere sane;
- reduced-motion does not get a hidden/stuck page;
- failure falls back to hard navigation.

Commit and push after this checkpoint.

## A-Phase Checkpoint 3: Same-Document Continuity

Once soft-navigation keeps the journey in one document, continuity can become
cleaner.

Target behavior:

- A clicked search result / passage link can preserve source geometry.
- The destination reader highlight can be resolved after the soft swap.
- The continuity mark flies in the same document rather than across a hard page
  load boundary.
- The existing hard-navigation continuity path remains as fallback.
- Reduced motion remains quiet and immediate.

Relevant file:

```text
scripts/continuity.js
```

Existing constraints:

- Continuity currently listens for `renaissance:page-revealed`.
- `page-transition.js` owns composed reveal for hard navigation.
- The soft shell must either dispatch equivalent events or expose a narrower
  event that continuity can consume.

Do not break current hard-load behavior. Soft-nav is an enhancement.

Validation for Checkpoint 3:

```bash
npm run ci:continuity
npm run ci:passage-alignment
npm run ci:page-transitions
```

If the existing continuity regression only covers hard navigation, extend it to
cover the soft path.

Commit and push after this checkpoint.

## A-Phase Checkpoint 4: Magic Texture

Only after the correctness path is stable, add restrained texture.

Allowed ideas:

- A true-spring `linear()` easing variable for existing compose-in motion.
- Subtle depth scale on compose-in.
- A small landing shimmer on the continuity target.
- A word-level glint/shimmer only if it reinforces arrival and does not compete
  with selection/copy/highlight states.

Cut idea from prior discussion:

- Do not add a blur/luminosity veil dissolve over `main` during the continuity
  flight unless you can prove it does not blur the flying mark or fight
  `page-main-in`. The prior analysis found a real conflict risk.

Critical CSS constraint:

- Existing opacity regressions expect `main` opacity to stay effectively 1 in
  relevant states. Avoid opacity-based page veil tricks that break those tests.

Reduced motion:

- All added motion must be disabled or made immediate under
  `prefers-reduced-motion: reduce`.

Validation for Checkpoint 4:

```bash
npm run ci:page-transitions
npm run ci:continuity
npm run ci:visual
npm run ci:a11y
```

If a purely aesthetic idea cannot be evaluated by test and looks risky, do not
ship it unattended. Record it as a follow-up in the sprint doc.

Commit and push after this checkpoint.

## A-Phase Checkpoint 5: Evidence And Sprint Doc Update

Update:

```text
docs/TRANSITION-SPOTLIGHT-SPRINT.md
```

Record:

- what changed;
- what tests ran;
- which Actions/browser suites passed or failed;
- what remains;
- any visual/motion decisions;
- any deferred risky texture;
- new known risks.

Do not over-document every line of code. Record decisions, evidence, and next
actions.

Commit and push after this checkpoint.

## After A-Phase: Never Run Out Of Useful Work

If A-phase completes and tests are in a good state, continue down this queue.
Do not invent random feature work. Use this order.

### 1. Physical `section.js` Split

The reader controller is too large. The budget was parked to unblock sprint
work, not because the size is acceptable.

Goal:

- Split `scripts/section.js` into coherent modules without adding a build step.
- Preserve global browser exports.
- Keep tests green.

Likely split candidates:

- route/load/render controller;
- highlight/anchor resolution;
- selection copy/citation UI;
- reading progress/attention wiring;
- section turn animation/prefetch helpers.

Validation:

```bash
npm run check
npm run ci:standalone
npm run ci:regression
npm run ci:continuity
npm run ci:passage-alignment
```

Commit and push per slice. Do not attempt a giant split in one commit.

### 2. Legacy Runtime Search Engine Purge

The sprint doc parks a dedicated cleanup:

- drop legacy runtime search where production no longer needs it;
- remove file://-only fallback branches if they are now just baggage;
- keep oracle-only behavior;
- preserve no-build testing for pure modules.

Treat this as its own commit. Run the search and browser suites that show what
breaks.

Validation:

```bash
npm run test:search-engine
npm run test:search-index
npm run test:search-oracle
npm run test:search-lexicon
npm run ci:spotlight
npm run ci:regression
```

### 3. Reading-Attention Feel Pass

The math is tested; constants are taste calls.

Tune only with evidence:

- `WPM`
- `READ_FRACTION`
- velocity full-credit threshold
- velocity zero-credit threshold
- heartbeat/save cadence if needed

Do not make the visual bar attention-based.

Validation:

```bash
npm run test:reading-attention
npm run test:reading-state-unit
npm run ci:regression
```

### 4. Advanced Search Follow-Ups

Already parked:

- URL-persist advanced/show-everything mode.
- Add scope/section filters in advanced mode.
- Keep default search curated and tight.

Validation:

```bash
npm run test:search-oracle
npm run ci:spotlight
npm run ci:regression
```

### 5. AST Promotion / Build Compiler

This is the first truly large "reading instrument" project. Do not start it
until A-phase is stable and the section split / search cleanup state is clear.
If you start it, first write a short plan into
`docs/TRANSITION-SPOTLIGHT-SPRINT.md` so the branch has a durable map.

Current shape of the system:

- Raw essay text lives under `raw/<essay-slug>/`.
- Essay metadata lives in `data/essays.json` and per-essay manifests.
- Generated browser fallback data lives in `scripts/essays-data.js` and
  `scripts/chapters-data.js`.
- The AST parser already exists under `scripts/ast/` and `scripts/ast-tools/`.
- Search index generation already knows about passage identity and oracle
  ranking.
- Runtime rendering still carries too much legacy shape from pre-AST DOM.

Goal:

- Promote AST from "useful internal parse artifact" into the canonical content
  contract for rendering, search, anchors, and future reader features.
- Keep static deployment and no-build runtime ergonomics intact.
- Preserve generated fallback data for GitHub Pages / offline use.
- Make passage identity stable enough that URLs, search, copy links, reading
  state, and continuity can all rely on the same structure.

Do not attempt this as a single giant rewrite. Slice it.

Suggested slices:

1. **Inventory current AST contracts.**
   Read parser output, fixtures, renderer expectations, search-index generation,
   anchor tests, and reader rendering. Write a short contract note in the sprint
   doc: node types, stable IDs, passage/range semantics, and current gaps.

2. **Define canonical passage identity.**
   Decide whether public passage IDs stay simple paragraph indices, become
   generated opaque anchors, or use a hybrid. Respect existing URLs. If changing
   grammar, add compatibility and tests.

3. **Move rendering closer to AST.**
   Reduce any path where section text is rendered from loose block/string data
   while AST identity is reconstructed later. Prefer rendering from AST nodes
   with `data-passage-id` / range metadata created at the same time as DOM.

4. **Unify generated data shape.**
   If `generate-embedded-data.js`, `chapters-data.js`, and search-index
   generation duplicate content transformations, consolidate the transformation
   behind a shared library. Keep generated artifacts deterministic.

5. **Strengthen fixture coverage.**
   Add AST fixtures for edge cases that matter to the reader: headings,
   paragraph boundaries, emphasis, quotes, blank lines, Unicode punctuation,
   section starts/ends, search ranges, and copied selection ranges.

6. **Document migration boundaries.**
   If a legacy representation remains, name it and explain why. Do not leave
   invisible dual truths.

Validation:

```bash
npm run test:ast
npm run test:anchors
npm run test:search-index
npm run test:search-oracle
npm run test:reading-state-unit
npm run ci:passage-alignment
npm run ci:regression
```

Commit and push each slice.

### 6. Algorithmic Typesetting

Start this only after AST identity is solid enough to trust. The goal is not
"fancy typography"; the goal is a prose page that uses structure to improve
reading.

Possible directions:

- paragraph rhythm based on section shape;
- first-paragraph / transition-paragraph treatment derived from AST position;
- pull-quote candidates derived from actual text structure, not invented copy;
- smarter line-length and measure rules by viewport;
- section opening composition that respects title/subtitle/body relationships;
- print-style refinements that do not hurt mobile reading;
- better treatment of long quotes, lists, or unusual blocks if the AST supports
  them.

Guardrails:

- Do not add decorative cards around prose.
- Do not make the reader look like a marketing landing page.
- Do not use arbitrary generated ornament.
- Do not change content words.
- Do not fabricate pull quotes or annotations.
- Maintain accessibility and sensible source order.

Validation:

```bash
npm run ci:regression
npm run ci:a11y
npm run ci:devices
npm run ci:visual
```

Record visual decisions in the sprint doc.

### 7. Concordance / Derived Literary Apparatus

Editorial apparatus is out when it means fabricated footnotes or fake scholarly
context. Derived apparatus is allowed if it is mechanically grounded in the
essay text.

Possible directions:

- concordance view for recurring terms and motifs;
- motif trails that link passages sharing meaningful terms;
- section-level term density summaries;
- search result side information that explains recurrence across the essay;
- "where this word returns" affordances from a selected term;
- lightweight bibliography-like metadata only if it exists in source data.

Guardrails:

- Never invent references.
- Never imply scholarship that is not present.
- Keep the prose primary.
- Make apparatus opt-in and quiet.
- Reuse oracle/search index data where possible.

Potential files:

```text
scripts/search-oracle.js
scripts/oracle-client.js
scripts/generate-search-index.js
scripts/essay.js
scripts/section.js
search.html
essay.html
styles/main.css
```

Validation:

```bash
npm run test:search-index
npm run test:search-oracle
npm run test:search-lexicon
npm run ci:spotlight
npm run ci:regression
npm run ci:a11y
```

### 8. Reader Memory And Continuation Quality

If the structural work is stable, improve how the site remembers and resumes
reading without making it creepy or noisy.

Possible directions:

- better resume target wording;
- resume previews that show context around the last actually read paragraph;
- cross-section journey summaries;
- more reliable completion transitions from one section to the next;
- explicit "mark section read/unread" only if it does not fight the attention
  model;
- export/import or reset of local reading state if useful.

Guardrails:

- Attention progress remains honest.
- Scroll progress remains visual position only.
- Do not nag the reader.
- Do not create account/server assumptions.

Validation:

```bash
npm run test:reading-attention
npm run test:reading-state-unit
npm run test:reading-state
npm run ci:regression
npm run ci:a11y
```

### 9. Offline / PWA Hardening

If the interaction and content architecture are stable, harden offline behavior.

Possible directions:

- ensure all newly split scripts are precached;
- improve service-worker update recovery;
- verify subpath behavior under `/renaissance/`;
- make offline reader/search failure states clearer;
- reduce stale-cache hazards after generated data changes.

Validation:

```bash
npm run validate:offline-assets:check
npm run validate:cache-version:check
npm run ci:offline
npm run ci:sw-update
npm run ci:subpath
```

Run `node scripts/generate-cache-version.js` after precached changes.

### 10. Final Polish Pass

Only after the structural queue is exhausted, spend time on small polish.

Good polish:

- simpler code paths;
- clearer focus states;
- better empty states;
- tighter copy where UI already exists;
- fewer special cases;
- stronger tests for known risks;
- documentation that helps the next session.

Bad polish:

- new ornamental UI;
- broad redesigns;
- motion for its own sake;
- new systems without tests;
- changes that make the site feel less like a reader.

## If Everything Above Is Done

If the implementation queue is exhausted, do not pad the branch with random
polish. Switch to review mode.

Perform a comprehensive codebase review and write findings to:

```text
docs/AUTONOMOUS-CODEBASE-REVIEW.md
```

The review should prioritize:

- correctness risks;
- brittle DOM contracts;
- service worker/cache hazards;
- route/subpath hazards;
- accessibility gaps;
- test gaps;
- modules that are too large;
- dead code;
- search/ranking correctness;
- reading-state persistence edge cases;
- continuity/transition failure modes;
- places where the code could be simpler.

Do not blindly apply recommendations from the review unless they are small,
obviously correct, and independently testable. Prefer writing the review with
specific file references and proposed follow-up commits.

Commit and push the review doc.

## Failure Handling

If a test fails:

1. Read the failure.
2. Identify whether it is caused by your change.
3. Fix if clearly caused by your change.
4. If infrastructure/flaky, retry once.
5. If still failing and not caused by your change, record it in the sprint doc
   and continue only if safe.

If a change makes the site feel worse or creates a brittle transition:

1. Revert the smallest transition-specific commit if it has already been pushed,
   or undo the local change before committing.
2. Preserve tests that caught real regressions.
3. Record the rejected motif or approach in the sprint doc.

If quota or runner time is nearly exhausted:

1. Stop starting new risky work.
2. Run the narrowest relevant test.
3. Commit and push current coherent work.
4. Update `docs/TRANSITION-SPOTLIGHT-SPRINT.md` with exactly where to resume.

## Smoke Mode Contract

If invoked in smoke mode, do not edit files.

Smoke mode should:

1. Confirm Claude can start.
2. Print the current branch.
3. Print the latest commit.
4. Confirm the repo root can be listed.
5. Confirm whether the requested sprint branch exists.
6. Stop.

If smoke mode fails with a usage-limit message, that is still useful signal: the
workflow reached Claude authentication and the remaining blocker is quota.

## Final Reminder

The goal is to wake up with banked progress, not a heroic uncommitted diff.

Small pushed commits beat one huge unpushed attempt.
