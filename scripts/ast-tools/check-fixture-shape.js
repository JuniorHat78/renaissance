#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fixtures = require("./lib/fixtures");
const files = require("./lib/files");

const entries = fixtures.fixtureEntries([]);
const failures = [];

for (const entry of entries) {
  check(entry.name + " has complete fixture files", () => {
    [
      "README.md",
      "input.txt",
      "ast.json",
      "diagnostics.json",
      "html.html",
      "search.txt",
      "text.txt",
    ].forEach((name) => {
      assert.ok(files.exists(path.join(entry.dir, name)), "missing " + name);
    });
  });

  check(entry.name + " input has a focused README purpose", () => {
    const readme = files.readText(path.join(entry.dir, "README.md"));
    assert.ok(readme.trim().length >= 20, "README is too sparse");
  });
}

if (failures.length > 0) {
  console.error("\nAST fixture shape FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("AST fixture shape checks passed (" + String(entries.length) + " fixtures).");

function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name + "\n  " + error.message);
  }
}
