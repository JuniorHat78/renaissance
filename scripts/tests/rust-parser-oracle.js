#!/usr/bin/env node
"use strict";

// The NATIVE equivalence oracle for the Rust parser (SCRIPTORIUM-RUST-PARSER.md
// §6): drive the crate-free Rust *binary* against the committed golden snapshot
// of the JS parse authority (scripts/tests/goldens/parse-ast.json, §14.3) over
// the shared corpus + adversarial + fuzz set, and assert the two ASTs are
// STRUCTURALLY identical (the canonical-form contract — both sides JSON-parsed
// and deep-compared, so key order / number formatting can't cause a false diff).
// Fail-closed with the first differing path. The live differential already
// proved Rust ≡ JS; with parse.js retired the goldens are the regression guard.
//
// One spawn handles ALL inputs via a length-prefixed framing: stdin/stdout carry
// [u32 LE len][payload]. Inputs are UTF-16LE (the parser's native unit;
// round-trips lone surrogates exactly); outputs are UTF-8 canonical JSON.
//
// The FULL AST is compared, including stats { blocks, words }.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const shared = require("./lib/parser-oracle-corpus.js");
const { loadGoldens } = require("./lib/parse-goldens.js");

const ROOT = shared.ROOT;
const EXE = process.platform === "win32" ? "scriptorium-parser.exe" : "scriptorium-parser";
const BIN = process.env.SCRIPTORIUM_PARSER_BIN && process.env.SCRIPTORIUM_PARSER_BIN.trim()
  ? path.resolve(process.env.SCRIPTORIUM_PARSER_BIN.trim())
  : path.join(ROOT, "rust", "target", "release", EXE);

function encodeFrames(inputs) {
  const parts = [];
  for (const s of inputs) {
    const payload = Buffer.from(s, "utf16le");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    parts.push(header, payload);
  }
  return Buffer.concat(parts);
}

function decodeFrames(buf) {
  const out = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = buf.readUInt32LE(pos);
    pos += 4;
    if (pos + len > buf.length) break;
    out.push(buf.toString("utf8", pos, pos + len));
    pos += len;
  }
  return out;
}

function main() {
  if (!fs.existsSync(BIN)) {
    console.warn(
      "SKIP rust-parser-oracle — binary not built at " + path.relative(ROOT, BIN) + ".\n" +
      "  Build it first:  cargo build --release --manifest-path rust/Cargo.toml\n" +
      "  (CI builds it before running this; locally it needs a working linker — on Windows\n" +
      "   the MSVC linker + Windows SDK. The wasm oracle has no such requirement.)"
    );
    process.exit(0);
  }

  const { corpus, adversarial, fuzz, inputs, trees } = loadGoldens();
  const res = spawnSync(BIN, [], { input: encodeFrames(inputs), maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0 || res.error) {
    console.error("rust-parser-oracle: binary failed to run.");
    if (res.error) console.error(String(res.error));
    if (res.stderr && res.stderr.length) console.error(res.stderr.toString("utf8"));
    process.exit(1);
  }

  const frames = decodeFrames(res.stdout);
  if (frames.length !== inputs.length) {
    console.error(
      "rust-parser-oracle: got " + frames.length + " output frames for " +
      inputs.length + " inputs — framing/protocol mismatch."
    );
    process.exit(1);
  }

  let failures = 0;
  const MAX_REPORT = 20;
  for (let i = 0; i < inputs.length; i += 1) {
    let rustTree;
    try {
      rustTree = JSON.parse(frames[i]);
    } catch (e) {
      failures += 1;
      if (failures <= MAX_REPORT) {
        console.error("FAIL #" + i + " — Rust output is not valid JSON: " + e.message);
        console.error("  input: " + shared.snippet(inputs[i]));
      }
      continue;
    }
    const d = shared.diffDeep(trees[i], rustTree, "$");
    if (d) {
      failures += 1;
      if (failures <= MAX_REPORT) {
        console.error(
          "FAIL #" + i + " (" + shared.regionFor(i, corpus.length, adversarial.length) +
          ") at " + d.path + " — " + d.why
        );
        console.error("  input : " + shared.snippet(inputs[i]));
        console.error("  golden: " + JSON.stringify(d.a));
        console.error("  Rust  : " + JSON.stringify(d.b));
      }
    }
  }

  if (failures > 0) {
    console.error(
      "\nrust-parser-oracle: " + failures + "/" + inputs.length + " inputs diverged" +
      (failures > MAX_REPORT ? " (showing first " + MAX_REPORT + ")" : "") + "."
    );
    process.exit(1);
  }
  console.log(
    "rust-parser-oracle (native): " + inputs.length + " inputs match the goldens " +
    "(" + corpus.length + " corpus, " + adversarial.length + " adversarial, " + fuzz.length + " fuzz)."
  );
  console.log("Rust parser ≡ JS golden snapshot.");
}

main();
