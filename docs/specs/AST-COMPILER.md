# AST Compiler — Design of Record

> Canonical spec for the AST content pipeline. This is the document a future
> session reads to understand *why the reader is the way it is* without
> reverse-engineering commit history. If the code and this doc disagree, one of
> them is a bug — fix it, don't guess.

## The one invariant

**The live parser is the equivalence oracle.** A section's compiled AST must be
byte-for-byte identical to what a fresh runtime parse of the same source
produces. Everything else is built on this: because compiled == parsed, anything
derived from the compiled AST (rendered DOM, passage IDs, search records,
anchors) is exactly what the parser would have produced. This is what dissolves
the entire "does the client parse match the index?" passage-alignment bug class
— not by testing for it, but by making the two *the same artifact*.

Guarded by `scripts/tests/content-ast-regression.js` (the oracle test) and
`scripts/tests/search-index-regression.js`.

## Data flow

```
raw/<n>.txt  ──parse──▶  contentAst  ──▶  data/compiled/<slug>.json   (hydration source)
 (authored      │         (the one          │
  source)       │          parse)           ├──▶  reader renders it  (content.js → render)
                │                            └──▶  data/search-index.json (search derives from it)
                └─ the ONLY place text becomes an AST: scripts/generate-content-ast.js → contentAstFor()
```

- **One parse authority.** `contentAstFor(essay, section)` in
  `generate-content-ast.js` is the single function that turns source text into a
  content AST. The compiler emits it to `data/compiled/`; the search-index
  generator imports the same function. There is no second parse.
- **The reader hydrates, never parses.** `content.js loadSection` reads
  `data/compiled/<slug>.json` and recomputes every projection (passages,
  searchable text, first paragraph, word count) from the stored AST with the
  same consume-side functions — same DOM, same `p1..pN` IDs.
- **Derive at deploy.** `npm run build:artifacts` regenerates every derived
  artifact from source; `.github/workflows/pages.yml` runs it on every push to
  `main` and publishes via GitHub Actions Pages. Derived artifacts are **build
  output, not committed** (see Net-off).

## Module layout (post-P5)

`scripts/ast/` splits along the parse/consume seam so the parser stops shipping
to the browser:

| File | Role | Ships to browser? |
|------|------|-------------------|
| `ast/core.js` | Shared spine: `BLOCK_TYPES`/`INLINE_TYPES`, `clampHeadingLevel`, `normalizeWhitespace`, `escapeHtml`, `inlineToText`, `blockToSearchableText`, `normalizeAstInput`, `getBlockChildren` | yes |
| `ast/render.js` | Consume-only: `renderBlocks`, `passagesFromDocument`, `toSearchableText`, `firstParagraphText`, `wordCount`, `astToLegacyBlocks`, `serializeBlocks`, `withoutLeadingHeadings` | yes |
| `ast/parse.js` | Text → AST: `parseDocument` + every tokenizer, `validateDocument`, `legacyBlocksToAst` | **no — Node build-time only** |
| `ast/index.js` | Full Node re-export (`core + render + parse`) — the unchanged `require()` surface | n/a (Node) |

**Why this shape:** keeping `ast/index.js` as the full Node re-export means the
compiler, the search-index generator, every `ast-tools/*` script, and every test
keep `require("./ast/index.js")` untouched — so the equivalence oracle and the
whole existing test suite guard the split itself. Only the browser changes: the
four HTML shells load `core` + `render` (not `parse`), and `content.js` drops
the parse fallback. A scary refactor made safe by not moving the Node surface.

The browser's entire AST usage is mediated through `content.js` (no other
browser script touches `RenaissanceAst`), so the blast radius on the client is
exactly: the `<script>` tags + `content.js`.

## What P5 removes (and why it's safe)

P5 drops the client parser. Removing it makes a cascade of things dead, because
**raw text is only useful to something that can parse it**:

1. **`content.js`'s `fetch(.txt)+parseDocument` fallback** — dead. The compiled
   artifact is the contract; a missing one is a *deploy* bug, not a runtime
   condition to parse around. The missing-artifact path becomes a clean,
   tested error ("Unable to load this section.").
2. **The embedded `chapters-data.js` fallback** + its loader in `content.js` +
   the chapter half of `generate-embedded-data.js` — dead. It existed to hand
   raw chapter text to the parser; with no parser, raw text has no consumer.
