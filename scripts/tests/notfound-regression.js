#!/usr/bin/env node

// Verifies the custom 404: a missing path serves our page with a 404 status,
// the recovery links stay correct under the project subpath, and the
// did-you-mean shim resolves a recognizable essay slug from the dead URL.

const assert = require("node:assert/strict");
const { browserType, resolveBrowserName } = require("./lib/browser");

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4177/renaissance" };
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
  return new URL(base + "/").pathname.replace(/\/+$/, "");
}

async function main() {
  const options = parseArgs(process.argv);
  const prefix = mountPrefix(options.base);
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
      console.error("FAIL " + name);
    }
  }

  await step("missing path serves the custom 404 with a 404 status", async () => {
    const response = await page.goto(options.base + "/this-page-does-not-exist", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    assert.ok(response, "expected a response");
    assert.equal(response.status(), 404, "missing path should return HTTP 404");
    const heading = (await page.textContent("h1").catch(() => "")) || "";
    assert.match(heading, /slipped out of the archive/i, "should render the custom 404 copy");
  });

  await step("recovery links stay under the subpath", async () => {
    const archive = await page.getAttribute("#archive-link", "href");
    const search = await page.getAttribute("#search-link", "href");
    assert.ok(archive.endsWith(prefix + "/index.html"), "archive link should target the subpath archive, got " + archive);
    assert.ok(search.endsWith(prefix + "/search.html"), "search link should target the subpath search, got " + search);
  });

  await step("did-you-mean resolves an essay slug from the dead URL", async () => {
    await page.goto(options.base + "/old-link.html?essay=etching-god-into-sand", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector("#did-you-mean:not([hidden])", { timeout: 5000 });
    const href = await page.getAttribute("#did-you-mean a", "href");
    assert.ok(
      href.endsWith(prefix + "/essay.html?essay=etching-god-into-sand"),
      "did-you-mean should point at the essay under the subpath, got " + href
    );
  });

  await step("did-you-mean resolves a section when section is present", async () => {
    await page.goto(options.base + "/old-link.html?essay=shadows&section=2", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector("#did-you-mean:not([hidden])", { timeout: 5000 });
    const href = await page.getAttribute("#did-you-mean a", "href");
    assert.ok(
      href.endsWith(prefix + "/section.html?essay=shadows&section=2"),
      "did-you-mean should point at the section under the subpath, got " + href
    );
  });

  await step("section shell gives recovery links for an unknown essay slug", async () => {
    const response = await page.goto(options.base + "/section.html?essay=etching-god-into-san&section=1", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    assert.ok(response, "expected a response");
    assert.equal(response.status(), 200, "app-shell not-found states keep the shell response");
    await page.waitForFunction(() => {
      const title = document.getElementById("section-title");
      return title && /Essay not found/i.test(String(title.textContent || ""));
    }, null, { timeout: 5000 });

    const robots = await page.getAttribute('meta[name="robots"]', "content");
    assert.equal(robots, "noindex", "app-level missing section routes should be noindex");
    const links = await page.$$eval("#section-content a", (anchors) => anchors.map((anchor) => anchor.href));
    assert.ok(
      links.some((href) => href.endsWith(prefix + "/index.html")),
      "section recovery should link to the archive under the subpath"
    );
    assert.ok(
      links.some((href) => href.endsWith(prefix + "/search.html")),
      "section recovery should link to search under the subpath"
    );
  });

  await step("essay shell gives recovery links for an unknown essay slug", async () => {
    const response = await page.goto(options.base + "/essay.html?essay=etching-god-into-san", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    assert.ok(response, "expected a response");
    assert.equal(response.status(), 200, "app-shell not-found states keep the shell response");
    await page.waitForFunction(() => {
      const title = document.getElementById("essay-title");
      return title && /Essay not found/i.test(String(title.textContent || ""));
    }, null, { timeout: 5000 });

    const robots = await page.getAttribute('meta[name="robots"]', "content");
    assert.equal(robots, "noindex", "app-level missing essay routes should be noindex");
    const links = await page.$$eval("#section-list a", (anchors) => anchors.map((anchor) => anchor.href));
    assert.ok(
      links.some((href) => href.endsWith(prefix + "/index.html")),
      "essay recovery should link to the archive under the subpath"
    );
    assert.ok(
      links.some((href) => href.endsWith(prefix + "/search.html")),
      "essay recovery should link to search under the subpath"
    );
  });

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Not-found regression checks passed (" + resolveBrowserName() + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
