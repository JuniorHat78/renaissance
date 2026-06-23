# Scriptorium — the living editor

> The design of record for Scriptorium's **structural layer**: the two-way bridge
> between the source buffer and the live preview, and the AST-aware command
> surface built on top of it. This is `docs/specs/SCRIPTORIUM.md` §8 **P3
> ("structural feel")**, deepened into its own spec — the move that turns a slick
> *viewer with an editable pane* into an editor that feels alive.
>
> Status: **P3a/b/c shipped** (two-way sync, oracle-verified commands,
> select-node + block toggles), plus a zero-dep installable-PWA capstone, plus
> the **command & navigation & feel layer** (§14): command palette, slash menu,
> find & replace, block ops, list continuation, focus mode, autosave, theme,
> reading time, shortcuts. The pure brains (`mapping`, `commands`, `palette`,
> `find-replace`, `block-ops`, `list-continue`) are unit-tested in the spine
> guard. Read `SCRIPTORIUM.md` first; this assumes its spine invariant (§2) and
> caret boundary (§4) as settled law.
>
> Last refreshed: 2026-06-24.

---

## 1. What this layer is

Today the two panes are strangers. You type on the left; a faithful preview
appears on the right; clicking a diagnostic or an outline entry nudges the
caret. That is the whole of the interaction. Everything else an editor does —
*"where am I in the output?", "take me to that paragraph", "make this bold",
"promote this to a pull-quote"* — does not exist yet.

This spec adds exactly two things, and a third that falls out of them:

1. **Two-way source↔preview sync** — the panes become one object. Caret position
   lights up the matching preview block; clicking a preview block moves the
   caret; the two scroll together.
2. **AST-aware commands** — `Ctrl+B`/`Ctrl+I`, heading levels, pull-quote and
   blockquote toggles, link insertion — each defined *by the parser*, not by
   naive string wrapping, and each verified against the AST before it commits.
3. **Select-this-node** — selecting/operating on a whole block — which is just
   sync + a selection write, so it comes nearly for free.

It adds **nothing** to the editing surface itself. The caret boundary
(`SCRIPTORIUM.md` §4) is law: the `<textarea>` still owns every glyph, the
selection, IME, and the native undo stack. We work *above* the caret and, for
commands, *replace spans of buffer text* — we never install a custom caret,
never reflow text under the caret as the author types.

## 2. The one principle: a single mapping, run both ways

There is exactly one piece of new knowledge under this whole layer:

> **Given the last parse, which block owns a given source offset — and where in
> the source does a given block live.**

`offset → block` powers caret-tracking and active-block highlight.
`block → offset` powers click-to-jump and command targeting. They are the same
function read in two directions. Everything in this spec is a consumer of that
one mapping. Build the mapping once, correctly, in a pure and Node-testable
form; wire both directions and every command through it.

## 3. The substrate that already exists (ground truth)

This layer is *possible* because the AST already carries source positions and
the preview DOM already exposes them. The exact, verified extent of that today:

- **`parse.js` stamps `position: { line, startOffset, endOffset }` on blocks**,
  and inline link/emphasis/etc. children carry offsets too.
- **`render.js` projects those onto the preview DOM** as `data-source-start` /
  `data-source-end` — but only via `core.passageRecordForBlock`, which returns a
  record **only for `isPassageBlock` types: `heading`, `paragraph`,
  `pull_quote`, `list_item`.**
- Therefore the **addressable** blocks (carry source positions in the DOM) are:
  `heading`, `paragraph`, `pull_quote`, `list_item`.
- The **unaddressable** containers are: `block_quote`, `list` (the `ul`/`ol`),
  and `divider` (the `hr`). A blockquote's *inner paragraph* is addressable; the
  blockquote wrapper is not. A list's *items* are addressable; the list wrapper
  and bare dividers are not.

### 3.1 The coordinate contract (pin this)

