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

function readPageState() {
  const root = document.documentElement;
  const body = window.getComputedStyle(document.body);
  const main = document.querySelector("main");
  const mainStyle = main ? window.getComputedStyle(main) : null;
  return {
    prep: root.classList.contains("page-transition-prep"),
    out: root.classList.contains("page-transition-out"),
    ready: root.classList.contains("page-transition-ready"),
    busy: root.getAttribute("aria-busy"),
    opacity: Number.parseFloat(body.opacity || "0"),
    mainOpacity: mainStyle ? Number.parseFloat(mainStyle.opacity || "0") : 1,
    motion: root.getAttribute("data-page-motion") || "",
    arrival: root.getAttribute("data-page-arrival") || "",
    sourceX: window.getComputedStyle(root).getPropertyValue("--page-source-x").trim()
  };
}

async function assertPageVisible(page, label) {
  // A history restore (notably webkit's bfcache) can fire a follow-up
  // navigation just after waitForReady resolves, destroying the execution
  // context mid-evaluate. That is a not-yet-settled signal, not a regression:
  // re-settle and read once more before trusting the throw.
  let state;
  try {
    state = await page.evaluate(readPageState);
  } catch (error) {
    if (!/Execution context was destroyed/.test(String(error && error.message))) {
      throw error;
    }
    await waitForReady(page);
    state = await page.evaluate(readPageState);
  }
  assert.equal(state.prep, false, label + " should not keep prep class");
  assert.equal(state.out, false, label + " should not keep outgoing class");
  assert.equal(state.ready, true, label + " should be marked ready");
  assert.notEqual(state.busy, "true", label + " should not remain busy");
  assert.ok(state.opacity > 0.95, label + " body should be visible");
  assert.ok(state.mainOpacity > 0.95, label + " main content should be fully readable");
  return state;
}

async function clickInternal(page, selector, expectedPath, expectedMotion) {
  await page.waitForSelector(selector, { timeout: 30000 });
  const clickState = await page.evaluate((targetSelector) => {
    document.querySelector(targetSelector).click();
    return {
      out: document.documentElement.classList.contains("page-transition-out"),
      source: Boolean(document.querySelector(".is-page-transition-source")),
      delay: window.RenaissancePageTransition && window.RenaissancePageTransition.outDelayMs,
      revealMode: window.RenaissancePageTransition && window.RenaissancePageTransition.revealMode
    };
  }, selector);
  assert.equal(clickState.out, true, "click should mark the current page as outgoing immediately");
  assert.equal(clickState.source, true, "click should mark the source link immediately");
  assert.ok(clickState.delay <= 200, "outgoing delay should stay responsive (graceful out, ~120ms)");
  assert.equal(clickState.revealMode, "composed", "destination reveal composes on content-ready under the paper veil");

  await page.waitForURL((url) => url.pathname.endsWith(expectedPath), {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await waitForReady(page);
  const state = await assertPageVisible(page, expectedPath);
  assert.equal(state.motion, expectedMotion, expectedPath + " should receive the expected motion");
  assert.equal(state.arrival, "navigation", expectedPath + " should mark an internal navigation arrival");
  assert.match(state.sourceX, /px$/, expectedPath + " should retain source geometry for the arrival flourish");
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
    const directState = await assertPageVisible(page, "archive");
    assert.equal(directState.motion, "settle", "direct loads should not fake an internal movement");
    assert.equal(directState.arrival, "", "direct loads should not run internal arrival choreography");

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
