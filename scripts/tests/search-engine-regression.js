#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

global.window = {};
require("../search-engine");

const Search = global.window.RenaissanceSearch;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
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

  await check("search result cache evicts old entries", async () => {
    const engine = Search.createSearchEngine(fakeContentApi());

    for (let index = 0; index < 40; index += 1) {
      await engine.search({ query: "term" + String(index), mode: "contains" });
    }

    assert.ok(engine.cacheSize() <= 24, "cache should stay bounded");
  });

  await check("cached searches preserve result shape", async () => {
    const engine = Search.createSearchEngine(fakeContentApi());
    const first = await engine.search({ query: "alpha", mode: "contains" });
    const second = await engine.search({ query: "alpha", mode: "contains" });

    assert.equal(first.totalHits, 1);
    assert.equal(second.totalHits, 1);
    assert.deepEqual(
      second.hits.map((hit) => hit.matchedText),
      ["alpha"]
    );
  });

  console.log("Search engine regression checks passed.");
}

function fakeContentApi() {
  const essay = {
    slug: "fixture",
    title: "Fixture",
    published: true,
    section_order: [1],
  };

  return {
    async loadEssays() {
      return [essay];
    },
    async loadEssaySections() {
      return {
        essay,
        sections: [
          {
            sectionNumber: 1,
            searchableText: "alpha beta gamma term39",
          },
        ],
      };
    },
    sectionDisplay(_essay, sectionNumber) {
      return {
        label: "Section " + String(sectionNumber),
        title: "Fixture Section",
        searchLabel: "Section " + String(sectionNumber) + " | Fixture Section",
      };
    },
  };
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("PASS " + name));
}
