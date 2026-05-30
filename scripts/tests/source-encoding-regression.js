#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const root = path.join(__dirname, "..", "..");
const decoder = new TextDecoder("utf-8", { fatal: true });
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

const files = childProcess.execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean)
  .filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));

const failures = [];
for (const file of files) {
  try {
    decoder.decode(fs.readFileSync(path.join(root, file)));
  } catch (error) {
    failures.push(file + ": " + error.message);
  }
}

assert.deepEqual(failures, [], failures.join("\n"));
console.log("Source encoding checks passed (" + String(files.length) + " UTF-8 text files).");
