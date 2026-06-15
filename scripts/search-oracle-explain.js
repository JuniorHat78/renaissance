#!/usr/bin/env node
"use strict";

// Terminal harness to FEEL the oracle ranking on real queries before any UI
// exists. Usage:
//   node scripts/search-oracle-explain.js "grain of sand"
//   node scripts/search-oracle-explain.js --essay etching-god-into-sand "omega point"
//   node scripts/search-oracle-explain.js "section 4"

const fs = require("node:fs");
const path = require("node:path");
const oracle = require("./search-oracle.js");

const root = path.join(__dirname, "..");
const index = JSON.parse(fs.readFileSync(path.join(root, "data", "search-index.json"), "utf8"));

const args = process.argv.slice(2);
let essaySlug = null;
const queryParts = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--essay") {
    essaySlug = args[i + 1];
    i += 1;
  } else {
    queryParts.push(args[i]);
  }
}
const rawQuery = queryParts.join(" ");

const { query, results, totalMatched } = oracle.rank(index, rawQuery, { essaySlug });

console.log("");
console.log('query:   "' + rawQuery + '"  ->  intent: ' + query.kind + (query.sectionNumber ? " (section " + query.sectionNumber + ")" : ""));
if (essaySlug) {
  console.log("context: reading " + essaySlug);
}
console.log("matched: " + totalMatched + " result(s); showing " + results.length);
console.log("");

results.forEach((result, position) => {
  const reasons = result.reasons.map((r) => r.label + " +" + r.points).join(", ");
  console.log(
    String(position + 1).padStart(2) + ". [" + String(result.score).padStart(4) + "] " +
    result.kind.toUpperCase() + "  §" + result.sectionNumber + " " + result.sectionTitle +
    "  (" + result.passageId + "/" + result.blockType + ")"
  );
  console.log("      why:  " + reasons);
  if (result.snippet && result.snippet.text) {
    console.log("      text: " + result.snippet.text.replace(/\s+/g, " ").slice(0, 140));
  }
  console.log("");
});
