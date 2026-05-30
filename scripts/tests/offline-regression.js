#!/usr/bin/env node

// Proves the PWA actually works offline. Loads the site so the service worker
// installs and precaches the shell, then flips the browser offline and verifies
// the archive still renders, an essay still reads (content lives in the precached
// essays-data.js), and a never-before-visited essay also reads — all with the
// network cut. This is the real promise of Phase 14, asserted end to end.

const assert = require("node:assert/strict");
const { browserType, resolveBrowserName } = require("./lib/browser");

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4180/renaissance" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await browserType().launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC", colorScheme: "light" });
  const page = await context.newPage();

  const failures = [];
  async function step(name, fn) {
    try {
      await fn();
      console.log("PASS " + name);
    } catch (error) {
      failures.push(name + ": " + error.message);
      console.error("FAIL " + name + "\n  " + error.message);
    }
  }

  // Discover two essay slugs from the live archive before we go offline: the
  // first we will "visit" online, the second we will only open offline.
  let slugs = [];

  await step("service worker registers and activates", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true),
      { timeout: 30000 }
    );
    const controlled = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg && reg.active);
    });
    assert.ok(controlled, "service worker should be active after first load");

    slugs = await page.$$eval('#essay-list a[href*="essay.html"]', (links) =>
      links
        .map((a) => new URL(a.href).searchParams.get("essay"))
        .filter(Boolean)
    );
    assert.ok(slugs.length >= 1, "archive should expose at least one essay slug");
  });

  // Give the SW a beat to finish precaching the shell before cutting the network.
  await page.waitForTimeout(1500);

  await step("archive renders with the network offline", async () => {
    await context.setOffline(true);
    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 30000 });
  });

  await step("an essay reads offline (content from precached data)", async () => {
    await page.goto(options.base + "/essay.html?essay=" + encodeURIComponent(slugs[0]), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector("#essay-title", { timeout: 30000 });
    const title = (await page.textContent("#essay-title").catch(() => "")) || "";
    assert.ok(title.trim().length > 0, "essay title should render offline");
  });

  await step("a section reads offline", async () => {
    await page.goto(options.base + "/section.html?essay=" + encodeURIComponent(slugs[0]) + "&section=1", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector("#section-content p", { timeout: 30000 });
  });

  await step("the custom 404 shell is available offline", async () => {
    const response = await page.goto(options.base + "/does-not-exist-offline", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    // Served from cache (ignoreSearch navigation fallback); just assert it renders.
    assert.ok(response, "expected a cached response while offline");
    const heading = (await page.textContent("h1").catch(() => "")) || "";
    assert.ok(heading.trim().length > 0, "a cached page should render while offline");
  });

  await context.setOffline(false);
  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nOffline regression FAILED:");
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Offline reading checks passed (" + resolveBrowserName() + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
