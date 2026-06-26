# Roadmap

This is the current planning source for Renaissance (the reader site).

The next work should make the existing reader feel more intentional before
adding a large new interaction. Spotlight search is still important; it should
become the first flagship expression of the Renaissance interaction system, not
a generic command palette.

> **Scriptorium native editor** (the authoring tool's project-within-a-project)
> has its own living roadmap in `docs/specs/SCRIPTORIUM-NATIVE-EDITOR.md` §7 —
> the active frontier is a true zero-dep native Windows editor.

## Guiding Shape

- Preserve the warm, book-style reader experience.
- Prefer small, memorable touches over busy feature density.
- Keep every enhancement graceful under keyboard, touch, reduced motion, offline,
  and the `/renaissance/` GitHub Pages subpath.
- Keep current CI and content guarantees intact while polishing the surface.
- Keep zero runtime dependencies as a control strategy for specialized,
  reader-first interactions, while using development tooling for confidence.
- Move speculative ideas into `docs/IDEAS.md` instead of deleting them.

## Phase 1: Documentation And Project Intent

Goal: make the docs reflect the project as it exists now.

- [x] Keep `docs/ROADMAP.md` as the only active roadmap.
- [x] Keep future ideas in `docs/IDEAS.md`.
- [x] Move completed or superseded plans into `docs/archive/`.
- [x] Update `README.md`, `docs/ARCHITECTURE.md`, and `docs/QA.md` so they
      describe the current site, not older phases.
- [x] Add `docs/EXPERIENCE.md` for the Apple-feel/Renaissance interaction
      posture.
- [x] Group feature-specific contracts under `docs/specs/`.
- [x] Remove or explicitly ignore local scratch files once their useful ideas
      are captured.

## Phase 2: Interface Grammar Pass

Goal: make every control feel like it belongs to Renaissance.

- [x] Define the shared control language for buttons, ghost buttons, search
      fields, selects, checkboxes, chips, pagination, and contextual copy UI.
- [x] Replace browser-default-looking search options with a quieter, more
      literary treatment.
- [x] Make primary, secondary, and contextual actions visually consistent across
      archive, essay, section, search, and error states.
- [ ] Keep controls dense enough for repeated reading/search workflows, but
      softer than a generic dashboard.
- [ ] Add or update visual QA scenarios for the changed controls.

## Phase 2.5: Renaissance Interaction System

Goal: make Renaissance feel like a small, precise reading OS rather than a
styled static site.

- [ ] Define Apple-feel in Renaissance terms: quiet, tactile, exact,
      reader-first, and native where possible.
- [ ] Promote shared motion, feedback, focus, and control rules into the
      interaction docs before building larger new surfaces.
- [ ] Make selection, copying, citation, recovery, offline, and empty states
      feel authored instead of generic.
- [ ] Treat `published: false` as an explicit unlisted-public draft state, not a
      privacy boundary.
- [ ] Add polish QA scenarios for interaction states, not only layout snapshots.
- [ ] Use Spotlight as the first major proof of this interaction system.

## Phase 3: Magical 404 And Empty States

Goal: make recovery states feel like part of the archive instead of dead ends.

- [x] Rework the 404 into a more wondrous self-contained page.
- [x] Implement contextual 404 modes from `docs/specs/404-MAGIC-SPEC.md`.
- [x] Keep path-depth safety: the 404 must not depend on relative external
      assets that can break at arbitrary missing URLs.
- [x] Make app-shell not-found states on `essay.html` and `section.html` share
      the same tone and recovery model.
- [x] Consider a small "lost leaf" / "found in the margins" interaction that
      remains subtle, fast, and reduced-motion aware.
- [x] Keep archive/search recovery obvious.

## Phase 4: Authoring And Content Doctor Polish

Goal: make the site easier to publish into, not just easier to browse.

- [x] Add or improve commands for content health, AST diagnostics, generated
      data freshness, and publish readiness.
- [ ] Consider a `new essay` / `new section` helper if content additions become
      repetitive.
- [ ] Confirm publish metadata such as `published_at` dates before feed entries
      become canonical.
- [x] Keep the AST grammar intentionally small unless real essays need more.

## Phase 5: Spotlight Search As Hidden Index

Goal: build Spotlight as the first flagship expression of the Renaissance
interaction system.

- [ ] Add a global `Cmd/Ctrl+K` launcher.
- [ ] Make it feel like opening a hidden index, not a generic command palette.
- [ ] Reuse the established motion, focus, recovery, and control grammar from
      `docs/EXPERIENCE.md` and `docs/INTERFACE-GRAMMAR.md`.
- [ ] Show contextual actions first, including Continue Reading when available.
- [ ] Update results instantly while typing.
- [ ] Support keyboard navigation, Enter, Escape, and mobile full-screen use.
- [ ] Keep ranking scope-aware and predictable.
- [ ] Add regression coverage for open/close, keyboard selection, action routing,
      reduced motion, and mobile layout.

## Phase 6: Future Enchantments

Goal: preserve the dream list without committing all of it at once.

- [ ] Marginalia and hidden notes.
- [ ] Essay-specific rituals and ambient moments.
- [ ] Cross-essay parallel passages.
- [ ] Completion-state changes after finishing published essays.
- [ ] More polished offline states, including a readable cached-library view.
- [ ] Generated or worker-backed search data if the archive grows enough to need
      it.

Detailed idea inventory lives in `docs/IDEAS.md`.

The long-form implementation checklist for recovery/offline/backend hardening
lives in `docs/ENGINEERING-SPRINT.md`.

Latest sprint notes:

- Transition hardening, oracle search, AST anchors, and Spotlight planning live
  in `docs/TRANSITION-SPOTLIGHT-SPRINT.md` and the companion specs under
  `docs/specs/`.
- Post-main artifact review, beta-testing, and expanded Actions gauntlets to
  implement in the sprint are tracked in
  `docs/specs/HARDENING-GAUNTLETS-SPEC.md`.
- Recovery/offline/cache/generated-artifact hardening is tracked in
  `docs/ENGINEERING-SPRINT.md`.
- AST syntax support and legacy bridge boundaries are documented in
  `docs/specs/AST-DIALECT.md`.
- Search ranking and growth thresholds are documented in
  `docs/specs/SEARCH-RANKING-SPEC.md`.
- Experience posture and zero-dependency control strategy are documented in
  `docs/EXPERIENCE.md`.
- Interface-token and interaction grammar is documented in
  `docs/INTERFACE-GRAMMAR.md`.
