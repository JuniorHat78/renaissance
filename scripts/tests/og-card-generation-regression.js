#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const essaysPath = path.join(rootDir, "data", "essays.json");
const manifestPath = path.join(rootDir, "assets", "og-cards", "manifest.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  assert.ok(fs.existsSync(manifestPath), "Expected OG manifest at assets/og-cards/manifest.json");
  const manifest = readJson(manifestPath);
  const cards = Array.isArray(manifest.cards) ? manifest.cards : [];
  assert.ok(cards.length > 0, "Expected at least one generated OG card");

  const payload = readJson(essaysPath);
  const essays = payload && Array.isArray(payload.essays) ? payload.essays : [];
  const slugs = essays.map((essay) => String((essay && essay.slug) || "").trim()).filter((slug) => slug);

  for (const slug of slugs) {
    const record = cards.find((entry) => entry && entry.slug === slug);
    assert.ok(record, "Expected OG manifest entry for slug " + slug);
    assert.ok(record.image, "Expected image path for slug " + slug);
    const imagePath = path.join(rootDir, String(record.image || ""));
    assert.ok(fs.existsSync(imagePath), "Expected generated OG image for slug " + slug);
  }

  console.log("OG card generation regression checks passed.");
}

main();
