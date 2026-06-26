# Scriptorium — the authoring instrument

> The design of record for Renaissance's local authoring tool. A *scriptorium*
> is the room where manuscripts were written and copied by hand; this is that
> room for this site. It is the second great project-within-a-project, the
> authoring counterpart to the AST compiler (`docs/specs/AST-COMPILER.md`).
>
> Status: **spec / P0 not yet started.** Doc-driven — this file is written first,
> we build to it, and the planning prose retires when it ships (the convention
> established by the AST compiler).
>
> Last refreshed: 2026-06-24.

---

## 1. What Scriptorium is (and is not)

Scriptorium is a **zero-dependency, local-only authoring tool** for the
Renaissance essays. It is the missing front-end of the content pipeline: today
authoring means *edit a `.txt` by hand, separately hand-maintain `essays.json`,
then run a build and hope they didn't drift*. Scriptorium replaces that with one
surface that writes the prose **and** its metadata together, previews exactly
what will ship, and surfaces the AST's own diagnostics as you type.

It **is**:
- a tool for *the author*, run on the author's own machine;
- frameworkless and dependency-free, in the same spirit as the served site;
- a hard customer of the existing AST — it rides the AST for preview,
  diagnostics, structure, and commands.

It is **not**:
- shipped to readers. It never enters the served output, the precache, the
  asset budget, or the cross-browser gauntlet. (See §6, Quarantine.)
- a WYSIWYG / contenteditable editor. The caret stays the browser's problem.
  (See §4.)
- a second parser, a second renderer, or a second grammar. (See §2.)

## 2. The spine — one invariant

The AST compiler's load-bearing idea was **compiled == parsed**. Scriptorium's is
its authoring analogue:

> **The editor never forks the grammar. It authors *through the one parse
> authority*, exactly as the reader hydrates *through the one consume authority*.**

Concretely: what the author types is turned into an AST by the **same**
`contentAstFor` / parse authority the compiler uses — since the cutover
(`SCRIPTORIUM-RUST-PARSER.md` §14) that authority is the crate-free **Rust core**
in `rust/` (native bins for the build, wasm in the editor), behavior-identical to
the retired `parse.js`. There is no editor-private parse. (Later references below
to `parse.js` / `DIAGNOSTIC_CODES` / position-stamping name that same contract,
now fulfilled by the Rust parser.) Therefore the chain is closed end to end:

```
author's buffer  ─parse(one authority)→  AST  ─compile→  data/compiled/<slug>.json
                                          │
                                          └─render(render.js)→ preview == shipped DOM
```

**buffer == compiled == rendered == shipped**, all provably one artifact. The
reader "hydrates, never parses"; the editor "authors through the one parser,
never a second one." Because of this, the editor *cannot preview a lie* — the
preview is `render(parse(buffer))` using the exact modules the deploy uses. This
extends the equivalence oracle one layer up, into authoring, and dissolves the
"does my draft preview match the published page?" bug class the same way the
oracle dissolved passage-alignment.

**Guard:** a Scriptorium regression asserts that the editor's preview render of a
buffer is byte-identical to compiling that buffer through `build:artifacts` and
rendering the stored AST. If those ever diverge, the editor has grown a second
parse path and the build fails closed.

## 3. The clunk it kills — prose/metadata drift

The prose source of truth (`raw/<slug>/<n>.txt`) is clean. The clunk is
`data/essays.json`: `section_order` and per-section `section_meta`
(title/subtitle) are hand-maintained *separately* from the files, so they drift —
add `11.txt` but forget `11` in `section_order`; rename a section's spirit in the
prose but leave the old `section_meta.title`.

Scriptorium is the **only writer of both**, so it makes drift unrepresentable:
- creating/removing a section writes the `.txt` **and** updates `section_order`
  in one atomic operation;
- `section_meta` is edited in the same surface as the prose it titles;
- a **project doctor** (mirroring `ast doctor`) refuses to save a state where
  `section_order`, the files on disk, and `section_meta` keys disagree.

This is the same move as the oracle: don't *test against* drift, make the drifted
state impossible to author.

## 4. The caret boundary — how far we ride the AST

The hard, expensive part of any editor is the **editing surface** (caret,
selection, IME, undo/redo, mobile). That is precisely what ProseMirror /
CodeMirror / Monaco spend tens of thousands of lines on. Scriptorium does **not**
re-solve it. The editing surface is a plain `<textarea>`; the browser owns the
caret.

