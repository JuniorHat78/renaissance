#!/usr/bin/env node
"use strict";

const fixtures = require("./lib/fixtures");
const files = require("./lib/files");
const { firstDifference } = require("./lib/diff");

const names = process.argv.slice(2);
const entries = fixtures.fixtureEntries(names);
const failures = [];

if (entries.length === 0) {
  console.error("No AST fixtures found.");
  process.exit(1);
}

for (const entry of entries) {
  try {
    const input = files.readText(entry.inputPath);
    const actual = fixtures.stringifyOutputs(fixtures.buildOutputs(input, entry.name));
    const expected = fixtures.readExpected(entry);

    for (const key of Object.keys(actual)) {
      if (actual[key] !== expected[key]) {
        throw new Error(
          entry.name + "/" + key + " does not match expected output.\n" +
          firstDifference(expected[key], actual[key])
        );
      }
    }

    console.log("PASS " + entry.name);
  } catch (error) {
    failures.push(entry.name + ": " + error.message);
    console.error("FAIL " + entry.name + "\n  " + String(error.message).replace(/\n/g, "\n  "));
  }
}

if (failures.length > 0) {
  console.error("\nAST fixture regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  console.error("\nIf the behavior change is intentional, run npm run ast:fixtures:update.");
  process.exit(1);
}

console.log("AST fixture regression passed (" + String(entries.length) + " fixtures).");
