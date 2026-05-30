#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const site = require("./lib/site-data");

const pagePath = path.join(site.root, "404.html");
const START = "<!-- RECOVERY_CATALOGUE_START -->";
const END = "<!-- RECOVERY_CATALOGUE_END -->";

function catalogueBlock() {
  const json = JSON.stringify(site.recoveryCatalogue(site.loadEssays()));
  return [
    START,
    '  <script type="application/json" id="recovery-catalogue">' + json + "</script>",
    END
  ].join("\n");
}

function updatePage(source, block) {
  const startIndex = source.indexOf(START);
  const endIndex = source.indexOf(END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("404.html is missing recovery catalogue markers");
  }
  return source.slice(0, startIndex) + block + source.slice(endIndex + END.length);
}

function main() {
  const check = process.argv.includes("--check");
  const source = fs.readFileSync(pagePath, "utf8");
  const expected = updatePage(source, catalogueBlock());

  if (check) {
    if (source !== expected) {
      console.error("Out of date: embedded recovery catalogue in 404.html");
      console.error("Run: node scripts/generate-404-catalogue.js");
      process.exit(1);
    }
    console.log("404 recovery catalogue is up to date.");
    return;
  }

  fs.writeFileSync(pagePath, expected, "utf8");
  console.log("Updated embedded recovery catalogue in 404.html");
}

main();
