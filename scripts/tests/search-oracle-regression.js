#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const oracle = require("../search-oracle.js");

const root = path.join(__dirname, "..", "..");
const index = JSON.parse(fs.readFileSync(path.join(root, "data", "search-index.json"), "utf8"));
const lexicon = JSON.parse(fs.readFileSync(path.join(root, "data", "search-lexicon.json"), "utf8"));

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

function rank(query, context) {
  return oracle.rank(index, query, context);
}

check("query intent is parsed before matching", () => {
  assert.equal(oracle.parseQuery("").kind, "empty");
  assert.equal(oracle.parseQuery("   ").kind, "empty");
  assert.equal(oracle.parseQuery('"grain of sand"').kind, "phrase");
  assert.equal(oracle.parseQuery("omega point").kind, "term");

  assert.equal(oracle.parseQuery("section 4").kind, "section-jump");
  assert.equal(oracle.parseQuery("section 4").sectionNumber, 4);
  assert.equal(oracle.parseQuery("4").sectionNumber, 4);
  assert.equal(oracle.parseQuery("iv").sectionNumber, 4);
  assert.equal(oracle.parseQuery("section iv").sectionNumber, 4);
});

check("idf weights rare terms above common ones", () => {
  const idf = oracle.makeIdf(index);
  assert.ok(idf("omega") > idf("point"), "omega should outweigh point");
  assert.ok(idf("point") > idf("the"), "point should outweigh the");
});

check("section jump returns exactly the named section", () => {
  const out = rank("section 4");
  assert.equal(out.results.length, 1, "one jump result expected");
  assert.equal(out.results[0].kind, "section-jump");
  assert.equal(out.results[0].sectionNumber, 4);
  assert.ok(out.results[0].score >= 1000, "jump should dominate");
});

check("empty query yields no matches", () => {
  assert.deepEqual(rank("").results, []);
});

check("exact section title outranks its own body", () => {
  const out = rank("omega point");
  assert.equal(out.results[0].kind, "title", "title hit must rank first");
  assert.equal(out.results[0].sectionNumber, 7);
});

check("importance gate suppresses common-only matches", () => {
  // "omega" + "point" both occur only in §7 and §10; passages matching just the
  // common word "point" must be dropped, not flood the results.
  const out = rank("omega point");
  assert.ok(out.results.length <= 6, "expected a tight result set, got " + out.results.length);
  for (const result of out.results) {
    assert.ok(
      result.sectionNumber === 7 || result.sectionNumber === 10,
      "common-only match leaked from section " + result.sectionNumber
    );
  }
});

check("section-title affinity lifts the load-bearing passage", () => {
  const out = rank('"grain of sand"');
  assert.equal(out.results[0].sectionNumber, 8, "epigraph in 'A World in a Grain' should top the phrase results");
  for (const result of out.results) {
    assert.equal(result.kind, "passage");
  }
});

check("current-essay context boosts matching passages", () => {
  const withContext = rank("glass", { essaySlug: "etching-god-into-sand" });
  const withoutContext = rank("glass");
  const top = withContext.results[0];
  assert.ok(top.reasons.some((r) => r.label === "current essay"), "context boost should appear in reasons");
  assert.ok(top.score > (withoutContext.results[0].score), "context should raise the score");
});

check("passage results carry a highlightable range", () => {
  const out = rank("verdun");
  const passage = out.results.find((result) => result.kind === "passage");
  assert.ok(passage, "expected a passage result for 'verdun'");
  assert.ok(Number.isInteger(passage.rangeStart) && passage.rangeStart >= 0, "rangeStart must be a non-negative integer");
  assert.ok(passage.rangeEnd > passage.rangeStart, "rangeEnd must exceed rangeStart for a deep-link highlight");
});

check("lexicon synonyms boost conceptually related passages", () => {
  // "silicon" passages that also mention chip/wafer/transistor should carry a
  // related-term boost (the lexicon seam), and that boost should not appear
  // when no lexicon is supplied.
  const withLexicon = rank("silicon", { lexicon });
  const boosted = withLexicon.results.find((result) =>
    result.reasons.some((item) => /^related: /.test(item.label))
  );
  assert.ok(boosted, "expected at least one synonym-boosted result");

  const withoutLexicon = rank("silicon");
  const leaked = withoutLexicon.results.some((result) =>
    result.reasons.some((item) => /^related: /.test(item.label))
  );
  assert.ok(!leaked, "synonym boost must not appear without a lexicon");
});

check("every result's score equals the sum of its reasons", () => {
  for (const query of ["sand", "omega point", '"grain of sand"', "section 4", "glass"]) {
    for (const result of rank(query).results) {
      const sum = result.reasons.reduce((total, item) => total + item.points, 0);
      assert.equal(result.score, sum, "score must equal sum of reasons for query: " + query);
      assert.ok(result.score > 0, "score must be positive");
      assert.ok(typeof result.snippet.text === "string", "snippet text required");
    }
  }
});

if (failures.length > 0) {
  console.error("\nSearch oracle regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("Search oracle regression checks passed.");