3. **`.txt` in the offline precache** — droppable. Offline reading runs entirely
   off the precached compiled artifact. (`.txt` stays in the repo as the
   authored *source* the compiler reads; it just stops being a runtime asset.)

This is safe **only because** of the rigor already in place — this is the Google
rigor that earns the Apple removal:

- the **equivalence oracle** proves compiled == parse for every section;
- the compiler **errors** if any source `.txt` is missing, so artifacts are
  always complete;
- the **`astVersion` guard** + single-parse-authority prevent grammar drift;
- the deploy's **determinism gate** fails *closed*, and GitHub Pages keeps
  serving the last good deploy — so a bad build is *stale-but-working*, never
  broken.

## Net-off (derived artifacts are build output)

The Apple answer, chosen deliberately: **derived artifacts are not committed.**
One human source of truth (the prose under `raw/` + `data/essays.json`), one set
of derived outputs, built invisibly at deploy. No committed blobs, no `--check`
freshness nag, no half-committed inconsistency.

**Gitignored (wholly generated):** `data/compiled/`, `data/search-index.json`,
`data/offline-assets.json`, `data/site-registry.json`, `scripts/essays-data.js`,
`sitemap.xml`, `feed.xml`, `rss.xml`. (`scripts/chapters-data.js` is removed
outright per above.)

**Stays committed (source files with a generated *region*, not whole files):**
`sw.js` (its `VERSION` constant) and `404.html` (its embedded recovery
catalogue). `build:artifacts` rewrites these regions in place.

**How correctness survives losing the committed copy:**

- The old `validate:*:check` gates (committed file == regenerated) are obsolete —
  there's nothing committed to drift. They're replaced by **build-then-test**:
  `build:artifacts` runs, then the regression tests (equivalence oracle,
  search-index, etc.) prove the freshly built artifacts are correct.
- The deploy's **determinism gate** still covers the in-place files (`sw.js`,
  `404.html`) via `git diff --quiet`. For the gitignored files, determinism is
  proven by a **double-build check**: build twice, assert the second build is a
  no-op (the regression suite already asserts content correctness).
- **Local dev stays one command:** a `predev` hook runs `build:artifacts` before
  `npm run dev`, so a contributor never hand-runs a build. The machinery is
  invisible even locally — the one concession that keeps net-off from becoming a
  papercut.

CI (`ci.yml`) gains a `build:artifacts` step before any suite that serves the
site, since the artifacts are no longer in the checkout.

## Invariants & their tests

The whole safety story should be a few green checks away:

- **Equivalence** — compiled AST == fresh parse (`content-ast-regression.js`).
- **Parser does not ship** — a regression walks the `<script>` graph of the four
  HTML shells and asserts none of the loaded modules reference `parseDocument`
  / the tokenizers. The point of P5 is an *enforceable* guarantee, not a hope.
- **Determinism** — `build:artifacts` run twice is a no-op.
- **Budget ratchet** — `asset-budget-regression.js` ceilings are lowered to lock
  in the shipped-JS reduction; a budget with slack you just created is not a
  budget.

## Phase log

- **P0–1** — build-time compiler (`generate-content-ast.js` → `data/compiled/`)
  + equivalence harness. `3ba6f38`.
- **P2** — runtime hydration with parse fallback. `4e550e4`.
- **P3** — search index derives from the single `contentAstFor()` authority.
  `2096a47`.
- **P4** — `build:artifacts` + `pages.yml`; Pages cut over `legacy → workflow`
  (live, proven). `2287629`, `6f696d5`, `5e62e05`.
- **P5** — module split (parser stops shipping) + drop the fallbacks + net off.
  *(this change)*

## Revert runbook

- **Undo the Pages cutover:** `gh api -X PUT repos/<owner>/<repo>/pages -f build_type=legacy`
  then re-point source to `main`/`/`. The last Actions deploy keeps serving until then.
- **Re-commit the artifacts (undo net-off):** remove the gitignore entries, run
  `npm run build:artifacts`, commit the outputs. The `--check` gates can be
  restored from git history.
- **Restore the client parser:** revert the P5 commit; `ast/index.js` Node
  surface was never changed, so only the browser `<script>` tags + `content.js`
  fallback come back.
- **Regenerate everything:** `npm run build:artifacts` (deterministic).
