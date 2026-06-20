#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = { base: "http://127.0.0.1:8000" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

async function openReadyArchive(page, options) {
  await page.goto(new URL("/index.html", options.base).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForFunction(
    () => typeof window.RenaissanceRouter === "object" && typeof window.RenaissanceRouter.parse === "function",
    null,
    { timeout: 30000 }
  );
}

function sectionUrl(base, sectionNumber) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", "etching-god-into-sand");
  url.searchParams.set("section", String(sectionNumber));
  return url.toString();
}

async function runCase(name, browser, options, body, failures) {
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
    await body(page);
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + (error && error.stack ? error.stack : error.message));
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

  await runCase("parse() returns frozen route with normalized defaults", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const result = await page.evaluate(() => {
      const route = window.RenaissanceRouter.parse();
      return {
        view: route.view,
        essaySlug: route.essaySlug,
        sectionNumber: route.sectionNumber,
        passageId: route.passageId,
        rangeStart: route.rangeStart,
        rangeEnd: route.rangeEnd,
        scope: route.scope,
        query: route.query,
        mode: route.mode,
        sort: route.sort,
        caseSensitive: route.caseSensitive,
        page: route.page,
        pageSize: route.pageSize,
        occurrence: route.occurrence,
        frozen: Object.isFrozen(route)
      };
    });
    assert.equal(result.view, "archive", "view should detect archive from index.html");
    assert.equal(result.essaySlug, "", "essaySlug default empty");
    assert.equal(result.sectionNumber, null, "sectionNumber default null");
    assert.equal(result.passageId, "", "passageId default empty");
    assert.equal(result.rangeStart, null, "rangeStart default null");
    assert.equal(result.rangeEnd, null, "rangeEnd default null");
    assert.equal(result.scope, "all", "scope default all");
    assert.equal(result.query, "", "query default empty");
    assert.equal(result.mode, "contains", "mode default contains");
    assert.equal(result.sort, "reading_order", "sort default reading_order");
    assert.equal(result.caseSensitive, false, "caseSensitive default false");
    assert.equal(result.page, 1, "page default 1");
    assert.equal(result.pageSize, 50, "pageSize default 50");
    assert.equal(result.occurrence, null, "occurrence default null");
    assert.equal(result.frozen, true, "route must be frozen");
  }, failures);

  await runCase("parse() sanitizes garbage URL params", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const result = await page.evaluate(() => {
      window.history.replaceState(null, "", "?essay=   etching-god-into-sand   &section=-99&mode=malicious&page=abc&page_size=999&sort=garbage&case=yes&scope=BAD%20VALUE&occ=-5");
      const route = window.RenaissanceRouter.parse();
      return {
        essaySlug: route.essaySlug,
        sectionNumber: route.sectionNumber,
        mode: route.mode,
        page: route.page,
        pageSize: route.pageSize,
        sort: route.sort,
        caseSensitive: route.caseSensitive,
        scope: route.scope,
        occurrence: route.occurrence
      };
    });
    assert.equal(result.essaySlug, "etching-god-into-sand", "slug should be trimmed and validated");
    assert.equal(result.sectionNumber, null, "negative section clamps to null");
    assert.equal(result.mode, "contains", "unknown mode defaults to contains");
    assert.equal(result.page, 1, "non-numeric page defaults to 1");
    assert.equal(result.pageSize, 50, "out-of-range pageSize defaults to 50");
    assert.equal(result.sort, "reading_order", "unknown sort defaults to reading_order");
    assert.equal(result.caseSensitive, false, "non-truthy case flag is false");
    assert.equal(result.scope, "all", "invalid scope defaults to all");
    assert.equal(result.occurrence, null, "negative occurrence clamps to null");
  }, failures);

  await runCase("build() produces stable param order and elides defaults", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const result = await page.evaluate(() => {
      const r = window.RenaissanceRouter;
      const sectionUrl = r.build("section", {
        essaySlug: "etching-god-into-sand",
        sectionNumber: 3,
        passageId: "p12",
        rangeStart: 4,
        rangeEnd: 9,
        query: "sand",
        mode: "fuzzy",
        caseSensitive: true,
        occurrence: 2
      });
      const archiveDefaults = r.build("archive", {});
      const archiveWithDefaults = r.build("archive", {
        mode: "contains",
        sort: "reading_order",
        page: 1,
        pageSize: 50,
        scope: "all",
        caseSensitive: false
      });
      const searchAll = r.build("search", {
        query: "shadow",
        sort: "relevance",
        scope: "shadows",
        page: 2,
        pageSize: 25
      });
      return { sectionUrl, archiveDefaults, archiveWithDefaults, searchAll };
    });

    assert.match(result.sectionUrl, /section\.html\?essay=etching-god-into-sand&section=3&p=p12&start=4&end=9&q=sand&occ=2&mode=fuzzy&case=1$/, "section URL has stable param order: essay,section,p,start,end,q,occ,mode,case");
    assert.ok(/index\.html$/.test(result.archiveDefaults), "archive default URL has no query");
    assert.ok(/index\.html$/.test(result.archiveWithDefaults), "explicit defaults must be elided");
    assert.match(result.searchAll, /search\.html\?scope=shadows&q=shadow&sort=relevance&page=2&page_size=25$/, "search URL stable order");
    // Links must be relative so navigation survives a project subpath
    // (e.g. GitHub Pages at /renaissance/). A leading "/" would 404 there.
    assert.ok(!result.sectionUrl.startsWith("/"), "build() must return a relative section path");
    assert.ok(!result.archiveDefaults.startsWith("/"), "build() must return a relative archive path");
    assert.ok(!result.searchAll.startsWith("/"), "build() must return a relative search path");
  }, failures);

  await runCase("build() round-trips through parse()", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const result = await page.evaluate(() => {
      const r = window.RenaissanceRouter;
      const cases = [
        { view: "section", params: { essaySlug: "shadows", sectionNumber: 5, passageId: "p9", rangeStart: 2, rangeEnd: 14, query: "moon", mode: "exact_phrase", caseSensitive: true, occurrence: 4 } },
        { view: "search", params: { query: "umbra", scope: "etching-god-into-sand", mode: "fuzzy", sort: "relevance", caseSensitive: true, page: 3, pageSize: 25 } },
        { view: "essay", params: { essaySlug: "etching-god-into-sand", query: "verdun", mode: "exact_phrase" } },
        { view: "archive", params: { query: "sand", scope: "shadows", caseSensitive: true } }
      ];
      return cases.map((c) => {
        const url = r.build(c.view, c.params);
        const parsed = r.parse(url);
        return { url, parsed };
      });
    });

    const sectionCase = result[0].parsed;
    assert.equal(sectionCase.view, "section");
    assert.equal(sectionCase.essaySlug, "shadows");
    assert.equal(sectionCase.sectionNumber, 5);
    assert.equal(sectionCase.passageId, "p9");
    assert.equal(sectionCase.rangeStart, 2);
    assert.equal(sectionCase.rangeEnd, 14);
    assert.equal(sectionCase.query, "moon");
    assert.equal(sectionCase.mode, "exact_phrase");
    assert.equal(sectionCase.caseSensitive, true);
    assert.equal(sectionCase.occurrence, 4);

    const searchCase = result[1].parsed;
    assert.equal(searchCase.view, "search");
    assert.equal(searchCase.query, "umbra");
    assert.equal(searchCase.scope, "etching-god-into-sand");
    assert.equal(searchCase.mode, "fuzzy");
    assert.equal(searchCase.sort, "relevance");
    assert.equal(searchCase.caseSensitive, true);
    assert.equal(searchCase.page, 3);
    assert.equal(searchCase.pageSize, 25);

    const essayCase = result[2].parsed;
    assert.equal(essayCase.view, "essay");
    assert.equal(essayCase.essaySlug, "etching-god-into-sand");
    assert.equal(essayCase.query, "verdun");
    assert.equal(essayCase.mode, "exact_phrase");

    const archiveCase = result[3].parsed;
    assert.equal(archiveCase.view, "archive");
    assert.equal(archiveCase.query, "sand");
    assert.equal(archiveCase.scope, "shadows");
    assert.equal(archiveCase.caseSensitive, true);
  }, failures);

  await runCase("build() preserves extras after navigation params", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const url = await page.evaluate(() => window.RenaissanceRouter.build("section", {
      essaySlug: "etching-god-into-sand",
      sectionNumber: 2,
      query: "sand",
      extras: [["hl", "first surprise"], ["hlp", "the"], ["hls", "that"]]
    }));
    assert.match(url, /section\.html\?essay=etching-god-into-sand&section=2&q=sand&hl=first%20surprise&hlp=the&hls=that$/, "extras come after nav params, percent-encoded");
  }, failures);

  await runCase("go() pushes history and dispatches route event", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const finalUrl = await page.evaluate(async () => {
      let captured = null;
      window.addEventListener("renaissance:route", (event) => {
        captured = event.detail;
      });
      window.RenaissanceRouter.go("essay", { essaySlug: "etching-god-into-sand" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { href: window.location.href, capturedView: captured ? captured.view : null };
    });
    assert.match(finalUrl.href, /essay\.html\?essay=etching-god-into-sand$/, "go() updated location");
    assert.equal(finalUrl.capturedView, "essay", "renaissance:route event fired with payload");
  }, failures);

  await runCase("go() with throttle debounces successive updates", browser, options, async (page) => {
    await openReadyArchive(page, options);
    const result = await page.evaluate(async () => {
      window.RenaissanceRouter.go("archive", { query: "a" }, { replace: true, throttle: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.RenaissanceRouter.go("archive", { query: "ab" }, { replace: true, throttle: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.RenaissanceRouter.go("archive", { query: "abc" }, { replace: true, throttle: true });
      await new Promise((resolve) => setTimeout(resolve, 400));
      return window.location.search;
    });
    assert.equal(result, "?q=abc", "only the last throttled call commits");
  }, failures);

  await runCase("self-heal cleans malformed URL on load", browser, options, async (page) => {
    await page.goto(new URL("/index.html?q=sand&mode=hacker&page=abc&page_size=999&case=1", options.base).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForFunction(
      () => typeof window.RenaissanceRouter === "object",
      null,
      { timeout: 30000 }
    );
    const cleaned = await page.evaluate(() => window.location.search);
    assert.ok(!cleaned.includes("mode=hacker"), "invalid mode stripped");
    assert.ok(!cleaned.includes("page=abc"), "invalid page stripped");
    assert.ok(!cleaned.includes("page_size=999"), "invalid pageSize stripped");
    assert.match(cleaned, /q=sand/, "query preserved");
    assert.match(cleaned, /case=1/, "valid case flag preserved");
  }, failures);

  await runCase("self-heal preserves unknown extras beside passage anchors", browser, options, async (page) => {
    await page.goto(new URL("/section.html?essay=etching-god-into-sand&section=1&hl=first&mark=3&p=3&start=4&end=9", options.base).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForFunction(
      () => typeof window.RenaissanceRouter === "object",
      null,
      { timeout: 30000 }
    );
    const search = await page.evaluate(() => window.location.search);
    assert.match(search, /hl=first/, "unknown extra hl preserved");
    assert.match(search, /mark=3/, "unknown extra mark preserved");
    assert.match(search, /p=p3/, "canonical passage id preserved");
    assert.match(search, /start=4/, "range start preserved");
    assert.match(search, /end=9/, "range end preserved");
  }, failures);

  await runCase("saveScroll() persists scrollY into history.state", browser, options, async (page) => {
    await openReadyArchive(page, options);
    await page.waitForSelector("#essay-list .essay-item", { timeout: 30000 });
    const result = await page.evaluate(async () => {
      // Inject a tall spacer so a known scroll position is reachable.
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.body.appendChild(spacer);
      await new Promise((r) => setTimeout(r, 100));
      window.scrollTo({ top: 500, behavior: "auto" });
      await new Promise((r) => setTimeout(r, 100));
      const actualY = window.scrollY;
      window.RenaissanceRouter.saveScroll();
      const savedY = window.history.state ? window.history.state.scrollY : null;
      return { actualY, savedY };
    });
    assert.equal(result.savedY, result.actualY, "scrollY should be persisted; actualY=" + result.actualY + " savedY=" + result.savedY);
    assert.ok(result.actualY >= 400, "scroll position should be reached (got " + result.actualY + ")");
  }, failures);

  await runCase("section nav swaps sections without reloading the document", browser, options, async (page) => {
    await page.goto(sectionUrl(options.base, 1), {
      waitUntil: "networkidle",
      timeout: 30000
    });
    await page.waitForSelector("#next-link:not(.hidden)", { timeout: 30000 });
    await page.evaluate(() => {
      window.__sectionNavSentinel = "still-here";
    });

    await page.click("#next-link");
    await page.waitForFunction(
      () => document.querySelector("#section-title") &&
        /Nine Nines/.test(document.querySelector("#section-title").textContent || ""),
      null,
      { timeout: 30000 }
    );

    const result = await page.evaluate(() => ({
      sentinel: window.__sectionNavSentinel,
      url: window.location.href,
      scrollY: window.scrollY,
      previousVisible: !document.getElementById("prev-link").classList.contains("hidden")
    }));

    assert.equal(result.sentinel, "still-here", "section navigation should not reload the document");
    assert.match(result.url, /section=2/, "URL should advance to section 2");
    assert.ok(result.scrollY < 80, "reader should land near the top of the next section");
    assert.equal(result.previousVisible, true, "previous link should become available after advancing");
  }, failures);

  await browser.close();

  if (failures.length > 0) {
    console.error("\nRouter regression failed:");
    failures.forEach((line) => console.error("  - " + line));
    process.exit(1);
  }

  console.log("\nRouter regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
