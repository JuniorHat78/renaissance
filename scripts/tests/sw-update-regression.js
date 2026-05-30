#!/usr/bin/env node

// Verifies the service-worker cache-versioning contract: when a worker activates,
// its activate handler deletes every cache that isn't the current version, so a
// VERSION bump cleanly evicts the previous deploy's cache rather than letting
// storage grow without bound or serving stale assets forever. We simulate a
// leftover cache from an older version, force a fresh activation, and assert the
// stale cache is gone while the current one survives.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const swSource = fs.readFileSync(path.join(__dirname, "..", "..", "sw.js"), "utf8");
const versionMatch = swSource.match(/const VERSION = "([^"]+)";/);
assert.ok(versionMatch, "sw.js must declare a VERSION constant");

const CURRENT_CACHE = "renaissance-" + versionMatch[1];
const STALE_CACHE = "renaissance-vstale";

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4185/renaissance" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function pollKeys(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await page.evaluate(() => caches.keys());
    if (predicate(last)) {
      return last;
    }
    await page.waitForTimeout(300);
  }
  return last;
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
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

  await step("worker installs and precaches under " + CURRENT_CACHE, async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    const keys = await pollKeys(page, (k) => k.includes(CURRENT_CACHE), 20000);
    assert.ok(keys.includes(CURRENT_CACHE), "expected " + CURRENT_CACHE + ", saw: " + keys.join(", "));
  });

  await step("a leftover older-version cache coexists until re-activation", async () => {
    await page.evaluate(async (stale) => {
      const cache = await caches.open(stale);
      await cache.put("/placeholder", new Response("stale"));
    }, STALE_CACHE);
    const keys = await page.evaluate(() => caches.keys());
    assert.ok(keys.includes(STALE_CACHE), "seeded stale cache should be present");
    assert.ok(keys.includes(CURRENT_CACHE), "current cache should still be present");
  });

  await step("re-activation evicts the stale cache and keeps the current one", async () => {
    // Unregister + reload forces a fresh install -> activate, which runs the
    // cleanup that a real VERSION bump would trigger.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.unregister();
      }
    });
    await page.goto(options.base + "/index.html", { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    const keys = await pollKeys(
      page,
      (k) => k.includes(CURRENT_CACHE) && !k.includes(STALE_CACHE),
      20000
    );
    assert.ok(keys.includes(CURRENT_CACHE), "current cache should survive, saw: " + keys.join(", "));
    assert.ok(!keys.includes(STALE_CACHE), "stale cache should be evicted, saw: " + keys.join(", "));
  });

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nSW update-flow regression FAILED:");
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("Service worker cache-versioning checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
