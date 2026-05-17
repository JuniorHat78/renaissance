#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const STORAGE_KEY = "renaissance-reading-state:v1";

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

function sectionUrl(base, sectionNumber, extraParams) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", "etching-god-into-sand");
  url.searchParams.set("section", String(sectionNumber));
  Object.entries(extraParams || {}).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function essayUrl(base) {
  const url = new URL("/essay.html", base);
  url.searchParams.set("essay", "etching-god-into-sand");
  return url.toString();
}

function archiveUrl(base) {
  return new URL("/index.html", base).toString();
}

function stateWithRecord(record) {
  const clean = {
    essaySlug: "etching-god-into-sand",
    sectionNumber: 1,
    progress: 0.38,
    maxProgress: 0.38,
    scrollY: 850,
    completed: false,
    updatedAt: 1700000000000,
    essayTitle: "Etching God into Sand",
    sectionTitle: "The Oldest Material",
    sectionLabel: "Section I",
    ...record
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

async function newContext(browser, state) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
    reducedMotion: "reduce"
  });

  if (state) {
    await context.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, {
      key: STORAGE_KEY,
      value: state
    });
  }

  return context;
}

async function openReadySection(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#section-content p", { timeout: 30000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("section-title");
    return title && !/loading/i.test(String(title.textContent || ""));
  }, null, { timeout: 30000 });
  await page.waitForTimeout(350);
}

async function openReadyEssay(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#section-list .toc-item", { timeout: 30000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("essay-title");
    return title && !/loading/i.test(String(title.textContent || ""));
  }, null, { timeout: 30000 });
}

async function openReadyArchive(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#essay-list .essay-item", { timeout: 30000 });
}

async function runCase(name, browser, state, callback, failures) {
  let context;
  try {
    context = await newContext(browser, state);
    await callback(context);
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name);
  } finally {
    if (context) {
      await context.close();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const failures = [];

  await runCase("reader progress persists on scroll", browser, null, async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(550);
    const snapshot = await page.evaluate((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key));
      const bar = document.getElementById("reader-progress-bar");
      return {
        progress: parsed.essays["etching-god-into-sand"]["1"].progress,
        maxProgress: parsed.essays["etching-god-into-sand"]["1"].maxProgress,
        transform: bar ? String(bar.style.transform || "") : ""
      };
    }, STORAGE_KEY);
    assert.ok(snapshot.progress > 0.05, "progress should be saved after scrolling");
    assert.ok(snapshot.maxProgress >= snapshot.progress, "high-water progress should be retained");
    assert.match(snapshot.transform, /scaleX\((?!0\.0000)/);
  }, failures);

  await runCase("unfinished reader position restores on normal section open", browser, stateWithRecord({
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 900
  }), async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.ok(scrollY > 600, "saved section position should restore");
  }, failures);

  await runCase("completed reader position does not restore to the end", browser, stateWithRecord({
    progress: 0.98,
    maxProgress: 0.98,
    scrollY: 1200,
    completed: true
  }), async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.ok(scrollY < 260, "completed sections should reopen near the top");
  }, failures);

  await runCase("archive continue reading targets unfinished section", browser, stateWithRecord({
    progress: 0.38,
    maxProgress: 0.38,
    scrollY: 850
  }), async (context) => {
    const page = await context.newPage();
    await openReadyArchive(page, archiveUrl(options.base));
    const snapshot = await page.evaluate(() => {
      const panel = document.getElementById("continue-reading-panel");
      const link = document.getElementById("continue-reading-link");
      return {
        hidden: panel ? panel.hidden : true,
        href: link ? link.getAttribute("href") : "",
        title: document.getElementById("continue-reading-heading").textContent,
        detail: document.getElementById("continue-reading-detail").textContent,
        status: document.getElementById("continue-reading-status").textContent
      };
    });
    assert.equal(snapshot.hidden, false);
    assert.match(snapshot.href, /section\.html\?essay=etching-god-into-sand&section=1$/);
    assert.equal(snapshot.title, "Etching God into Sand");
    assert.match(snapshot.detail, /Section I/);
    assert.equal(snapshot.status, "38%");
  }, failures);

  await runCase("archive continue reading advances after completed section", browser, stateWithRecord({
    progress: 0.96,
    maxProgress: 0.96,
    scrollY: 1400,
    completed: true
  }), async (context) => {
    const page = await context.newPage();
    await openReadyArchive(page, archiveUrl(options.base));
    const snapshot = await page.evaluate(() => {
      const link = document.getElementById("continue-reading-link");
      return {
        href: link ? link.getAttribute("href") : "",
        detail: document.getElementById("continue-reading-detail").textContent,
        status: document.getElementById("continue-reading-status").textContent
      };
    });
    assert.match(snapshot.href, /section\.html\?essay=etching-god-into-sand&section=2$/);
    assert.match(snapshot.detail, /^Next: Section II/);
    assert.equal(snapshot.status, "Ready");
  }, failures);

  await runCase("essay table of contents shows section progress", browser, stateWithRecord({
    progress: 0.38,
    maxProgress: 0.38,
    scrollY: 850
  }), async (context) => {
    const page = await context.newPage();
    await openReadyEssay(page, essayUrl(options.base));
    const label = await page.locator(".toc-item").first().locator(".chapter-item-progress-label").textContent();
    assert.equal(label, "38% read");
  }, failures);

  await browser.close();

  if (failures.length > 0) {
    console.error("\nReading-state regression failures:");
    failures.forEach((failure) => console.error("- " + failure));
    process.exit(1);
  }

  console.log("\nReading-state regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
