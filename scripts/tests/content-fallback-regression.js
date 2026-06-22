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
  assert.ok(
    source.includes("scripts/ast/core.js and scripts/ast/render.js must load before scripts/content.js"),
    "Content runtime should require the shipped AST modules before section rendering"
  );
  assert.ok(
    !source.includes("AST.parseDocument"),
    "Content runtime must not parse on the client — it hydrates the compiled AST"
  );
  assert.ok(
    !source.includes("function formatInlineMarkdown"),
    "Content runtime should not keep a parallel regex inline renderer"
  );
  assert.ok(
    !source.includes("container.innerHTML ="),
    "Content runtime should render through the AST DOM renderer, not innerHTML"
  );

  console.log("Content fallback regression checks passed.");
}

main();
