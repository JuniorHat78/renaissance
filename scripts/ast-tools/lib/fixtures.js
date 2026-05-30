#!/usr/bin/env node
"use strict";

const path = require("node:path");
const Ast = require("../../ast");
const files = require("./files");

const OUTPUT_FILES = Object.freeze({
  ast: "ast.json",
  diagnostics: "diagnostics.json",
  html: "html.html",
  search: "search.txt",
  text: "text.txt",
});

function manifestPath() {
  return path.join(files.fixtureRoot, "manifest.json");
}

function loadManifest() {
  if (!files.exists(manifestPath())) {
    return { version: 1, fixtures: [] };
  }

  const manifest = files.readJson(manifestPath());
  if (!manifest || !Array.isArray(manifest.fixtures)) {
    throw new Error("AST fixture manifest must contain a fixtures array.");
  }
  return manifest;
}

function fixtureDir(name) {
  return path.join(files.fixtureRoot, name);
}

function fixtureInputPath(name) {
  return path.join(fixtureDir(name), "input.txt");
}

function fixtureEntries(filterNames) {
  const selected = new Set((filterNames || []).filter(Boolean));
  return loadManifest().fixtures
    .filter((fixture) => fixture && fixture.name)
    .filter((fixture) => selected.size === 0 || selected.has(fixture.name))
    .map((fixture) => Object.assign({}, fixture, {
      dir: fixtureDir(fixture.name),
      inputPath: fixtureInputPath(fixture.name),
    }));
}

function buildOutputs(input, sourceName) {
  const documentNode = Ast.parseDocument(input, { sourceName });
  const validation = Ast.validateDocument(documentNode);
  if (validation.length > 0) {
    throw new Error(
      "AST validation failed for " + sourceName + ":\n" +
      validation.map((error) => "  - " + error.path + ": " + error.message).join("\n")
    );
  }

  return {
    ast: snapshotAst(documentNode),
    diagnostics: documentNode.diagnostics,
    html: Ast.serializeDocument(documentNode),
    search: Ast.toSearchableText(documentNode),
    text: Ast.toPlainText(documentNode),
  };
}

function snapshotAst(documentNode) {
  return JSON.parse(JSON.stringify(documentNode));
}

function readExpected(entry) {
  return {
    ast: files.stableJson(files.readJson(path.join(entry.dir, OUTPUT_FILES.ast))) + "\n",
    diagnostics: files.stableJson(files.readJson(path.join(entry.dir, OUTPUT_FILES.diagnostics))) + "\n",
    html: files.readText(path.join(entry.dir, OUTPUT_FILES.html)),
    search: files.readText(path.join(entry.dir, OUTPUT_FILES.search)),
    text: files.readText(path.join(entry.dir, OUTPUT_FILES.text)),
  };
}

function stringifyOutputs(outputs) {
  return {
    ast: files.stableJson(outputs.ast) + "\n",
    diagnostics: files.stableJson(outputs.diagnostics) + "\n",
    html: outputs.html + "\n",
    search: outputs.search + "\n",
    text: outputs.text + "\n",
  };
}

function writeExpected(entry, outputs) {
  const serialized = stringifyOutputs(outputs);
  files.writeJson(path.join(entry.dir, OUTPUT_FILES.ast), outputs.ast);
  files.writeJson(path.join(entry.dir, OUTPUT_FILES.diagnostics), outputs.diagnostics);
  files.writeText(path.join(entry.dir, OUTPUT_FILES.html), serialized.html);
  files.writeText(path.join(entry.dir, OUTPUT_FILES.search), serialized.search);
  files.writeText(path.join(entry.dir, OUTPUT_FILES.text), serialized.text);
}

module.exports = {
  OUTPUT_FILES,
  buildOutputs,
  fixtureDir,
  fixtureEntries,
  fixtureInputPath,
  loadManifest,
  manifestPath,
  readExpected,
  stringifyOutputs,
  writeExpected,
};
