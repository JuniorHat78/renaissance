#!/usr/bin/env node
"use strict";

// Net-off's correctness gate (AST P5). With derived artifacts no longer
// committed (see docs/specs/AST-COMPILER.md → Net-off), the old
// committed-file-vs-regenerated `--check` gates are obsolete. This replaces them:
//
//   1. Build the artifacts from source (`npm run build:artifacts`).
//   2. Freshness of the in-place committed files (sw.js, 404.html): the build
//      must not have changed them — i.e. whoever touched source already rebuilt
//      and committed them. Enforced with `git diff --quiet`.
//   3. Determinism: build a second time and assert every derived artifact is
//      byte-identical. A non-deterministic build would publish a different site
//      on every deploy and quietly defeat the freshness gate.
//
// Content correctness of the freshly built artifacts is proven separately by the
// regression suite (equivalence oracle, search-index, site-registry, …), which
// runs against these same outputs.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..", "..");

// Committed source files that carry a generated *region* (not whole files).
const IN_PLACE = ["sw.js", "404.html"];

// Wholly-generated, gitignored outputs. data/compiled/ is a directory.
const GENERATED_FILES = [
  "data/search-index.json",
  "data/offline-assets.json",
  "data/site-registry.json",
  "scripts/essays-data.js",
  "sitemap.xml",
  "feed.xml",
  "rss.xml",
];
const GENERATED_DIRS = ["data/compiled"];

function build(label) {
  console.log(`\n[verify-build] ${label}: npm run build:artifacts`);
  execSync("npm run build:artifacts", { cwd: root, stdio: "inherit" });
}

function listDerived() {
  const files = [...IN_PLACE, ...GENERATED_FILES];
  for (const dir of GENERATED_DIRS) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs)) {
      for (const name of fs.readdirSync(abs)) {
        files.push(path.join(dir, name).replace(/\\/g, "/"));
      }
    }
  }
  return files.sort();
}

function hashTree() {
  const tree = {};
  for (const rel of listDerived()) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`expected derived artifact is missing after build: ${rel}`);
    }
    tree[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  }
  return tree;
}

function fail(message, detail) {
  console.error(`\n[verify-build] FAILED: ${message}`);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

// 1 + 2: build, then assert the in-place committed files are already fresh.
build("build #1");

try {
  execSync(`git diff --quiet -- ${IN_PLACE.join(" ")}`, { cwd: root, stdio: "pipe" });
} catch (error) {
  const diff = (() => {
    try {
      return execSync(`git --no-pager diff -- ${IN_PLACE.join(" ")}`, { cwd: root }).toString();
    } catch (_) {
      return "";
    }
  })();
  fail(
    `building from source changed a committed in-place file (${IN_PLACE.join(", ")}).\n` +
      "Run `npm run build:artifacts` and commit the regenerated file(s).",
    diff
  );
}

const first = hashTree();

// 3: build again and assert byte-identical output.
build("build #2");
const second = hashTree();

const drifted = Object.keys(first).filter((rel) => first[rel] !== second[rel]);
const appeared = Object.keys(second).filter((rel) => !(rel in first));
if (drifted.length > 0 || appeared.length > 0) {
  fail(
    "build is not deterministic — a second build produced different output.",
    [...drifted.map((r) => `  changed: ${r}`), ...appeared.map((r) => `  new: ${r}`)].join("\n")
  );
}

console.log(
  `\n[verify-build] OK — ${Object.keys(first).length} derived artifacts are deterministic ` +
    `and the committed in-place files (${IN_PLACE.join(", ")}) are fresh.`
);
