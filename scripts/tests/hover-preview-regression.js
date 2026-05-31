#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000",
    essay: "etching-god-into-sand"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    } else if (token === "--essay" && argv[index + 1]) {
      options.essay = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function archiveUrl(base) {
  return new URL("/index.html", base).toString();
}

function essayUrl(base, essay) {
  const url = new URL("/essay.html", base);
  url.searchParams.set("essay", essay);
  return url.toString();
}

function sectionUrl(base, essay, section) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", essay);
  url.searchParams.set("section", String(section));
  return url.toString();
}

async function readCard(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".link-preview-card");
    if (!card) {
      return null;
    }
    return {
      hidden: Boolean(card.hidden),
      visible: card.classList.contains("is-visible"),
      kicker: String((card.querySelector(".link-preview-kicker") || {}).textContent || "").trim(),
      title: String((card.querySelector(".link-preview-title") || {}).textContent || "").trim(),
      body: String((card.querySelector(".link-preview-body") || {}).textContent || "").trim()
    };
  });
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
  const failures = [];

  // Desktop (fine pointer): previews should appear on hover.
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();

  await runCase("essay link shows a preview on hover", async () => {
    await page.goto(archiveUrl(options.base), { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 30000 });

    await page.hover('#essay-list a[href*="essay.html"]');
    await page.waitForSelector(".link-preview-card.is-visible", { timeout: 5000 });

    const card = await readCard(page);
    assert.ok(card, "preview card should exist");
    assert.equal(card.kicker, "Essay", "essay preview should be kickered as an essay");
    assert.ok(card.title.length > 0, "essay preview should have a title");
    assert.ok(card.body.length > 0, "essay preview should have body text");
  }, failures);

  await runCase("Escape dismisses the preview", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    const card = await readCard(page);
    assert.ok(card && card.hidden, "Escape should hide the preview card");
  }, failures);

  await runCase("section link shows a section preview", async () => {
    await page.goto(essayUrl(options.base, options.essay), { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector('a[href*="section.html"]', { timeout: 30000 });

    await page.hover('a[href*="section.html"]');
    await page.waitForSelector(".link-preview-card.is-visible", { timeout: 5000 });

    const card = await readCard(page);
    assert.ok(card, "section preview card should exist");
    assert.ok(card.title.length > 0, "section preview should have a title");
    assert.ok(card.body.length > 0, "section preview should have body text");
  }, failures);

  await runCase("home link shows an archive preview", async () => {
    await page.goto(sectionUrl(options.base, options.essay, 1), { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector('.reader-header-links a[href="index.html"]', { timeout: 30000 });

    await page.hover('.reader-header-links a[href="index.html"]');
    await page.waitForSelector(".link-preview-card.is-visible", { timeout: 5000 });

    const card = await readCard(page);
    assert.ok(card, "home preview card should exist");
    assert.equal(card.kicker, "Archive", "home preview should point to the archive");
    assert.equal(card.title, "Renaissance", "home preview should name the archive");
    assert.ok(card.body.length > 0, "home preview should have body text");
  }, failures);

  await context.close();

  // Touch (coarse pointer): the module should bow out entirely — no card.
  const touchContext = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce"
  });
  const touchPage = await touchContext.newPage();

  await runCase("touch pointers get no preview card", async () => {
    await touchPage.goto(archiveUrl(options.base), { waitUntil: "networkidle", timeout: 30000 });
    await touchPage.waitForSelector("#essay-list .essay-item a", { timeout: 30000 });
    await touchPage.hover('#essay-list a[href*="essay.html"]');
    await touchPage.waitForTimeout(400);
    const exists = await touchPage.evaluate(() => Boolean(document.querySelector(".link-preview-card")));
    assert.ok(!exists, "no preview card should be created on coarse pointers");
  }, failures);

  await touchContext.close();
  await browser.close();

  if (failures.length > 0) {
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Hover preview regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
