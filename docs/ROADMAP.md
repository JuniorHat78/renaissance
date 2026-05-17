# Roadmap

## Phase 1: Maintenance Cleanup

- [x] Consolidate root planning docs into `docs/`.
- [x] Keep historical implementation plans under `docs/archive/`.
- [x] Add `npm run dev`.
- [x] Add `npm run check`.
- [x] Mark generated embedded data files.
- [x] Extract shared page metadata helpers.

## Phase 2: Continuity Foundation

- [x] Track last-read essay, section, and reader position.
- [x] Add a quiet Continue Reading affordance on the archive page.
- [x] Show section progress in the reader.
- [x] Surface touched/completed section state on essay pages.
- [x] Ensure highlight links and manual scroll restoration do not fight each other.

## Phase 3: Spotlight Search

- [ ] Add a global `Cmd/Ctrl+K` launcher.
- [ ] Show contextual actions first, including Continue Reading when available.
- [ ] Update results instantly while typing.
- [ ] Support keyboard navigation and Enter/Escape behavior.
- [ ] Provide a mobile-friendly full-screen variant.
- [ ] Keep ranking scope-aware and predictable.

## Phase 4: Motion Polish

- [ ] Add View Transitions API support where available.
- [ ] Respect `prefers-reduced-motion`.
- [ ] Use one timing/easing system for panels, toasts, highlights, and route motion.
- [ ] Add restrained highlight-arrival and search-open animations.

## Deferred

- Generated compact search index for larger content volume.
- Strict visual QA in CI.
- Social-card metadata consistency check.
- Shared default-route utility.
