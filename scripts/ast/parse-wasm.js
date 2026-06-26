// Renaissance AST — parse (NODE / BUILD-TIME ONLY; never shipped to the browser).
//
// The text -> AST tokenizer used to live here in JS (parse.js). After the
// cutover (SCRIPTORIUM-RUST-PARSER.md §14.3) there is ONE parser: the crate-free
// Rust core (rust/), compiled to wasm. This module sources parseDocument from
// that wasm in Node.
//
// It is deliberately self-contained — it does NOT reach into scriptorium/ (the
// editor app has its own browser glue, scriptorium/wasm-parser.js). Keeping the
// build/test parser dependent only on rust/ is what lets the §6 quarantine hold:
// the shipped build needs the Rust core, never the author tooling. The ~20 lines
// of marshalling below mirror that glue exactly and are held byte-identical to
// the old JS authority by the equivalence oracles + goldens.
//
// The wasm is instantiated lazily on the first parse (synchronously, off the
// browser main thread), so merely requiring ast/index.js for core/render/validate
// costs nothing and needs no build artifact. Registering parseDocument as core's
// string parser keeps normalizeAstInput("raw text") working in Node exactly as
// parse.js did. The browser never loads this file. See docs/specs/AST-COMPILER.md.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const core = require("./core.js");

const ROOT = path.join(__dirname, "..", "..");
const decoder = new TextDecoder("utf-8");

// Honour an explicit override (the oracles set this), then the release wasm under
// the cargo target, then the copy `npm run wasm:editor` drops next to the editor.
function resolveWasmPath() {
  const override = process.env.SCRIPTORIUM_PARSER_WASM;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const candidates = [
    path.join(ROOT, "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm"),
    path.join(ROOT, "scriptorium", "scriptorium_parser.wasm"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

let wasmExports = null;

function ensureLoaded() {
  if (wasmExports) {
    return wasmExports;
  }
  const wasmPath = resolveWasmPath();
  if (!fs.existsSync(wasmPath)) {
    throw new Error(
      "Scriptorium parser wasm not found at " + path.relative(ROOT, wasmPath) + ".\n" +
      "  Build it first:  npm run build:rust-wasm\n" +
      "  (or set SCRIPTORIUM_PARSER_WASM to an existing .wasm). The parser is the\n" +
      "  Rust core compiled to wasm — there is no JS fallback after the cutover."
    );
  }
  // Synchronous instantiate (Node allows sync compile of any size off the main
  // browser thread). No imports — the parser is freestanding.
  const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasmPath)), {});
  const ex = instance.exports;
  for (const name of ["alloc", "dealloc", "parse_utf16", "memory"]) {
    if (!ex[name]) {
      throw new Error("Scriptorium parser wasm is missing export '" + name + "'.");
    }
  }
  wasmExports = ex;
  return wasmExports;
}

// Matches the old parse.js signature: parseDocument(source, { sourceName }).
// Allocate a buffer, write the source as UTF-16LE, call parse_utf16, read the
// (ptr,len) of UTF-8 canonical JSON it returns, decode, JSON.parse, free both.
// The wasm emits the bare document (sourceName === null, the third key); we set
// the requested sourceName in place — byte-identical to parseDocument(text, opts).
function parseDocument(source, options) {
  const ex = ensureLoaded();
  const text = String(source == null ? "" : source);
  const byteLen = text.length * 2;

  const inPtr = ex.alloc(byteLen);
  // Build the view AFTER alloc — alloc may grow (detach) the buffer.
  const inView = new DataView(ex.memory.buffer);
  for (let i = 0; i < text.length; i += 1) {
    inView.setUint16(inPtr + i * 2, text.charCodeAt(i), true);
  }

  const packed = ex.parse_utf16(inPtr, byteLen); // i64 -> BigInt
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);

  // Copy out (re-fetch: parse may have grown memory), then free both buffers.
  const outBytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
  ex.dealloc(outPtr, outLen);
  ex.dealloc(inPtr, byteLen);

  const doc = JSON.parse(decoder.decode(outBytes));
  doc.sourceName = options && options.sourceName != null ? options.sourceName : null;
  return doc;
}

// Restore the Node contract: core.normalizeAstInput("raw text") routes through
// the parser (it stays null in the browser, where parse is not shipped).
core.registerStringParser(parseDocument);

module.exports = { parseDocument };
