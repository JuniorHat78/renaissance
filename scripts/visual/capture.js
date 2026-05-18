#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  ensureDir,
  parseArgs,
  resolveScenarios,
  toTargetUrl
} = require("./common");

const DEFAULT_BASE = "http://127.0.0.1:8000";
const DEFAULT_SCENARIOS = "qa/visual/scenarios.json";
const DEFAULT_OUT = "qa/visual/current";
const READING_STATE_KEY = "renaissance-reading-state:v1";

function stateFromRecord(record) {
  const clean = {
    essaySlug: "etching-god-into-sand",
    sectionNumber: 1,
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 900,
    completed: false,
    updatedAt: 1700000000000,
    resumeParagraphIndex: 3,
    resumeParagraphRatio: 0.46,
    essayTitle: "Etching God into Sand",
    sectionTitle: "The Oldest Material",
    sectionLabel: "Section I",
    ...(record || {})
  };

  return {
    version: 1,
    last: clean,
    essays: {
      [clean.essaySlug]: {
        [String(clean.sectionNumber)]: clean
      }
    }
  };
}

async function captureScenario(browser, base, outDir, scenario) {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: scenario.theme === "dark" ? "dark" : "light",
    reducedMotion: "reduce"
  });

  await context.addInitScript(({ theme, readingState, readingStateKey }) => {
    try {
      localStorage.setItem("renaissance-theme", theme);
      if (readingState) {
        localStorage.setItem(readingStateKey, JSON.stringify(readingState));
      }
    } catch (error) {
      // Ignore localStorage failures.
    }
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  }, {
    theme: scenario.theme,
    readingStateKey: READING_STATE_KEY,
    readingState: scenario.readingStateRecord ? stateFromRecord(scenario.readingStateRecord) : null
  });

  const page = await context.newPage();
  const targetUrl = toTargetUrl(base, scenario.url);
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 45000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });

  if (scenario.waitMs > 0) {
    await page.waitForTimeout(scenario.waitMs);
  }

  if (scenario.waitForSelector) {
    await page.waitForSelector(String(scenario.waitForSelector), { timeout: 30000 });
  }

  if (scenario.scroll === "bottom") {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(450);
  } else if (scenario.scroll !== "preserve") {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
  }

  const relativeFile = `${scenario.id}.png`;
  const absoluteFile = path.join(outDir, relativeFile);
  await page.screenshot({
    path: absoluteFile,
    fullPage: scenario.scroll === "full_page"
  });

  await context.close();
  return {
    id: scenario.id,
    url: targetUrl,
    file: relativeFile
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const base = String(args.base || DEFAULT_BASE);
  const scenarioFile = String(args.scenarios || DEFAULT_SCENARIOS);
  const outDir = path.resolve(process.cwd(), String(args.out || DEFAULT_OUT));
  const only = args.only ? String(args.only) : "";

  const { scenarios, configPath, version } = resolveScenarios(scenarioFile, only);
  ensureDir(outDir);

  const browser = await chromium.launch({ headless: true });
  const captured = [];
  try {
    for (const scenario of scenarios) {
      const record = await captureScenario(browser, base, outDir, scenario);
      captured.push(record);
      console.log(`captured ${record.file}`);
    }
  } finally {
    await browser.close();
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    base,
    configPath: path.relative(process.cwd(), configPath),
    version,
    count: captured.length,
    scenarios: captured
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  console.log(`done ${captured.length} captures -> ${path.relative(process.cwd(), outDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
