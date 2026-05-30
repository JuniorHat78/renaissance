"use strict";

// Captures the current Lighthouse performance scores into a committed baseline
// that the warning summarizer diffs future runs against. Scores are hardware-
// sensitive, so a trustworthy baseline comes from CI: run the lighthouse job (or
// download its .lighthouseci artifact), then run this to write qa/lighthouse/
// baseline.json. It reads whatever .lighthouseci/*.json reports are present.

const fs = require("fs");
const path = require("path");
const { scoreFromReport } = require("./lighthouse-warning-summary");

const REPORTS = [
  { label: "Home", file: ".lighthouseci/index.json" },
  { label: "Essay", file: ".lighthouseci/essay.json" },
  { label: "Section", file: ".lighthouseci/section.json" }
];

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function main() {
  const scores = {};
  let captured = 0;
  for (const report of REPORTS) {
    const data = readJsonSafe(path.resolve(report.file));
    const score = data ? scoreFromReport(data) : null;
    if (Number.isFinite(score)) {
      scores[report.label] = score;
      captured += 1;
    } else {
      console.warn("WARN no score for " + report.label + " (" + report.file + ") — skipping");
    }
  }

  if (captured === 0) {
    console.error("No Lighthouse reports found under .lighthouseci/. Run the lighthouse job first.");
    process.exit(1);
  }

  const baseline = {
    capturedAt: new Date().toISOString().slice(0, 10),
    sourceRun: process.env.GITHUB_RUN_ID || process.env.LIGHTHOUSE_SOURCE_RUN || "local",
    note: "Performance scores are noisy on shared runners; the summarizer flags drops >= 8pts only.",
    scores
  };

  const outDir = path.resolve("qa", "lighthouse");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "baseline.json");
  fs.writeFileSync(outFile, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log("Wrote " + path.relative(process.cwd(), outFile) + ":");
  console.log(JSON.stringify(baseline, null, 2));
}

main();
