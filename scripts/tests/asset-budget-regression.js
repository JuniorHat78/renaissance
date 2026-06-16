#!/usr/bin/env node
"use strict";

// A deterministic performance guardrail. Unlike Lighthouse (noisy, never gates),
// raw asset weight is stable, so we CAN gate it: for each shell page, sum the
// bytes of the CSS + every script it loads and fail if it exceeds the budget.
// This catches "someone dropped a 300KB library into the reader" before it ships,
// without the flakiness of a timing-based metric.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const SHELL_PAGES = ["index.html", "essay.html", "section.html", "search.html"];
const DEFAULT_BUDGET_BYTES = Number.parseInt(process.env.RENAISSANCE_ASSET_BUDGET_BYTES || "", 10) || 256 * 1024;
const PAGE_BUDGET_BYTES = {
  // section.html is the heaviest shell: the 86KB section.js reader plus the
  // cross-page Spotlight launcher, oracle, and now the continuity transition.
  // Raised 264 -> 304 (Spotlight) -> 320 (oracle) -> 336 (continuity). This is
  // the agreed ceiling: continuity is the last feature we grow it for. The real
  // fix is booked — split section.js — and is the immediate follow-on to the
  // continuity work, NOT another budget bump.
  "section.html": 336 * 1024,
  // essay.html carries the motif card + oracle client/engine on top of the
  // essay view. Raised 256 -> 272 (oracle-native search) -> 280 (the composed-
  // arrival veil CSS, which is shared site.css weight across every page).
  "essay.html": 280 * 1024,
  // index.html crossed the default ceiling when the continuity transition
  // (capture side) joined the home archive. Raised 256 -> 272.
  "index.html": 272 * 1024
};

function localAssets(html) {
  const out = new Set();
  const re = /(?:src|href)="(scripts\/[^"]+|styles\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.add(m[1]);
  }
  return out;
}

const failures = [];
const rows = [];

for (const page of SHELL_PAGES) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  const assets = [...localAssets(html)];
  let total = 0;
  for (const asset of assets) {
    try {
      total += fs.statSync(path.join(root, asset)).size;
    } catch (error) {
      failures.push(page + " references " + asset + " which is missing on disk");
    }
  }
  const budget = PAGE_BUDGET_BYTES[page] || DEFAULT_BUDGET_BYTES;
  const kb = (total / 1024).toFixed(1);
  rows.push(page + ": " + kb + "KB across " + assets.length + " files (budget " + (budget / 1024).toFixed(0) + "KB)");
  if (total > budget) {
    failures.push(page + " is " + kb + "KB, over the " + (budget / 1024).toFixed(0) + "KB budget");
  }
}

rows.forEach((row) => console.log("  " + row));

if (failures.length > 0) {
  console.error("\nAsset weight budget FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("Asset weight budget checks passed (" + SHELL_PAGES.length + " pages).");
