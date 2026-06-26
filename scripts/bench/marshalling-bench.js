#!/usr/bin/env node
"use strict";

// Step 0 of SCRIPTORIUM-WASM-MARSHALLING.md — the benchmark harness that gates
// every marshalling change. It measures the per-parse JS <-> wasm boundary cost
// and breaks it into phases, so no optimization lands without a before/after
// number from this script.
//
// What it does:
//   1. Drives the REAL shipped browser glue (scriptorium/wasm-parser.js) for the
//      authoritative whole-parse cost — same code path the editor runs on every
//      keystroke. (We shim global.fetch so load() reads the local .wasm.)
//   2. Runs an instrumented MIRROR of that exact marshalling sequence to attribute
//      time to each phase: alloc, input-write, parse_utf16, copy-out, decode,
//      JSON.parse, dealloc.
//   3. Asserts the mirror's output is byte-identical to the real glue's, so the
//      per-phase breakdown is trustworthy (the mirror is not drifting).
//
// Inputs are real content sections (raw/), in three size classes: tiny (fresh
// buffer), realistic (smallest real section), large (worst-case big section/paste).
//
// Usage:
//   node scripts/bench/marshalling-bench.js            # human table
//   node scripts/bench/marshalling-bench.js --json      # machine-readable, for diffing
//   node scripts/bench/marshalling-bench.js --iters 1000

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

// --- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return Number(argv[i + 1]);
  return fallback;
}
const itersOverride = argValue("--iters", 0);

// --- locate + load the wasm (same path the Node glue resolves) ----------------
function resolveWasmPath() {
  const override = process.env.SCRIPTORIUM_PARSER_WASM;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(ROOT, "rust", "target", "wasm32-unknown-unknown", "release", "scriptorium_parser.wasm");
}

const wasmPath = resolveWasmPath();
if (!fs.existsSync(wasmPath)) {
  console.error("parser wasm not found at " + path.relative(ROOT, wasmPath));
  console.error("  build it:  npm run build:rust-wasm");
  process.exit(2);
}
const wasmBytes = fs.readFileSync(wasmPath);

// --- shim fetch so the browser glue's async load() reads the local file -------
// The browser glue does fetch(url).arrayBuffer() then WebAssembly.instantiate.
// A real Response over the bytes satisfies it unmodified.
const realFetch = global.fetch;
global.fetch = function benchFetch() {
  return Promise.resolve(new Response(wasmBytes));
};

