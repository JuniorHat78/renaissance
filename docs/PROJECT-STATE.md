# Renaissance — State of the Project

> The orientation document. If you are a fresh agent or contributor, read this
> first: it explains *what this is, how it's built, why it's built that way, and
> where things stand*. It links out to the durable feature specs for depth.
> Pairs with the root `CLAUDE.md` (the short, always-loaded version).
>
> Last refreshed: 2026-06-27. AST compiler **P5** is shipped (the client parser
> was dropped and derived artifacts were "netted off"); **Scriptorium**, the local
> authoring tool, is the active second project-within-a-project (§9). The
> **parse.js cutover is complete** — the JS parser is deleted and a crate-free
> **Rust core at top-level `rust/`** is now the one parser (native bins for the
> build, wasm in the editor). The next frontier is a **true native desktop
> editor** (zero-dep, Win32 FFI); see §9.

---

## 1. What Renaissance is

A warm, book-style **static website for long-form essays** — a "reading
instrument" for continuous literary prose (not a blog, not a docs site, not a
CMS). One author, a small number of long essays, each split into numbered
sections. The whole experience is designed around *reading*: soft page
transitions, same-document continuity, a hidden search "spotlight," reading-
progress attention, offline reading, and graceful recovery.

- **Frameworkless and buildless to serve.** No React/Vue, no bundler, no
  transpile step in the served output. The browser loads plain `.js`, `.css`,
  and `.html`. There *is* a build step that derives artifacts from source (see
  §4), but the served site is just files.
- **Deployed to GitHub Pages under the `/renaissance/` subpath.** Every internal
  link must be relative — the site is served from `https://<user>.github.io/renaissance/`,
  not a domain root. (Tests run at server root and will NOT catch absolute-path
  404s — be careful with leading-slash URLs.)
- **The content is real.** `raw/etching-god-into-sand/` is a published
  ten-section essay; `raw/shadows/` is a second, *unpublished* draft essay used
  both as future content and as the multi-essay non-regression guard.

## 2. The content model (one source of truth)

```
raw/<slug>/<n>.txt      authored prose for section n (the human source of truth)
raw/<slug>/manifest.json{ "chapters": [1,2,...] }  section order on disk
data/essays.json        essay metadata: slug, title, summary, published_at,
                        social_image, source_dir, section_order, section_meta
                        (per-section title/subtitle), published flag
```

