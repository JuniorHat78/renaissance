#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  ensureDir,
  parseArgs,
  resolveScenarios
} = require("./common");

const DEFAULT_SCENARIOS = "qa/visual/scenarios.json";
const DEFAULT_CURRENT = "qa/visual/current";
const DEFAULT_BASELINE = "qa/visual/baseline";

function copyFile(source, destination) {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function main() {
  const args = parseArgs(process.argv);
  const scenarioFile = String(args.scenarios || DEFAULT_SCENARIOS);
  const only = args.only ? String(args.only) : "";
  const { scenarios } = resolveScenarios(scenarioFile, only);

  const currentDir = path.resolve(process.cwd(), String(args.current || DEFAULT_CURRENT));
  const baselineDir = path.resolve(process.cwd(), String(args.baseline || DEFAULT_BASELINE));

  ensureDir(baselineDir);

  let approved = 0;
  scenarios.forEach((scenario) => {
    const source = path.join(currentDir, `${scenario.id}.png`);
    const destination = path.join(baselineDir, `${scenario.id}.png`);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing current capture for ${scenario.id}: ${source}`);
    }
    copyFile(source, destination);
    approved += 1;
    console.log(`approved ${scenario.id}.png`);
  });

  console.log(`baseline updated for ${approved} scenario(s)`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
