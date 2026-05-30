#!/usr/bin/env node
"use strict";

const path = require("node:path");
const Ast = require("../ast");
const files = require("./lib/files");
const fixtures = require("./lib/fixtures");

const args = process.argv.slice(2);
const json = args.includes("--json");
const full = args.includes("--full");
const target = args.find((arg) => !arg.startsWith("--"));

if (!target) {
  console.error("Usage: node scripts/ast-tools/explain.js <fixture-name|path> [--json] [--full]");
  process.exit(1);
}

const inputPath = resolveInputPath(target);
const sourceName = files.relative(inputPath);
const source = files.readText(inputPath);
const documentNode = Ast.parseDocument(source, { sourceName });
const validation = Ast.validateDocument(documentNode);
const summary = {
  sourceName,
  blocks: documentNode.children.length,
  words: Ast.wordCount(Ast.toSearchableText(documentNode)),
  diagnostics: documentNode.diagnostics.length,
  validationErrors: validation.length,
};

if (json) {
  console.log(files.stableJson({
    summary,
    diagnostics: documentNode.diagnostics,
    validation,
    ast: documentNode,
    html: Ast.serializeDocument(documentNode),
    search: Ast.toSearchableText(documentNode),
    text: Ast.toPlainText(documentNode),
  }));
  process.exit(validation.length > 0 ? 1 : 0);
}

console.log("AST Explain: " + sourceName);
console.log("Blocks: " + String(summary.blocks));
console.log("Words: " + String(summary.words));

printDiagnostics(documentNode.diagnostics, validation);
printTree(documentNode);
printProjection("Plain Text", Ast.toPlainText(documentNode));
printProjection("Search Text", Ast.toSearchableText(documentNode));
printProjection("HTML", Ast.serializeDocument(documentNode));

process.exit(validation.length > 0 ? 1 : 0);

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

function printDiagnostics(diagnostics, validation) {
  console.log("");
  console.log("Diagnostics:");
  if (diagnostics.length === 0 && validation.length === 0) {
    console.log("  none");
    return;
  }

  diagnostics.forEach((diagnostic) => {
    const position = diagnostic.position
      ? " line " + String(diagnostic.position.line) + ", column " + String(diagnostic.position.column)
      : " offset " + String(diagnostic.offset || 0);
    console.log("  " + diagnostic.severity + " " + diagnostic.code + ":" + position + " - " + diagnostic.message);
  });

  validation.forEach((error) => {
    console.log("  " + error.severity + " " + error.code + ": " + error.path + " - " + error.message);
  });
}

function printTree(documentNode) {
  console.log("");
  console.log("Tree:");
  documentNode.children.forEach((block, index) => {
    const label = block.type === Ast.BLOCK_TYPES.HEADING
      ? block.type + "(" + String(block.level) + ")"
      : block.type;
    console.log("  " + String(index + 1) + ". " + label + " - " + JSON.stringify(Ast.blockToPlainText(block)));
  });
}

function printProjection(title, value) {
  console.log("");
  console.log(title + ":");
  console.log(indent(full ? value : excerpt(value)));
}

function excerpt(value) {
  const text = String(value || "");
  if (text.length <= 1000) {
    return text;
  }
  return text.slice(0, 1000).trimEnd() + "\n... (" + String(text.length - 1000) + " more chars; pass --full to print all)";
}

function indent(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => "  " + line)
    .join("\n");
}
