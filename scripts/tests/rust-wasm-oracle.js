#!/usr/bin/env node
"use strict";

// The WASM equivalence oracle (SCRIPTORIUM-RUST-PARSER.md §6, R1): instantiate
// the SAME Rust parser compiled to wasm32 and assert its AST is structurally
// identical to the ONE JS parse authority over the shared corpus + adversarial +
// fuzz set. This is the artifact the browser editor loads, so proving the .wasm
// itself is byte-identical (in Node, which runs wasm natively) covers the parser;
// the in-browser wiring check (Playwright) is the remaining mile.
//
// The glue is crate-free (no wasm-bindgen, §7): allocate a buffer, write the
// source as UTF-16LE, call parse_utf16, read the (ptr,len) of UTF-8 JSON it
// returns, decode, then free both buffers. Memory views are re-fetched after
// every call that can grow linear memory.

const fs = require("node:fs");
const path = require("node:path");

const ast = require("../ast/index.js");
const shared = require("./lib/parser-oracle-corpus.js");

const ROOT = shared.ROOT;
const WASM = process.env.SCRIPTORIUM_PARSER_WASM && process.env.SCRIPTORIUM_PARSER_WASM.trim()
  ? path.resolve(process.env.SCRIPTORIUM_PARSER_WASM.trim())
  : path.join(ROOT, "scriptorium", "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");

function makeParser(instance) {
  const ex = instance.exports;
  const decoder = new TextDecoder("utf-8");

  return function parse(str) {
    const len16 = str.length;
    const byteLen = len16 * 2;
    const inPtr = ex.alloc(byteLen);

    // Write the source as UTF-16LE (re-fetch the view: alloc may have grown mem).
    const inView = new DataView(ex.memory.buffer);
    for (let i = 0; i < len16; i += 1) {
      inView.setUint16(inPtr + i * 2, str.charCodeAt(i), true);
    }

    const packed = ex.parse_utf16(inPtr, byteLen); // i64 → BigInt
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);

    // Copy the JSON bytes out (re-fetch: parse may have grown memory).
    const outBytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
    const json = decoder.decode(outBytes);

    ex.dealloc(outPtr, outLen);
    ex.dealloc(inPtr, byteLen);
    return JSON.parse(json);
  };
}

async function main() {
  if (!fs.existsSync(WASM)) {
    console.warn(
      "SKIP rust-wasm-oracle — wasm not built at " + path.relative(ROOT, WASM) + ".\n" +
      "  Build it first:  cargo build --release --lib --target wasm32-unknown-unknown \\\n" +
      "                     --manifest-path scriptorium/rust/Cargo.toml"
    );
    process.exit(0);
  }

  const bytes = fs.readFileSync(WASM);
  let instance;
  try {
    const mod = await WebAssembly.instantiate(bytes, {});
    instance = mod.instance;
  } catch (e) {
    console.error("rust-wasm-oracle: failed to instantiate wasm (unexpected imports?): " + e.message);
    process.exit(1);
  }

  for (const fn of ["alloc", "dealloc", "parse_utf16", "memory"]) {
    if (!instance.exports[fn]) {
      console.error("rust-wasm-oracle: wasm is missing export '" + fn + "'.");
      process.exit(1);
    }
  }

  const parse = makeParser(instance);
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
  console.log("Rust parser (wasm) ≡ JS authority.");
}

main();
