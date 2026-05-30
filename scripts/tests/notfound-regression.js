#!/usr/bin/env node

// Verifies the custom 404 and app-shell recovery states: missing paths serve
// the self-contained recovery page, route modes stay subpath-safe, and shell
// not-found states expose useful archive/search exits.

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
    const mode = await page.getAttribute("body", "data-recovery-mode");
    assert.equal(mode, "unknown", "plain missing path should use unknown recovery mode");
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

  await step("did-you-mean resolves nearest section when section is out of range", async () => {
    await page.goto(options.base + "/old-link.html?essay=etching-god-into-sand&section=999", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector("#did-you-mean:not([hidden])", { timeout: 5000 });
    const href = await page.getAttribute("#did-you-mean a", "href");
    const mode = await page.getAttribute("body", "data-recovery-mode");
    assert.equal(mode, "section", "section query should use section recovery mode");
    assert.ok(
      href.endsWith(prefix + "/section.html?essay=etching-god-into-sand&section=10"),
      "did-you-mean should point at the nearest published section under the subpath, got " + href
    );
  });

  await step("search-like missing path recovers query terms", async () => {
    await page.goto(options.base + "/old-search.html?query=amber%20twilight", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    const mode = await page.getAttribute("body", "data-recovery-mode");
    const query = await page.inputValue("#notfound-query");
    const firstSuggestion = await page.getAttribute("#suggestions a", "href");
    assert.equal(mode, "search", "search-like route should use search recovery mode");
    assert.equal(query, "amber twilight", "search query should be preserved");
    assert.ok(firstSuggestion.endsWith(prefix + "/search.html?q=amber%20twilight"));
  });

  await step("asset-like missing path uses asset recovery mode", async () => {
    await page.goto(options.base + "/assets/og-etching-god-into-snad.png", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    const mode = await page.getAttribute("body", "data-recovery-mode");
    assert.equal(mode, "asset", "missing asset should use asset recovery mode");
  });

  await step("unpublished essay slugs do not leak into browser 404 suggestions", async () => {
    await page.goto(options.base + "/old-link.html?essay=shadows&section=2", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    const text = await page.textContent("body");
    const hrefs = await page.$$eval("a", (anchors) => anchors.map((anchor) => anchor.href));
    assert.ok(!/SHADOWS/.test(text || ""), "unpublished essay title should not appear in 404 recovery");
    assert.ok(!hrefs.some((href) => /essay=shadows/.test(href)), "unpublished essay route should not appear in 404 recovery links");
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
    assert.ok(
      links.some((href) => href.includes(prefix + "/search.html?q=etching%20god%20into%20san")),
      "section recovery should link to a search for the bad slug"
    );
  });

  await step("section shell suggests nearest valid section", async () => {
    const response = await page.goto(options.base + "/section.html?essay=etching-god-into-sand&section=999", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    assert.ok(response, "expected a response");
    assert.equal(response.status(), 200, "app-shell not-found states keep the shell response");
    await page.waitForFunction(() => {
      const title = document.getElementById("section-title");
      return title && /Section not found/i.test(String(title.textContent || ""));
    }, null, { timeout: 5000 });

    const links = await page.$$eval("#section-content a", (anchors) => anchors.map((anchor) => anchor.href));
    assert.ok(
      links.some((href) => href.endsWith(prefix + "/section.html?essay=etching-god-into-sand&section=10")),
      "section recovery should link to the nearest valid section"
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
    assert.ok(
      links.some((href) => href.includes(prefix + "/search.html?q=etching%20god%20into%20san")),
      "essay recovery should link to a search for the bad slug"
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
