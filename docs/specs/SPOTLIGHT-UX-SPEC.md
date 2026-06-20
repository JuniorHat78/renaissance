# Spotlight UX Spec

Spotlight is the hidden index for Renaissance. It should feel Apple-esque in
discipline: immediate, calm, precise, native where possible, and beautiful
without becoming decorative.

It should not look or behave like a generic command palette.

## Experience Model

Opening Spotlight should feel like the archive reveals a private index above the
current page.

The page remains present. The index appears quickly. The input is ready. The
first rows are useful before typing.

## Core Promise

- Open instantly.
- Offer the next likely action.
- Search the archive with oracle-grade ranking.
- Activate results through seamless transitions.
- Close cleanly and return focus.

## Feel Quality Ladder

Use this ladder for beta-testing Spotlight.

1. **Functional**: it opens, searches, navigates, and closes.
2. **Fast**: the shell appears immediately and typing never feels blocked.
3. **Useful before typing**: default rows feel context-aware.
4. **Precise**: top results usually feel right.
5. **Elegant**: animation supports the action without calling attention to
   itself.
6. **Native**: keyboard, focus, touch, back/forward, and reduced motion feel
   expected.
7. **Renaissance**: the surface feels like a hidden index from this archive, not
   an imported launcher.

## Entry Points

Required:

- `Cmd+K` on macOS.
- `Ctrl+K` elsewhere.

Possible later:

- small search/index button in header;
- search input affordance can open Spotlight instead of inline preview on some
  pages;
- mobile header action.

Avoid visible instructional copy inside the interface. Discovery should come
from conventional shortcut support, subtle controls, and documentation.

## Shell Layout

Desktop:

- centered or top-biased index surface;
- width constrained for scanning;
- input at top;
- result groups below;
- current page subtly present behind it;
- no nested cards;
- no glass panel;
- no oversized hero treatment.

Mobile:

- full-screen or near-full-screen index sheet;
- input pinned near top;
- comfortable touch rows;
- no background scroll leak;
- close affordance and Escape/back behavior;
- virtual keyboard does not hide active result.

## Visual Language

Use:

- paper/index slip;
- fine rules;
- compact rows;
- section/essay metadata;
- small accent mark for active row;
- high-quality focus outline;
- quiet shadows only if needed for overlay separation.

Avoid:

- neon command palette;
- translucent glass;
- giant rounded pill rows;
- colorful category chips everywhere;
- decorative icons for every row;
- heavy blur that hurts text readability.

## Opening Motion

Target:

- shell visible immediately;
- input focused immediately;
- a fine rule or index line settles in;
- page may soften by a tiny amount but remains readable;
- results appear without delaying input.

Opening should not:

- wait for the search index;
- fade the page to unreadable opacity;
- scale dramatically;
- bounce;
- block typing.

## Closing Motion

Closing should:

- be quick;
- clear active descendant state;
- restore focus to the opener or previous active element;
- leave no scroll lock behind;
- cancel pending query work.

## Default Rows

Before typing, Spotlight should show useful context.

Priority:

1. Continue Reading when available.
2. Current section action if on a reader page.
3. Current essay actions.
4. Section jump actions.
5. Archive/search actions.
6. Top published essay or section suggestions.

Default rows should make the site feel smart before the first keystroke.

## Query Results

Group results only when grouping improves scanning.

Possible groups:

- Best Matches
- Passages
- Sections
- Essays
- Actions

If one result is clearly best, avoid burying it under group labels.

Each row should include:

- title;
- compact subtitle/context;
- snippet if passage;
- type cue through text/spacing, not noisy badges;
- active state;
- accessible name.

## Result Activation

Activation rules:

- Enter activates the selected result.
- Click/tap activates pointer target.
- Result row becomes transition source.
- Route is built by router/search action model.
- Passage results route to stable AST anchor.
- Destination page becomes readable before arrival flourish completes.

## Keyboard Behavior

Required:

- `Cmd/Ctrl+K`: open.
- Escape: close.
- ArrowDown/ArrowUp: move selection.
- Home/End: first/last result when focus is in input.
- Enter: activate selected result.
- Tab: either trap inside dialog or move through close/input/results in a
  predictable accessible order.
- Shift+Tab: reverse order.

The active result should be exposed through ARIA semantics without breaking
native input editing.

## Accessibility Model

Likely structure:

