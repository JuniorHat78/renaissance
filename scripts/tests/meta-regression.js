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

function essayUrl(base, slug) {
  const url = new URL("/essay.html", base);
  url.searchParams.set("essay", slug);
  return url.toString();
}

function sectionUrl(base, slug, sectionNumber) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", slug);
  url.searchParams.set("section", String(sectionNumber));
  return url.toString();
}

async function openEssay(page, base, slug) {
  await page.goto(essayUrl(base, slug), { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#essay-title", { timeout: 30000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("essay-title");
    return title && !/loading/i.test(String(title.textContent || ""));
  }, null, { timeout: 30000 });
  await page.waitForTimeout(120);
}

async function openSection(page, base, slug, sectionNumber) {
  await page.goto(sectionUrl(base, slug, sectionNumber), { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#section-title", { timeout: 30000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("section-title");
    return title && !/loading/i.test(String(title.textContent || ""));
  }, null, { timeout: 30000 });
  await page.waitForTimeout(120);
}

async function metaSnapshot(page) {
  return page.evaluate(() => {
    const byName = (name) => {
      const node = document.querySelector('meta[name="' + name + '"]');
      return node ? String(node.getAttribute("content") || "") : "";
    };
    const byProperty = (property) => {
      const node = document.querySelector('meta[property="' + property + '"]');
      return node ? String(node.getAttribute("content") || "") : "";
    };
    const canonical = document.querySelector('link[rel="canonical"]');
    return {
      title: String(document.title || ""),
      canonical: canonical ? String(canonical.getAttribute("href") || "") : "",
      description: byName("description"),
      ogTitle: byProperty("og:title"),
      ogDescription: byProperty("og:description"),
      ogUrl: byProperty("og:url"),
      ogImage: byProperty("og:image"),
      twitterTitle: byName("twitter:title"),
      twitterDescription: byName("twitter:description"),
      twitterImage: byName("twitter:image")
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
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const failures = [];

  await runCase("etching essay metadata is slug-aware", async () => {
    await openEssay(page, options.base, "etching-god-into-sand");
    const meta = await metaSnapshot(page);
    assert.equal(meta.title, "Etching God into Sand | Renaissance");
    assert.match(meta.canonical, /essay\.html\?essay=etching-god-into-sand$/);
    assert.match(meta.ogUrl, /essay\.html\?essay=etching-god-into-sand$/);
    assert.equal(meta.ogTitle, meta.title);
    assert.equal(meta.twitterTitle, meta.title);
    assert.match(meta.ogImage, /assets\/og-etching-god-into-sand\.png$/);
    assert.equal(meta.twitterImage, meta.ogImage);
  }, failures);

  await runCase("shadows essay metadata is not Etching-hardcoded", async () => {
    await openEssay(page, options.base, "shadows");
    const meta = await metaSnapshot(page);
    assert.equal(meta.title, "SHADOWS | Renaissance");
    assert.match(meta.canonical, /essay\.html\?essay=shadows$/);
    assert.match(meta.ogUrl, /essay\.html\?essay=shadows$/);
    assert.equal(meta.ogTitle, meta.title);
    assert.equal(meta.twitterTitle, meta.title);
    assert.ok(!/Etching God into Sand/.test(meta.description));
    assert.ok(!/Etching God into Sand/.test(meta.ogDescription));
    assert.match(meta.ogImage, /assets\/og-shadows\.png$/);
    assert.equal(meta.twitterImage, meta.ogImage);
  }, failures);

  await runCase("etching section metadata is slug and section aware", async () => {
    await openSection(page, options.base, "etching-god-into-sand", 1);
    const meta = await metaSnapshot(page);
    assert.equal(meta.title, "The Oldest Material | Etching God into Sand | Renaissance");
    assert.match(meta.canonical, /section\.html\?essay=etching-god-into-sand&section=1$/);
    assert.match(meta.ogUrl, /section\.html\?essay=etching-god-into-sand&section=1$/);
    assert.equal(meta.ogTitle, meta.title);
    assert.equal(meta.twitterTitle, meta.title);
    assert.ok(meta.description.length > 0, "Description should be populated from section content");
    assert.match(meta.ogImage, /assets\/og-etching-god-into-sand\.png$/);
    assert.equal(meta.twitterImage, meta.ogImage);
  }, failures);

  await runCase("shadows section metadata is not Etching-hardcoded", async () => {
    await openSection(page, options.base, "shadows", 1);
    const meta = await metaSnapshot(page);
    assert.equal(meta.title, "SPEED | SHADOWS | Renaissance");
    assert.match(meta.canonical, /section\.html\?essay=shadows&section=1$/);
    assert.match(meta.ogUrl, /section\.html\?essay=shadows&section=1$/);
    assert.equal(meta.ogTitle, meta.title);
    assert.equal(meta.twitterTitle, meta.title);
    assert.ok(meta.description.length > 0, "Description should be populated from section content");
    assert.ok(!/Etching God into Sand/.test(meta.description));
    assert.ok(!/Etching God into Sand/.test(meta.ogDescription));
    assert.match(meta.ogImage, /assets\/og-shadows\.png$/);
    assert.equal(meta.twitterImage, meta.ogImage);
  }, failures);

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nMeta regression failures:");
    failures.forEach((failure) => console.error("- " + failure));
    process.exit(1);
  }

  console.log("\nMeta regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
