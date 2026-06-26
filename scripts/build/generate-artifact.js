#!/usr/bin/env node
"use strict";

// Run a build-artifact generator, preferring the native Rust bin and falling back
// to the JS generator (which parses via the wasm). The two are proven byte-
// identical by the rust-oracle `build-artifacts` job, so either is correct
// (SCRIPTORIUM-RUST-PARSER.md §14.3 step e). The deploy builds the native bin and
// uses it; local dev — where the native bin may not link (e.g. Windows without the
// MSVC linker) — transparently falls back to JS-via-wasm. Usage:
//   node scripts/build/generate-artifact.js <native-bin> <js-fallback.js> [args...]

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [bin, jsFallback, ...passthru] = process.argv.slice(2);
if (!bin || !jsFallback) {
  console.error("usage: generate-artifact.js <native-bin> <js-fallback.js> [args...]");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..", "..");
const exe = process.platform === "win32" ? bin + ".exe" : bin;
const binPath = path.join(ROOT, "rust", "target", "release", exe);

let res;
if (fs.existsSync(binPath)) {
  res = spawnSync(binPath, passthru, { stdio: "inherit" });
} else {
  res = spawnSync(process.execPath, [path.join(ROOT, jsFallback), ...passthru], { stdio: "inherit" });
}

if (res.error) {
  console.error("generate-artifact: failed to run " + bin + ": " + res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
