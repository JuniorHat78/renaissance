#!/usr/bin/env node
"use strict";

// The equivalence oracle for the Rust parser (SCRIPTORIUM-RUST-PARSER.md §6).
//
// Drives the crate-free Rust parser (scriptorium/rust) against the ONE JS parse
// authority (scripts/ast/index.js) over a corpus + an adversarial set + seeded
// fuzz, and asserts the two ASTs are STRUCTURALLY identical. Structural (not raw
// string) comparison is the canonical-form contract: both sides are JSON-parsed
// and deep-compared, so JSON key order / number formatting can't cause a false
// diff — only a real grammar divergence can. Fail-closed: any single mismatch
// exits nonzero with the first differing path and both values.
//
// One process spawn handles ALL inputs via a length-prefixed framing (don't
// hammer the machine): stdin/stdout carry [u32 LE len][payload] records. Inputs
// are UTF-16LE (the parser's native unit; round-trips lone surrogates exactly);
// outputs are UTF-8 canonical JSON.
//
// `stats` is excluded from the comparison for now (deferred — §11 decision 6):
// the Rust side does not emit it and we strip it from the JS AST here.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ast = require("../ast/index.js");

const ROOT = path.join(__dirname, "..", "..");
const RAW_ROOT = path.join(ROOT, "raw");
const EXE = process.platform === "win32" ? "scriptorium-parser.exe" : "scriptorium-parser";
const BIN = path.join(ROOT, "scriptorium", "rust", "target", "release", EXE);

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// structural deep-compare (first differing path wins)
// ---------------------------------------------------------------------------

function diffDeep(a, b, pathStr) {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    return { path: pathStr, a, b, why: "type " + ta + " vs " + tb };
  }
  if (ta === "array") {
    if (a.length !== b.length) {
      return { path: pathStr, a: a.length, b: b.length, why: "array length" };
    }
    for (let i = 0; i < a.length; i += 1) {
      const d = diffDeep(a[i], b[i], pathStr + "[" + i + "]");
      if (d) return d;
    }
    return null;
  }
  if (ta === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join("") !== kb.join("")) {
      return { path: pathStr, a: ka, b: kb, why: "object keys" };
    }
    for (const k of ka) {
      const d = diffDeep(a[k], b[k], pathStr + "." + k);
      if (d) return d;
    }
    return null;
  }
  // primitive
  if (a !== b) {
    return { path: pathStr, a, b, why: "value" };
  }
  return null;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

// ---------------------------------------------------------------------------
// inputs: corpus + adversarial + seeded fuzz
// ---------------------------------------------------------------------------

