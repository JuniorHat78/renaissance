#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..", "..");
const fixtureRoot = path.join(rootDir, "test-fixtures", "ast");

function fromRoot() {
  return path.join(rootDir, ...Array.from(arguments));
}

function relative(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(value), "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, value) {
  writeText(filePath, stableJson(value) + "\n");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function stableJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      out[key] = sortJson(value[key]);
      return out;
    }, {});
}

module.exports = {
  ensureDir,
  exists,
  fixtureRoot,
  fromRoot,
  readJson,
  readText,
  relative,
  rootDir,
  stableJson,
  writeJson,
  writeText,
};
