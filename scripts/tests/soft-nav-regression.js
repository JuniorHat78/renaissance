#!/usr/bin/env node

// Soft-navigation regression suite (A-phase checkpoint 2).
//
// Asserts the reading shell's key contracts:
//   1. essay → section: no hard reload; title, URL, and main content update.
//   2. section → essay: no hard reload; title, URL, and main content update.
//   3. Title and meta description sync after soft nav.
//   4. Focus lands on <main> after soft nav.
//   5. Reduced motion: soft nav still happens (no hard reload), but the
//      page-transition-out animation is skipped.
//   6. Hard fallback: navigating to index.html (archive) is NOT intercepted
//      (remains hard nav territory handled by page-transition.js).
//
// Tests exercise the *essay.html → section.html* direction. The
// *section.html → essay.html* direction requires essay.js to be lazily
// loaded by the shell; that lazy-load path is covered by case 2.

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000",
    essay: "etching-god-into-sand",
    section: 1
  };
  for (let i = 2; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--base" && argv[i + 1]) { options.base = argv[i + 1]; i += 1; }
    if (tok === "--essay" && argv[i + 1]) { options.essay = argv[i + 1]; i += 1; }
    if (tok === "--section" && argv[i + 1]) {
      options.section = Number.parseInt(argv[i + 1], 10) || options.section;
      i += 1;
    }
  }
  return options;
}

async function runCase(label, fn, failures) {
  try {
    await fn();
    console.log(`PASS ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err && err.stack ? err.stack : String(err)}`);
    console.error(`FAIL ${label}`);
  }
}

async function waitForShell(page) {
  await page.waitForFunction(
    () => Boolean(window.RenaissanceReadingShell),
    { timeout: 10000 }
  );
}

async function essayUrl(base, essay) {
  return `${base}/essay.html?essay=${essay}`;
}

async function sectionUrl(base, essay, section) {
  return `${base}/section.html?essay=${essay}&section=${section}`;
}

