#!/usr/bin/env node
"use strict";

const Ast = require("../ast");
const files = require("./lib/files");
const legacy = require("./lib/legacy-renderer");
const { corpusFiles } = require("./lib/corpus");

const entries = corpusFiles();
const failures = [];
let exactHtmlMatches = 0;
let intentionalHtmlDifferences = 0;

for (const entry of entries) {
  const source = files.readText(entry.filePath);
  const oldBlocks = legacy.parseBlocks(source);
  const newDocument = Ast.parseDocument(source, { sourceName: entry.sourceName });
  const oldSearch = legacy.searchableText(oldBlocks);
  const newSearch = Ast.toSearchableText(newDocument);

  if (normalize(oldSearch) !== normalize(newSearch)) {
    failures.push(entry.sourceName + ": searchable text changed");
  }

  const oldHtml = legacy.serializeBlocks(oldBlocks);
  const newHtml = Ast.serializeDocument(newDocument);
  if (oldHtml === newHtml) {
    exactHtmlMatches += 1;
  } else {
    intentionalHtmlDifferences += 1;
    if (unsafeHtmlDifference(oldHtml, newHtml)) {
      failures.push(entry.sourceName + ": AST output appears less escaped than legacy output");
    }
  }
}

if (failures.length > 0) {
  console.error("AST renderer comparison FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log(
  "PASS compared " + String(entries.length) + " corpus files " +
  "(" + String(exactHtmlMatches) + " exact HTML matches, " +
  String(intentionalHtmlDifferences) + " conservative HTML differences)."
);

function normalize(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function unsafeHtmlDifference(oldHtml, newHtml) {
  return /<script/i.test(newHtml) ||
    /<img/i.test(newHtml) ||
    /onerror\s*=/i.test(newHtml) ||
    (/[<>]/.test(stripTags(newHtml)) && !/[<>]/.test(stripTags(oldHtml)));
}

function stripTags(value) {
  return String(value).replace(/<\/?(?:h1|h2|h3|p|em|br|hr)(?: class="pull-quote")?>/g, "");
}
