# Experience

Renaissance should feel like a small, precise reading OS for long-form essays:
quiet, tactile, exact, and authored all the way down. The goal is not to look
like Apple. The goal is to borrow the discipline: every state has intent, every
control responds cleanly, and the interface never competes with attention.

## Experience Position

- The prose is the center. Interface appears when it helps reading, searching,
  resuming, citing, recovering, or publishing.
- The site should feel hand-built, but not rough. Handmade means more care, not
  more friction.
- Specialized beats generic. Search is an index, copying is citation, progress
  is a bookmark, recovery is an archive action, and drafts are unlisted rooms.
- Zero runtime dependencies are a control strategy. They preserve durability,
  load predictability, and ownership of fine interaction details. Development
  and test dependencies are welcome when they buy confidence.
- The site remains static, frameworkless, and GitHub Pages friendly unless a
  future feature has enough standardized complexity to justify changing that.

## Apple-Feel In Renaissance Terms

- **Quiet**: controls stay compact, labels are useful, and decoration never asks
  for attention before the essay does.
- **Tactile**: hover, focus, pressed, copied, restored, and unavailable states
  should feel immediate and physically plausible.
- **Exact**: spacing, timing, scroll targets, focus return, and URL state should
  land where the reader expects.
- **Native where possible**: prefer real links, buttons, inputs, selections, and
  browser affordances with Renaissance presentation over fully custom widgets.
- **Forgiving**: app-shell misses, offline reads, stale reader state, malformed
  routes, and empty search states should recover without feeling like errors
  from a generic web app.

## Specialized Interaction Surfaces

- **Reader**: progress, resume, anchors, copy tools, and section navigation
  should feel like a reader substrate, not page chrome.
- **Selection and citation**: selecting prose is a first-class act. Copy tools
  should preserve source context and stay out of the way on touch devices.
- **Search**: inline search is an index slip. Future Spotlight should feel like
  opening a hidden catalogue, not a generic command palette.
- **Recovery**: 404, app-shell not-found states, and offline fallbacks should
  use the same archive language as the rest of the site.
- **Unlisted drafts**: `published: false` means omitted from archive listings,
  search, feeds, sitemap, and recovery suggestions. It does not mean private;
  direct URLs and bundled assets may still expose the work.

## Motion And Feedback

- Motion is short, local, and purposeful. Prefer opacity, line weight, color,
  and small position changes over large animated movement.
- No bounce, flourish, or decorative motion unless it communicates a state the
  reader would otherwise miss.
- Every motion path must collapse cleanly under `prefers-reduced-motion`.
- Feedback should be near the action that caused it: copied, restored, saved,
  empty, unavailable, or recovered.

## Things To Avoid

- Generic SaaS dashboards, command palettes, glass panels, and showroom hero
  styling.
- Component-library defaults that flatten the archive voice.
- Large visual rewrites without fresh screenshots and interaction checks.
- Adding syntax, controls, or animation because the system can, rather than
  because the essays need it.

## Documentation Map

- `docs/ROADMAP.md` tracks active sequencing.
- `docs/INTERFACE-GRAMMAR.md` defines reusable controls, tokens, focus, and
  interaction primitives.
- `docs/specs/` contains feature-specific contracts such as AST, 404 recovery,
  and search ranking.
- `docs/QA.md` defines the checks that keep the feeling honest across keyboard,
  touch, reduced motion, forced colors, offline, subpath, and production deploys.