The ambition goes *above* the caret, not into it. The key enabler already exists:
**`render.js` stamps `data-source-start` / `data-source-end` on passages**, so the
AST carries source positions. That lets Scriptorium map **caret offset → AST
node** over a plain textarea — a *structural* feel with none of the
contenteditable tarpit:

| Concern | Owner |
|---|---|
| Glyph entry, caret, selection, IME, undo | the `<textarea>` (browser) |
| Navigation, outline, fold, "select this node" | the AST (source positions) |
| Commands (wrap emphasis, promote pull-quote, etc.) | AST-aware, applied as text surgery on the buffer |
| Diagnostics, preview, structure | the AST (parse + render) |

**Text is the source of truth for *content*; the AST is the source of truth for
*navigation, structure, and commands*.** We ride the train for everything except
typing the letters. This boundary is the whole design — protect it.

## 5. The workbench reunified

The AST workbench (`scripts/ast-tools/`: doctor, corpus lint, report, compare,
fixtures, tree/explain) is rich but currently has no day-to-day *user* — it risks
becoming an orphan project. Scriptorium gives it a home: the workbench becomes
the editor's intelligence layer.

- **Live diagnostics** — `parse.js`'s `DIAGNOSTIC_CODES` (unmatched emphasis /
  strong / code, unsafe link URL, heading-level clamp, CRLF/BOM) surfaced inline
  as you type.
- **Outline / structure** — from the AST passages.
- **Fixture capture** — "save current section as a test fixture"
  (`ast:fixture:from-corpus` behind a button).
- **Equivalence badge** — a live "this ships identically" indicator backed by the
  oracle.
- **Build + preview the real site** — one-click `build:artifacts`, then open the
  served pages.

## 6. Quarantine (firm)

Scriptorium is local author tooling and must never leak into the shipped site.

- Lives entirely under **`scriptorium/`** (server + editor assets).
- **Dependency direction is one-way:** `scriptorium/` may import from the site
  (`scripts/ast/*`, `scripts/generate-content-ast.js`); the **site must never
  import from `scriptorium/`.** The day the served bundle needs the author
  server to function, the quarantine has failed.
- Excluded from the deploy stage (`_site`), the precache (`sw.js` PRECACHE), the
  asset budget, and the browser gauntlets. It gets its *own* small regression
  (the spine guard §2 + atomic-write + doctor), not the reader CI.
- A doctor/CI check enforces "site does not import scriptorium" the way
  `ast doctor` enforces "parser does not ship."

## 7. The local server

A tiny zero-dep Node HTTP server (`node scriptorium/server.js`), same ergonomics
as today's `python -m http.server` dev flow, but able to **write**:

- Reads/writes `raw/<slug>/<n>.txt` and `data/essays.json`.
- **Atomic writes only** — write to a temp file, `fsync`, rename into place;
  never a torn file mid-save.
- Refuses paths outside the project content roots (no traversal).
- Optional: git-aware status surface (dirty/clean per file) since it sits in the
  repo.

> Chooser note: a local Node server is preferred over the File System Access API
> — it works in any browser, does true atomic writes, and is git-aware, where the
> FSA API is Chromium-only and sandboxed.

## 8. Phase plan (P0–P5)

Each phase is shippable and leaves the tool usable. Per-checkpoint commits.

- **P0 — walking skeleton + the load-bearing bit.** The Node server (§7): open a
  section, see its text, save it back, atomically. The spine contract wired in:
  the editor parses through the one authority (§2). No preview yet. Success = a
  section round-trips to disk safely and the spine guard passes.
- **P1 — the loop.** Split-pane: `<textarea>` + live `render.js` preview. Now it
  is an editor.
- **P2 — live diagnostics.** Inline surfacing of `parse.js` `DIAGNOSTIC_CODES`.
- **P3 — structural feel. [SHIPPED]** caret↔node mapping via source positions:
  two-way source↔preview sync, "select this node," AST-aware (oracle-verified)
  commands. The "push it" phase. **Deepened into its own design of record:**
  `docs/specs/SCRIPTORIUM-EDITOR.md`. A zero-dep installable-PWA capstone
  (manifest + `/scriptorium/`-scoped service worker + `--open` launcher) makes
  the editor a real desktop app without Electron.
- **P4 — kill the clunk.** Scriptorium owns `essays.json`: create / reorder /
  retitle sections from the UI, drift made unrepresentable, project doctor (§3).
- **P5 — reunite the workbench.** Fixture capture, equivalence badge, corpus-lint
  panel, one-click `build:artifacts` + preview the real site (§5).

