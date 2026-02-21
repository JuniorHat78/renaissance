#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const contentPath = path.join(__dirname, "..", "content.js");

function main() {
  const source = fs.readFileSync(contentPath, "utf8");

  assert.ok(
    !source.includes('const DEFAULT_ESSAY_SLUG = "etching-god-into-sand"'),
    "Content fallback should not hardcode Etching slug constants"
  );
  assert.ok(
    !source.includes('const DEFAULT_ESSAY_SOURCE_DIR = "raw/etching-god-into-sand"'),
    "Content fallback should not hardcode Etching source dir constants"
  );
  assert.ok(
    !source.includes('title: "Etching God into Sand"'),
    "Content fallback should not hardcode Etching title"
  );
  assert.ok(
    source.includes("function embeddedEssaySlugFallback()"),
    "Expected generic embedded essay slug fallback helper"
  );
  assert.ok(
    source.includes("function fallbackTitleFromSlug(slug)"),
    "Expected generic fallback title generation helper"
  );

  console.log("Content fallback regression checks passed.");
}

main();
