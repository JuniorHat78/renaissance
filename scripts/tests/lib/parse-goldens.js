"use strict";

// Golden reference for the parse-side equivalence oracles after the parse.js
// cutover (SCRIPTORIUM-RUST-PARSER.md §14.3). The committed, FROZEN snapshot
// (scripts/tests/goldens/parse-ast.json) holds the inputs AND the JS
// parseDocument output for each, so the Rust parser is compared against a frozen
// snapshot of the (now-deleted) JS authority rather than a live parse.js. The
// live differential already proved Rust ≡ JS; this is the standing regression
// guard, and it is fully self-contained — it no longer reconstructs inputs from
// raw/, so a later corpus change cannot make it stale (and there is no JS parser
// left to regenerate it from). See generate-ast-goldens.js (retired with parse.js).

const fs = require("node:fs");
const path = require("node:path");
const shared = require("./parser-oracle-corpus.js");

const GOLDEN_PATH = path.join(shared.ROOT, "scripts", "tests", "goldens", "parse-ast.json");

function loadGoldens() {
  if (!fs.existsSync(GOLDEN_PATH)) {
    throw new Error("Missing AST goldens at " + path.relative(shared.ROOT, GOLDEN_PATH) + ".");
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
  const inputs = golden.inputs;
  const c = golden.counts;

  if (!Array.isArray(inputs) || !Array.isArray(golden.asts) || inputs.length !== golden.asts.length) {
    throw new Error("AST goldens are malformed (inputs/asts length mismatch).");
  }

  // Slice the frozen input list back into its regions via the recorded counts.
  return {
    corpus: inputs.slice(0, c.corpus),
    adversarial: inputs.slice(c.corpus, c.corpus + c.adversarial),
    fuzz: inputs.slice(c.corpus + c.adversarial),
    inputs: inputs,
    // Parsed reference ASTs (bare parseDocument shape: sourceName === null).
    trees: golden.asts.map(function parse(s) { return JSON.parse(s); }),
    // The compact canonical JSON strings, untouched (some oracles re-project).
    raw: golden.asts,
    astVersion: golden.astVersion,
    fuzzCount: golden.fuzz,
  };
}

module.exports = { loadGoldens, GOLDEN_PATH };
