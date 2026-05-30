#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const site = require("./lib/site-data");

const swPath = path.join(site.root, "sw.js");
const VERSION_RE = /const VERSION = "([^"]+)";/;

function extractPrecache(source) {
  const match = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("could not find PRECACHE array in sw.js");
  }
  return match[1]
    .split(",")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = line.match(/^"([^"]+)"$/);
      if (!parsed) {
        throw new Error("could not parse PRECACHE entry: " + line);
      }
      return parsed[1];
    });
}

function readAssetForHash(asset) {
  const filePath = asset === "./" ? path.join(site.root, "index.html") : path.join(site.root, asset);
  if (!fs.existsSync(filePath)) {
    throw new Error("precache asset missing: " + asset);
  }
  if (isTextAsset(filePath)) {
    return normalizeTextForHash(fs.readFileSync(filePath, "utf8"));
  }
  return fs.readFileSync(filePath);
}

function isTextAsset(filePath) {
  return new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".svg",
    ".txt",
    ".webmanifest",
    ".xml"
  ]).has(path.extname(filePath).toLowerCase());
}

function normalizeTextForHash(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

function computedVersion(source) {
  const hash = crypto.createHash("sha256");
  const normalizedSw = normalizeTextForHash(source)
    .replace(VERSION_RE, 'const VERSION = "__CACHE_VERSION__";');
  hash.update("sw.js\0");
  hash.update(normalizedSw);
  hash.update("\0");
  for (const asset of extractPrecache(source).sort()) {
    hash.update(asset);
    hash.update("\0");
    hash.update(readAssetForHash(asset));
    hash.update("\0");
  }
  return "asset-" + hash.digest("hex").slice(0, 12);
}

function updateSource(source, version) {
  if (!VERSION_RE.test(source)) {
    throw new Error("could not find VERSION constant in sw.js");
  }
  return source.replace(VERSION_RE, 'const VERSION = "' + version + '";');
}

function main() {
  const check = process.argv.includes("--check");
  const source = fs.readFileSync(swPath, "utf8");
  const version = computedVersion(source);
  const expected = updateSource(source, version);

  if (check) {
    if (source !== expected) {
      console.error("Out of date: sw.js cache VERSION should be " + version);
      console.error("Run: node scripts/generate-cache-version.js");
      process.exit(1);
    }
    console.log("Service worker cache version is up to date (" + version + ").");
    return;
  }

  fs.writeFileSync(swPath, expected, "utf8");
  console.log("Updated sw.js cache VERSION to " + version);
}

main();
