#!/usr/bin/env node
"use strict";

// The render equivalence oracle (SCRIPTORIUM-RUST-PARSER.md): the Rust AST→HTML
// renderer must be byte-identical to render.js serializeBlocks over corpus +
// adversarial + fuzz. With this, parse AND render both live in Rust, both
// oracle-proven. Verified locally via wasm (Node runs wasm natively).
//
// Render output is returned as UTF-16LE so lone surrogates round-trip exactly;
// compared as JS strings.

const fs = require("node:fs");
const path = require("node:path");

const ast = require("../ast/index.js");
const shared = require("./lib/parser-oracle-corpus.js");

const ROOT = shared.ROOT;
const WASM = process.env.SCRIPTORIUM_PARSER_WASM && process.env.SCRIPTORIUM_PARSER_WASM.trim()
  ? path.resolve(process.env.SCRIPTORIUM_PARSER_WASM.trim())
  : path.join(ROOT, "scriptorium", "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");

function makeRender(instance) {
  const ex = instance.exports;
  return function render(str) {
    const len16 = str.length;
    const byteLen = len16 * 2;
    const inPtr = ex.alloc(byteLen);
    const inView = new DataView(ex.memory.buffer);
    for (let i = 0; i < len16; i += 1) {
      inView.setUint16(inPtr + i * 2, str.charCodeAt(i), true);
    }
    const packed = ex.render_utf16(inPtr, byteLen);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    const bytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
    ex.dealloc(outPtr, outLen);
    ex.dealloc(inPtr, byteLen);
    // Decode UTF-16LE code unit by code unit — preserves lone surrogates exactly
    // (TextDecoder('utf-16le') would replace them with U+FFFD and false-fail).
    let html = "";
    for (let k = 0; k + 1 < bytes.length; k += 2) {
      html += String.fromCharCode(bytes[k] | (bytes[k + 1] << 8));
    }
    return html;
  };
}

async function main() {
  if (!fs.existsSync(WASM)) {
    console.warn("SKIP rust-render-oracle — wasm not built. Run: npm run build:rust-wasm");
    process.exit(0);
  }
  const mod = await WebAssembly.instantiate(fs.readFileSync(WASM), {});
  const ex = mod.instance.exports;
  for (const fn of ["alloc", "dealloc", "render_utf16", "memory"]) {
    if (!ex[fn]) {
      console.error("rust-render-oracle: wasm missing export '" + fn + "'.");
      process.exit(1);
    }
  }
  const render = makeRender(mod.instance);
  const { corpus, adversarial, fuzz, inputs } = shared.allInputs();

  let failures = 0;
  const MAX = 20;
  for (let i = 0; i < inputs.length; i += 1) {
    const jsHtml = ast.serializeBlocks(ast.parseDocument(inputs[i]));
    let rustHtml;
    try {
      rustHtml = render(inputs[i]);
    } catch (e) {
      failures += 1;
      if (failures <= MAX) {
        console.error("FAIL #" + i + " — render threw: " + e.message);
      }
      continue;
    }
    if (jsHtml !== rustHtml) {
      failures += 1;
      if (failures <= MAX) {
        const region = shared.regionFor(i, corpus.length, adversarial.length);
        console.error("FAIL #" + i + " (" + region + ") HTML differs");
        console.error("  input: " + shared.snippet(inputs[i]));
        console.error("  JS  : " + JSON.stringify(jsHtml.length > 120 ? jsHtml.slice(0, 120) + "…" : jsHtml));
        console.error("  Rust: " + JSON.stringify(rustHtml.length > 120 ? rustHtml.slice(0, 120) + "…" : rustHtml));
      }
    }
  }

  if (failures > 0) {
    console.error("\nrust-render-oracle: " + failures + "/" + inputs.length + " inputs diverged.");
    process.exit(1);
  }
  console.log(
    "rust-render-oracle: " + inputs.length + " inputs byte-identical " +
    "(" + corpus.length + " corpus, " + adversarial.length + " adversarial, " + fuzz.length + " fuzz)."
  );
  console.log("Rust renderer ≡ render.js serializeBlocks.");
}

main();
