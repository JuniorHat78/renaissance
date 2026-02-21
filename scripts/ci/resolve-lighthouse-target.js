#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const essaysPath = path.join(rootDir, "data", "essays.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toSectionNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function firstSection(order) {
  if (!Array.isArray(order)) {
    return 1;
  }

  for (const value of order) {
    const section = toSectionNumber(value);
    if (section !== null) {
      return section;
    }
  }

  return 1;
}

function resolveTarget(essays) {
  if (!Array.isArray(essays) || essays.length === 0) {
    throw new Error("No essays available in data/essays.json");
  }

  const published = essays.find((essay) => essay && essay.published !== false && String(essay.slug || "").trim());
  const fallback = essays.find((essay) => essay && String(essay.slug || "").trim());
  const target = published || fallback;
  if (!target) {
    throw new Error("No valid essay slug found in data/essays.json");
  }

  const slug = String(target.slug).trim();
  const sectionNumber = firstSection(target.section_order);
  return { slug, sectionNumber };
}

function resolveLighthouseEnv(payload) {
  const essays = payload && Array.isArray(payload.essays) ? payload.essays : [];
  return resolveTarget(essays);
}

function main() {
  const payload = readJson(essaysPath);
  const target = resolveLighthouseEnv(payload);
  process.stdout.write("LIGHTHOUSE_ESSAY_SLUG=" + target.slug + "\n");
  process.stdout.write("LIGHTHOUSE_SECTION_NUMBER=" + String(target.sectionNumber) + "\n");
}

if (require.main === module) {
  main();
}

module.exports = {
  firstSection,
  resolveLighthouseEnv,
  resolveTarget,
  toSectionNumber
};
