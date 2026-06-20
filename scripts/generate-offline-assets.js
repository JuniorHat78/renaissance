#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outPath = path.join(root, "data", "offline-assets.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeAssetPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function sectionNumbers(essay) {
  const sourceDir = normalizeAssetPath(essay.source_dir || "raw");
  const manifestPath = path.join(root, sourceDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (Array.isArray(manifest.chapters) && manifest.chapters.length > 0) {
      return manifest.chapters;
    }
  }
  return Array.isArray(essay.section_order) ? essay.section_order : [];
}

function buildManifest() {
  const payload = readJson(path.join(root, "data", "essays.json"));
  const essays = Array.isArray(payload.essays) ? payload.essays : [];
  const assets = new Set(["data/essays.json"]);

  essays.forEach((essay) => {
    const sourceDir = normalizeAssetPath(essay.source_dir || "raw");
    assets.add(sourceDir + "/manifest.json");
    sectionNumbers(essay).forEach((sectionNumber) => {
      const parsed = Number.parseInt(sectionNumber, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        assets.add(sourceDir + "/" + String(parsed) + ".txt");
      }
    });
    // Precache the compiled content AST so offline reading uses the same
    // hydration fast path as online (scripts/content.js loadCompiledEssay).
    // Scope matches the compiler: published essays only.
    if (essay && essay.published !== false && essay.slug) {
      assets.add("data/compiled/" + String(essay.slug) + ".json");
    }
  });

  return {
    version: 1,
    assets: Array.from(assets).sort(),
  };
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function main() {
  const expected = stableJson(buildManifest());
  const check = process.argv.includes("--check");

  if (check) {
    const actual = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (actual !== expected) {
      console.error("Out of date: data/offline-assets.json");
      process.exit(1);
    }
    console.log("Offline asset manifest is up to date.");
    return;
  }

  fs.writeFileSync(outPath, expected);
  console.log("Wrote data/offline-assets.json");
}

main();
