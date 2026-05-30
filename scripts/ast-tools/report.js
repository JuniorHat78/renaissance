#!/usr/bin/env node
"use strict";

const Ast = require("../ast");
const files = require("./lib/files");
const { corpusFiles } = require("./lib/corpus");

const entries = corpusFiles();
const diagnostics = new Map();
const blockTypes = new Map();
const inlineTypes = new Map();
const failures = [];

let totalBlocks = 0;
let totalWords = 0;

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
      failures.push(entry.sourceName + ": " + validationErrors.map(formatValidationError).join("; "));
    }

    totalBlocks += documentNode.children.length;
    totalWords += Ast.wordCount(Ast.toSearchableText(documentNode));
    countDocumentShapes(documentNode);

    for (const diagnostic of documentNode.diagnostics) {
      diagnostics.set(diagnostic.code, (diagnostics.get(diagnostic.code) || 0) + 1);
    }
  } catch (error) {
    failures.push(entry.sourceName + ": " + error.message);
  }
}

if (failures.length > 0) {
  console.error("AST report found failures:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("AST Corpus Report");
console.log("=================");
console.log("Files: " + String(entries.length));
console.log("Blocks: " + String(totalBlocks));
console.log("Words: " + String(totalWords));
printCounts("Block Types", blockTypes);
printCounts("Inline Types", inlineTypes);
printCounts("Diagnostics", diagnostics);

function countDocumentShapes(documentNode) {
  for (const block of documentNode.children) {
    addCount(blockTypes, block.type);
    for (const inline of block.children || []) {
      countInline(inline);
    }
  }
}

function countInline(node) {
  addCount(inlineTypes, node.type);
  for (const child of node.children || []) {
    countInline(child);
  }
}

function addCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function printCounts(title, counts) {
  console.log("");
  console.log(title + ":");
  if (counts.size === 0) {
    console.log("  none");
    return;
  }

  Array.from(counts.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .forEach(([key, count]) => {
      console.log("  " + key + ": " + String(count));
    });
}

function formatValidationError(error) {
  return error.code + " at " + error.path + " (" + error.message + ")";
}
