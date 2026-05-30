#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const site = require("./lib/site-data");

const outPath = path.join(site.root, "data", "site-registry.json");

function main() {
  const expected = site.stableJson(site.routeRegistry(site.loadEssays()));
  const check = process.argv.includes("--check");

  if (check) {
    const actual = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (actual !== expected) {
      console.error("Out of date: data/site-registry.json");
      console.error("Run: node scripts/generate-site-registry.js");
      process.exit(1);
    }
    console.log("Site registry is up to date.");
    return;
  }

  fs.writeFileSync(outPath, expected, "utf8");
  const registry = JSON.parse(expected);
  console.log(
    "Wrote data/site-registry.json (" +
    registry.stats.routes + " routes, " +
    registry.stats.essays + " essays, " +
    registry.stats.sections + " sections)"
  );
}

main();
