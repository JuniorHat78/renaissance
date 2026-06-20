#!/usr/bin/env node

// Continuity transition regression. The effect itself is a 480ms FLIP, so we do
// not assert mid-flight pixels (that would be flaky); we assert the *outcomes*
// that prove the contract held:
//   1. Happy path: clicking a search result lands on the reader fully
//      highlighted AND a flight ran (data-continuity-arrived), then the inline
//      flight styles are cleaned up (no stranded transform).
//   2. Reduced motion: still lands highlighted, but NO flight runs.
//   3. Direct nav (no capture): still lands highlighted, no flight, no errors.
// Any uncaught page error fails the run.

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000",
    essay: "etching-god-into-sand",
    section: 1,
    query: "sand"
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    } else if (token === "--query" && argv[index + 1]) {
      options.query = argv[index + 1];
      index += 1;
    } else if (token === "--essay" && argv[index + 1]) {
      options.essay = argv[index + 1];
      index += 1;
    } else if (token === "--section" && argv[index + 1]) {
      options.section = Number.parseInt(argv[index + 1], 10) || options.section;
      index += 1;
    }
  }
  return options;
}

async function runCase(name, callback, failures) {
  try {
    await callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error && error.stack ? error.stack : error.message}`);
    console.error(`FAIL ${name}`);
  }
}

async function openSearchAndClickResult(page, options) {
  await page.goto(options.base + "/search.html", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#search-page-input", { timeout: 30000 });
  await page.fill("#search-page-input", options.query);
  // A section-linked result that actually carries a <mark> is the continuity case.
  const selector = "#search-page-results .oracle-result[href*='section.html']";
  await page.waitForSelector(selector, { timeout: 30000 });
  const handle = await page.evaluateHandle((sel) => {
    const rows = Array.from(document.querySelectorAll(sel));
    return rows.find((row) => row.querySelector("mark")) || rows[0] || null;
  }, selector);
  const element = handle.asElement();
  assert.ok(element, "Expected a section-linked search result with a mark to click");
  await element.click();
  await page.waitForURL(/section\.html/, { timeout: 30000 });
  await page.waitForSelector('mark[data-auto-highlight="1"]', { timeout: 30000 });
}

async function readMarkInlineState(page) {
  return page.evaluate(() => {
    const mark = document.querySelector('mark[data-auto-highlight="1"]');
    const root = document.documentElement;
    return {
      hasMark: Boolean(mark),
      transform: mark ? mark.style.transform : null,
      display: mark ? mark.style.display : null,
      arrived: root.getAttribute("data-continuity-arrived")
    };
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const failures = [];

  await runCase("search result flies into the reader and settles clean", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference",
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error && error.message)));

    await openSearchAndClickResult(page, options);

    // The flight is claimed synchronously when the highlight settles.
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-continuity-arrived") === "1",
      null,
      { timeout: 10000 }
    );

    // Let the 480ms flight finish, then confirm the inline flight styles are gone.
    await page.waitForTimeout(900);
    const state = await readMarkInlineState(page);
    assert.ok(state.hasMark, "Reader should land fully highlighted");
    assert.equal(state.arrived, "1", "A continuity flight should have run");
    assert.equal(state.transform || "", "", "Flight should not strand an inline transform");
    assert.equal(state.display || "", "", "Flight should restore inline display");
    assert.deepEqual(pageErrors, [], "No uncaught page errors:\n  " + pageErrors.join("\n  "));

    await context.close();
  }, failures);

  await runCase("reduced motion lands highlighted with no flight", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error && error.message)));

    await openSearchAndClickResult(page, options);
    await page.waitForTimeout(300);
    const state = await readMarkInlineState(page);
    assert.ok(state.hasMark, "Reduced motion should still land fully highlighted");
    assert.notEqual(state.arrived, "1", "Reduced motion must not run a flight");
    assert.deepEqual(pageErrors, [], "No uncaught page errors:\n  " + pageErrors.join("\n  "));

    await context.close();
  }, failures);

  await runCase("direct nav (no capture) lands highlighted with no flight", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference",
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error && error.message)));

    const url = new URL("/section.html", options.base);
    url.searchParams.set("essay", options.essay);
    url.searchParams.set("section", String(options.section));
    url.searchParams.set("q", options.query);
    await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector('mark[data-auto-highlight="1"]', { timeout: 30000 });
    await page.waitForTimeout(300);
    const state = await readMarkInlineState(page);
    assert.ok(state.hasMark, "Direct nav should land fully highlighted");
    assert.notEqual(state.arrived, "1", "Direct nav has no capture, so no flight");
    assert.deepEqual(pageErrors, [], "No uncaught page errors:\n  " + pageErrors.join("\n  "));

    await context.close();
  }, failures);

  await browser.close();

  if (failures.length > 0) {
    console.error("\nContinuity regression failures:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log("\nContinuity regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
