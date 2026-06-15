#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ast = require("../ast/index.js");
const generator = require("../generate-search-index.js");

const root = path.join(__dirname, "..", "..");
const indexPath = path.join(root, "data", "search-index.json");
const committedText = fs.readFileSync(indexPath, "utf8");
const index = JSON.parse(committedText);

const essaysPayload = JSON.parse(fs.readFileSync(path.join(root, "data", "essays.json"), "utf8"));
const allEssays = Array.isArray(essaysPayload.essays) ? essaysPayload.essays : [];
const unpublished = allEssays.filter((essay) => essay && essay.published === false);

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name + "\n  " + error.message);
  }
}

check("index has deterministic shape", () => {
  assert.equal(index.version, 1, "version must be 1");
  assert.equal(index.astVersion, String(ast.VERSION), "astVersion must match the AST module");
  assert.ok(Array.isArray(index.essays), "essays must be an array");
  assert.ok(index.stats && typeof index.stats === "object", "stats are required");
});

check("committed index matches a fresh regeneration", () => {
  const regenerated = generator.stableJson(generator.buildSearchIndex(generator.loadEssays()));
  assert.equal(committedText, regenerated, "data/search-index.json is stale; run node scripts/generate-search-index.js");
});

check("stats agree with the actual records", () => {
  const sectionTotal = index.essays.reduce((count, essay) => count + essay.sections.length, 0);
  const passageTotal = index.essays.reduce(
    (count, essay) => count + essay.sections.reduce((inner, section) => inner + section.passages.length, 0),
    0
  );
  assert.equal(index.stats.essays, index.essays.length, "stats.essays mismatch");
  assert.equal(index.stats.sections, sectionTotal, "stats.sections mismatch");
  assert.equal(index.stats.passages, passageTotal, "stats.passages mismatch");
});

check("essay and section ordering is monotonic and dense", () => {
  index.essays.forEach((essay, essayOrder) => {
    assert.equal(essay.order, essayOrder, "essay.order must match position: " + essay.slug);
    assert.equal(essay.sectionCount, essay.sections.length, "sectionCount mismatch: " + essay.slug);
    essay.sections.forEach((section, sectionOrder) => {
      assert.equal(section.order, sectionOrder, "section.order must match position: " + essay.slug + "/" + section.sectionNumber);
    });
  });
});

check("passage ids are unique, well-formed, and aligned with their index", () => {
  for (const essay of index.essays) {
    for (const section of essay.sections) {
      const seen = new Set();
      section.passages.forEach((passage, position) => {
        assert.match(passage.passageId, /^p[1-9][0-9]*$/, "passageId must look like p<n>: " + passage.passageId);
        assert.ok(!seen.has(passage.passageId), "duplicate passageId in section: " + passage.passageId);
        seen.add(passage.passageId);
        assert.equal(passage.passageId, "p" + String(passage.passageIndex), "passageId must encode passageIndex");
        assert.equal(passage.passageIndex, position + 1, "passageIndex must be 1-based and dense");
        assert.ok(typeof passage.text === "string" && passage.text.length > 0, "passage text must be non-empty");
      });
    }
  }
});

check("source offsets are sane when present", () => {
  for (const essay of index.essays) {
    for (const section of essay.sections) {
      for (const passage of section.passages) {
        if (passage.sourceStart !== null) {
          assert.ok(passage.sourceStart >= 0, "sourceStart must be >= 0");
        }
        if (passage.sourceStart !== null && passage.sourceEnd !== null) {
          assert.ok(passage.sourceEnd >= passage.sourceStart, "sourceEnd must be >= sourceStart");
        }
      }
    }
  }
});

check("term stats are present, pruned, and sane", () => {
  assert.ok(index.terms && typeof index.terms === "object", "terms table is required");
  assert.equal(Object.keys(index.terms).length, index.stats.indexedTerms, "indexedTerms count mismatch");
  assert.ok(index.stats.vocabulary >= index.stats.indexedTerms, "vocabulary must be >= stored terms");
  // Determinism is guaranteed by the regeneration check above plus the ES key
  // ordering spec (integer-like keys ascend, then string keys in insertion
  // order); we don't assert lexicographic order because numeric terms hoist.
  for (const [term, df] of Object.entries(index.terms)) {
    assert.match(term, /^[a-z0-9]+$/, "term must be normalized: " + term);
    assert.ok(Number.isInteger(df) && df >= 2, "stored term must have df >= 2 (singletons pruned): " + term);
    assert.ok(df <= index.stats.passages, "df cannot exceed passage count: " + term);
  }
});

check("artifact stays within its size budget", () => {
  // Deterministic guard against bloat (e.g. accidentally re-storing body text)
  // and against the artifact growing into precache/offline payloads unnoticed.
  // Raise this intentionally as more essays publish, the same way the per-page
  // asset budget is managed.
  const BUDGET_BYTES = 512 * 1024;
  const bytes = Buffer.byteLength(committedText, "utf8");
  console.log("  search index size: " + (bytes / 1024).toFixed(1) + "KB of " + (BUDGET_BYTES / 1024).toFixed(0) + "KB budget (" + index.stats.passages + " passages)");
  assert.ok(bytes <= BUDGET_BYTES, "search index is " + (bytes / 1024).toFixed(1) + "KB, over the " + (BUDGET_BYTES / 1024).toFixed(0) + "KB budget");
});

check("unpublished essays do not leak into the index", () => {
  const serialized = JSON.stringify(index);
  for (const essay of unpublished) {
    assert.ok(!index.essays.some((entry) => entry.slug === essay.slug), "unpublished essay present: " + essay.slug);
    assert.ok(!serialized.includes(String(essay.slug)), "unpublished slug leaked: " + essay.slug);
    if (essay.title) {
      assert.ok(!serialized.includes(String(essay.title)), "unpublished title leaked: " + essay.title);
    }
  }
});

if (failures.length > 0) {
  console.error("\nSearch index regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("Search index regression checks passed.");
