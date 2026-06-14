#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { browserType, resolveBrowserName } = require("./lib/browser");

function parseArgs(argv) {
  const options = {
    base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4188",
    outputDir: process.env.RENAISSANCE_SPOTLIGHT_DIR || ""
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--output-dir" && argv[index + 1]) {
      options.outputDir = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  if (!options.outputDir) {
    options.outputDir = path.join(
      "qa",
      "spotlight",
      "run-" + new Date().toISOString().replace(/[:.]/g, "-")
    );
  }
  return options;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const root = document.documentElement;
    return window.RenaissanceSpotlight &&
      window.RenaissanceSearch &&
      root.classList.contains("page-transition-ready") &&
      root.getAttribute("aria-busy") !== "true";
  }, null, { timeout: 30000 });
}

async function openSpotlight(page) {
  await page.keyboard.press("Control+K");
  await page.waitForSelector(".spotlight-root:not([hidden])", { timeout: 30000 });
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === "spotlight-input", null, {
    timeout: 30000
  });
}

async function setSpotlightQuery(page, query) {
  await page.fill("#spotlight-input", query);
  await page.waitForFunction(() => {
    return document.querySelectorAll(".spotlight-result").length > 0;
  }, null, { timeout: 30000 });
}

async function screenshot(page, outputDir, name) {
  await page.screenshot({ path: path.join(outputDir, name), fullPage: true });
}