Everything else about content is **derived** from those two inputs. `published`
gates *visibility* (home listing, search index, sitemap, offline precache) — it
does **not** gate compilation. Drafts are compiled too, so a draft opened by
direct URL still renders (it just isn't linked or indexed).

## 3. The AST compiler — the spine of the project

This is the most important architectural idea, delivered as a multi-phase
"project-within-a-project" (P0–P5, all shipped). **Read `docs/specs/AST-COMPILER.md`
for the canonical design of record.** Summary:

- Prose is parsed into a small **content AST** (a tiny literary document
  grammar — headings, paragraphs, pull-quotes, blockquotes, lists, dividers,
  and inline emphasis/strong/code/links/hard-breaks; see `docs/specs/AST-DIALECT.md`).
- **The one invariant — the equivalence oracle:** a section's *compiled* AST
  must be byte-for-byte identical to what a fresh *runtime parse* of the same
  source produces. Because compiled == parsed, everything derived from the
  compiled AST (rendered DOM, `p1..pN` passage IDs, search records, anchors) is
  exactly what the parser would have produced. This dissolves the entire "does
  the client's parse match the search index?" passage-alignment bug class — not
  by testing around it, but by making the two *the same artifact*. Guarded by
  `scripts/tests/content-ast-regression.js`.
- **One parse authority:** `contentAstFor(essay, section)` in
  `scripts/generate-content-ast.js` is the single place text becomes an AST. The
  compiler emits `data/compiled/<slug>.json`; the search-index generator imports
  the same function. There is no second parse.
- **The reader hydrates, never parses.** `scripts/content.js` `loadSection`
  reads `data/compiled/<slug>.json` and recomputes every projection (passages,
  searchable text, first paragraph, word count) from the stored AST with the
  same consume-side functions. A missing/stale artifact is a clean error
  ("Unable to load this section."), **not** a reparse — since P5 there is no
  client parser to fall back to.

### The `scripts/ast/` module split (P5 → post-cutover)

The AST library is split along the parse/consume seam so the tokenizer stops
shipping to the browser. After the **parse.js cutover** (see §9) the JS parser is
gone; the parser is the Rust core, reached in Node through a thin wasm glue:

| File | Role | Ships to browser? |
|------|------|-------------------|
| `ast/core.js` | shared spine + every consume projection + `normalizeAstInput` | **yes** |
| `ast/render.js` | DOM render + HTML serialize | **yes** |
| `ast/parse-wasm.js` | registers `parseDocument` via the Rust **wasm** (self-contained; depends only on `rust/`) | **no — Node/build-time only** |
| `ast/validate.js` | `validateDocument` + helpers (survived parse.js's deletion) | **no — Node/build-time only** |
| `ast/index.js` | thin Node merge (core + render + validate + wasm parse) | n/a (Node) |

`core.normalizeAstInput` reaches the parser through **registration hooks** that
`parse-wasm.js` installs at load (the Rust wasm is the registered string parser).
In the browser neither file is loaded, so the hooks stay unregistered and a
raw-string input throws loudly — the reader only ever hands in already-parsed
ASTs. The Node `require("./ast/index.js")` surface is preserved, so the
equivalence oracle and the whole test suite guard the split. The browser's only
AST entry point is `content.js`; the four reader shells load `core.js` then
`render.js` (never `index.js`). An `ast doctor` check enforces "parser does not
ship," and the Scriptorium doctor enforces "parse-wasm depends only on `rust/`,
never on the editor app." (`parseInline` / `normalizeSource` / `legacyBlocksToAst`
were retired with parse.js — they had no live consumers.)

## 4. Build model — derive-at-deploy + net-off

**Derived artifacts are build output, not committed** (the "net-off," P5). One
command regenerates everything from source:

```
npm run build:artifacts
```

**Gitignored (wholly generated):** `data/compiled/`, `data/search-index.json`,
`data/offline-assets.json`, `data/site-registry.json`, `scripts/essays-data.js`,
`sitemap.xml`, `feed.xml`, `rss.xml`.

**Committed (because they hold a generated *region* inside a hand-authored file,
not a whole file):** `sw.js` (its cache `VERSION`, a hash of the precached
assets) and `404.html` (its inline recovery catalogue). `build:artifacts`
rewrites those regions in place.

**Why net-off:** one human source of truth, no committed blobs to drift, no
`--check` freshness nag, clean diffs. The trade-off — the build must run before
serving — is handled by:

- a `predev` hook (`npm run dev` builds first),
- a `build:artifacts` step in every CI job that serves the site,
- **`npm run ci:build-verify`** (`scripts/ci/verify-artifacts-build.js`) — the
  correctness gate that replaced the old eight `validate:*:check` gates: it
  builds, asserts the committed in-place files (`sw.js`, `404.html`) are fresh
  via `git diff`, then builds **again** and asserts every derived artifact is
  byte-identical (determinism). Content correctness is proven by the regression
  suite running against those freshly built artifacts.

> **GOTCHA:** if you edit any *precached* asset (anything in `sw.js`'s `PRECACHE`
> list — e.g. `ast/core.js`, `content.js`, `section.js`, `styles/site.css`), you
> must regenerate `sw.js`'s VERSION (`npm run cache-version:generate`, or just
> `npm run build:artifacts`) and commit it, or `ci:build-verify` fails the
> freshness gate. This is the gate doing its job.

## 5. Deploy

`/.github/workflows/pages.yml` is the **live deploy** for `main`. On every push
to `main` it runs `ci:build-verify` (build + determinism + freshness), stages
the working tree (minus VCS/CI/QA noise) into `_site`, and publishes via the
**GitHub Actions Pages** pipeline (the legacy "deploy from branch" mode was cut
over). A bad/non-deterministic build fails closed; GitHub Pages keeps serving
the last good deploy — stale-but-working, never broken. Reversible via the Pages
API (`build_type=legacy`); see the revert runbook in `AST-COMPILER.md`.

## 6. The reader experience (browser modules)

All browser scripts are **IIFE global modules** (`(function(){ ... window.X = ... })()`),
no imports. The dual-export UMD wrappers in `ast/*` are the exception (they
support both the browser global and Node `require`). Key shipped modules:

- `content.js` — the only browser consumer of the AST; loads essays + hydrates sections.
- `section.js` — the section reader (the heaviest module; a split is the top parked task).
- `essay.js`, `archive.js`, `archive-select.js` — essay overview + home archive.
- `router.js` — URL param parse/build, history, soft-navigation routing.
- `page-transition.js`, `reading-shell.js`, `continuity.js` — soft page
  transitions + same-document continuity between sections.
- `spotlight.js` + `oracle-client.js` + `search-oracle.js` — the hidden-index
  "spotlight" search (oracle is the current search authority; `search-engine.js`
  is the older/legacy engine being phased out).
