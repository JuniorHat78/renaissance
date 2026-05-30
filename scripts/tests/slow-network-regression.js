#!/usr/bin/env node

// Exercises the reader journey under emulated Slow-3G (≈400kbps, 400ms RTT) via
// the Chrome DevTools protocol. A static essay site should stay perfectly usable
// on a poor connection; this gate fails if the archive or an essay can't load and
// render within a generous budget — i.e. if someone ships an asset heavy enough
// to make the site unusable on mobile data.

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const SLOW_3G = {
  offline: false,
  latency: 400,
  downloadThroughput: Math.floor((400 * 1024) / 8),
  uploadThroughput: Math.floor((400 * 1024) / 8),
  connectionType: "cellular3g"
};
const BUDGET_MS = 30000;

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4184" };
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", SLOW_3G);

  const failures = [];
  async function step(name, fn) {
    const started = Date.now();
    try {
      await fn();
      console.log("PASS " + name + " (" + (Date.now() - started) + "ms)");
    } catch (error) {
      failures.push(name + ": " + error.message);
      console.error("FAIL " + name + "\n  " + error.message);
    }
  }

  await step("archive loads and renders on Slow-3G", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: BUDGET_MS });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: BUDGET_MS });
  });

  await step("an essay loads and renders on Slow-3G", async () => {
    await page.click('#essay-list a[href*="essay.html"]');
    await page.waitForURL(/essay\.html/, { timeout: BUDGET_MS });
    await page.waitForSelector("#essay-title", { timeout: BUDGET_MS });
    const title = (await page.textContent("#essay-title").catch(() => "")) || "";
    assert.ok(title.trim().length > 0, "essay should render its title under Slow-3G");
  });

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nSlow-network regression FAILED:");
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("Slow-network (Slow-3G) checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
