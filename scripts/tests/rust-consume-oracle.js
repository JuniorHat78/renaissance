#!/usr/bin/env node
"use strict";

// The consume-projection oracle: the Rust passage projection must be structurally
// identical to core.passagesFromDocument (the stable p1..pN records that drive
// search / anchors / arrival) over corpus + adversarial + fuzz. With parse,
// render, and now the consume projections all in Rust, the whole content
// pipeline is oracle-proven. Verified locally via wasm.

const fs = require("node:fs");
const path = require("node:path");

const ast = require("../ast/index.js");
const shared = require("./lib/parser-oracle-corpus.js");

const ROOT = shared.ROOT;
const WASM = process.env.SCRIPTORIUM_PARSER_WASM && process.env.SCRIPTORIUM_PARSER_WASM.trim()
  ? path.resolve(process.env.SCRIPTORIUM_PARSER_WASM.trim())
  : path.join(ROOT, "scriptorium", "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");

function makeProjector(instance) {
  const ex = instance.exports;
  const dec = new TextDecoder("utf-8");
  return function passages(str) {
    const len16 = str.length;
    const byteLen = len16 * 2;
    const inPtr = ex.alloc(byteLen);
    const inView = new DataView(ex.memory.buffer);
    for (let i = 0; i < len16; i += 1) {
      inView.setUint16(inPtr + i * 2, str.charCodeAt(i), true);
    }
    const packed = ex.passages_utf16(inPtr, byteLen);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    const bytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
    const json = dec.decode(bytes);
    ex.dealloc(outPtr, outLen);
    ex.dealloc(inPtr, byteLen);
    return JSON.parse(json);
  };
}

async function main() {
  if (!fs.existsSync(WASM)) {
    console.warn("SKIP rust-consume-oracle — wasm not built. Run: npm run build:rust-wasm");
    process.exit(0);
  }
  const mod = await WebAssembly.instantiate(fs.readFileSync(WASM), {});
  const ex = mod.instance.exports;
  for (const fn of ["alloc", "dealloc", "passages_utf16", "memory"]) {
    if (!ex[fn]) {
      console.error("rust-consume-oracle: wasm missing export '" + fn + "'.");
      process.exit(1);
    }
  }
  const project = makeProjector(mod.instance);
  const { corpus, adversarial, fuzz, inputs } = shared.allInputs();

  let failures = 0;
  const MAX = 20;
  for (let i = 0; i < inputs.length; i += 1) {
    const jsPassages = ast.passagesFromDocument(ast.parseDocument(inputs[i]));
    let rustPassages;
    try {
      rustPassages = project(inputs[i]);
    } catch (e) {
      failures += 1;
      if (failures <= MAX) {
        console.error("FAIL #" + i + " — projection threw / bad JSON: " + e.message);
      }
      continue;
    }
    const d = shared.diffDeep(jsPassages, rustPassages, "$");
    if (d) {
      failures += 1;
      if (failures <= MAX) {
        console.error("FAIL #" + i + " (" + shared.regionFor(i, corpus.length, adversarial.length) + ") at " + d.path + " — " + d.why);
        console.error("  input: " + shared.snippet(inputs[i]));
        console.error("  JS  : " + JSON.stringify(d.a));
        console.error("  Rust: " + JSON.stringify(d.b));
      }
    }
  }

  if (failures > 0) {
    console.error("\nrust-consume-oracle: " + failures + "/" + inputs.length + " inputs diverged.");
    process.exit(1);
  }
  console.log(
    "rust-consume-oracle: " + inputs.length + " inputs byte-identical " +
    "(" + corpus.length + " corpus, " + adversarial.length + " adversarial, " + fuzz.length + " fuzz)."
  );
  console.log("Rust passages ≡ core.passagesFromDocument.");
}

main();