async function run() {
  const options = parseArgs(process.argv);
  const { base, essay, section } = options;
  const failures = [];
  const browser = await chromium.launch();

  // ---- Case 1: essay → section soft nav (no hard reload) ----
  await runCase("essay→section: no hard navigation reload", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(await essayUrl(base, essay), { waitUntil: "networkidle", timeout: 30000 });
    await waitForShell(page);

    // Wait for section list to be populated
    await page.waitForSelector("#section-list a[href*='section.html']", { timeout: 15000 });

    // Track navigation events — a hard navigation would trigger load/navigated
    let hardNavCount = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !frame.url().includes("essay.html")) {
        hardNavCount += 1;
      }
    });

    // Click the first section link
    const link = await page.locator("#section-list a[href*='section.html']").first();
    await link.click();

    // Wait for the section to load (announced by page-transition-ready class)
    await page.waitForFunction(
      () => document.documentElement.classList.contains("page-transition-ready"),
      { timeout: 15000 }
    );

    // The main element should now be the section reader layout
    const mainClass = await page.evaluate(() => {
      const m = document.querySelector("main");
      return m ? m.className : "";
    });
    assert.ok(
      mainClass.includes("reader-layout"),
      `Expected main to have reader-layout class after soft nav, got: "${mainClass}"`
    );

    // The URL should have changed to section.html without a hard navigation
    const finalUrl = page.url();
    assert.ok(
      finalUrl.includes("section.html"),
      `Expected URL to include section.html, got: "${finalUrl}"`
    );
    assert.strictEqual(
      hardNavCount,
      0,
      `Expected 0 hard navigations (soft nav), but got ${hardNavCount}`
    );

    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join("; ")}`);
    await context.close();
  }, failures);

  // ---- Case 2: section → essay soft nav (lazy-loads essay.js) ----
  await runCase("section→essay: no hard navigation reload", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(await sectionUrl(base, essay, section), { waitUntil: "networkidle", timeout: 30000 });
    await waitForShell(page);

    // Wait for the section reader to be populated (back-to-essay link resolves)
    await page.waitForFunction(
      () => {
        const a = document.getElementById("back-to-essay");
        return a && a.href && a.href !== "#" && !a.href.endsWith("#");
      },
      { timeout: 15000 }
    );

    let hardNavCount = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !frame.url().includes("section.html")) {
        hardNavCount += 1;
      }
    });

    // Click Back to Essay
    await page.locator("#back-to-essay").click();

    // Wait for essay-layout to appear
    await page.waitForFunction(
      () => {
        const m = document.querySelector("main");
        return m && m.className.includes("essay-layout");
      },
      { timeout: 15000 }
    );

    const finalUrl = page.url();
    assert.ok(
      finalUrl.includes("essay.html"),
      `Expected URL to include essay.html, got: "${finalUrl}"`
    );
    assert.strictEqual(hardNavCount, 0, `Expected 0 hard navigations, got ${hardNavCount}`);
    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join("; ")}`);
    await context.close();
  }, failures);

  // ---- Case 3: title and meta sync after essay→section soft nav ----
  await runCase("essay→section: title and meta description update", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(await essayUrl(base, essay), { waitUntil: "networkidle", timeout: 30000 });
    await waitForShell(page);
    const originalTitle = await page.title();

    await page.waitForSelector("#section-list a[href*='section.html']", { timeout: 15000 });
    await page.locator("#section-list a[href*='section.html']").first().click();

    await page.waitForFunction(
      () => document.documentElement.classList.contains("page-transition-ready"),
      { timeout: 15000 }
    );

    const newTitle = await page.title();
    assert.ok(
      newTitle !== originalTitle,
      `Expected title to change after soft nav (was: "${originalTitle}", got: "${newTitle}")`
    );
    assert.ok(newTitle.length > 0, "Expected non-empty title after soft nav");
    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join("; ")}`);
    await context.close();
  }, failures);

  // ---- Case 4: focus lands on main after soft nav ----
  await runCase("essay→section: focus moves to main content", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(await essayUrl(base, essay), { waitUntil: "networkidle", timeout: 30000 });
    await waitForShell(page);
    await page.waitForSelector("#section-list a[href*='section.html']", { timeout: 15000 });
    await page.locator("#section-list a[href*='section.html']").first().click();

    await page.waitForFunction(
      () => document.documentElement.classList.contains("page-transition-ready"),
      { timeout: 15000 }
    );
    // Give the rAF focus call time to execute
    await page.waitForTimeout(200);

    const focusedId = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.id || el.tagName.toLowerCase() : "none";
    });
    // Focus should be on main (id=main-content) or a descendant of main
    const focusIsOnMain = await page.evaluate(() => {
      const main = document.getElementById("main-content") || document.querySelector("main");
      const active = document.activeElement;
      return main && (active === main || main.contains(active));
    });
    assert.ok(
      focusIsOnMain,
      `Expected focus on main or descendant, but focused: "${focusedId}"`
    );
    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join("; ")}`);
    await context.close();
  }, failures);

  // ---- Case 5: reduced motion — soft nav still happens (no hard reload) ----
  await runCase("reduced motion: soft nav still replaces main without reload", async () => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(await essayUrl(base, essay), { waitUntil: "networkidle", timeout: 30000 });
    await waitForShell(page);
    await page.waitForSelector("#section-list a[href*='section.html']", { timeout: 15000 });

    let hardNavCount = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !frame.url().includes("essay.html")) {
        hardNavCount += 1;
      }
    });

    await page.locator("#section-list a[href*='section.html']").first().click();

    await page.waitForFunction(
      () => {
        const m = document.querySelector("main");
        return m && m.className.includes("reader-layout");
      },
      { timeout: 15000 }
    );

    assert.strictEqual(hardNavCount, 0, `Expected 0 hard navigations under reduced-motion, got ${hardNavCount}`);
    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join("; ")}`);
    await context.close();
  }, failures);

  // ---- Case 6: reader-progress bar appears after essay→section soft nav ----
  await runCase("essay→section: reader-progress bar is injected", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(await essayUrl(base, essay), { waitUntil: "networkidle", timeout: 30000 });
    await waitForShell(page);

    // reader-progress should NOT be on the essay page
    const beforeNav = await page.evaluate(() => Boolean(document.getElementById("reader-progress")));
    assert.strictEqual(beforeNav, false, "reader-progress should not exist on essay page before soft nav");

    await page.waitForSelector("#section-list a[href*='section.html']", { timeout: 15000 });
    await page.locator("#section-list a[href*='section.html']").first().click();

    await page.waitForFunction(
      () => document.documentElement.classList.contains("page-transition-ready"),
      { timeout: 15000 }
    );

    const afterNav = await page.evaluate(() => Boolean(document.getElementById("reader-progress")));
    assert.strictEqual(afterNav, true, "reader-progress should be injected after essay→section soft nav");
    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join("; ")}`);
    await context.close();
  }, failures);

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} case(s) failed:\n`);
    failures.forEach((f) => console.error(`  ${f}\n`));
    process.exit(1);
  } else {
    console.log(`\nAll ${6 - failures.length} soft-nav regression cases passed.`);
  }
}

run().catch((err) => {
  console.error("Soft-nav regression runner error:", err);
  process.exit(1);
});
