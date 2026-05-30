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

## Token Scale

Use the existing CSS custom properties as the stable token surface before any
future visual rewrite:

- **Color roles**: `--canvas`, `--paper`, `--text`, `--muted`, `--line`,
  `--accent`, `--accent-hover`, `--accent-ink`, `--accent-wash`.
- **Type roles**: `--font-title` for essay/archive headings, `--font-body` for
  prose, `--font-ui` for controls and metadata.
- **Motion roles**: `--motion-fast`, `--motion-base`, `--motion-slow`,
  `--motion-ease`.
- **Radius roles**: 2px for pressed/archive-tab edges, 4px for controls, 8px
  only for tool surfaces such as popovers and debug panels.
- **Shadow roles**: prefer border/line contrast first; use shadows only for
  transient overlays, selection affordances, and 404/recovery depth.

Apple-feel work should refine these roles rather than adding one-off color,
radius, shadow, or timing values in isolated components.

## Interaction Primitives

Shared behaviors should converge on these patterns:

- **Disclosure**: trigger has `aria-expanded`, panel has a stable id, Escape
  closes, outside click closes, focus returns to the trigger.
- **Listbox/select**: visual control mirrors the native value, options expose
  `role="option"` and `aria-selected`, arrow keys move focus, Enter/Space
  choose, Escape closes.
- **Preview/popover**: opening is delayed enough to avoid flicker, closing is
  immediate on Escape, scroll, pointer leave, or route change.
- **Recovery choices**: primary suggestion first, search/archive fallback always
  reachable, no automatic redirect unless the route is certain.
- **Selection tools**: never fight native selection on touch devices; mobile uses
  the bottom bar pattern instead of a floating chip.

## Accessibility Expectations

- Focus states use the accent outline and must be visible in light, dark, and
  forced-colors modes.
- Motion must be short and respect `prefers-reduced-motion: reduce`.
- Custom controls must keep the native control in sync or provide equivalent
  keyboard semantics.
- Warning-only visual/Lighthouse checks are review signals; deterministic
  keyboard, focus, reduced-motion, subpath, and recovery tests are the gates.

## Non-Goals

- No framework-like command palette styling yet.
- No decorative gradients or glass panels.
- No new behavior in this pass.
- No broad visual taste pass without fresh screenshots and user feedback.
