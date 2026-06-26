"use strict";

// Golden reference for the parse-side equivalence oracles after the parse.js
// cutover (SCRIPTORIUM-RUST-PARSER.md §14.3). Loads the committed JS
// parseDocument snapshots (scripts/tests/goldens/parse-ast.json, produced by
// generate-ast-goldens.js) and the index-aligned inputs, so the Rust parser is
// compared against a frozen snapshot of the (now-retired) JS authority rather
// than a live parse.js. The live differential already proved Rust ≡ JS; this is
// the standing regression guard.
//
// The golden is index-aligned with shared.allInputs() at a FIXED fuzz count, so
// we force SCRIPTORIUM_FUZZ to that count while reproducing the inputs (then
// restore it), regardless of how high CI cranked the live-fuzz knob elsewhere.

const fs = require("node:fs");
const path = require("node:path");
const shared = require("./parser-oracle-corpus.js");

const GOLDEN_PATH = path.join(shared.ROOT, "scripts", "tests", "goldens", "parse-ast.json");

function loadGoldens() {
  if (!fs.existsSync(GOLDEN_PATH)) {
    throw new Error(
      "Missing AST goldens at " + path.relative(shared.ROOT, GOLDEN_PATH) +
      " — generate them: node scripts/tests/generate-ast-goldens.js"
    );
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

  // Reproduce exactly the inputs the golden was built from (it baked a fixed
  // fuzz count); leave the ambient SCRIPTORIUM_FUZZ untouched for other callers.
  const prev = process.env.SCRIPTORIUM_FUZZ;
  process.env.SCRIPTORIUM_FUZZ = String(golden.fuzz);
  let sets;
  try {
    sets = shared.allInputs();
  } finally {
    if (prev === undefined) {
      delete process.env.SCRIPTORIUM_FUZZ;
    } else {
      process.env.SCRIPTORIUM_FUZZ = prev;
    }
  }

  if (sets.inputs.length !== golden.asts.length) {
    throw new Error(
      "AST goldens are stale: " + golden.asts.length + " snapshots vs " +
      sets.inputs.length + " inputs (did raw/ change?). Regenerate: " +
      "node scripts/tests/generate-ast-goldens.js"
    );
  }

  return {
    corpus: sets.corpus,
    adversarial: sets.adversarial,
    fuzz: sets.fuzz,
    inputs: sets.inputs,
    // Parsed reference ASTs (bare parseDocument shape: sourceName === null).
    trees: golden.asts.map(function parse(s) { return JSON.parse(s); }),
    // The compact canonical JSON strings, untouched (some oracles re-project).
    raw: golden.asts,
    astVersion: golden.astVersion,
    fuzzCount: golden.fuzz,
  };
}

module.exports = { loadGoldens, GOLDEN_PATH };
