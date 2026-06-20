#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

global.window = {};
require("../search-engine");

const Search = global.window.RenaissanceSearch;

check("fuzzy search finds bounded near matches", () => {
  const hits = Search.findOccurrencesInText("cat cot cut cart", "cat", { mode: "fuzzy" });
  assert.ok(hits.some((hit) => hit.matchedText === "cat"), "exact fuzzy candidate should match");
  assert.ok(hits.some((hit) => hit.matchedText === "cot"), "near fuzzy candidate should match");
});

check("fuzzy search ignores very long tokens", () => {
  const longToken = "a".repeat(80);
  const hits = Search.findOccurrencesInText(longToken + " alpha", longToken, { mode: "fuzzy" });
  assert.deepEqual(hits, []);
});

check("case sensitivity is explicit and deterministic", () => {
  const loose = Search.findOccurrencesInText("Alpha alpha", "alpha", { mode: "contains", caseSensitive: false });
  const strict = Search.findOccurrencesInText("Alpha alpha", "alpha", { mode: "contains", caseSensitive: true });
  assert.deepEqual(loose.map((hit) => hit.matchedText), ["Alpha", "alpha"]);
  assert.deepEqual(strict.map((hit) => hit.matchedText), ["alpha"]);
});

check("exact phrase mode tolerates whitespace but not empty noise", () => {
  const hits = Search.findOccurrencesInText("alpha\nbeta alpha   beta", "alpha beta", { mode: "exact_phrase" });
  assert.deepEqual(hits.map((hit) => hit.matchedText), ["alpha\nbeta", "alpha   beta"]);
  assert.deepEqual(Search.findOccurrencesInText("alpha beta", "   ", { mode: "exact_phrase" }), []);
});

check("highlight snippets escape html before marking terms", () => {
  assert.equal(
    Search.highlightSnippet("<script>sand</script>", "sand"),
    "&lt;script&gt;<mark>sand</mark>&lt;/script&gt;"
  );
});

console.log("Search helper regression checks passed.");

function check(name, fn) {
  fn();
  console.log("PASS " + name);
}
