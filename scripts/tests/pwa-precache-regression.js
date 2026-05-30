#!/usr/bin/env node
"use strict";

// Deterministic guard for offline completeness. If a shell page starts loading
// a script/style that the service worker does not precache, the site silently
// breaks offline — so we assert every local asset referenced by the shell pages
// is in the SW PRECACHE list, that the manifest is valid, and that nothing in
// the precache or the manifest points at a file that does not exist on disk.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const SHELL_PAGES = ["index.html", "essay.html", "section.html", "search.html"];

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name + "\n  " + error.message);
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function extractPrecache(swSource) {
  const match = swSource.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(match, "could not find PRECACHE array in sw.js");
  return match[1]
    .split(",")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((token) => token.replace(/^["']|["']$/g, ""));
}

function localAssets(html) {
  const out = new Set();
  const re = /(?:src|href)="(scripts\/[^"]+|styles\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.add(m[1]);
  }
  return out;
}

const swSource = read("sw.js");
const precache = extractPrecache(swSource);
const precacheSet = new Set(precache);

check("every local asset the shell pages load is precached", () => {
  for (const page of SHELL_PAGES) {
    const assets = localAssets(read(page));
    for (const asset of assets) {
      assert.ok(precacheSet.has(asset), page + " loads " + asset + " but the SW does not precache it");
    }
    // The page document itself must be precached so it opens offline.
    assert.ok(precacheSet.has(page), page + " is not in the SW precache");
  }
});

check("404.html is precached so it works offline", () => {
  assert.ok(precacheSet.has("404.html"), "404.html should be precached");
});

check("cache version is generated from assets", () => {
  const match = swSource.match(/const VERSION = "([^"]+)";/);
  assert.ok(match, "service worker needs a VERSION constant");
  assert.match(match[1], /^asset-[a-f0-9]{12}$/, "service worker VERSION should be an asset hash");
});

check("navigation network fallback is bounded", () => {
  assert.match(swSource, /NAVIGATION_NETWORK_TIMEOUT_MS\s*=\s*\d+/, "navigation fallback should declare a network timeout");
  assert.match(swSource, /Promise\.race\(\[network,\s*timeoutAfter/, "navigation fetch should race the timeout");
});

check("every precached path exists on disk (no dangling entries)", () => {
  for (const entry of precache) {
    if (entry === "./") {
      continue; // directory root, served as index.html
    }
    assert.ok(fs.existsSync(path.join(root, entry)), "precache lists " + entry + " but it does not exist");
  }
});

check("offline text asset manifest is cached and points at real files", () => {
  assert.ok(precacheSet.has("data/offline-assets.json"), "offline asset manifest should be precached");
  assert.ok(/cacheOfflineAssets/.test(swSource), "service worker should cache offline text assets during install");

  const manifest = JSON.parse(read("data/offline-assets.json"));
  assert.ok(Array.isArray(manifest.assets), "offline asset manifest needs an assets array");
  assert.ok(manifest.assets.includes("data/essays.json"), "offline assets should include essay metadata");
  assert.ok(
    manifest.assets.some((asset) => /^raw\/.+\/1\.txt$/.test(asset)),
    "offline assets should include raw section text"
  );

  for (const asset of manifest.assets) {
    assert.ok(fs.existsSync(path.join(root, asset)), "offline asset missing on disk: " + asset);
  }
});

check("the webmanifest is valid and complete", () => {
  const manifest = JSON.parse(read("site.webmanifest"));
  assert.ok(manifest.name, "manifest needs a name");
  assert.equal(manifest.display, "standalone", "manifest should be standalone");
  assert.ok(manifest.start_url, "manifest needs a start_url");
  assert.ok(manifest.scope, "manifest needs a scope");
  assert.ok(/^#/.test(manifest.theme_color), "manifest needs a theme_color");
  assert.ok(/^#/.test(manifest.background_color), "manifest needs a background_color");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "manifest needs icons");

  const purposes = manifest.icons.map((icon) => icon.purpose).join(" ");
  assert.ok(/maskable/.test(purposes), "manifest should declare a maskable icon");

  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, icon.src)), "manifest icon missing on disk: " + icon.src);
    // Icons must be cached so install + offline launch have them.
    assert.ok(precacheSet.has(icon.src), "manifest icon not precached: " + icon.src);
  }
});

check("every shell page advertises the manifest, theme-color, and icons", () => {
  for (const page of SHELL_PAGES) {
    const html = read(page);
    assert.ok(/<link rel="manifest" href="site\.webmanifest">/.test(html), page + " missing manifest link");
    assert.ok(/<meta name="theme-color"/.test(html), page + " missing theme-color");
    assert.ok(/rel="apple-touch-icon"/.test(html), page + " missing apple-touch-icon");
    assert.ok(/rel="icon"[^>]*image\/svg\+xml/.test(html), page + " missing svg icon");
    assert.ok(/<script src="scripts\/pwa\.js"/.test(html), page + " does not register the service worker");
  }
});

if (failures.length > 0) {
  console.error("\nPWA precache regression FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("PWA precache + manifest checks passed.");
