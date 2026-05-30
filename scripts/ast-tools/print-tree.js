#!/usr/bin/env node
"use strict";

const path = require("node:path");
const Ast = require("../ast");
const files = require("./lib/files");
const fixtures = require("./lib/fixtures");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/ast-tools/print-tree.js <fixture-name|path>");
  process.exit(1);
}

const inputPath = resolveInputPath(target);
const source = files.readText(inputPath);
const documentNode = Ast.parseDocument(source, { sourceName: files.relative(inputPath) });

console.log("document " + files.relative(inputPath));
for (const block of documentNode.children) {
  printBlock(block);
}

if (documentNode.diagnostics.length > 0) {
  console.log("\ndiagnostics");
  for (const diagnostic of documentNode.diagnostics) {
    console.log("- " + diagnostic.code + " @ " + String(diagnostic.offset));
  }
}

function resolveInputPath(value) {
  const fixturePath = fixtures.fixtureInputPath(value);
  if (files.exists(fixturePath)) {
    return fixturePath;
  }

  const absolute = path.isAbsolute(value) ? value : files.fromRoot(value);
  if (files.exists(absolute)) {
    return absolute;
  }

  throw new Error("Cannot find fixture or file: " + value);
}

function printBlock(block) {
  if (block.type === Ast.BLOCK_TYPES.HEADING) {
    console.log("- heading(" + String(block.level) + ") " + JSON.stringify(Ast.blockToPlainText(block)));
    return;
  }

  if (block.type === Ast.BLOCK_TYPES.PARAGRAPH || block.type === Ast.BLOCK_TYPES.PULL_QUOTE) {
    console.log("- " + block.type + " " + JSON.stringify(Ast.blockToPlainText(block)));
    return;
  }

  console.log("- " + block.type);
}
