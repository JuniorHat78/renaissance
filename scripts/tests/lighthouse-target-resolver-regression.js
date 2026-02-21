#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { resolveLighthouseEnv } = require("../ci/resolve-lighthouse-target");

const rootDir = path.join(__dirname, "..", "..");
const essaysPath = path.join(rootDir, "data", "essays.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toSectionNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function expectedTarget(essays) {
  const published = essays.find((essay) => essay && essay.published !== false && String(essay.slug || "").trim());
  const fallback = essays.find((essay) => essay && String(essay.slug || "").trim());
  const target = published || fallback;
  assert.ok(target, "Expected at least one essay with a slug");

  const sectionOrder = Array.isArray(target.section_order) ? target.section_order : [];
  let section = 1;
  for (const value of sectionOrder) {
    const parsed = toSectionNumber(value);
    if (parsed !== null) {
      section = parsed;
      break;
    }
  }

  return {
    slug: String(target.slug).trim(),
    section: section
  };
}

function main() {
  const payload = readJson(essaysPath);
  const essays = payload && Array.isArray(payload.essays) ? payload.essays : [];
  const expected = expectedTarget(essays);
  const resolved = resolveLighthouseEnv(payload);

  assert.equal(resolved.slug, expected.slug);
  assert.equal(resolved.sectionNumber, expected.section);

  console.log("Lighthouse target resolver regression checks passed.");
}

main();
