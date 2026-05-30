#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fixtures = require("./lib/fixtures");
const files = require("./lib/files");
const { corpusFiles } = require("./lib/corpus");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const name = args[0];
const sourceName = args[1];
const startLine = optionalPositiveInt(flagValue("--start"));
const endLine = optionalPositiveInt(flagValue("--end"));
const purpose = flagValue("--purpose") || "Corpus-derived regression fixture.";

if (!/^[a-z0-9][a-z0-9-]*$/.test(String(name || "")) || !sourceName) {
  printUsage();
  process.exit(1);
}

if (startLine !== null && endLine !== null && endLine < startLine) {
  console.error("--end must be greater than or equal to --start.");
  process.exit(1);
}

const entry = corpusFiles().find((candidate) => candidate.sourceName === sourceName);
if (!entry) {
  console.error("Cannot find corpus file: " + sourceName);
  process.exit(1);
}

const dir = fixtures.fixtureDir(name);
const inputPath = fixtures.fixtureInputPath(name);

if (files.exists(dir)) {
  console.error("Fixture already exists: " + files.relative(dir));
  process.exit(1);
}

const source = files.readText(entry.filePath).replace(/\r\n?/g, "\n");
const excerpt = selectLines(source, startLine, endLine);
const outputs = fixtures.buildOutputs(excerpt, name);

files.ensureDir(dir);
files.writeText(inputPath, excerpt);
files.writeText(
  path.join(dir, "README.md"),
  "# " + name + "\n\n" +
  purpose + "\n\n" +
  "Source: `" + entry.sourceName + "`" +
  (startLine !== null ? " lines " + String(startLine) + "-" + String(endLine || startLine) : "") +
  "\n"
);

const manifestPath = fixtures.manifestPath();
const manifest = fixtures.loadManifest();
manifest.fixtures.push({ name, purpose });
manifest.fixtures.sort((left, right) => left.name.localeCompare(right.name));
files.writeJson(manifestPath, manifest);

fixtures.writeExpected(
  {
    name,
    dir,
    inputPath,
  },
  outputs
);

console.log("Created " + files.relative(dir) + " from " + entry.sourceName);

function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return "";
  }
  return String(args[index + 1] || "").trim();
}

function optionalPositiveInt(value) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error("Expected a positive integer, received: " + value);
    process.exit(1);
  }
  return parsed;
}

function selectLines(source, start, end) {
  if (start === null) {
    return source.endsWith("\n") ? source : source + "\n";
  }

  const lines = source.split("\n");
  const first = Math.max(0, start - 1);
  const last = Math.min(lines.length, end || start);
  return lines.slice(first, last).join("\n").replace(/\s+$/g, "") + "\n";
}

function printUsage() {
  console.error("Usage:");
  console.error("  node scripts/ast-tools/fixture-from-corpus.js <fixture-name> <sourceName> [--start N] [--end N] [--purpose TEXT]");
  console.error("");
  console.error("Example:");
  console.error("  node scripts/ast-tools/fixture-from-corpus.js odd-pull-quote raw/essay/3.txt --start 12 --end 18 --purpose \"Pin odd pull quote spacing.\"");
}
