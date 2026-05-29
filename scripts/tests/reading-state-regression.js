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
    resumeParagraphIndex: 3,
    resumeParagraphRatio: 0.46,
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

async function newContext(browser, state, overrides) {
  const settings = overrides || {};
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: settings.viewport || { width: 1440, height: 1200 },
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

async function readerRestoreSnapshot(page) {
  return page.evaluate((key) => {
    const lineY = Math.max(80, window.innerHeight * 0.36);
    const bookmark = document.querySelector(".reader-resume-bookmark");
    const rect = bookmark ? bookmark.getBoundingClientRect() : null;
    const offset = bookmark
      ? Number.parseFloat(bookmark.style.getPropertyValue("--reader-bookmark-offset") || "0")
      : null;
    const parsed = JSON.parse(window.localStorage.getItem(key) || "null");
    const record = parsed && parsed.essays &&
      parsed.essays["etching-god-into-sand"] &&
      parsed.essays["etching-god-into-sand"]["1"]
        ? parsed.essays["etching-god-into-sand"]["1"]
        : null;

    return {
      scrollY: window.scrollY,
      lineY,
      bookmarkCount: document.querySelectorAll(".reader-resume-bookmark").length,
      paragraphIndex: bookmark ? bookmark.getAttribute("data-paragraph-index") : "",
      ratioAtLine: rect ? (lineY - rect.top) / Math.max(1, rect.height) : null,
      cueY: rect && offset !== null ? rect.top + offset : null,
      bookmarkOffset: offset,
      savedParagraphIndex: record ? record.resumeParagraphIndex : null,
      savedParagraphRatio: record ? record.resumeParagraphRatio : null
    };
  }, STORAGE_KEY);
}

function assertRestoreGeometry(snapshot, expectedRatio, label) {
  assert.equal(snapshot.bookmarkCount, 1, label + " should show one resume bookmark");
  assert.equal(snapshot.paragraphIndex, "3", label + " should target paragraph 3");
  assert.ok(snapshot.scrollY > 100, label + " should not rely on top-of-page scroll");
  assert.ok(
    Math.abs(snapshot.ratioAtLine - expectedRatio) < 0.09,
    label + " should place the saved ratio near the reading line"
  );
  assert.ok(
    Math.abs(snapshot.cueY - snapshot.lineY) < 42,
    label + " should place the visible cue near the reading line"
  );
}

async function runCase(name, browser, state, callback, failures, contextOptions) {
  let context;
  try {
    context = await newContext(browser, state, contextOptions);
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
        resumeParagraphIndex: parsed.essays["etching-god-into-sand"]["1"].resumeParagraphIndex,
        resumeParagraphRatio: parsed.essays["etching-god-into-sand"]["1"].resumeParagraphRatio,
        transform: bar ? String(bar.style.transform || "") : ""
      };
    }, STORAGE_KEY);
    assert.ok(snapshot.progress > 0.05, "progress should be saved after scrolling");
    assert.ok(snapshot.maxProgress >= snapshot.progress, "high-water progress should be retained");
    assert.ok(snapshot.resumeParagraphIndex > 0, "nearest paragraph should be saved");
    assert.ok(snapshot.resumeParagraphRatio >= 0 && snapshot.resumeParagraphRatio <= 1, "paragraph ratio should be saved");
    assert.match(snapshot.transform, /scaleX\((?!0\.0000)/);
  }, failures);

  await runCase("reader progress line fades in past the first screen", browser, null, async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));

    const readOpacity = () => page.evaluate(() => {
      const bar = document.getElementById("reader-progress-bar");
      return bar ? Number(bar.style.opacity || "0") : null;
    });

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(140);
    const topOpacity = await readOpacity();

    await page.evaluate(() => window.scrollTo(0, window.innerHeight * 2.5));
    await page.waitForTimeout(180);
    const midOpacity = await readOpacity();

    assert.ok(topOpacity <= 0.05, "progress line should be hidden at the very top");
    assert.ok(midOpacity > 0.5, "progress line should be visible once a screen in");
  }, failures);

  await runCase("semantic reader position restores on normal section open", browser, stateWithRecord({
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 0,
    resumeParagraphIndex: 3,
    resumeParagraphRatio: 0.46
  }), async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));
    const snapshot = await readerRestoreSnapshot(page);
    assertRestoreGeometry(snapshot, 0.46, "semantic restore");
    assert.equal(snapshot.savedParagraphIndex, 3, "restore should not rewrite the saved paragraph immediately");
    assert.equal(snapshot.savedParagraphRatio, 0.46, "restore should not rewrite the saved ratio immediately");
  }, failures);

  await runCase("semantic reader position survives mobile layout", browser, stateWithRecord({
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 900,
    resumeParagraphIndex: 3,
    resumeParagraphRatio: 0.46
  }), async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));
    const snapshot = await readerRestoreSnapshot(page);
    assertRestoreGeometry(snapshot, 0.46, "mobile semantic restore");
  }, failures, {
    viewport: { width: 390, height: 844 }
  });

  await runCase("missing paragraph resume target falls back to scroll", browser, stateWithRecord({
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 900,
    resumeParagraphIndex: 999,
    resumeParagraphRatio: 0.46
  }), async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1));
    const snapshot = await readerRestoreSnapshot(page);
    assert.ok(snapshot.scrollY > 600, "scroll fallback should restore saved vertical position");
    assert.equal(snapshot.bookmarkCount, 1, "scroll fallback should still show one resume bookmark");
    assert.notEqual(snapshot.paragraphIndex, "999", "scroll fallback should not mark a missing paragraph");
    assert.ok(snapshot.ratioAtLine >= 0 && snapshot.ratioAtLine <= 1, "scroll fallback should resolve a readable paragraph");
  }, failures);

  await runCase("reader anchors bypass resume restore", browser, stateWithRecord({
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 900,
    resumeParagraphIndex: 3,
    resumeParagraphRatio: 0.46
  }), async (context) => {
    const cases = [
      { label: "occurrence", params: { q: "sand", occ: 1 }, expectHighlight: true },
      { label: "paragraph", params: { p: "3" }, expectHighlight: true },
      { label: "range", params: { r: "0-4" }, expectHighlight: true },
      { label: "payload", params: { hl: "Sand" }, expectHighlight: true }
    ];

    for (const entry of cases) {
      const page = await context.newPage();
      await openReadySection(page, sectionUrl(options.base, 1, entry.params));
      await page.waitForTimeout(450);
      const snapshot = await page.evaluate(() => ({
        bookmarkCount: document.querySelectorAll(".reader-resume-bookmark").length,
        highlightCount: document.querySelectorAll('mark[data-auto-highlight="1"]').length
      }));
      assert.equal(snapshot.bookmarkCount, 0, entry.label + " anchors should not show resume bookmark");
      if (entry.expectHighlight) {
        assert.ok(snapshot.highlightCount >= 1, entry.label + " anchors should keep their normal highlight");
      }
      await page.close();
    }
  }, failures);

  await runCase("debug inspector reports semantic restore state", browser, stateWithRecord({
    progress: 0.42,
    maxProgress: 0.42,
    scrollY: 0,
    resumeParagraphIndex: 3,
    resumeParagraphRatio: 0.46
  }), async (context) => {
    const page = await context.newPage();
    await openReadySection(page, sectionUrl(options.base, 1, { debugReadingState: 1 }));
    await page.waitForSelector(".reading-state-debug", { timeout: 30000 });
    const text = await page.locator(".reading-state-debug").textContent();
    assert.match(text, /restore: semantic/, "debug inspector should report semantic restore mode");
    assert.match(text, /saved p: 3/, "debug inspector should report saved paragraph");
    assert.match(text, /bookmark p: 3/, "debug inspector should report bookmark paragraph");
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
    assert.equal(snapshot.status, "Up next");
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
