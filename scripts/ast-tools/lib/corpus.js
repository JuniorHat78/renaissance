#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const files = require("./files");

function readEssayRegistry() {
  const registryPath = files.fromRoot("data", "essays.json");
  if (!files.exists(registryPath)) {
    return [];
  }

  const payload = files.readJson(registryPath);
  return Array.isArray(payload.essays) ? payload.essays : [];
}

function sectionNumbers(essay, sourcePath) {
  if (Array.isArray(essay.section_order) && essay.section_order.length > 0) {
    return essay.section_order
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
  }

  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  return fs.readdirSync(sourcePath)
    .filter((name) => /^\d+\.txt$/i.test(name))
    .map((name) => Number.parseInt(name, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

function corpusFiles() {
  const entries = [];

  for (const essay of readEssayRegistry()) {
    const slug = String((essay && essay.slug) || "").trim();
    const sourceDir = String((essay && essay.source_dir) || "raw").trim() || "raw";
    const sourcePath = files.fromRoot(sourceDir);

    for (const sectionNumber of sectionNumbers(essay || {}, sourcePath)) {
      const filePath = path.join(sourcePath, String(sectionNumber) + ".txt");
      if (fs.existsSync(filePath)) {
        entries.push({
          essaySlug: slug,
          sectionNumber,
          filePath,
          sourceName: sourceDir.replace(/\\/g, "/") + "/" + String(sectionNumber) + ".txt",
        });
      }
    }
  }

  return entries;
}

module.exports = { corpusFiles, readEssayRegistry };
