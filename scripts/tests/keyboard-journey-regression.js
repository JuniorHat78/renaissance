#!/usr/bin/env node

// Drives the core reader journey using ONLY the keyboard: Tab to move focus,
// Enter to activate. Proves a keyboard / switch / screen-reader user can reach
// an essay, descend into a section, and reach the theme control without a mouse
// — focus order that the automated a11y audit can't assert on its own.

const assert = require("node:assert/strict");
const { browserType, resolveBrowserName } = require("./lib/browser");

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4183" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

// Press Tab until the focused element matches the selector; returns the number
// of tabs it took, or -1 if it was never reached within maxTabs.
async function tabUntil(page, selector, maxTabs) {
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press("Tab");
    const matched = await page.evaluate((sel) => {
      const el = document.activeElement;
      return Boolean(el && el.matches && el.matches(sel));
    }, selector);
    if (matched) {
      return i + 1;
    }
  }
  return -1;
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await browserType().launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce"
  });
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

  await step("reach and open an essay with the keyboard", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 30000 });
    const tabs = await tabUntil(page, '#essay-list a[href*="essay.html"]', 60);
    assert.ok(tabs > 0, "an essay link should be reachable by Tab");
    await page.keyboard.press("Enter");
    await page.waitForURL(/essay\.html/, { timeout: 30000 });
    await page.waitForSelector("#essay-title", { timeout: 30000 });
  });

  await step("descend into a section with the keyboard", async () => {
    const tabs = await tabUntil(page, 'a[href*="section.html"]', 80);
    assert.ok(tabs > 0, "a section link should be reachable by Tab");
    await page.keyboard.press("Enter");
    await page.waitForURL(/section\.html/, { timeout: 30000 });
    await page.waitForSelector("#section-content p", { timeout: 30000 });
  });

  await step("reach the theme toggle with the keyboard", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "networkidle", timeout: 30000 });
    const tabs = await tabUntil(page, "#theme-toggle", 30);
    assert.ok(tabs > 0, "the theme toggle should be reachable by Tab");
  });

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nKeyboard journey regression FAILED:");
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("Keyboard-only journey checks passed (" + resolveBrowserName() + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