- `search-page.js` — `search.html` (oracle-only; clean "unavailable" if the
  index can't load).
- `reading-attention.js`, `reading-state.js` — reading progress / attention.
- `recovery-engine.js` + `404.html` catalogue — graceful not-found recovery.
- `meta.js` — per-page metadata/OG. `theme.js` — light/dark. `pwa.js` + `sw.js` —
  offline/PWA. `preview-card.js`, `clipboard-citation.js` — hover previews, copy.

The four reader **shells** are `index.html` (home), `essay.html`, `section.html`,
`search.html`. `chapter.html` is a legacy redirect surface. Styling is a single
`styles/site.css`.

## 7. Tooling & tests

~47 regression suites under `scripts/tests/`, orchestrated through `package.json`:

- **`npm run check`** — source-level: syntax, the AST suite (`test:ast` =
  runtime regression + doctor + fixtures + corpus + cross-renderer compare),
  content validation. No artifacts needed.
- **`npm run ci:standalone`** — `ci:build-verify` → `check` → `test:standalone`
  (every Node-only regression: the oracle, search-index, site-registry,
  pwa-precache, asset-budget, html-validate, etc.). Self-contained.
- **Browser suites** (`ci:*`, Playwright via `scripts/ci/run-with-server.js`):
  cross-browser reader journey, page transitions, subpath, custom 404, a11y
  (axe), offline/SW, focus/keyboard, device matrix, slow-network, SW-update,
  passage-alignment, continuity, soft-nav, spotlight, transition-evidence.
- **AST tooling** under `scripts/ast-tools/` (doctor, fixtures, corpus lint,
  renderer compare, tree/explain/report) — a genuinely rich AST workbench.

### CI workflows (`.github/workflows/`)

- `ci.yml` — the gating PR/`main` suite (a `validate` job + a `cross-browser` matrix).
- `a11y-matrix.yml` — a 2⁴ factorial ablation of the accessibility audit (theme ×
  motion × viewport × forced-colors = 16 gating cells).
- `manual-checks.yml` — dispatchable per-suite runner (incl. `full-chromium`).
- `codeql.yml` — security/quality scanning.
- `nightly.yml`, `post-deploy-smoke.yml` — live-site smoke. `pages.yml` — deploy.
- `one-shot-claude-sprint.yml` — a (largely retired) autonomous-run harness.

## 8. Conventions (these are firm — see also the root `CLAUDE.md` + agent memory)

- **No `Co-Authored-By: Claude` trailer** on commits in this project.
- **Relative internal links only** (the `/renaissance/` subpath).
- **CI gating philosophy:** reserve hard gates for *deterministic correctness*.
  Fickle metrics (Lighthouse, visual diffs) **inform, never gate** — they warn.
  Flag drastic regressions for human review; never auto-fail a PR on noise.
- **Maximal, informative CI** is wanted; compute budget is not a constraint.
  Favor expansive matrices over minimal runs.
- **Working style:** drive autonomously, go fast / batch, but keep per-checkpoint
  commits. **Validate on Actions, not the laptop** (push and read the run rather
  than running browser suites locally). Doc-driven for landmark changes: write
  the spec first, build to it, retire the planning docs when done.
- **CI ground-truth discipline:** never trust `gh run watch --exit-status` — a
  cancelled run has reported exit 0. Verify with `gh run view <id>` + per-suite
  grep before believing green.
- Write commit messages via the Write tool to a temp file, not heredoc, to avoid
  permission prompts in unattended runs.

## 9. Where things stand (2026-06-27)

**Shipped & live:** the full AST compiler (P0–P5), derive-at-deploy, net-off, the
soft-nav reading shell, same-document continuity, oracle search + spotlight,
reading-attention, the 404/recovery magic, the rich a11y/device/network CI
gauntlets. PRs **#17** (P5 parser-drop + net-off) and **#18** (review-feedback +
CodeQL) landed on `main`.

