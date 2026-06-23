#!/usr/bin/env node
"use strict";

// The WASM equivalence oracle (SCRIPTORIUM-RUST-PARSER.md §6, R1): instantiate
// the SAME Rust parser compiled to wasm32 and assert its AST is structurally
// identical to the ONE JS parse authority over the shared corpus + adversarial +
// fuzz set. This is the artifact the browser editor loads, so proving the .wasm
// is byte-identical (in Node, which runs wasm natively) covers the parser; the
// in-browser wiring check (Playwright) is the remaining mile.
//
// It drives the ACTUAL shipped browser glue (scriptorium/wasm-parser.js) via a
// fetch shim, so the editor's real load/parse path is what gets tested — not a
// parallel copy. The glue is crate-free (no wasm-bindgen, §7).

const fs = require("node:fs");
const path = require("node:path");

const ast = require("../ast/index.js");
const shared = require("./lib/parser-oracle-corpus.js");
const wasmGlue = require("../../scriptorium/wasm-parser.js");

const ROOT = shared.ROOT;
const WASM = process.env.SCRIPTORIUM_PARSER_WASM && process.env.SCRIPTORIUM_PARSER_WASM.trim()
  ? path.resolve(process.env.SCRIPTORIUM_PARSER_WASM.trim())
  : path.join(ROOT, "scriptorium", "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");

// Shim fetch so the browser glue's load() can read the local .wasm file. This is
// the only browser-ism the glue needs; everything else (WebAssembly, DataView,
// TextDecoder, BigInt) exists in Node.
global.fetch = function fetchShim(url) {
  return Promise.resolve({
    ok: true,
    status: 200,
    arrayBuffer: function () {
      const b = fs.readFileSync(url);
      return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    },
  });
};

async function main() {
  if (!fs.existsSync(WASM)) {
    console.warn(
      "SKIP rust-wasm-oracle — wasm not built at " + path.relative(ROOT, WASM) + ".\n" +
      "  Build it first:  npm run build:rust-wasm"
    );
    process.exit(0);
  }

  try {
    await wasmGlue.load(WASM);
  } catch (e) {
    console.error("rust-wasm-oracle: glue failed to load the wasm: " + e.message);
    process.exit(1);
  }

  const parse = wasmGlue.parseDocument;
  const { corpus, adversarial, fuzz, inputs } = shared.allInputs();

  let failures = 0;
  const MAX_REPORT = 20;
  for (let i = 0; i < inputs.length; i += 1) {
    let wasmTree;
    try {
      wasmTree = parse(inputs[i]);
    } catch (e) {
      failures += 1;
      if (failures <= MAX_REPORT) {
        console.error("FAIL #" + i + " — wasm parse threw / bad JSON: " + e.message);
        console.error("  input: " + shared.snippet(inputs[i]));
      }
      continue;
    }
    const d = shared.diffDeep(ast.parseDocument(inputs[i]), wasmTree, "$");
    if (d) {
      failures += 1;
      if (failures <= MAX_REPORT) {
        console.error(
          "FAIL #" + i + " (" + shared.regionFor(i, corpus.length, adversarial.length) +
          ") at " + d.path + " — " + d.why
        );
        console.error("  input: " + shared.snippet(inputs[i]));
        console.error("  JS  : " + JSON.stringify(d.a));
        console.error("  wasm: " + JSON.stringify(d.b));
      }
    }
  }

  if (failures > 0) {
    console.error(
      "\nrust-wasm-oracle: " + failures + "/" + inputs.length + " inputs diverged" +
      (failures > MAX_REPORT ? " (showing first " + MAX_REPORT + ")" : "") + "."
    );
    process.exit(1);
  }
  console.log(
    "rust-wasm-oracle: " + inputs.length + " inputs byte-identical " +
    "(" + corpus.length + " corpus, " + adversarial.length + " adversarial, " + fuzz.length + " fuzz)."
  );
  console.log("Rust parser (wasm, via shipped glue) ≡ JS authority.");
}

main();
