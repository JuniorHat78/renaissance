#!/usr/bin/env node
"use strict";

// Generates data/search-index.json: an AST-derived, deterministic precompute of
// the per-essay/per-section/per-passage records the runtime search engine builds
// in the browser. The goal is one shared search truth for full search, inline
// search, and Spotlight, instead of rebuilding the index from raw text at
// runtime. Unpublished essays are excluded. Run with --check in CI to fail when
// the committed artifact drifts from the source content or AST grammar.

const fs = require("node:fs");
const path = require("node:path");
const ast = require("./ast/index.js");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const outPath = path.join(dataDir, "search-index.json");

const INDEX_VERSION = 1;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueNumbers(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const number = toNumber(value);
    if (number === null || seen.has(number)) {
      continue;
    }
    seen.add(number);
    out.push(number);
  }
  return out;
}

function loadEssays() {
  const parsed = readJson(path.join(dataDir, "essays.json"));
  return Array.isArray(parsed.essays) ? parsed.essays : [];
}

function publishedEssays(essays) {
  return essays.filter((essay) => essay && essay.published !== false && essay.slug);
}

function sectionMeta(essay, sectionNumber) {
  const meta = essay && essay.section_meta && typeof essay.section_meta === "object"
    ? essay.section_meta[String(sectionNumber)]
    : null;
  return meta && typeof meta === "object" ? meta : {};
}

function readSectionSource(essay, sectionNumber) {
  const sourceDir = String((essay && essay.source_dir) || "").trim() || "raw";
  const filePath = path.join(root, sourceDir, String(sectionNumber) + ".txt");
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "Missing section file for search index: " +
      sourceDir + "/" + String(sectionNumber) + ".txt (" + essay.slug + ")"
    );
  }
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function passageRecord(passage) {
  return {
    passageId: String(passage.passageId),
    passageIndex: Number(passage.passageIndex),
    blockType: String(passage.blockType || ""),
    text: String(passage.text || ""),
    sourceStart: Number.isFinite(Number(passage.sourceStart)) ? Number(passage.sourceStart) : null,
    sourceEnd: Number.isFinite(Number(passage.sourceEnd)) ? Number(passage.sourceEnd) : null,
    sourceLine: Number.isFinite(Number(passage.sourceLine)) ? Number(passage.sourceLine) : null,
  };
}

function sectionRecord(essay, sectionNumber, sectionOrder) {
  const meta = sectionMeta(essay, sectionNumber);
  const rawText = readSectionSource(essay, sectionNumber);
  const searchText = ast.toSearchableText(rawText);
  const passages = ast.passagesFromDocument(rawText).map(passageRecord);
  return {
    sectionNumber,
    order: sectionOrder,
    title: String(meta.title || "Section " + String(sectionNumber)),
    subtitle: meta.subtitle ? String(meta.subtitle) : "",
    wordCount: ast.wordCount(searchText),
    searchText,
    passages,
  };
}

function essayRecord(essay, essayOrder) {
  const sections = uniqueNumbers(essay.section_order).map((sectionNumber, sectionOrder) =>
    sectionRecord(essay, sectionNumber, sectionOrder)
  );
  return {
    slug: String(essay.slug),
    title: String(essay.title || essay.slug),
    summary: String(essay.summary || ""),
    order: essayOrder,
    sectionCount: sections.length,
    passageCount: sections.reduce((count, section) => count + section.passages.length, 0),
    sections,
  };
}

function buildSearchIndex(essays) {
  const essayRecords = publishedEssays(essays).map(essayRecord);
  return {
    version: INDEX_VERSION,
    astVersion: String(ast.VERSION),
    essays: essayRecords,
    stats: {
      essays: essayRecords.length,
      sections: essayRecords.reduce((count, essay) => count + essay.sectionCount, 0),
      passages: essayRecords.reduce((count, essay) => count + essay.passageCount, 0),
    },
  };
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function main() {
  const expected = stableJson(buildSearchIndex(loadEssays()));
  const check = process.argv.includes("--check");

  if (check) {
    const actual = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (actual !== expected) {
      console.error("Out of date: data/search-index.json");
      console.error("Run: node scripts/generate-search-index.js");
      process.exit(1);
    }
    console.log("Search index is up to date.");
    return;
  }

  fs.writeFileSync(outPath, expected, "utf8");
  const index = JSON.parse(expected);
  console.log(
    "Wrote data/search-index.json (" +
    index.stats.essays + " essays, " +
    index.stats.sections + " sections, " +
    index.stats.passages + " passages, ast " +
    index.astVersion + ")"
  );
}

if (require.main === module) {
  main();
}

module.exports = { buildSearchIndex, stableJson, loadEssays, publishedEssays };
