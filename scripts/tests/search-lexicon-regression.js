#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const lexicon = JSON.parse(fs.readFileSync(path.join(root, "data", "search-lexicon.json"), "utf8"));
const essaysPayload = JSON.parse(fs.readFileSync(path.join(root, "data", "essays.json"), "utf8"));
const publishedSlugs = new Set(
  (essaysPayload.essays || [])
    .filter((essay) => essay && essay.published !== false && essay.slug)
    .map((essay) => essay.slug)
);

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

check("lexicon has a versioned, well-formed shape", () => {
  assert.equal(lexicon.version, 1);
  assert.ok(Array.isArray(lexicon.synonyms), "synonyms must be an array");
  assert.ok(Array.isArray(lexicon.aliases), "aliases must be an array");
});

check("synonym groups are normalized and non-trivial", () => {
  const seen = new Map();
  lexicon.synonyms.forEach((group, groupIndex) => {
    assert.ok(Array.isArray(group) && group.length >= 2, "group " + groupIndex + " needs >= 2 terms");
    const within = new Set();
    for (const term of group) {
      assert.match(term, /^[a-z0-9]+$/, "synonym term must be a lowercase token: " + term);
      assert.ok(!within.has(term), "duplicate term within group " + groupIndex + ": " + term);
      within.add(term);
      // A term belonging to two groups would create ambiguous expansions.
      assert.ok(!seen.has(term), "term '" + term + "' appears in groups " + seen.get(term) + " and " + groupIndex);
      seen.set(term, groupIndex);
    }
  });
});

check("aliases reference only published essays", () => {
  for (const alias of lexicon.aliases) {
    assert.ok(alias && typeof alias.match === "string" && alias.match.trim(), "alias needs a match string");
    assert.ok(publishedSlugs.has(alias.essay), "alias points at unknown/unpublished essay: " + alias.essay);
  }
});

if (failures.length > 0) {
  console.error("\nSearch lexicon regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("Search lexicon regression checks passed.");