// --- inputs: real content sections in three size classes ----------------------
function readIfExists(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

const TINY = "# A fresh thought\n\nThe cursor blinks in an *empty* room. " +
  "One [link](https://example.com), one `span`, and a trailing idea—\n";

const realistic = readIfExists("raw/etching-god-into-sand/2.txt");
const large = readIfExists("raw/shadows/4.txt");

const inputs = [
  { name: "tiny", text: TINY },
  realistic ? { name: "realistic", text: realistic } : null,
  large ? { name: "large", text: large } : null,
].filter(Boolean);

// Default iteration budget per class — keeps wall time ~constant across sizes.
function defaultIters(name) {
  if (name === "tiny") return 5000;
  if (name === "realistic") return 1500;
  return 500; // large
}

// --- instrumented mirror of the browser glue marshalling ----------------------
// Mirrors scriptorium/wasm-parser.js parseDocument() exactly, but times each phase
// into `acc` (ns). Returns the parsed doc so we can verify byte-identity.
const decoder = new TextDecoder("utf-8");
function now() { return process.hrtime.bigint(); }

function instrumentedParse(ex, text, acc) {
  let t;
  const len16 = text.length;
  const byteLen = len16 * 2;

  t = now();
  const inPtr = ex.alloc(byteLen);
  acc.alloc += now() - t;

  t = now();
  const inView = new DataView(ex.memory.buffer);
  for (let i = 0; i < len16; i += 1) {
    inView.setUint16(inPtr + i * 2, text.charCodeAt(i), true);
  }
  acc.write += now() - t;

  t = now();
  const packed = ex.parse_utf16(inPtr, byteLen);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  acc.parse += now() - t;

  t = now();
  const outBytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
  acc.copyout += now() - t;

  t = now();
  const json = decoder.decode(outBytes);
  acc.decode += now() - t;

  t = now();
  ex.dealloc(outPtr, outLen);
  ex.dealloc(inPtr, byteLen);
  acc.dealloc += now() - t;

  t = now();
  const doc = JSON.parse(json);
  acc.jsonparse += now() - t;

  return doc;
}

const PHASES = ["alloc", "write", "parse", "copyout", "decode", "dealloc", "jsonparse"];
function newAcc() {
  const a = {};
  for (const p of PHASES) a[p] = 0n;
  return a;
}

// --- main ---------------------------------------------------------------------
async function main() {
  // The real shipped browser glue, driven exactly as the editor drives it.
  const glue = require(path.join(ROOT, "scriptorium", "wasm-parser.js"));
  await glue.load("scriptorium_parser.wasm"); // url ignored by our fetch shim

  // A private wasm instance for the instrumented mirror (so its alloc churn does
  // not perturb the glue's instance between glue calls).
  const mirror = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  const ex = mirror.exports;

  const results = [];

  for (const input of inputs) {
    const iters = itersOverride || defaultIters(input.name);
    const warmup = Math.max(20, Math.floor(iters / 10));

    // Correctness gate: the mirror must produce the exact bytes the real glue does.
    const fromGlue = JSON.stringify(glue.parseDocument(input.text));
    const fromMirror = JSON.stringify(instrumentedParse(ex, input.text, newAcc()));
    if (fromGlue !== fromMirror) {
      console.error("FATAL: instrumented mirror diverged from the real glue on '" +
        input.name + "' — the breakdown would be untrustworthy.");
      process.exit(1);
    }

    // Warm up both paths (JIT).
    for (let i = 0; i < warmup; i += 1) {
      glue.parseDocument(input.text);
      instrumentedParse(ex, input.text, newAcc());
    }

    // Whole-parse cost via the REAL glue.
    let tWhole = now();
    for (let i = 0; i < iters; i += 1) glue.parseDocument(input.text);
    const wholeNs = Number(now() - tWhole) / iters;

    // Per-phase breakdown via the mirror.
    const acc = newAcc();
    for (let i = 0; i < iters; i += 1) instrumentedParse(ex, input.text, acc);
    const phases = {};
    let mirrorTotal = 0;
    for (const p of PHASES) {
      const perIter = Number(acc[p]) / iters / 1000; // µs
      phases[p] = perIter;
      mirrorTotal += perIter;
    }

    results.push({
      name: input.name,
      chars: input.text.length,
      iters,
      wholeUs: wholeNs / 1000,
      mirrorTotalUs: mirrorTotal,
      parsesPerSec: 1e9 / wholeNs,
      phases,
    });
  }

  global.fetch = realFetch;

  if (asJson) {
    console.log(JSON.stringify({ wasm: path.relative(ROOT, wasmPath), at: new Date().toISOString(), results }, null, 2));
    return;
  }

  report(results);
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function padl(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }
function us(x) { return x.toFixed(2); }

function report(results) {
  console.log("\nJS <-> WASM marshalling benchmark (step 0 baseline)");
  console.log("wasm: " + path.relative(ROOT, wasmPath));
  console.log("");
  for (const r of results) {
    console.log("── " + r.name + "  (" + r.chars + " chars, " + r.iters + " iters)");
    console.log("   whole parse: " + us(r.wholeUs) + " µs/parse   (" +
      Math.round(r.parsesPerSec).toLocaleString() + " parses/sec)");
    console.log("   " + pad("phase", 12) + padl("µs/parse", 10) + padl("% of total", 14));
    const order = PHASES.slice().sort((a, b) => r.phases[b] - r.phases[a]);
    for (const p of order) {
      const v = r.phases[p];
      const pct = r.mirrorTotalUs ? (v / r.mirrorTotalUs) * 100 : 0;
      console.log("   " + pad(p, 12) + padl(us(v), 10) + padl(pct.toFixed(1) + "%", 14));
    }
    console.log("   " + pad("(mirror sum)", 12) + padl(us(r.mirrorTotalUs), 10));
    console.log("");
  }
  console.log("Spec groupings (input-write / parse / copy+decode / JSON.parse / alloc+dealloc):");
  for (const r of results) {
    const p = r.phases;
    console.log("   " + pad(r.name, 11) +
      " write " + padl(us(p.write), 8) +
      "  parse " + padl(us(p.parse), 8) +
      "  copy+dec " + padl(us(p.copyout + p.decode), 8) +
      "  JSON " + padl(us(p.jsonparse), 8) +
      "  alloc+free " + padl(us(p.alloc + p.dealloc), 8) + " µs");
  }
  console.log("");
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
