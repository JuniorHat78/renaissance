# Interface Grammar

Renaissance controls should feel like they belong to a quiet archive: labels,
index slips, bookmarks, and ledger lines. The interface should not feel like a
generic web app laid on top of prose.

## Principles

- Controls stay compact and useful; the prose remains the center.
- Edges are crisp, slightly softened, and paper-like. Avoid pill overload.
- Primary actions may carry the terracotta accent. Secondary actions should feel
  like annotated paper, not gray browser defaults.
- Search controls should feel like an index/catalog surface.
- Motion is rare and short. Use color, line weight, and small reveals before
  movement.
- Focus states must be obvious in light and dark themes.
- Touch targets remain comfortable on mobile.

## Component Language

- **Primary button**: terracotta archive mark, small radius, subtle inset paper
  highlight, steady hover/active states.
- **Ghost button**: paper slip with a fine border and a small accent rule on
  hover/focus.
- **Search field**: catalog field with a quiet inset line and clear text.
- **Select**: same field language as search, with a custom caret.
- **Checkbox**: small stamped square with an accent fill when checked.
- **Advanced search**: index drawer, using top/bottom ledger lines rather than a
  generic floating form card.
- **Copy chip/toast**: small archival slips; useful, not decorative.
- **Recovery actions**: use the same buttons as the rest of the site so error
  states feel like part of the archive. Browser-level 404 behavior is specified
  in `docs/404-MAGIC-SPEC.md`.

## Non-Goals

- No framework-like command palette styling yet.
- No decorative gradients or glass panels.
- No new behavior in this pass.
- No magical 404 redesign yet; only alignment with shared controls.
