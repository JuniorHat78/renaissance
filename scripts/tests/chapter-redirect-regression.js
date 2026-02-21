#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function chapterUrl(base, params) {
  const url = new URL("/chapter.html", base);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function assertLocation(actualUrl, expectedPath, expectedQuery) {
  const url = new URL(actualUrl);
  assert.equal(url.pathname, expectedPath, "Unexpected redirect pathname");
  for (const [key, value] of Object.entries(expectedQuery)) {
    assert.equal(url.searchParams.get(key), String(value), "Unexpected query param for " + key);
  }
}

async function open(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(120);
}

async function runCase(name, callback, failures) {
  try {
    await callback();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const failures = [];

  await runCase("chapter+essay redirects to section with essay", async () => {
    await open(page, chapterUrl(options.base, { chapter: 2, essay: "shadows" }));
    assertLocation(page.url(), "/section.html", {
      essay: "shadows",
      section: 2
    });
  }, failures);

  await runCase("chapter-only redirects to section with safe default shape", async () => {
    await open(page, chapterUrl(options.base, { chapter: 3 }));
    assertLocation(page.url(), "/section.html", {
      section: 3
    });
    assert.equal(new URL(page.url()).searchParams.get("essay"), null, "Essay should stay unset when omitted");
  }, failures);

  await runCase("essay-only redirects to essay page", async () => {
    await open(page, chapterUrl(options.base, { essay: "shadows" }));
    assertLocation(page.url(), "/essay.html", {
      essay: "shadows"
    });
  }, failures);

  await runCase("no params redirects to home", async () => {
    await open(page, chapterUrl(options.base, {}));
    assertLocation(page.url(), "/index.html", {});
  }, failures);

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nChapter redirect regression failures:");
    failures.forEach((failure) => console.error("- " + failure));
    process.exit(1);
  }

  console.log("\nChapter redirect regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
