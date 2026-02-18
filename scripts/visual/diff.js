#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const pixelmatchModule = require("pixelmatch");
const pixelmatch = pixelmatchModule.default || pixelmatchModule;
const {
  ensureDir,
  parseArgs,
  resolveScenarios
} = require("./common");

const DEFAULT_SCENARIOS = "qa/visual/scenarios.json";
const DEFAULT_CURRENT = "qa/visual/current";
const DEFAULT_BASELINE = "qa/visual/baseline";
const DEFAULT_DIFF = "qa/visual/diff";
const DEFAULT_REPORT_JSON = "qa/visual/report.json";
const DEFAULT_REPORT_MD = "qa/visual/report.md";
const DEFAULT_RATIO_THRESHOLD = 0.003;

function readPng(filePath) {
  const buffer = fs.readFileSync(filePath);
  return PNG.sync.read(buffer);
}

function writePng(filePath, png) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function dimensionMismatchDiff(width, height) {
  const diff = new PNG({ width, height });
  for (let index = 0; index < diff.data.length; index += 4) {
    diff.data[index] = 186;
    diff.data[index + 1] = 40;
    diff.data[index + 2] = 28;
    diff.data[index + 3] = 255;
  }
  return diff;
}

function buildMarkdownReport(summary, entries) {
  const lines = [];
  lines.push("# Visual QA Report");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Threshold: ${summary.maxMismatchRatio}`);
  lines.push(`Warn only: ${summary.warnOnly ? "yes" : "no"}`);
  lines.push("");
  lines.push("| Scenario | Status | Pixels | Ratio |");
  lines.push("| --- | --- | ---: | ---: |");
  entries.forEach((entry) => {
    lines.push(
      `| ${entry.id} | ${entry.status} | ${entry.mismatchPixels} | ${entry.mismatchRatio.toFixed(6)} |`
    );
  });
  lines.push("");
  lines.push(`Changed: ${summary.changed}`);
  lines.push(`Missing baseline/current: ${summary.missing}`);
  lines.push(`Pass: ${summary.passed}`);
  lines.push(`Fail: ${summary.failed}`);
  lines.push("");
  return lines.join("\n");
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function compareScenario(scenario, options) {
  const baselineFile = path.join(options.baselineDir, `${scenario.id}.png`);
  const currentFile = path.join(options.currentDir, `${scenario.id}.png`);
  const diffFile = path.join(options.diffDir, `${scenario.id}.png`);

  if (!fs.existsSync(currentFile) || !fs.existsSync(baselineFile)) {
    return {
      id: scenario.id,
      status: "missing",
      mismatchPixels: 0,
      mismatchRatio: 1,
      baselineFile: path.relative(process.cwd(), baselineFile),
      currentFile: path.relative(process.cwd(), currentFile),
      diffFile: path.relative(process.cwd(), diffFile)
    };
  }

  const baseline = readPng(baselineFile);
  const current = readPng(currentFile);
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    writePng(diffFile, dimensionMismatchDiff(width, height));
    return {
      id: scenario.id,
      status: "changed",
      mismatchPixels: width * height,
      mismatchRatio: 1,
      baselineFile: path.relative(process.cwd(), baselineFile),
      currentFile: path.relative(process.cwd(), currentFile),
      diffFile: path.relative(process.cwd(), diffFile)
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const mismatchPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    baseline.width,
    baseline.height,
    {
      threshold: 0.1
    }
  );
  const totalPixels = baseline.width * baseline.height;
  const mismatchRatio = totalPixels > 0 ? mismatchPixels / totalPixels : 0;

  if (mismatchPixels > 0) {
    writePng(diffFile, diff);
  } else if (fs.existsSync(diffFile)) {
    fs.unlinkSync(diffFile);
  }

  return {
    id: scenario.id,
    status: mismatchPixels > 0 ? "changed" : "unchanged",
    mismatchPixels,
    mismatchRatio,
    baselineFile: path.relative(process.cwd(), baselineFile),
    currentFile: path.relative(process.cwd(), currentFile),
    diffFile: path.relative(process.cwd(), diffFile)
  };
}

function main() {
  const args = parseArgs(process.argv);
  const scenarioFile = String(args.scenarios || DEFAULT_SCENARIOS);
  const only = args.only ? String(args.only) : "";
  const { scenarios, configPath, version } = resolveScenarios(scenarioFile, only);

  const currentDir = path.resolve(process.cwd(), String(args.current || DEFAULT_CURRENT));
  const baselineDir = path.resolve(process.cwd(), String(args.baseline || DEFAULT_BASELINE));
  const diffDir = path.resolve(process.cwd(), String(args.diff || DEFAULT_DIFF));
  const reportJsonPath = path.resolve(process.cwd(), String(args.report || DEFAULT_REPORT_JSON));
  const reportMdPath = path.resolve(process.cwd(), String(args["report-md"] || DEFAULT_REPORT_MD));
  const maxMismatchRatio = parseNumber(args.threshold, DEFAULT_RATIO_THRESHOLD);
  const warnOnly = Boolean(args["warn-only"]);

  ensureDir(diffDir);
  ensureDir(path.dirname(reportJsonPath));
  ensureDir(path.dirname(reportMdPath));

  const entries = scenarios.map((scenario) => compareScenario(scenario, {
    baselineDir,
    currentDir,
    diffDir
  }));

  const changed = entries.filter((entry) => entry.status === "changed");
  const missing = entries.filter((entry) => entry.status === "missing");
  const failed = changed
    .filter((entry) => entry.mismatchRatio > maxMismatchRatio)
    .concat(missing);
  const passed = entries.length - failed.length;

  const summary = {
    generatedAt: new Date().toISOString(),
    version,
    configPath: path.relative(process.cwd(), configPath),
    currentDir: path.relative(process.cwd(), currentDir),
    baselineDir: path.relative(process.cwd(), baselineDir),
    diffDir: path.relative(process.cwd(), diffDir),
    maxMismatchRatio,
    warnOnly,
    total: entries.length,
    changed: changed.length,
    missing: missing.length,
    passed,
    failed: failed.length
  };

  const report = {
    summary,
    scenarios: entries
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(reportMdPath, buildMarkdownReport(summary, entries), "utf8");

  console.log(
    `visual diff complete: ${passed}/${entries.length} pass, ${failed.length} fail (${changed.length} changed, ${missing.length} missing)`
  );

  if (failed.length > 0) {
    const changedIds = failed.map((entry) => entry.id).join(", ");
    if (warnOnly) {
      console.warn(`WARNING visual diff issues: ${changedIds}`);
      return;
    }
    throw new Error(`Visual diff failed for: ${changedIds}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
