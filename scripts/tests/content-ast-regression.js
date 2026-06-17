#!/usr/bin/env node
"use strict";

// Equivalence harness for the build-time AST compiler (data/compiled/<slug>.json).
// The compiler's whole safety story is one property: the committed, compiled AST
// must be byte-for-byte what a runtime parse of the same source produces — so
// hydrating it renders the identical DOM, passages, and anchors the live parser
// would, and the "does the client parse match the index?" bug class cannot
// exist. This test is the oracle: the existing runtime parser is the reference
// implementation, and the artifact must match it. Pure (no DOM), Node-only.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ast = require("../ast/index.js");
const compiler = require("../generate-content-ast.js");

const root = path.join(__dirname, "..", "..");
const compiledDir = path.join(root, "data", "compiled");

function sourceName(essay, sectionNumber) {
  return (String((essay && essay.source_dir) || "").trim() || "raw") + "/" + String(sectionNumber) + ".txt";
}

function freshAst(essay, sectionNumber) {
  const raw = fs.readFileSync(path.join(root, sourceName(essay, sectionNumber)), "utf8").replace(/\r\n/g, "\n");
  return ast.withoutLeadingHeadings(ast.parseDocument(raw, { sourceName: sourceName(essay, sectionNumber) }));
}

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + (error && error.message ? error.message : String(error)));
    console.error("FAIL " + name);
  }
}

const essays = compiler.publishedEssays(compiler.loadEssays());

check("a compiled artifact exists for every published essay", () => {
  assert.ok(essays.length > 0, "no published essays found");
  for (const essay of essays) {
    assert.ok(
      fs.existsSync(path.join(compiledDir, essay.slug + ".json")),
      "missing data/compiled/" + essay.slug + ".json — run npm run content-ast:generate"
    );
  }
});

for (const essay of essays) {
  const artifactPath = path.join(compiledDir, essay.slug + ".json");
  if (!fs.existsSync(artifactPath)) {
    continue;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  check(essay.slug + ": compiled AST equals a fresh runtime parse (equivalence oracle)", () => {
    assert.strictEqual(artifact.astVersion, String(ast.VERSION), "artifact astVersion lags the parser");
    for (const section of artifact.sections) {
      assert.deepStrictEqual(
        section.ast,
        freshAst(essay, section.sectionNumber),
        "section " + section.sectionNumber + " compiled AST diverged from a runtime parse"
      );
    }
  });

  check(essay.slug + ": derived passages/words/IDs match the stored AST", () => {
    for (const section of artifact.sections) {
      const passages = ast.passagesFromDocument(section.ast);
      assert.strictEqual(section.passageCount, passages.length,
        "passageCount mismatch in section " + section.sectionNumber);
      assert.strictEqual(section.wordCount, ast.wordCount(ast.toSearchableText(section.ast)),
        "wordCount mismatch in section " + section.sectionNumber);
      passages.forEach((passage, index) => {
        assert.strictEqual(passage.passageId, "p" + String(index + 1),
          "passage IDs must stay the stable p1..pN scheme URLs/anchors depend on");
      });
    }
  });

  check(essay.slug + ": render parity — compiled AST serializes identically to a fresh parse", () => {
    for (const section of artifact.sections) {
      assert.strictEqual(
        ast.serializeBlocks(section.ast),
        ast.serializeBlocks(freshAst(essay, section.sectionNumber)),
        "serialized render diverged in section " + section.sectionNumber
      );
    }
  });
}

if (failures.length) {
  console.error("\nContent AST regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("\nContent AST regression checks passed (" + passed + " checks across " + essays.length + " essay(s)).");