function corpusInputs() {
  const inputs = [];
  let slugs = [];
  try {
    slugs = fs.readdirSync(RAW_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return inputs;
  }
  for (const slug of slugs) {
    const dir = path.join(RAW_ROOT, slug);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((n) => /^[0-9]+\.txt$/.test(n));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      try {
        inputs.push(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch (_) {
        /* skip unreadable */
      }
    }
  }
  return inputs;
}

function adversarialInputs() {
  const LS_HI = String.fromCharCode(0xd83d); // lone high surrogate
  const LS_LO = String.fromCharCode(0xde00); // lone low surrogate
  const EMOJI = "\u{1F600}"; // astral (surrogate pair)
  return [
    "",
    "\n",
    "\n\n\n",
    "   ",
    "﻿leading BOM then text",
    "crlf\r\nin\r\nthe\r\nmiddle\r\n",
    "lone \r carriage return",
    "# Heading one",
    "###### six hashes clamps to three",
    "#nospace is not a heading",
    "#  extra   spaces   after   hashes  ",
    "Plain paragraph with **bold** and *em* and `code` and [a](https://x.y).",
    "**unclosed strong",
    "*unclosed em",
    "`unclosed code",
    "mid*word*emphasis should not open",
    "a **b *c **d** e* f** g",
    "[label](javascript:alert(1)) unsafe",
    "[label](mailto:x@y.z) safe",
    "[empty]() and [](href) and [a](b)",
    "[ctrl](http) control char in url",
    "> a quote line\n> second line\n> third",
    "> \"a quoted pull inside blockquote\"",
    "- one\n- two\n- three",
    "1. first\n2. second\n3) third paren",
    "- bullet\n1. ordered breaks the list",
    "---",
    "----",
    " - - - ",
    "\"a pull quote\"",
    "“curly pull quote”",
    "'single quoted'",
    "trailing hard break  \nnext line",
    "tabs\tand nbsp emspace",
    "emoji " + EMOJI + " and CJK 中文 and combining á",
    "lone high " + LS_HI + " surrogate",
    "lone low " + LS_LO + " surrogate",
    "pair split [" + LS_HI + "](" + LS_LO + ")",
    "nested **a *b `c` d* e** f",
    "deep " + "*".repeat(30) + "x" + "*".repeat(30),
    "code with\nnewline `a\nb` inside",
    "link [text with `code` and *em*](https://example.com/path?q=1)",
    "# leading heading\n\nbody paragraph\n\n## another\n\nmore",
    "para one\nstill para one\n\npara two",
    "   indented paragraph keeps indent as leading ws",
    ">no space after marker",
    ">\ttab after marker",
    "* a\n* b\n* c with `code`",
    "mixed   line sep   para sep",
  ];
}

// Deterministic LCG so failures reproduce exactly.
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fuzzInputs(count, seed) {
  const rng = makeRng(seed);
  const tokens = [
    "a", "b", "c", "Z", "1", "2", " ", "  ", "\n", "\n\n", "\t",
    "*", "**", "`", "#", "##", "###", "####", "#####", "######",
    "[", "]", "(", ")", "](", ")(", "-", "+", "1.", "2)", ">", " > ",
    "---", "\"", "'", "“", "”", "‘", "’",
    " ", "﻿", "\r", "\r\n", "\u{1F600}", "中",
    String.fromCharCode(0xd83d), String.fromCharCode(0xde00),
    "x".repeat(5), "word ", ". ", ", ", ": ",
  ];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = 1 + Math.floor(rng() * 40);
    let s = "";
    for (let j = 0; j < n; j += 1) {
      s += tokens[Math.floor(rng() * tokens.length)];
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function jsAst(input) {
  const tree = ast.parseDocument(input);
  // stats is deferred from the byte-identity contract for now.
  if (tree && typeof tree === "object") {
    delete tree.stats;
  }
  return tree;
}

function snippet(s) {
  const show = s.length > 80 ? s.slice(0, 80) + "…" : s;
  return JSON.stringify(show);
}

function main() {
  if (!fs.existsSync(BIN)) {
    console.warn(
      "SKIP rust-parser-oracle — binary not built at " + path.relative(ROOT, BIN) + ".\n" +
      "  Build it first:  cargo build --release --manifest-path scriptorium/rust/Cargo.toml\n" +
      "  (CI builds it before running this; locally it needs the MSVC linker + Windows SDK,\n" +
      "   or any platform with a working cc.)"
    );
    process.exit(0);
  }

  const corpus = corpusInputs();
  const adversarial = adversarialInputs();
  const fuzz = fuzzInputs(500, 0x5c819f7);
  const inputs = corpus.concat(adversarial, fuzz);

  const stdin = encodeFrames(inputs);
  const res = spawnSync(BIN, [], { input: stdin, maxBuffer: 256 * 1024 * 1024 });
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
        console.error("  input: " + snippet(inputs[i]));
      }
      continue;
    }
    const jsTree = jsAst(inputs[i]);
    const d = diffDeep(jsTree, rustTree, "$");
    if (d) {
      failures += 1;
      if (failures <= MAX_REPORT) {
        const where = i < corpus.length ? "corpus"
          : i < corpus.length + adversarial.length ? "adversarial"
          : "fuzz";
        console.error("FAIL #" + i + " (" + where + ") at " + d.path + " — " + d.why);
        console.error("  input: " + snippet(inputs[i]));
        console.error("  JS  : " + JSON.stringify(d.a));
        console.error("  Rust: " + JSON.stringify(d.b));
      }
    }
  }

  const total = inputs.length;
  if (failures > 0) {
    console.error(
      "\nrust-parser-oracle: " + failures + "/" + total + " inputs diverged" +
      (failures > MAX_REPORT ? " (showing first " + MAX_REPORT + ")" : "") + "."
    );
    process.exit(1);
  }
  console.log(
    "rust-parser-oracle: " + total + " inputs byte-identical " +
    "(" + corpus.length + " corpus, " + adversarial.length + " adversarial, " + fuzz.length + " fuzz)."
  );
  console.log("Rust parser ≡ JS authority.");
}

main();
