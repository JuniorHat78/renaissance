#!/usr/bin/env node

const assert = require("node:assert/strict");
const { browserType, resolveBrowserName } = require("./lib/browser");

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4186" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function waitForReady(page) {
  await page.waitForFunction(() => {
    const root = document.documentElement;
    return root.classList.contains("page-transition-ready") &&
      !root.classList.contains("page-transition-prep") &&
      !root.classList.contains("page-transition-out") &&
      root.getAttribute("aria-busy") !== "true";
  }, null, { timeout: 30000 });
}

async function assertPageVisible(page, label) {
  const state = await page.evaluate(() => {
    const root = document.documentElement;
    const body = window.getComputedStyle(document.body);
    return {
      prep: root.classList.contains("page-transition-prep"),
      out: root.classList.contains("page-transition-out"),
      ready: root.classList.contains("page-transition-ready"),
      busy: root.getAttribute("aria-busy"),
      opacity: Number.parseFloat(body.opacity || "0"),
      motion: root.getAttribute("data-page-motion") || ""
    };
  });
  assert.equal(state.prep, false, label + " should not keep prep class");
  assert.equal(state.out, false, label + " should not keep outgoing class");
  assert.equal(state.ready, true, label + " should be marked ready");
  assert.notEqual(state.busy, "true", label + " should not remain busy");
  assert.ok(state.opacity > 0.95, label + " body should be visible");
  return state;
}

async function clickInternal(page, selector, expectedPath, expectedMotion) {
  await page.waitForSelector(selector, { timeout: 30000 });
  await page.evaluate((targetSelector) => {
    document.querySelector(targetSelector).click();
  }, selector);

  await page.waitForFunction(() => {
    const source = document.querySelector(".is-page-transition-source");
    return document.documentElement.classList.contains("page-transition-out") && Boolean(source);
  }, null, { timeout: 5000 });

  await page.waitForURL((url) => url.pathname.endsWith(expectedPath), {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await waitForReady(page);
  const state = await assertPageVisible(page, expectedPath);
  assert.equal(state.motion, expectedMotion, expectedPath + " should receive the expected motion");
}

async function main() {
  const options = parseArgs(process.argv);
  const browserName = resolveBrowserName();
  const browser = await browserType().launch({ headless: true });
  const failures = [];

  async function step(name, fn) {
    try {
      await fn();
      console.log("PASS " + name);
    } catch (error) {
      failures.push(name + ": " + (error && error.stack ? error.stack : error.message));
      console.error("FAIL " + name);
    }
  }

  await step("internal page movements reveal without stuck hidden states (" + browserName + ")", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference"
    });
    const page = await context.newPage();

    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForReady(page);
    await assertPageVisible(page, "archive");

    await clickInternal(page, '#essay-list a[href*="essay.html"]', "/essay.html", "forward");
    await clickInternal(page, '#section-list a[href*="section.html"]', "/section.html", "forward");
    await clickInternal(page, "#back-to-essay", "/essay.html", "back");
    await clickInternal(page, '.site-header a[href="index.html"]', "/index.html", "home");

    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForReady(page);
    await assertPageVisible(page, "history-restored essay");

    await context.close();
  });

  await step("reduced motion does not hide the shell while content loads", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce"
    });
    const page = await context.newPage();
    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForReady(page);
    await assertPageVisible(page, "reduced-motion archive");
    await context.close();
  });

  await browser.close();

  if (failures.length > 0) {
    console.error("\nPage transition regression failures:");
    failures.forEach((failure) => console.error("- " + failure));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
