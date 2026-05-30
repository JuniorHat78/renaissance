#!/usr/bin/env node

// Verifies the site works when served from a project SUBPATH (e.g. GitHub
// project Pages at /renaissance/). It navigates ONLY by clicking the site's own
// links, so it exercises the router's real link generation — the exact thing
// that shipped a production 404 before. Any root-absolute link would escape the
// subpath and surface here as a 404.

const assert = require("node:assert/strict");
const { browserType, resolveBrowserName } = require("./lib/browser");

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4176/renaissance" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

function mountPrefix(base) {
  return new URL(base + "/").pathname.replace(/\/+$/, ""); // e.g. "/renaissance"
}

async function main() {
  const options = parseArgs(process.argv);
  const prefix = mountPrefix(options.base);
  const browser = await browserType().launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC", colorScheme: "light" });
  const page = await context.newPage();

  const notFound = [];
  page.on("response", (response) => {
    if (response.status() === 404) {
      notFound.push(response.url());
    }
  });

  const failures = [];
  async function step(name, fn) {
    try {
      await fn();
      console.log("PASS " + name);
    } catch (error) {
      failures.push(name + ": " + error.message);
      console.error("FAIL " + name);
    }
  }

  await step("archive loads under subpath with essays", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 30000 });
  });

  await step("archive -> essay keeps the subpath and renders", async () => {
    await page.click('#essay-list a[href*="essay.html"]');
    // Wait for the click-driven navigation to actually commit before asserting.
    // A bare waitForLoadState can resolve against the already-idle archive page
    // (webkit dispatches link navigation slightly later), so we wait on the URL.
    await page.waitForURL(/essay\.html/, { timeout: 30000 });
    assert.ok(
      page.url().includes(prefix + "/essay.html"),
      "essay URL must keep the subpath prefix, got " + page.url()
    );
    await page.waitForSelector("#section-list .toc-item, #essay-title", { timeout: 30000 });
    const title = (await page.textContent("#essay-title").catch(() => "")) || "";
    assert.ok(title.trim().length > 0, "essay page should render a title");
  });

  await step("essay -> section keeps the subpath and renders", async () => {
    await page.click('a[href*="section.html"]');
    await page.waitForURL(/section\.html/, { timeout: 30000 });
    assert.ok(
      page.url().includes(prefix + "/section.html"),
      "section URL must keep the subpath prefix, got " + page.url()
    );
    await page.waitForSelector("#section-content p", { timeout: 30000 });
  });

  await step("no 404 responses during the whole click-through", async () => {
    // Filter to same-origin requests; external (fonts, analytics) are not our concern.
    const origin = new URL(options.base).origin;
    const local404 = notFound.filter((url) => url.startsWith(origin));
    assert.deepEqual(local404, [], "expected zero same-origin 404s, got:\n  " + local404.join("\n  "));
  });

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Subpath regression checks passed (" + resolveBrowserName() + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
