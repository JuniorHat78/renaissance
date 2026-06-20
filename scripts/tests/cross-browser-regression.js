#!/usr/bin/env node

// Runs the core reader journey on Chromium, Firefox and WebKit (Safari's engine)
// so per-engine breakage in the things we lean on — color-mix, backdrop-filter,
// View Transitions (opt-in; absent in FF/WebKit), matchMedia, selection UI —
// surfaces here. Visual pixel diffing stays Chromium-only by design; this is a
// FUNCTIONAL smoke. Uses only engine-agnostic context options (no isMobile).

const assert = require("node:assert/strict");
const playwright = require("playwright");

function parseArgs(argv) {
  const options = {
    base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4178",
    browsers: ["chromium", "firefox", "webkit"]
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--browsers" && argv[index + 1]) {
      options.browsers = argv[index + 1].split(",").map((value) => value.trim()).filter(Boolean);
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function runJourney(browserName, base) {
  const browser = await playwright[browserName].launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 900 },
    colorScheme: "light"
  });
  const page = await context.newPage();

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  try {
    // Archive renders with essays.
    await page.goto(base + "/index.html", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 45000 });

    // Archive -> essay -> section.
    await page.click('#essay-list a[href*="essay.html"]');
    await page.waitForURL(/essay\.html/, { timeout: 45000 });
    await page.waitForSelector("#section-list .toc-item, #essay-title", { timeout: 45000 });
    const essayTitle = (await page.textContent("#essay-title").catch(() => "")) || "";
    assert.ok(essayTitle.trim().length > 0, "[" + browserName + "] essay should render a title");

    await page.click('a[href*="section.html"]');
    await page.waitForURL(/section\.html/, { timeout: 45000 });
    await page.waitForSelector("#section-content p", { timeout: 45000 });
    const paragraphs = await page.$$eval("#section-content p", (nodes) => nodes.length);
    assert.ok(paragraphs > 0, "[" + browserName + "] section should render prose");

    // Selection UI (engine-agnostic; no clipboard API) — chip appears for a real selection.
    await page.evaluate(() => {
      const p = document.querySelector("#section-content p");
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.waitForTimeout(250);
    const chipReady = await page.evaluate(() => {
      const chip = document.getElementById("selection-copy-chip");
      const bar = document.getElementById("selection-copy-bar");
      // On a desktop viewport the chip is used; either being present in the DOM is fine.
      return Boolean(chip || bar);
    });
    assert.ok(chipReady, "[" + browserName + "] selection share controls should exist");

    // Search returns results.
    await page.goto(base + "/search.html", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForSelector("#search-page-input", { timeout: 45000 });
    await page.fill("#search-page-input", "sand");
    await page.waitForSelector("#search-page-results .oracle-result", { timeout: 45000 });
    const hits = await page.$$eval("#search-page-results .oracle-result", (nodes) => nodes.length);
    assert.ok(hits > 0, "[" + browserName + "] search should return results");

    assert.deepEqual(pageErrors, [], "[" + browserName + "] should have no uncaught page errors:\n  " + pageErrors.join("\n  "));
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const failures = [];

  for (const browserName of options.browsers) {
    try {
      await runJourney(browserName, options.base);
      console.log("PASS " + browserName + " core journey");
    } catch (error) {
      failures.push(browserName + ": " + error.message);
      console.error("FAIL " + browserName + " core journey");
    }
  }

  if (failures.length > 0) {
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Cross-browser regression checks passed (" + options.browsers.join(", ") + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
