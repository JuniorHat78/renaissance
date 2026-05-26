#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

async function runCase(name, browser, callback, failures) {
  let context;
  try {
    context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      viewport: { width: 1440, height: 1200 },
      colorScheme: "light",
      reducedMotion: "reduce"
    });
    const page = await context.newPage();
    await callback(page);
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name);
  } finally {
    if (context) {
      await context.close();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const failures = [];

  // Helper to open index.html and ensure router is present
  async function openReadyArchive(page) {
    await page.goto(new URL("/index.html", options.base).toString(), { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForFunction(() => typeof window.RenaissanceRouter === "object", null, { timeout: 30000 });
  }

  await runCase("router schema clamping and validation", browser, async (page) => {
    await openReadyArchive(page);

    const validation = await page.evaluate(() => {
      const router = window.RenaissanceRouter;
      
      // Inject query parameters dynamically
      window.history.replaceState(null, "", "?essay=   etching-god-into-sand   &section=-99&mode=malicious_hack&page=abc");
      const parsed = router.parseCurrentRoute();

      return {
        essaySlug: parsed.essaySlug,
        sectionNumber: parsed.sectionNumber,
        mode: parsed.mode,
        page: parsed.page
      };
    });

    assert.equal(validation.essaySlug, "etching-god-into-sand", "Slug should be trimmed");
    assert.equal(validation.sectionNumber, null, "Negative section numbers should clamp to null");
    assert.equal(validation.mode, "contains", "Invalid match modes should default to contains");
    assert.equal(validation.page, 1, "Non-numeric pages should default to 1");
  }, failures);

  await runCase("router URL building and symmetry", browser, async (page) => {
    await openReadyArchive(page);

    const symmetry = await page.evaluate(() => {
      const router = window.RenaissanceRouter;
      const initial = {
        essaySlug: "shadows",
        sectionNumber: 3,
        query: "umbra",
        mode: "fuzzy",
        sort: "relevance",
        caseSensitive: true,
        page: 2,
        pageSize: 25
      };

      const url = router.buildUrl("search", initial);
      window.history.replaceState(null, "", url);
      const parsed = router.parseCurrentRoute();

      return {
        essaySlug: parsed.essaySlug,
        sectionNumber: parsed.sectionNumber,
        query: parsed.query,
        mode: parsed.mode,
        sort: parsed.sort,
        caseSensitive: parsed.caseSensitive,
        page: parsed.page,
        pageSize: parsed.pageSize
      };
    });

    assert.equal(symmetry.essaySlug, "shadows");
    assert.equal(symmetry.sectionNumber, 3);
    assert.equal(symmetry.query, "umbra");
    assert.equal(symmetry.mode, "fuzzy");
    assert.equal(symmetry.sort, "relevance");
    assert.equal(symmetry.caseSensitive, true);
    assert.equal(symmetry.page, 2);
    assert.equal(symmetry.pageSize, 25);
  }, failures);

  await runCase("router self-healing URLs on load", browser, async (page) => {
    const invalidUrl = new URL("/search.html?page=-10&q=sand&mode=hacker_attempt", options.base).toString();
    await page.goto(invalidUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.RenaissanceRouter === "object", null, { timeout: 30000 });
    await page.waitForTimeout(150);

    const currentUrl = page.url();
    assert.ok(!currentUrl.includes("page=-10"), "Invalid page should self-heal");
    assert.ok(!currentUrl.includes("hacker_attempt"), "Invalid mode should self-heal");
    assert.ok(currentUrl.includes("q=sand"), "Valid query should be preserved");
  }, failures);

  await runCase("router reactive popstate browser history back updates", browser, async (page) => {
    await page.goto(new URL("/search.html?q=silicon", options.base).toString(), { waitUntil: "networkidle" });
    await page.waitForSelector("#search-page-input", { timeout: 30000 });
    
    // Trigger transition with pushState (replace: false) to add a history entry
    await page.evaluate(() => {
      window.RenaissanceRouter.transitionTo("search", { query: "sand" }, { replace: false });
    });
    await page.waitForTimeout(200);

    // Click browser back
    await page.goBack();
    await page.waitForTimeout(200);

    const value = await page.inputValue("#search-page-input");
    assert.equal(value, "silicon", "Back button should restore search input query");
  }, failures);

  await runCase("router subscriber auto-unsubscribe detached DOM", browser, async (page) => {
    await openReadyArchive(page);

    const listenerLeak = await page.evaluate(() => {
      const router = window.RenaissanceRouter;
      let callCount = 0;
      
      const element = document.createElement("div");
      document.body.appendChild(element);

      router.subscribe(element, () => {
        callCount += 1;
      });

      // Trigger transition
      router.transitionTo("archive", { query: "first" });
      
      // Detach element
      document.body.removeChild(element);

      // Trigger second transition
      router.transitionTo("archive", { query: "second" });

      return callCount;
    });

    assert.equal(listenerLeak, 1, "Detached elements should automatically unsubscribe");
  }, failures);

  await browser.close();

  if (failures.length > 0) {
    console.error("Router regression checks failed:");
    failures.forEach((fail) => console.error("- " + fail));
    process.exit(1);
  }

  console.log("Router regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
