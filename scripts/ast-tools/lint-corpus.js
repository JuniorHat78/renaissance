#!/usr/bin/env node
"use strict";

const Ast = require("../ast");
const files = require("./lib/files");
const { corpusFiles } = require("./lib/corpus");

const entries = corpusFiles();
const failures = [];
const diagnosticCounts = new Map();
let blockCount = 0;
let wordCount = 0;

if (entries.length === 0) {
  console.error("No essay corpus files found.");
  process.exit(1);
}

for (const entry of entries) {
  try {
    const source = files.readText(entry.filePath);
    const documentNode = Ast.parseDocument(source, { sourceName: entry.sourceName });
    const validationErrors = Ast.validateDocument(documentNode);
    if (validationErrors.length > 0) {
      failures.push(entry.sourceName + ": " + validationErrors.map((error) => error.path + " " + error.message).join("; "));
    }

    blockCount += documentNode.children.length;
    wordCount += Ast.wordCount(Ast.toSearchableText(documentNode));
    for (const diagnostic of documentNode.diagnostics) {
      diagnosticCounts.set(diagnostic.code, (diagnosticCounts.get(diagnostic.code) || 0) + 1);
    }
  } catch (error) {
    failures.push(entry.sourceName + ": " + error.message);
  }
}

if (failures.length > 0) {
  console.error("AST corpus lint FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log(
  "PASS parsed " + String(entries.length) + " corpus files, " +
  String(blockCount) + " blocks, " + String(wordCount) + " words."
);

if (diagnosticCounts.size > 0) {
  console.log("Diagnostics observed:");
  Array.from(diagnosticCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([code, count]) => console.log("  - " + code + ": " + String(count)));
}