async function stateSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".spotlight-root");
    const input = document.getElementById("spotlight-input");
    const active = document.querySelector(".spotlight-result.is-active");
    return {
      open: Boolean(root && !root.hidden),
      focusedId: document.activeElement ? document.activeElement.id : "",
      focusedClass: document.activeElement ? document.activeElement.className : "",
      expanded: input ? input.getAttribute("aria-expanded") : "",
      activeDescendant: input ? input.getAttribute("aria-activedescendant") : "",
      activeId: active ? active.id : "",
      activeHref: active ? active.getAttribute("href") : "",
      resultCount: document.querySelectorAll(".spotlight-result").length
    };
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const browserName = resolveBrowserName();
  await ensureDir(options.outputDir);

  const browser = await browserType().launch({ headless: true });
  const failures = [];
  const report = {
    browser: browserName,
    base: options.base,
    scenarios: []
  };

  async function step(name, fn) {
    const started = Date.now();
    try {
      const result = await fn();
      const elapsedMs = Date.now() - started;
      report.scenarios.push({ name, status: "pass", elapsedMs, result: result || null });
      console.log("PASS " + name + " (" + elapsedMs + "ms)");
    } catch (error) {
      const elapsedMs = Date.now() - started;
      report.scenarios.push({
        name,
        status: "fail",
        elapsedMs,
        error: error && error.stack ? error.stack : String(error)
      });
      failures.push(name + ": " + (error && error.stack ? error.stack : error.message));
      console.error("FAIL " + name);
    }
  }

  await step("keyboard launcher opens, traps focus, and restores focus", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference"
    });
    const page = await context.newPage();
    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForApp(page);
    await page.focus("#theme-toggle");
    await openSpotlight(page);
    await page.waitForFunction(() => document.querySelectorAll(".spotlight-result").length > 0, null, {
      timeout: 30000
    });
    await screenshot(page, options.outputDir, "desktop-open.png");

    const opened = await stateSnapshot(page);
    assert.equal(opened.open, true, "spotlight should be open");
    assert.equal(opened.focusedId, "spotlight-input", "input should take focus");
    assert.equal(opened.expanded, "true", "combobox should be expanded");
    assert.ok(opened.resultCount >= 3, "quick results should render");
    assert.equal(opened.activeDescendant, opened.activeId, "input should point to active option");

    await page.keyboard.press("Tab");
    const tabbed = await stateSnapshot(page);
    assert.match(tabbed.focusedClass, /spotlight-result/, "tab should move to active result");

    await page.keyboard.press("Tab");
    const cycled = await stateSnapshot(page);
    assert.equal(cycled.focusedId, "spotlight-input", "tab should cycle back to input");

    await page.keyboard.press("Shift+Tab");
    const reverseCycled = await stateSnapshot(page);
    assert.match(reverseCycled.focusedClass, /spotlight-result/, "shift-tab should cycle to active result");

    await page.keyboard.press("Escape");
    await page.waitForSelector(".spotlight-root[hidden]", { timeout: 30000 });
    const restored = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.equal(restored, "theme-toggle", "escape should restore focus");
    await context.close();
    return opened;
  });

  await step("body query creates passage-deep result and activates by keyboard", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference"
    });
    const page = await context.newPage();
    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForApp(page);
    await openSpotlight(page);
    await setSpotlightQuery(page, "verdun");
    await screenshot(page, options.outputDir, "passage-results.png");

    const passageIndex = await page.$$eval(".spotlight-result", (links) => {
      return links.findIndex((link) => /[?&]p=p\d+/.test(link.getAttribute("href") || "") &&
        /[?&]start=\d+/.test(link.getAttribute("href") || "") &&
        /[?&]end=\d+/.test(link.getAttribute("href") || ""));
    });
    assert.ok(passageIndex >= 0, "at least one result should deep-link to a passage range");

    for (let index = 0; index < passageIndex; index += 1) {
      await page.keyboard.press("ArrowDown");
    }
    const selectedHref = await page.$eval(".spotlight-result.is-active", (link) => link.getAttribute("href"));
    assert.match(selectedHref, /[?&]p=p\d+/, "active result should include a passage id");
    assert.match(selectedHref, /[?&]start=\d+/, "active result should include a range start");
    assert.match(selectedHref, /[?&]end=\d+/, "active result should include a range end");

    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname.endsWith("/section.html") && url.searchParams.has("p"), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector('mark[data-auto-highlight="1"]', { timeout: 30000 });
    const markText = await page.$eval('mark[data-auto-highlight="1"]', (mark) => mark.textContent || "");
    assert.match(markText.toLowerCase(), /verdun/, "passage-deep arrival should highlight the query");
    await screenshot(page, options.outputDir, "passage-arrival.png");
    await context.close();
    return { passageIndex, selectedHref };
  });

  await step("essay-local section intent jumps to roman numeral section", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference"
    });
    const page = await context.newPage();
    await page.goto(options.base + "/essay.html?essay=etching-god-into-sand", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await waitForApp(page);
    await openSpotlight(page);
    await setSpotlightQuery(page, "vii");
    const intent = await page.$$eval(".spotlight-result", (links) => {
      return links.map((link) => ({
        title: link.querySelector(".spotlight-result-title") ? link.querySelector(".spotlight-result-title").textContent : "",
        href: link.getAttribute("href") || ""
      })).find((entry) => /section=7/.test(entry.href));
    });
    assert.ok(intent, "roman section intent should produce a section 7 result");
    await context.close();
    return intent;
  });

  await step("mobile launcher stays inside the viewport", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "no-preference"
    });
    const page = await context.newPage();
    await page.goto(options.base + "/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForApp(page);
    await openSpotlight(page);
    await setSpotlightQuery(page, "cosmos");
    await screenshot(page, options.outputDir, "mobile-open.png");
    const metrics = await page.evaluate(() => {
      const panel = document.querySelector(".spotlight-panel").getBoundingClientRect();
      const resultRects = Array.from(document.querySelectorAll(".spotlight-result")).map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        panel: {
          left: panel.left,
          right: panel.right,
          top: panel.top,
          bottom: panel.bottom
        },
        resultRects
      };
    });
    assert.ok(metrics.panel.left >= -1, "panel should not overflow left");
    assert.ok(metrics.panel.right <= metrics.viewportWidth + 1, "panel should not overflow right");
    assert.ok(metrics.panel.bottom <= metrics.viewportHeight + 1, "panel should not overflow bottom");
    assert.ok(metrics.documentWidth <= metrics.viewportWidth + 1, "document should not gain horizontal scroll");
    metrics.resultRects.forEach((rect, index) => {
      assert.ok(rect.left >= metrics.panel.left - 1, "result " + index + " should stay inside panel left edge");
      assert.ok(rect.right <= metrics.panel.right + 1, "result " + index + " should stay inside panel right edge");
    });
    await context.close();
    return metrics;
  });

  await browser.close();

  await fs.writeFile(path.join(options.outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(
    path.join(options.outputDir, "report.md"),
    [
      "# Spotlight Regression",
      "",
      "| Scenario | Status | Time |",
      "| --- | --- | ---: |",
      ...report.scenarios.map((scenario) => (
        "| " + scenario.name + " | " + scenario.status + " | " + scenario.elapsedMs + "ms |"
      )),
      ""
    ].join("\n")
  );

  if (failures.length > 0) {
    console.error("\nSpotlight regression failures:");
    failures.forEach((failure) => console.error("- " + failure));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
