#!/usr/bin/env node
"use strict";

// Golden-fixture generator for the parse.js cutover (SCRIPTORIUM-RUST-PARSER.md
// §14.3 step a). Snapshots the JS authority's parseDocument output over the
// deterministic oracle inputs (corpus + adversarial + a FIXED fuzz seed/count)
// into a committed golden file. After parse.js is deleted, the parse-side oracles
// (rust-parser / rust-wasm / rust-content-ast) compare the Rust parser against
// these goldens instead of a live JS reference — a regression guard, since the
// live differential already proved Rust ≡ JS.
//
// Index-aligned with shared.allInputs() at GOLDEN_FUZZ, so an oracle regenerates
// the same inputs and compares golden[i] to its Rust output. sourceName is null
// (the bare parseDocument shape); the content-ast oracle re-projects via the
// surviving core.js (withoutLeadingHeadings) and sets sourceName itself.
//
// Run: node scripts/tests/generate-ast-goldens.js   (writes the golden file)

const fs = require("node:fs");
const path = require("node:path");

// Anchor directly to the JS parser, NOT ast/index.js — index.js now sources
// parseDocument from the wasm (the cutover), so going through it would make the
// goldens "wasm ≡ wasm". The goldens must capture the JS authority (parse.js)
// while it survives, so the Rust parser is held to an independent reference.
// parse.js + the goldens + this generator retire together at cutover step f.
const core = require("../ast/core.js");
const parse = require("../ast/parse.js");
const shared = require("./lib/parser-oracle-corpus.js");

// Fixed so the golden is reproducible and bounded (the live oracle still cranks
// fuzz to 50k against the JS reference until the cutover removes it).
const GOLDEN_FUZZ = 2000;

const OUT_DIR = path.join(shared.ROOT, "scripts", "tests", "goldens");
const OUT_PATH = path.join(OUT_DIR, "parse-ast.json");

function build() {
  process.env.SCRIPTORIUM_FUZZ = String(GOLDEN_FUZZ);
  const { corpus, adversarial, fuzz, inputs } = shared.allInputs();
  // Compact canonical JSON per input (lone surrogates escaped as \uXXXX → valid
  // JSON). Stored as strings; an oracle JSON.parses each for a structural compare.
  const asts = inputs.map((input) => JSON.stringify(parse.parseDocument(input)));
  return {
    note: "JS parseDocument goldens for the parse.js cutover; see generate-ast-goldens.js.",
    astVersion: String(core.VERSION),
    fuzz: GOLDEN_FUZZ,
    counts: { corpus: corpus.length, adversarial: adversarial.length, fuzz: fuzz.length, total: inputs.length },
    asts,
  };
}

function main() {
  const golden = build();
  const serialized = JSON.stringify(golden) + "\n";
  const check = process.argv.includes("--check");

  if (check) {
    const actual = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, "utf8") : "";
    if (actual !== serialized) {
      console.error("Out of date: scripts/tests/goldens/parse-ast.json");
      console.error("Run: node scripts/tests/generate-ast-goldens.js");
      process.exit(1);
    }
    console.log("AST goldens are up to date (" + golden.counts.total + " inputs).");
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, serialized, "utf8");
  console.log(
    "Wrote scripts/tests/goldens/parse-ast.json (" +
    golden.counts.total + " inputs: " + golden.counts.corpus + " corpus, " +
    golden.counts.adversarial + " adversarial, " + golden.counts.fuzz + " fuzz; ast " +
    golden.astVersion + ")"
  );
}

main();