- `role="dialog"` for the overlay;
- labelled search input;
- listbox or active-descendant result list;
- live region only for result count/status, not every keystroke;
- focus restoration on close;
- inert/background scroll management where supported and safe.

Reduced motion:

- no spatial flourish required;
- immediate open/close;
- active/focus states still clear;
- result activation still routes correctly.

## Loading States

Spotlight must not feel like it is waiting.

If full index is not ready:

- show actions immediately;
- show current context rows;
- show a quiet "index waking" state only if needed;
- replace with results as soon as available.

Avoid spinners unless the user explicitly triggers an expensive operation.

## Empty States

Empty states should be authored and actionable.

Examples:

- no passage match, but offer full search;
- no current essay scope, offer global search;
- offline without index, offer cached reading actions;
- malformed section intent, offer nearest section.

Do not make the empty state look like an application error.

## Search Modes

Spotlight should not expose many mode controls. It should infer:

- exact phrase;
- loose phrase;
- title/section intent;
- action intent;
- fuzzy rescue.

Full search can keep explicit controls if useful, but Spotlight should feel
direct.

## Context Awareness

Context inputs:

- current route/view;
- current essay;
- current section;
- reading state;
- selected text if Spotlight opens after selection in a future feature;
- online/offline state;
- whether search index is loaded.

Context uses:

- boost current essay results;
- show section navigation actions;
- show continue/resume;
- offer "search this essay" action;
- avoid global noise before local relevance.

## Downstream Surfaces

Spotlight is allowed to force improvements outside its own file. The user
experience is only as good as the route, search, reader, and recovery behavior
that happens after activation.

Downstream expectations:

- full search should not feel like an older, weaker version of Spotlight;
- inline search should share enough ranking behavior to feel consistent;
- passage activation should land with reader-grade polish;
- highlight arrival should be beautiful and precise;
- copied links should use the same anchor system when possible;
- Continue Reading should feel like a first-class action, not a shortcut hack;
- mobile and reduced-motion behavior should remain first-class after routing;
- offline/cached behavior should offer useful actions instead of dead rows.

If a Spotlight result exposes roughness downstream, fix the downstream system
rather than hiding the result.

## Implementation Modules

Likely modules:

- `scripts/spotlight.js`: UI lifecycle and keyboard interaction.
- `scripts/search-index.js`: generated index loading and warming.
- `scripts/search-query.js`: query parsing.
- `scripts/search-rank.js`: ranking.
- `scripts/search-actions.js`: context/default action rows.
- `scripts/search-results.js`: shaping, grouping, snippets.

The module split is a guide, not a lock. Extract where tests and clarity demand
it.

## Test Matrix

- [ ] Opens with `Cmd+K`.
- [ ] Opens with `Ctrl+K`.
- [ ] Focus lands in input.
- [ ] Escape closes and restores focus.
- [ ] Arrow keys move selection.
- [ ] Enter activates action row.
- [ ] Enter activates passage row.
- [ ] Mobile layout does not overflow.
- [ ] Background scroll is locked while open.
- [ ] Reduced motion path works.
- [ ] Offline actions still render.
- [ ] Current essay boost affects ordering.
- [ ] Continue Reading appears when meaningful.
- [ ] Passage activation lands and highlights.
- [ ] `/renaissance/` subpath URLs are correct.
- [ ] No unpublished essays appear.

## Beta Review Script

Use this manual script against desktop, mobile, and reduced-motion captures:

1. Open home, press `Cmd/Ctrl+K`, do not type. Are the default rows useful?
2. Type a known section title. Does the intended section win?
3. Type a body phrase. Does the intended passage win?
4. Type a messy remembered phrase. Does it recover gracefully?
5. Activate a passage result. Does the transition feel connected?
6. Return with browser back. Does focus/state feel sane?
7. Repeat inside an essay page. Are current essay results boosted?
8. Repeat inside a section. Are reader actions useful?
9. Enable reduced motion. Does the surface still feel polished?
10. Emulate mobile. Is it thumb-friendly and non-cramped?

Record surprising results in the sprint doc before tuning.

## Done Criteria

- Spotlight feels faster than manual browsing.
- The first rows are useful without typing.
- Typing feels instant.
- Result ranking is backed by fixtures.
- Mobile and keyboard flows are first-class.
- Activation inherits hardened transitions.
- Empty/offline states feel authored.
- The UI does not look like a generic command palette.
