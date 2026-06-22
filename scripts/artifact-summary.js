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

function readJsonIfPresent(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function extractPrecache(source) {
  const match = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = line.match(/^"([^"]+)"$/);
      return parsed ? parsed[1] : "";
    })
    .filter(Boolean);
}

function assetFilePath(asset) {
  if (asset === "./") {
    return path.join(site.root, "index.html");
  }
  return path.join(site.root, asset.replace(/^\.\//, ""));
}

function assetBytes(assets) {
  return assets.reduce((total, asset) => total + bytes(assetFilePath(asset)), 0);
}

function main() {
  const registryPath = path.join(site.root, "data", "site-registry.json");
  const offlinePath = path.join(site.root, "data", "offline-assets.json");
  const swPath = path.join(site.root, "sw.js");
  const essays = site.loadEssays();
  const published = site.publishedEssays(essays);
  const registry = readJsonIfPresent(registryPath);
  const offline = readJsonIfPresent(offlinePath);
  const swSource = fs.existsSync(swPath) ? fs.readFileSync(swPath, "utf8") : "";
  const precache = swSource ? extractPrecache(swSource) : [];
  const offlineAssets = offline && Array.isArray(offline.assets) ? offline.assets : [];
  const recovery = registry && registry.recovery ? registry.recovery : null;
  const recoveryEssays = recovery && Array.isArray(recovery.essays) ? recovery.essays : [];
  const recoverySections = recoveryEssays.reduce((count, essay) => {
    return count + (Array.isArray(essay.sections) ? essay.sections.length : 0);
  }, 0);
  const recoveryBytes = recovery ? Buffer.byteLength(JSON.stringify(recovery), "utf8") : 0;

  const rows = [
    ["essays", String(published.length) + " published / " + String(essays.length) + " total"],
    ["sections", String(published.reduce((count, essay) => count + site.sectionEntries(essay).length, 0))],
    ["routes", registry ? String(registry.routes.length) : "missing registry"],
    ["offline assets", offlineAssets.length ? String(offlineAssets.length) : "missing manifest"],
    ["service worker precache", precache.length ? String(precache.length) + " entries / " + kb(assetBytes(precache)) : "missing precache"],
    ["offline asset payload", offlineAssets.length ? String(offlineAssets.length) + " entries / " + kb(assetBytes(offlineAssets)) : "missing manifest"],
    ["recovery catalogue", recovery ? String(recoveryEssays.length) + " essays / " + String(recoverySections) + " sections / " + kb(recoveryBytes) : "missing catalogue"],
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