**Scriptorium — the second project-within-a-project (active, on `feat/scriptorium`):**
A zero-dependency, local-only authoring tool that writes prose **and** its
metadata through the *one parse authority* (so the editor "cannot preview a
lie" — the authoring analogue of the equivalence oracle). The structural editor
layer (P3: two-way source↔preview sync, oracle-verified AST-aware commands,
select-node) is shipped, plus a zero-dep installable-PWA desktop capstone. It is
**quarantined** — never shipped to readers, never in the precache/budget/
gauntlets. Design of record: `docs/specs/SCRIPTORIUM.md` (+ `SCRIPTORIUM-EDITOR.md`).

**The crate-free Rust core — shipped (cutover complete, 2026-06-27).** The
speculative port is no longer speculative:
- The Rust crate is promoted to **top-level `rust/`** (a shared workspace: parser
  library + wasm + the build generator bins + the editor server bin). `scriptorium/`
  is the editor *app* on top; the reader build consumes `rust/` directly.
- **`scripts/ast/parse.js` is deleted.** The Rust core is the one parser — natively
  (the `content-ast` / `search-index` build bins, prefer-native-else-JS-via-wasm)
  and as wasm in the editor. AST goldens (`scripts/tests/goldens/parse-ast.json`)
  are a FROZEN self-contained snapshot of the retired JS authority; the parse-side
  oracles compare Rust against it.
- The **JS⇄wasm marshalling boundary was benchmarked and is NOT the bottleneck**
  (alloc churn = 0.2%; parse algorithm dominates; no latency problem). The
  optimization was *not pursued*; `npm run bench:marshalling` stays as a guard.
  Design of record: `SCRIPTORIUM-RUST-PARSER.md` §14 + `SCRIPTORIUM-WASM-MARSHALLING.md`
  (closed).

**Next frontier — a true native desktop editor (in design).** The destination is
a zero-dep native Windows app: hand-rolled **Win32 + COM/DirectWrite FFI** (the
dependency line drawn at the OS API; bindings hand-declared, no `windows-sys`), with
the editor's text engine (buffer, layout, caret, input) **owned by us** for total
control of feel, reusing the `rust/` parser in-process (no wasm, no marshalling).
The PWA was a stepping stone that "didn't feel right" — the engine, not the chrome,
is the reason. First move (decided): a **platform/render walking skeleton** (window
+ DirectWrite text + caret + keyboard) to de-risk the COM FFI and unlock the
feel-loop. An umbrella vision/architecture spec is being written; it supersedes the
older "Win32 + RichEdit" sketch in `SCRIPTORIUM-RUST-PARSER.md` (RichEdit = OS owns
the caret; the new direction owns the whole engine — opposite philosophies).

**Top parked / next work (in priority order):**
1. **Native editor umbrella spec + platform/render skeleton** (the active frontier).
2. **`section.js` physical split** — `section.html` is the heaviest shell; budget
   parked at 384KB (was 1024KB). The split returns it to a real ~256–300KB ceiling.
3. **A-phase checkpoint 4: magic texture polish** — spring easing, veil dissolve,
   arriving-words shimmer (high visual-review risk).
4. **Reading-attention feel pass** — tune WPM/read-fraction/velocity constants.
5. Bespoke typesetting (B-feel) and concordance / literary apparatus (C).

Note: editorial apparatus (footnotes/sidenotes) is deliberately **OUT** — the
essays are continuous prose; never fabricate apparatus.

## 10. Map of the docs

- `docs/specs/AST-COMPILER.md` — **the AST compiler design of record** (invariant,
  data flow, module layout, net-off, invariants & tests, phase log, revert runbook).
- `docs/specs/AST-DIALECT.md` — the supported prose grammar + legacy bridge boundary.
- `docs/specs/AST-ANCHORS-SPEC.md` — stable passage anchors (search/copy/arrival).
- `docs/specs/SCRIPTORIUM.md` — **the local authoring tool design of record**
  (spine invariant, prose/metadata drift doctor, caret boundary, quarantine,
  server, phase plan, review findings + status).
- `docs/specs/SCRIPTORIUM-EDITOR.md` — the structural editor layer (two-way
  source↔preview sync, the offset↔block mapping, AST-aware commands + oracle).
- `docs/specs/SCRIPTORIUM-RUST-PARSER.md` — the crate-free Rust core (oracle-validated
  byte-identical parser → WASM + native). **Parser cutover complete**; the native-app
  shell sections are being superseded by the forthcoming native-editor umbrella spec.
- `docs/specs/SCRIPTORIUM-WASM-MARSHALLING.md` — **closed** decision record: the
  JS⇄wasm boundary was measured and is not the bottleneck; `npm run bench:marshalling`
  kept as a regression guard.
- `docs/specs/ORACLE-SEARCH-SPEC.md`, `SEARCH-RANKING-SPEC.md` — search/ranking.
- `docs/specs/SPOTLIGHT-UX-SPEC.md`, `404-MAGIC-SPEC.md`, `HARDENING-GAUNTLETS-SPEC.md`.
- `docs/ARCHITECTURE.md` — system architecture + the derived-artifacts/net-off model.
- `docs/TRANSITION-SPOTLIGHT-SPRINT.md` — the most recent sprint dashboard (AST done).
- `docs/ROADMAP.md`, `docs/IDEAS.md`, `docs/EXPERIENCE.md`, `docs/INTERFACE-GRAMMAR.md`,
  `docs/QA.md` — roadmap, future syntax ideas, experience principles, UI grammar, QA.
- `docs/CLAUDE-AUTONOMOUS-SPRINT.md` — the autonomous-run brief (AST section marked done).
- `README.md` — quick start. Root `CLAUDE.md` — the always-loaded short orientation.
