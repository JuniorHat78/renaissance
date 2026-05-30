#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const site = require("./lib/site-data");

function bytes(filePath) {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function kb(size) {
  return (size / 1024).toFixed(1) + "KB";
}

function main() {
  const registryPath = path.join(site.root, "data", "site-registry.json");
  const offlinePath = path.join(site.root, "data", "offline-assets.json");
  const essays = site.loadEssays();
  const published = site.publishedEssays(essays);
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : null;
  const offline = fs.existsSync(offlinePath) ? JSON.parse(fs.readFileSync(offlinePath, "utf8")) : null;

  const rows = [
    ["essays", String(published.length) + " published / " + String(essays.length) + " total"],
    ["sections", String(published.reduce((count, essay) => count + site.sectionEntries(essay).length, 0))],
    ["routes", registry ? String(registry.routes.length) : "missing registry"],
    ["offline assets", offline && Array.isArray(offline.assets) ? String(offline.assets.length) : "missing manifest"],
    ["scripts/chapters-data.js", kb(bytes(path.join(site.root, "scripts", "chapters-data.js")))],
    ["scripts/essays-data.js", kb(bytes(path.join(site.root, "scripts", "essays-data.js")))],
    ["data/site-registry.json", kb(bytes(registryPath))],
    ["data/offline-assets.json", kb(bytes(offlinePath))],
    ["404.html", kb(bytes(path.join(site.root, "404.html")))],
    ["sw.js", kb(bytes(path.join(site.root, "sw.js")))]
  ];

  console.log("Renaissance artifact summary");
  rows.forEach(([label, value]) => {
    console.log("  " + label + ": " + value);
  });
}

main();
