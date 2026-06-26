#!/usr/bin/env node
"use strict";

// The content-AST oracle (SCRIPTORIUM-RUST-PARSER.md §14, Pass 1 step 2): the
// Rust content compiler's per-section `ast` projection must be byte-identical to
//   JSON.stringify(withoutLeadingHeadings(parseDocument(text, { sourceName })), null, 2)
// over corpus + adversarial + fuzz. This proves the Document→pretty-JSON path
// (withoutLeadingHeadings + the json_value pretty-printer with parse.js key
// order) the build-time artifacts depend on. The end-to-end artifact byte-diff
// (the bin's `--check`) is proven separately in CI; this is the deep,
// fuzz-covered serializer proof. Verified locally via wasm (Node runs wasm).
//
// Output is always valid UTF-8 (JSON.stringify escapes lone surrogates as
// \uXXXX), so we decode UTF-8 and compare as JS strings.

const fs = require("node:fs");
const path = require("node:path");

const core = require("../ast/core.js");
const shared = require("./lib/parser-oracle-corpus.js");
const { loadGoldens } = require("./lib/parse-goldens.js");

const ROOT = shared.ROOT;
const WASM = process.env.SCRIPTORIUM_PARSER_WASM && process.env.SCRIPTORIUM_PARSER_WASM.trim()
  ? path.resolve(process.env.SCRIPTORIUM_PARSER_WASM.trim())
  : path.join(ROOT, "scriptorium", "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");

// A representative sourceName, exercised identically on both sides (it is the
// only field the projection reads beyond the text itself).
const SOURCE_NAME = "raw/oracle/1.txt";

function writeUtf16(view, ptr, str) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint16(ptr + i * 2, str.charCodeAt(i), true);
  }
}

function makeCompiler(instance) {
  const ex = instance.exports;
  const dec = new TextDecoder("utf-8");
  const nameByteLen = SOURCE_NAME.length * 2;
  return function compile(str) {
    const byteLen = str.length * 2;
    const inPtr = ex.alloc(byteLen);
    const namePtr = ex.alloc(nameByteLen);
    // DataView built AFTER both allocs — alloc may grow (detach) the buffer.
    const view = new DataView(ex.memory.buffer);
    writeUtf16(view, inPtr, str);
    writeUtf16(view, namePtr, SOURCE_NAME);
    const packed = ex.content_ast_utf16(inPtr, byteLen, namePtr, nameByteLen);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    const bytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
    ex.dealloc(outPtr, outLen);
    ex.dealloc(namePtr, nameByteLen);
    ex.dealloc(inPtr, byteLen);
    return dec.decode(bytes);
  };
}

// The JS reference, rebuilt from the golden tree instead of a live parse: the
// golden is the bare parseDocument shape (sourceName === null); inject the
// representative sourceName the same way parseDocument(text, { sourceName })
// would, then re-project through the surviving core.js (withoutLeadingHeadings).
function jsContentAst(tree) {
  const doc = core.withoutLeadingHeadings(Object.assign({}, tree, { sourceName: SOURCE_NAME }));
  return JSON.stringify(doc, null, 2);
}

async function main() {
  if (!fs.existsSync(WASM)) {
    console.warn("SKIP rust-content-ast-oracle — wasm not built. Run: npm run build:rust-wasm");
    process.exit(0);
  }
  const mod = await WebAssembly.instantiate(fs.readFileSync(WASM), {});
  const ex = mod.instance.exports;
  for (const fn of ["alloc", "dealloc", "content_ast_utf16", "memory"]) {
    if (!ex[fn]) {
      console.error("rust-content-ast-oracle: wasm missing export '" + fn + "'.");
      process.exit(1);
    }
  }
  const compile = makeCompiler(mod.instance);
  const { corpus, adversarial, fuzz, inputs, trees } = loadGoldens();

  let failures = 0;
  const MAX = 20;
  for (let i = 0; i < inputs.length; i += 1) {
    const jsJson = jsContentAst(trees[i]);
    let rustJson;
    try {
      rustJson = compile(inputs[i]);
    } catch (e) {
      failures += 1;
      if (failures <= MAX) {
        console.error("FAIL #" + i + " — compile threw: " + e.message);
      }
      continue;
    }
    if (jsJson !== rustJson) {
      failures += 1;
      if (failures <= MAX) {
        const region = shared.regionFor(i, corpus.length, adversarial.length);
        // Find the first differing offset for a useful pointer.
        let at = 0;
        while (at < jsJson.length && at < rustJson.length && jsJson[at] === rustJson[at]) {
          at += 1;
        }
        console.error("FAIL #" + i + " (" + region + ") JSON differs at offset " + at);
        console.error("  input: " + shared.snippet(inputs[i]));
        console.error("  JS  : " + JSON.stringify(jsJson.slice(Math.max(0, at - 30), at + 30)));
        console.error("  Rust: " + JSON.stringify(rustJson.slice(Math.max(0, at - 30), at + 30)));
      }
    }
  }

  if (failures > 0) {
    console.error("\nrust-content-ast-oracle: " + failures + "/" + inputs.length + " inputs diverged.");
    process.exit(1);
  }
  console.log(
    "rust-content-ast-oracle: " + inputs.length + " inputs byte-identical " +
    "(" + corpus.length + " corpus, " + adversarial.length + " adversarial, " + fuzz.length + " fuzz)."
  );
  console.log("Rust content AST ≡ JSON.stringify(withoutLeadingHeadings(parseDocument(...)), null, 2).");
}

main();
