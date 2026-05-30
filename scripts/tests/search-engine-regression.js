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

  await check("search index precomputes token and fuzzy records", async () => {
    const engine = Search.createSearchEngine(fakeContentApi());
    const index = await engine.ensureIndex();
    const section = index.sections[0];

    assert.ok(Array.isArray(section.tokens), "section record should include token spans");
    assert.ok(section.tokens.some((token) => token.raw === "alpha"), "section tokens should preserve raw text");
    assert.ok(section.fuzzyBuckets instanceof Map, "section record should include fuzzy candidate buckets");
    assert.ok(section.fuzzyBuckets.size > 0, "fuzzy candidate buckets should not be empty");
  });

  await check("fuzzy search uses indexed section records", async () => {
    const engine = Search.createSearchEngine(fakeContentApi());
    const result = await engine.search({ query: "alhpa", mode: "fuzzy" });

    assert.equal(result.totalHits, 1);
    assert.equal(result.hits[0].matchedText, "alpha");
  });

  await check("relevance ranking boosts essay and section titles over body hits", async () => {
    const engine = Search.createSearchEngine(rankingContentApi());
    const result = await engine.search({ query: "alpha", mode: "contains", sort: "relevance" });

    assert.ok(result.hits.length >= 3, "fixture should produce title, section, and body hits");
    assert.equal(result.hits[0].field, "essay_title");
    assert.equal(result.hits[1].field, "section_title");
    assert.ok(
      result.hits.findIndex((hit) => hit.field === "body") > 1,
      "body hit should rank after title fields"
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

function rankingContentApi() {
  const essay = {
    slug: "ranking-fixture",
    title: "Alpha Archive",
    summary: "Ranking fixture",
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
            searchableText: "A body paragraph mentions alpha once.",
          },
        ],
      };
    },
    sectionDisplay() {
      return {
        label: "Section 1",
        title: "Alpha Notes",
        searchLabel: "Section 1 | Alpha Notes",
      };
    },
  };
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("PASS " + name));
}
