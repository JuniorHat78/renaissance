#!/usr/bin/env node

// Runs the core reader journey under a spread of real device descriptors —
// narrow phones (incl. a 320px Galaxy S9+ that stresses layout), a tablet, and
// desktop — using Playwright's emulated viewport, touch, and device-scale. This
// catches layout/interaction breakage that only shows at a given size or with
// touch (e.g. a control that needs hover, a tap target that overflows).

const assert = require("node:assert/strict");
const playwright = require("playwright");

const DEVICES = ["Galaxy S9+", "iPhone 13", "Pixel 7", "iPad Mini", "Desktop Chrome"];

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4182" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function journey(browser, deviceName, base) {
  const descriptor = playwright.devices[deviceName];
  assert.ok(descriptor, "unknown device descriptor: " + deviceName);
  const context = await browser.newContext({ ...descriptor, locale: "en-US", timezoneId: "UTC" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(base + "/index.html", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 45000 });

    await page.click('#essay-list a[href*="essay.html"]');
    await page.waitForURL(/essay\.html/, { timeout: 45000 });
    await page.waitForSelector("#essay-title", { timeout: 45000 });
    const title = (await page.textContent("#essay-title").catch(() => "")) || "";
    assert.ok(title.trim().length > 0, "[" + deviceName + "] essay should render a title");

    await page.click('a[href*="section.html"]');
    await page.waitForURL(/section\.html/, { timeout: 45000 });
    await page.waitForSelector("#section-content p", { timeout: 45000 });

    await page.goto(base + "/search.html", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForSelector("#search-page-input", { timeout: 45000 });
    await page.fill("#search-page-input", "sand");
    await page.waitForSelector("#search-page-results .oracle-result", { timeout: 45000 });

    assert.deepEqual(pageErrors, [], "[" + deviceName + "] uncaught page errors:\n  " + pageErrors.join("\n  "));
    console.log("PASS " + deviceName + " (" + descriptor.viewport.width + "x" + descriptor.viewport.height + ", touch=" + Boolean(descriptor.hasTouch) + ")");
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await playwright.chromium.launch({ headless: true });
  const failures = [];
  for (const deviceName of DEVICES) {
    try {
      await journey(browser, deviceName, options.base);
    } catch (error) {
      failures.push(deviceName + ": " + error.message);
      console.error("FAIL " + deviceName + "\n  " + error.message);
    }
  }
  await browser.close();

  if (failures.length > 0) {
    console.error("\nDevice matrix regression FAILED:");
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("Device matrix checks passed (" + DEVICES.length + " devices).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