## 9. Risks & honest notes

- **Scope.** This is genuinely a second large project. The "project-within-a-
  project" framing is correct and means committing; it is *not* a side quest.
- **It pulls focus from parked reader work** (`section.js` split, magic-texture
  polish, reading-attention feel pass). That is an acceptable trade *if chosen on
  purpose* — name it, don't drift into it.
- **The upside that justifies it:** building Scriptorium is the hardest possible
  test of whether the AST dialect is actually sound. The editor is the AST's most
  demanding customer and will surface every soft spot in the grammar — that
  feedback loops straight back into `docs/specs/AST-DIALECT.md`.
- **The caret boundary (§4) is the line that keeps this finite.** Every time the
  scope wants to grow *into* the editing surface (rich contenteditable, custom
  caret), say no. Ambition goes above the caret, never into it.

## 10. Open questions (decide before/within P0)

- Name of the served folder confirmed as `scriptorium/`? (on-theme; matches the
  warm-book voice).
- Does the server expose a git status surface in P0, or is that deferred to P5?
- Undo/redo: rely entirely on the textarea's native stack for v1, or add a
  document-level snapshot history? (Lean: native for v1.)
- Multi-essay: does P4's create-essay flow scaffold `raw/<slug>/` + an
  `essays.json` entry in one move, or is essay-creation out of scope for v1
  (section-level authoring only)?

## 11. Map / related docs

- `docs/specs/SCRIPTORIUM-EDITOR.md` — the living editor: the §8 P3 structural
  layer (two-way source↔preview sync + AST-aware commands), deepened.
- `docs/specs/SCRIPTORIUM-RUST-PARSER.md` — the §7 server + the parser ported to
  a single crate-free Rust binary (WASM in the browser, native in the binary),
  killing the last runtime dependency (Node). The second parser is permitted
  only because the equivalence oracle proves it byte-identical, and is retired
  back to one parser at cutover. The "actual zero-dep desktop app" beyond the §8
  PWA.
- `docs/specs/AST-COMPILER.md` — the parse/consume authority Scriptorium rides.
- `docs/specs/AST-DIALECT.md` — the grammar the editor authors in (and stresses).
- `docs/specs/AST-ANCHORS-SPEC.md` — source positions / passage anchors that make
  the caret→node mapping (§4) possible.
- `docs/PROJECT-STATE.md` — overall orientation; add Scriptorium to §9 once P0
  lands.

## 12. Review findings (opened 2026-06-23; status refreshed 2026-06-24)

An adversarial design review against the real AST surfaced blockers the P0–P2
scaffold did not address. Recorded here so they're not lost; each now carries a
status.

**BLOCKERS**
1. **The §2 byte-identical guard tests a tautology, not the real risk.** It
   compares `contentAstFor(disk)` to the compiled artifact — both the *same Node
   path* — so it can't catch the actual divergence vector: the **browser**
   `core/render/parse.js` (mutating a shared global, load-order dependent) vs
   **Node** `ast/index.js` (frozen merged surface). Rewrite the guard to drive
   the browser modules (Playwright — already a dep) against a fresh Node compile.
   Also add `scriptorium/editor.html` to the `ast doctor` load-order check
   (`scripts/ast-tools/doctor.js` `SHELLS` only lists the four reader shells).
   — *Status: largely **resolved**. The **real** fix shipped (R1a): the WASM build
   runs the same parser the browser loads and is diffed against Node by the
   equivalence oracle (`scripts/tests/rust-wasm-oracle.js`, green in CI) — closing
   the browser-vs-Node vector via the shipped artifact. Editor load order is now
   guarded too, in `scripts/tests/scriptorium-regression.js` (its own suite — NOT
   the `ast doctor` `SHELLS` list, whose checks correctly reject `editor.html` for
   legitimately loading `parse.js` and `editor.js`). Remaining: a Playwright
   in-browser parity check for the final mile.*
2. **§4's "AST carries source positions for this use" is only partly true.**
   `render.js` stamps `data-source-start/end` only on heading/paragraph/
   pull_quote/list_item — **blockquote, list, and divider containers are
   unaddressable**, so "select this node" / node-aware commands silently exclude
   them. Worse: the shipped AST is `withoutLeadingHeadings`, but offsets are in
   **full-raw-file** coordinates — the editor must preview the *full* parse (it
   does), and the outline must mark leading headings as "stripped from the
   published page." Pin the coordinate space in the spec and enumerate which
   blocks are addressable. — *Status: largely **resolved** — `SCRIPTORIUM-EDITOR.md`
   §3 enumerates the addressable blocks and §3.1 pins the coordinate space
   (full-buffer UTF-16). Remaining: the outline affordance for stripped leading
   headings (an open question there, not a blocker).*