- **All offsets are indices into the full, raw buffer string** — JS string
  indices, i.e. **UTF-16 code units**, counted from `0` over `textarea.value`
  *in its entirety*, including any leading headings.
- **This is the exact unit `textarea.setSelectionRange(start, end)` consumes.**
  No translation layer exists or is needed. The parser's offset space and the
  caret's offset space are the same space. This identity is the keystone of the
  feature; if it ever stops being true, this layer breaks and the fix belongs
  here, loudly, not in a silent shim.
- **The preview is the *full* parse, not the shipped projection.** The shipped
  AST is `withoutLeadingHeadings`; the editor previews `parse(buffer)` whole, so
  offsets line up 1:1 with the buffer. Leading headings that won't reach the
  published page are previewed but **marked "stripped from the published page"**
  in the outline (carried over from `SCRIPTORIUM.md` §12 blocker 2).
- **Normalization happens at exactly one site: on load, never again.** When a
  section is loaded, the server already returns the file bytes; the editor
  normalizes `\r\n?` → `\n` **once, before the text enters the textarea**, and
  treats the normalized buffer as truth thereafter. The parser then sees no `\r`,
  so its offsets and the textarea's offsets cannot skew by a stray carriage
  return. (Resolves the `SCRIPTORIUM.md` §12 normalization should-fix for this
  layer's purposes; the save-side normalization story stays as specced there.)

## 4. Feature one — two-way sync

### 4.1 The mapping

After each parse (the existing debounced `refreshFromBuffer`), build an ordered
index of addressable blocks: `[{ start, end, blockType, previewEl }]`, sorted by
`start`. `previewEl` is found by matching `data-source-start` in the rendered
preview. Keep it as a flat array — addressable blocks never overlap, so lookup
is a binary search.

- `blockAtOffset(offset)` → the block whose `[start, end)` contains `offset`; if
  the offset falls in a gap (blank line, or inside an unaddressable container
  like a bare divider), return the **nearest preceding** block, or `null` before
  the first block.

### 4.2 Caret → preview (highlight + reveal)

- Listen on the textarea for `selectionchange`-equivalent events
  (`keyup`, `click`, `select`, and `input` after the re-parse settles). Debounce
  lightly (the parse debounce already gates the index rebuild).
- Compute `blockAtOffset(textarea.selectionStart)`, add an `.active-block` class
  to its `previewEl`, remove it from the previous one.
- **Reveal, don't yank:** if the active block is outside the preview viewport,
  scroll it into view *gently* (`scrollIntoView({ block: "nearest" })`), and
  **only when the caret moved by author action**, never on every keystroke of
  typing within an already-visible block — that would make the preview twitch.

### 4.3 Preview → caret (click to jump)

- Click anywhere in the preview → walk up to the nearest element carrying
  `data-source-start` → `setSelectionRange(start, start)` and `focus()` the
  textarea. (Native caret only — same mechanism as the existing diagnostic jump.)
- Clicking an unaddressable region (gap between blocks, the `hr`) is a no-op, not
  an error.

### 4.4 Scroll sync (the soft one)

- When the **author is scrolling the source**, proportionally track the preview:
  find the addressable block nearest the source viewport top and align its
  `previewEl` to the preview viewport top. Anchor-based, not percentage-based, so
  uneven block heights don't drift.
- Guard against feedback loops: a programmatic scroll of one pane must not
  re-trigger the other's handler (a short "I am driving" latch).
- **Decision:** scroll sync is *source-drives-preview only* in v1. Bidirectional
  scroll sync is a known feedback-loop tar pit for marginal gain; defer it.

### 4.5 Staleness honesty

The index is from the *last* parse; the caret may have moved into freshly typed
text the index doesn't know about yet. That is fine and expected: highlight the
nearest preceding known block and let the next debounced parse correct it. Never
block typing on a reparse, never show a wrong-but-confident highlight — prefer
"nearest preceding" over a guess.

## 5. Feature two — AST-aware commands

### 5.1 The command model

A command is a **pure function** over the buffer:

```
command(buffer, selectionStart, selectionEnd)
  → { buffer, selectionStart, selectionEnd }   // the proposed new state
```

It is pure and Node-testable. The editor applies the result to the textarea (see
§5.4 for *how*, to preserve undo) and lets the normal debounced parse refresh
everything. No command touches the DOM or the AST directly to mutate state — it
only proposes new buffer text.

### 5.2 The per-command oracle (the spine, applied to commands)

Naive string wrapping is wrong: emphasis markers are boundary-sensitive
(`*` adjacent to alphanumerics may not open/close), heading syntax depends on
line position, etc. So every command verifies itself against the **one parse
authority** before committing:

> Apply the proposed buffer → `parse(proposed)` → assert the intended node now
> exists (or, for a toggle-off, no longer exists) at the expected place. If the
> assertion fails, **revert** and surface a diagnostic ("couldn't make that
> bold here"). A command may never leave the buffer in a state whose parse
> contradicts the author's intent.

This is `SCRIPTORIUM.md` §2 pushed into editing: the editor doesn't *hope* the
markup it inserts parses as intended — it *checks*, through the same parser the
preview and the deploy use. Commands cannot lie either.

### 5.3 The initial command set

Each is defined by intended *AST effect*, with toggle semantics (apply if
absent, strip if present):

| Command | Key | Effect (verified by oracle) |
|---|---|---|
| Toggle emphasis | `Ctrl/Cmd+I` | selection becomes / un-becomes an `emphasis` inline |
| Toggle strong | `Ctrl/Cmd+B` | selection becomes / un-becomes a `strong` inline |
| Toggle code | `Ctrl/Cmd+\`` | selection becomes / un-becomes a `code` inline |
| Set heading 0–3 | `Ctrl/Cmd+0..3` | current block's `heading.level` (0 = demote to paragraph) |
| Toggle pull-quote | `Ctrl/Cmd+Shift+P` | current paragraph ↔ `pull_quote` |
| Toggle blockquote | `Ctrl/Cmd+Shift+.` | current block ↔ `block_quote` |
| Insert divider | `Ctrl/Cmd+Shift+-` | a `divider` block at the caret line |
| Insert link | `Ctrl/Cmd+K` | wrap selection as a `link`, caret lands in the URL slot |

- **Inline toggles** operate on `[selectionStart, selectionEnd)`; with an empty
  selection they insert the marker pair and place the caret between them.
- **Block commands** operate on the block containing the caret, located via the
  §4 mapping. Because `block_quote` is unaddressable in the DOM (§3), block
  commands locate the target via the **AST block list keyed by offset**, not via
  a preview element — the mapping must therefore index *all* blocks for command
  targeting even though only addressable ones get a highlight element. (Two
  indices, one parse: `highlightIndex` = addressable-with-element;
  `commandIndex` = every block with a position.)

### 5.4 Undo must survive (decision)

`textarea.value = …` and `setRangeText()` **destroy the native undo stack** — so
"rely on native undo for v1" (`SCRIPTORIUM.md` §10) silently fails the moment a
command runs. Decision for this layer:

> Commands apply their text change via **`document.execCommand("insertText", …)`
> on a focused textarea with the target range selected.** Despite being
> deprecated, it is the only method that *inserts into the native undo stack*
> across current browsers, so `Ctrl+Z` cleanly reverses a command as one step.
> No custom undo history in v1.

If a future browser drops `execCommand`, the fallback is a document-level
snapshot stack — but that is explicitly out of scope here and gets its own
decision when forced.

### 5.5 Command surface (UI)

- **A thin toolbar** above the editor pane (bold/italic/code, heading select,
  quote, link, divider) — discoverable, low-chrome, matches the existing minimal
  aesthetic. Buttons reflect state (active when caret is inside that node).
- Keybindings as in the table. The existing `Ctrl+S` interception pattern is the
  model: intercept the chord, `preventDefault`, run the pure command, apply via
  §5.4.
- **Shipped (was deferred):** a `/` slash-menu — see §14. The toolbar proved the
  command model, so the slash menu, command palette, and find/replace were built
  on top of it.

## 6. Feature three — select-this-node

Falls out of §4 + a selection write:

- **"Select block"** (e.g. `Ctrl/Cmd+L`, or double-click the preview block):
  `setSelectionRange(block.start, block.end)`. Now any inline command applies to
  the whole block; native copy/cut/paste work on it for free.
- Extending to "select node and its children" for containers is the same call
  with the container's span — which requires container positions that don't
  exist yet (§3), so it is **bounded to addressable blocks in v1** and noted as a
  grammar gap to feed back into the AST dialect.

## 7. What this layer must NOT do (boundary protection)

- No `contenteditable`, no custom caret, no rich editing surface — ever.
- No reformatting/normalizing the buffer *under the caret while typing*. The only
  writes to the buffer are (a) explicit section load, (b) an explicit command.
- No second parser, no preview-only heuristic. The mapping and every command
  consume `parse(buffer)` from the one authority. If a command needs grammar
  knowledge the parser doesn't expose, **extend the parser**, don't reimplement a
  shadow of it here.

## 8. Testing

The pure core is the point — most of this is Node-testable without a DOM:

- **Mapping unit tests** (`scriptorium-regression.js` additions): for fixture
  buffers, assert `blockAtOffset(o)` returns the right block across boundaries,
  gaps, leading-heading offsets, and empty buffers.
- **Command oracle tests**: for each command and a matrix of selections
  (mid-word, whole-word, empty, across a marker, on each block type), assert the
  re-parsed AST has the intended node — *and* that a toggle round-trips
  (apply→apply returns an equivalent AST). This is the command analogue of the
  equivalence oracle.
- **Boundary-failure tests**: cases where a command *should* refuse (e.g.
  emphasis where markers won't parse) assert it reverts and emits a diagnostic
  rather than producing mangled text.
- **DOM-level sync** (Playwright, the existing dep): caret move → correct
  `.active-block`; preview click → correct `selectionStart`. Thin; the logic is
  already covered by the pure mapping tests, so these only prove the wiring.

## 9. Architecture / where the code goes

Keep `editor.js` as the wiring/orchestration shell and extract the new logic into
small browser-IIFE-global modules under `scriptorium/`, each also requireable in
Node for tests (the `core/render/parse` dual-mode pattern):

- `scriptorium/mapping.js` — pure offset↔block index + `blockAtOffset`. No DOM.
- `scriptorium/commands.js` — the pure command functions + the oracle harness.
  No DOM (takes `parse` injected, returns proposed buffer state).
- `editor.js` — owns the DOM: builds the indices from a parse, wires sync
  listeners, binds keys/toolbar, applies command results via `execCommand`.

This keeps the testable brain (`mapping`, `commands`) free of the browser and
honors the spine: both import the one parser, neither forks it.

## 10. Phasing

- **P3a — sync.** The mapping + caret→highlight + click→caret + source-drives
  scroll. Ships the "alive" feeling. (Smallest, highest feel-per-effort.)
- **P3b — commands.** The command model, oracle, `execCommand` apply, the inline
  + heading set, the toolbar. Ships "fast hands."
- **P3c — select-node + remaining block commands.** Pull-quote/blockquote/divider
  toggles, select-block. Ships "structural."

Each is a per-checkpoint commit and leaves the editor usable.

## 11. Decisions made here (call out / override me)

1. **Scroll sync is one-way (source→preview) in v1.** §4.4.
2. **Undo via `execCommand("insertText")`, no custom history.** §5.4.
3. **Normalize `\r\n?`→`\n` once on load, then never.** §3.1.
4. **Toolbar first; slash-menu, palette, and find/replace built on the proven
   command model.** §5.5, §14.
5. **Container blocks (`block_quote`/`list`/`divider`) get command targeting via
   the AST offset index, but no preview highlight element, in v1.** §5.3.

## 12. Open questions

- Active-block highlight while *typing inside* a block: pulse once vs steady vs
  off-while-typing? (Lean: steady, no scroll on intra-block typing — §4.2.)
- Heading "demote to paragraph" (level 0): keep the heading text as a paragraph,
  obviously — but does it strip a now-orphaned blank line? (Lean: oracle decides;
  whatever re-parses cleanly.)
- Do we expose the "stripped from published page" mark (§3.1) as a preview
  affordance too (dimmed leading heading), or outline-only? (Lean: outline-only
  in v1, preview stays a faithful full render.)

## 13. Map / related docs

- `docs/specs/SCRIPTORIUM.md` — the parent; this is its §8 P3, deepened.
- `docs/specs/AST-DIALECT.md` — the grammar commands must honor; the unaddressable
  containers (§3) are feedback *to* this doc.
- `docs/specs/AST-ANCHORS-SPEC.md` — the source-position / passage-anchor
  machinery the mapping rides.
- `docs/specs/SCRIPTORIUM-RUST-PARSER.md` — the crate-free Rust port of the parser
  that must satisfy this layer's coordinate contract (§3.1) byte-for-byte; its
  §4.2 is the UTF-16 offset reconciliation that keeps the caret↔node mapping
  exact.

## 14. The command & navigation & feel layer (shipped)

Built on top of the proven command model (§5), all **above the caret** (§4):
overlays and buffer text-surgery only, never a re-solved editing surface. The
brains are pure, dual-mode, and unit-tested in `scripts/tests/scriptorium-regression.js`;
`editor.js` owns the DOM and maps ids to actions that ride the oracle-verified
commands.

**Command surfaces**
- **Command palette** (`Ctrl/Cmd+Shift+P` — `Ctrl+K` is Link). A fuzzy launcher
  over every command + navigation (jump to a section, jump to any block) +
  editor actions. Brain: `palette.js` (`fuzzyMatch`/`filter` with match-position
  highlighting).
- **Slash menu** (`/` at a line/word start). A caret-anchored popup of block
  commands, filtered as you type; accept removes the `/query` then runs the
  command. Brain: `palette.js` `slashContext` (never triggers on `http://`,
  `and/or`, `a/b`); caret pixel position via a mirror-div helper.

**Find & replace** (`Ctrl/Cmd+F` / `Ctrl/Cmd+H`). Match count, next/prev with
wrap, case / whole-word / regex toggles, invalid-regex feedback, replace-current
and replace-all. Brain: `find-replace.js` — matching always via one compiled
RegExp (literal queries escaped) so case-insensitivity can't desync offsets;
edits apply via `execCommand` so one `Ctrl+Z` reverses them.

**Block operations** (`Alt+↑`/`Alt+↓` move; duplicate/delete via the palette).
Brain: `block-ops.js` — move / duplicate / delete the caret's block by line-span
surgery; the result re-parses to the same blocks reordered/copied/removed.

**List continuation** (`Enter` in a list item). Continues the list with the next
marker, or ends it on an empty item. The boundary-respecting kind of smart
typing (§7): a single explicit edit on Enter, never ambient reflow. Brain:
`list-continue.js`.

**Feel & utility**
- **Focus / typewriter mode** — dims non-active preview blocks, centers the caret
  line. **Autosave** (off by default) — debounced idle save when dirty.
  **Light/dark theme** — persisted to `localStorage`. **Reading time** in the
  stats bar (~200 wpm). **Prev/next section**, **copy section text**, **trim
  trailing whitespace**, and a **keyboard-shortcuts overlay** — all palette
  actions.

Everything here is additive and behind new keys/triggers; the default authoring
path (type + preview) is untouched, and nothing forks the parser.
