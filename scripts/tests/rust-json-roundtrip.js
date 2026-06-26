#!/usr/bin/env node
"use strict";

// Verifies the Rust json_value module (R2 foundation) byte-for-byte against
// Node's JSON.stringify, locally via wasm (no native linker needed). The Rust
// server reuses this exact code to read/write data/essays.json and build API
// responses, so proving it here means server JSON can't drift from Node's.
//
//   rust to_compact(parse(x))   === JSON.stringify(JSON.parse(x))
//   rust to_pretty(parse(x), 2) === JSON.stringify(JSON.parse(x), null, 2)

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const WASM = path.join(ROOT, "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");

function callString(ex, fnName, str) {
  const len16 = str.length;
  const byteLen = len16 * 2;
  const inPtr = ex.alloc(byteLen);
  const view = new DataView(ex.memory.buffer);
  for (let i = 0; i < len16; i += 1) {
    view.setUint16(inPtr + i * 2, str.charCodeAt(i), true);
  }
  const packed = ex[fnName](inPtr, byteLen);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  const bytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
  const out = Buffer.from(bytes).toString("utf8");
  ex.dealloc(outPtr, outLen);
  ex.dealloc(inPtr, byteLen);
  return out;
}

// Deterministic integer-only JSON generator (floats are a documented gap).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function randomJson(rng, depth) {
  const r = rng();
  if (depth > 3 || r < 0.35) {
    const k = rng();
    if (k < 0.25) return rng() < 0.5;
    if (k < 0.4) return null;
    if (k < 0.7) return Math.floor(rng() * 2000) - 1000; // integers only
    // strings with escapes + unicode + a lone surrogate sometimes
    const pool = ["a", "b", " ", "\"", "\\", "\n", "\t", "中", "\u{1F600}", "/", String.fromCharCode(0xd83d)];
    let s = "";
    const n = Math.floor(rng() * 6);
    for (let i = 0; i < n; i += 1) s += pool[Math.floor(rng() * pool.length)];
    return s;
  }
  if (r < 0.7) {
    const n = Math.floor(rng() * 4);
    const arr = [];
    for (let i = 0; i < n; i += 1) arr.push(randomJson(rng, depth + 1));
    return arr;
  }
  const n = Math.floor(rng() * 4);
  const obj = {};
  for (let i = 0; i < n; i += 1) obj["k" + i] = randomJson(rng, depth + 1);
  return obj;
}

async function main() {
  if (!fs.existsSync(WASM)) {
    console.warn("SKIP rust-json-roundtrip — wasm not built. Run: npm run build:rust-wasm");
    process.exit(0);
  }
  const mod = await WebAssembly.instantiate(fs.readFileSync(WASM), {});
  const ex = mod.instance.exports;
  for (const fn of ["alloc", "dealloc", "json_pretty2", "json_compact"]) {
    if (!ex[fn]) {
      console.error("rust-json-roundtrip: wasm missing export '" + fn + "'.");
      process.exit(1);
    }
  }

  const inputs = [];
  // The real file the server must round-trip.
  try {
    inputs.push(fs.readFileSync(path.join(ROOT, "data", "essays.json"), "utf8"));
  } catch (_) { /* fine */ }
  // Hand cases.
  inputs.push(
    "{}", "[]", "null", "true", "false", "0", "-12", "123456",
    "\"plain\"", "\"esc \\\" \\\\ \\n \\t /\"", "\"unicode 中 \\uD83D\\uDE00\"",
    "{\"a\":1,\"b\":[1,2,{}],\"c\":{\"d\":null}}",
    "[ { \"x\" : 1 } , [ ] , { } ]",
    "{\"nested\":{\"deep\":{\"arr\":[true,false,null,7]}}}"
  );
  // Integer-only fuzz.
  const rng = makeRng(0x10ada1);
  for (let i = 0; i < 400; i += 1) {
    inputs.push(JSON.stringify(randomJson(rng, 0)));
  }

  let failures = 0;
  const MAX = 15;
  for (let i = 0; i < inputs.length; i += 1) {
    const x = inputs[i];
    let parsed;
    try {
      parsed = JSON.parse(x);
    } catch (_) {
      continue; // only feed valid JSON
    }
    const expectCompact = JSON.stringify(parsed);
    const expectPretty = JSON.stringify(parsed, null, 2);
    const gotCompact = callString(ex, "json_compact", x);
    const gotPretty = callString(ex, "json_pretty2", x);

    if (gotCompact !== expectCompact || gotPretty !== expectPretty) {
      failures += 1;
      if (failures <= MAX) {
        console.error("FAIL #" + i + " input: " + (x.length > 70 ? x.slice(0, 70) + "…" : x));
        if (gotCompact !== expectCompact) {
          console.error("  compact JS  : " + JSON.stringify(expectCompact));
          console.error("  compact Rust: " + JSON.stringify(gotCompact));
        }
        if (gotPretty !== expectPretty) {
          console.error("  pretty JS  : " + JSON.stringify(expectPretty));
          console.error("  pretty Rust: " + JSON.stringify(gotPretty));
        }
      }
    }
  }

  if (failures > 0) {
    console.error("\nrust-json-roundtrip: " + failures + "/" + inputs.length + " inputs diverged.");
    process.exit(1);
  }
  console.log("rust-json-roundtrip: " + inputs.length + " inputs match JSON.stringify (compact + 2-space).");
  console.log("Rust json_value ≡ JSON.stringify.");
}

main();