3. **The `raw/<slug>/<n>.txt` path model is `source_dir`-blind.** Paths are
   per-essay `source_dir`-relative (today `raw/<slug>/`, which *happens* to equal
   `raw/<slug>`); the server keys off `slug`. Resolve `source_dir` in the server
   and doctor before this diverges. Add a **slug-uniqueness** check — duplicate
   slugs collide on `data/compiled/<slug>.json` (compiler last-wins, reader
   first-wins → guaranteed divergence). — *Status: **RESOLVED (2026-06-24).**
   `server.js` now resolves the section path through `resolveSourceDir(slug)`
   (honoring the declared `source_dir`, falling back to `raw/<slug>` for an
   unregistered slug) and **refuses an ambiguous slug** at request time; the path
   is containment-checked under `PROJECT_ROOT`. `doctor.js` adds
   `checkSlugUniqueness` (a failing `slug-duplicate` issue). Both are covered by
   new units in `scripts/tests/scriptorium-regression.js` (`sourceDirForSlug`
   honor/fallback/duplicate + the doctor detection).*

**SHOULD-FIX**
- **Normalization is applied at three sites with two regexes** (`normalizeSource`
  strips `\r\n?`; the compiler strips only `\r\n`; `content.js` strips `\r\n?`).
  Decide where the editor normalizes (on load / save / never) and name it, or a
  lone `\r` breaks byte-identity. — *Status: **resolved for the editor** — load
  side: `SCRIPTORIUM-EDITOR.md` §3.1 normalizes `\r\n?`→`\n` once on load; save
  side: `server.js` `handlePutSection` now normalizes `\r\n?`→`\n` before the
  atomic write, so the editor never writes a stray `\r`. The broader
  regex-consistency across the shipped compiler/`content.js` is a separate
  pipeline cleanup, untouched here.*
- **Node-aware commands break native undo.** `setRangeText`/value surgery
  fragments the textarea undo stack, so "native undo for v1" silently fails once
  P3 lands. Decide `execCommand('insertText')` vs a snapshot stack *before* P3.
  — *Status: **decided + shipped** — `SCRIPTORIUM-EDITOR.md` §5.4: apply via
  `execCommand("insertText")` so `Ctrl+Z` reverses a command as one step.*
- **Command correctness must be parser-defined, not naive string wrapping.**
  Emphasis open/close is boundary-sensitive; wrapping `*…*` next to alphanumerics
  won't parse. Each command should re-parse and assert the intended node now
  exists, else revert (a per-command oracle). — *Status: **shipped** — the
  per-command oracle in `scriptorium/commands.js` (P3b/c), unit-tested.*
- **Quarantine needs a real check.** The asset-budget regex only matches
  `scripts/`/`styles/`, so it is *not* the enforcer. Add a dedicated grep over
  shipped HTML/JS + `sw.js` PRECACHE for the literal `scriptorium` path, and a CI
  job proving `build:artifacts` runs with `scriptorium/` deleted. — *Status:
  **resolved** — two enforcers now: `doctor.js` `runQuarantineCheck` greps shipped
  HTML + `scripts/` for `scriptorium/` references (CRITICAL on any hit), and the
  new `.github/workflows/scriptorium-quarantine.yml` deletes `scriptorium/` and
  proves `build:artifacts` still succeeds. (Extending the grep to the `sw.js`
  PRECACHE list specifically remains a minor nicety.)*
- **Doctor drift gaps:** draft (`published:false`) artifact handling; "authored
  subtitle that can never render" when `show_subtitles:false`; `section_meta` key
  type (string vs number) normalization; stale-artifact-with-no-source. —
  *Status: open.*

**DECIDE NOW (§10 answered by reality):** `source_dir` is per-essay and two
essays already exist (Q4 is not deferrable — it's the server's path contract).
— *Resolved 2026-06-24: the server and doctor now resolve per-essay `source_dir`
and enforce slug-uniqueness (blocker 3 above).* The **title's single home** must
still be decided before P1: the leading `#`/`##` in each `.txt` is stripped by
`withoutLeadingHeadings` and never reaches the reader, while `section_meta.title`
does — they currently coexist and disagree. *(Still open.)*
