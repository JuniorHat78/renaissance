#!/usr/bin/env node
"use strict";

// Build-time AST compiler. Promotes scripts/ast/index.js from a runtime browser
// parser into a precomputed, hydratable content contract: one artifact per
// published essay under data/compiled/<slug>.json, holding each section's
// content AST already projected through withoutLeadingHeadings — exactly as the
// reader renders it. The runtime hydrates these (rendering the SAME AST with the
// SAME renderer) instead of re-parsing raw .txt on every load, which makes the
// AST the single source of truth for rendering, search, and anchors and
// dissolves the "does the client parse match the index?" passage-alignment bug
// class. Deterministic; run with --check in CI to fail when the committed
// artifacts drift from source or the AST grammar.

const fs = require("node:fs");
const path = require("node:path");
const ast = require("./ast/index.js");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const outDir = path.join(dataDir, "compiled");

const ARTIFACT_VERSION = 1;

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

function sourceNameFor(essay, sectionNumber) {
  const sourceDir = String((essay && essay.source_dir) || "").trim() || "raw";
  return sourceDir + "/" + String(sectionNumber) + ".txt";
}

function readSectionSource(essay, sectionNumber) {
  const filePath = path.join(root, sourceNameFor(essay, sectionNumber));
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "Missing section file for content compile: " +
      sourceNameFor(essay, sectionNumber) + " (" + essay.slug + ")"
    );
  }
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function sectionRecord(essay, sectionNumber, order) {
  const meta = sectionMeta(essay, sectionNumber);
  const rawText = readSectionSource(essay, sectionNumber);
  // Match content.js's loadSection() exactly: the reader renders
  // withoutLeadingHeadings(parseDocument(text)) and numbers passages from that
  // projection. The compiled AST must come from the identical pipeline, or a
  // hydrated DOM (and its passage anchors) would diverge from a runtime parse.
  const document = ast.parseDocument(rawText, { sourceName: sourceNameFor(essay, sectionNumber) });
  const contentAst = ast.withoutLeadingHeadings(document);
  const searchableText = ast.toSearchableText(contentAst);
  return {
    sectionNumber,
    order,
    title: String(meta.title || "Section " + String(sectionNumber)),
    subtitle: meta.subtitle ? String(meta.subtitle) : "",
    wordCount: ast.wordCount(searchableText),
    passageCount: ast.passagesFromDocument(contentAst).length,
    // The canonical, hydratable content contract. Derived projections
    // (passages, searchable text) are recomputed from this by consumers, so the
    // AST stays the single stored truth rather than duplicating itself.
    ast: contentAst,
  };
}

function essayArtifact(essay) {
  const sections = uniqueNumbers(essay.section_order).map((sectionNumber, index) =>
    sectionRecord(essay, sectionNumber, index)
  );
  return {
    version: ARTIFACT_VERSION,
    astVersion: String(ast.VERSION),
    slug: String(essay.slug),
    title: String(essay.title || essay.slug),
    sectionCount: sections.length,
    sections,
  };
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function artifactPath(slug) {
  return path.join(outDir, slug + ".json");
}

// Returns [{ slug, content }] for every published essay, deterministically.
function build(essays) {
  return publishedEssays(essays).map((essay) => ({
    slug: String(essay.slug),
    content: stableJson(essayArtifact(essay)),
  }));
}

function listCompiledFiles() {
  if (!fs.existsSync(outDir)) {
    return [];
  }
  return fs.readdirSync(outDir).filter((name) => name.endsWith(".json"));
}

function main() {
  const artifacts = build(loadEssays());
  const check = process.argv.includes("--check");
  const expected = new Set(artifacts.map((entry) => entry.slug + ".json"));
  const orphans = listCompiledFiles().filter((name) => !expected.has(name));

  if (check) {
    const problems = [];
    for (const entry of artifacts) {
      const file = artifactPath(entry.slug);
      const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (actual !== entry.content) {
        problems.push("out of date: data/compiled/" + entry.slug + ".json");
      }
    }
    for (const orphan of orphans) {
      problems.push("orphaned (essay unpublished/removed): data/compiled/" + orphan);
    }
    if (problems.length) {
      console.error("Compiled content AST is stale:");
      problems.forEach((problem) => console.error("  - " + problem));
      console.error("Run: node scripts/generate-content-ast.js");
      process.exit(1);
    }
    console.log("Compiled content AST is up to date (" + artifacts.length + " essays).");
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of artifacts) {
    fs.writeFileSync(artifactPath(entry.slug), entry.content, "utf8");
  }
  for (const orphan of orphans) {
    fs.rmSync(path.join(outDir, orphan));
  }

  const sections = artifacts.reduce((sum, entry) => sum + JSON.parse(entry.content).sectionCount, 0);
  console.log(
    "Wrote " + artifacts.length + " compiled essay artifact(s) to data/compiled/ (" +
    sections + " sections, ast " + String(ast.VERSION) + ")" +
    (orphans.length ? "; removed " + orphans.length + " orphan(s)" : "")
  );
}

if (require.main === module) {
  main();
}

module.exports = { essayArtifact, build, stableJson, loadEssays, publishedEssays, sectionRecord };
