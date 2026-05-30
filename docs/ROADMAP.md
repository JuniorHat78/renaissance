# Roadmap

This is the current planning source for Renaissance.

The next work should make the existing reader feel more intentional before
adding a large new interaction. Spotlight search is still important; it should
arrive after the interface language feels worthy of it.

## Guiding Shape

- Preserve the warm, book-style reader experience.
- Prefer small, memorable touches over busy feature density.
- Keep every enhancement graceful under keyboard, touch, reduced motion, offline,
  and the `/renaissance/` GitHub Pages subpath.
- Keep current CI and content guarantees intact while polishing the surface.
- Move speculative ideas into `docs/IDEAS.md` instead of deleting them.

## Phase 1: Documentation And Project Intent

Goal: make the docs reflect the project as it exists now.

- [x] Keep `docs/ROADMAP.md` as the only active roadmap.
- [x] Keep future ideas in `docs/IDEAS.md`.
- [x] Move completed or superseded plans into `docs/archive/`.
- [x] Update `README.md`, `docs/ARCHITECTURE.md`, and `docs/QA.md` so they
      describe the current site, not older phases.
- [x] Remove or explicitly ignore local scratch files once their useful ideas
      are captured.

## Phase 2: Interface Grammar Pass

Goal: make every control feel like it belongs to Renaissance.

- [ ] Define the shared control language for buttons, ghost buttons, search
      fields, selects, checkboxes, chips, pagination, and contextual copy UI.
- [ ] Replace browser-default-looking search options with a quieter, more
      literary treatment.
- [ ] Make primary, secondary, and contextual actions visually consistent across
      archive, essay, section, search, and error states.
- [ ] Keep controls dense enough for repeated reading/search workflows, but
      softer than a generic dashboard.
- [ ] Add or update visual QA scenarios for the changed controls.

## Phase 3: Magical 404 And Empty States

Goal: make recovery states feel like part of the archive instead of dead ends.

- [ ] Rework the 404 into a more wondrous self-contained page.
- [ ] Implement contextual 404 modes from `docs/404-MAGIC-SPEC.md`.
- [ ] Keep path-depth safety: the 404 must not depend on relative external
      assets that can break at arbitrary missing URLs.
- [ ] Make app-shell not-found states on `essay.html` and `section.html` share
      the same tone and recovery model.
- [ ] Consider a small "lost leaf" / "found in the margins" interaction that
      remains subtle, fast, and reduced-motion aware.
- [ ] Keep archive/search recovery obvious.

## Phase 4: Authoring And Content Doctor Polish

Goal: make the site easier to publish into, not just easier to browse.

- [ ] Add or improve commands for content health, AST diagnostics, generated
      data freshness, and publish readiness.
- [ ] Consider a `new essay` / `new section` helper if content additions become
      repetitive.
- [ ] Confirm publish metadata such as `published_at` dates before feed entries
      become canonical.
- [ ] Keep the AST grammar intentionally small unless real essays need more.

## Phase 5: Spotlight Search As Hidden Index

Goal: build Spotlight after the interface grammar is settled.

- [ ] Add a global `Cmd/Ctrl+K` launcher.
- [ ] Make it feel like opening a hidden index, not a generic command palette.
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
