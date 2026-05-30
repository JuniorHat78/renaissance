#!/usr/bin/env node
"use strict";

const fixtures = require("./lib/fixtures");
const files = require("./lib/files");

const names = process.argv.slice(2);
const entries = fixtures.fixtureEntries(names);

if (entries.length === 0) {
  console.error("No AST fixtures found.");
  process.exit(1);
}

for (const entry of entries) {
  const input = files.readText(entry.inputPath);
  fixtures.writeExpected(entry, fixtures.buildOutputs(input, entry.name));
  console.log("UPDATED " + entry.name);
}

console.log("Updated " + String(entries.length) + " AST fixture snapshots.");
