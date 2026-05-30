#!/usr/bin/env node
"use strict";

// A deterministic performance guardrail. Unlike Lighthouse (noisy, never gates),
// raw asset weight is stable, so we CAN gate it: for each shell page, sum the
// bytes of the CSS + every script it loads and fail if it exceeds the budget.
// This catches "someone dropped a 300KB library into the reader" before it ships,
// without the flakiness of a timing-based metric.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const SHELL_PAGES = ["index.html", "essay.html", "section.html", "search.html"];
const BUDGET_BYTES = Number.parseInt(process.env.RENAISSANCE_ASSET_BUDGET_BYTES || "", 10) || 256 * 1024;

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
  const kb = (total / 1024).toFixed(1);
  rows.push(page + ": " + kb + "KB across " + assets.length + " files (budget " + (BUDGET_BYTES / 1024).toFixed(0) + "KB)");
  if (total > BUDGET_BYTES) {
    failures.push(page + " is " + kb + "KB, over the " + (BUDGET_BYTES / 1024).toFixed(0) + "KB budget");
  }
}

rows.forEach((row) => console.log("  " + row));

if (failures.length > 0) {
  console.error("\nAsset weight budget FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("Asset weight budget checks passed (" + SHELL_PAGES.length + " pages).");
