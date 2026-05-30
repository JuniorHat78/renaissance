#!/usr/bin/env node

// Keyboard & focus-management checks that axe can't make: the skip link is the
// first tab stop and becomes visible when focused, activating it moves focus
// into <main>, the theme toggle is operable from the keyboard and carries an
// accessible name, and every shell page exposes the skip link + focusable main.
// This is the "human" a11y layer behind the automated audit.

const assert = require("node:assert/strict");
const { browserType, resolveBrowserName } = require("./lib/browser");

const SHELL = ["index.html", "essay.html", "section.html", "search.html"];

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4181" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await browserType().launch({ headless: true });
  // reducedMotion collapses the skip-link slide-in (and other transitions) to
  // ~instant via the site's safety net, so we read its settled position rather
  // than a mid-transition value.
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

  // For essay/section we need a real slug; discover from the archive.
  await page.goto(options.base + "/index.html", { waitUntil: "networkidle", timeout: 30000 });
  const slug = await page.$eval('#essay-list a[href*="essay.html"]', (a) =>
    new URL(a.href).searchParams.get("essay")
  ).catch(() => null);

  const urlFor = (pageName) => {
    if (pageName === "essay.html" && slug) return options.base + "/essay.html?essay=" + encodeURIComponent(slug);
    if (pageName === "section.html" && slug) return options.base + "/section.html?essay=" + encodeURIComponent(slug) + "&section=1";
    return options.base + "/" + pageName;
  };

  await step("first Tab focuses a visible skip link on the archive", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "networkidle", timeout: 30000 });
    await page.keyboard.press("Tab");
    const onSkip = await page.evaluate(() =>
      Boolean(document.activeElement && document.activeElement.classList.contains("skip-link"))
    );
    assert.ok(onSkip, "first Tab should land on the skip link");
    // Poll the rendered position until the focused link is inside the viewport,
    // rather than sampling computed style once (which races the focus restyle /
    // slide-in transition and is timing-dependent across machines).
    await page.waitForFunction(() => {
      const el = document.querySelector(".skip-link");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.left >= 0;
    }, { timeout: 5000 }).catch(() => {
      throw new Error("focused skip link never slid into the viewport (top stayed < 0)");
    });
  });

  await step("activating the skip link moves focus into main", async () => {
    await page.keyboard.press("Enter");
    const focusedMain = await page.evaluate(() =>
      Boolean(document.activeElement && document.activeElement.id === "main-content")
    );
    assert.ok(focusedMain, "activating the skip link should focus #main-content");
  });

  await step("theme toggle has an accessible name and toggles via keyboard", async () => {
    const label = (await page.getAttribute("#theme-toggle", "aria-label")) || "";
    assert.ok(label.trim().length > 0, "theme toggle needs an aria-label");
    await page.focus("#theme-toggle");
    const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || "light");
    await page.keyboard.press("Enter");
    const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || "light");
    assert.notEqual(after, before, "Enter on the theme toggle should flip the theme");
  });

  for (const pageName of SHELL) {
    await step("skip link + focusable main present on " + pageName, async () => {
      await page.goto(urlFor(pageName), { waitUntil: "networkidle", timeout: 30000 });
      const skip = await page.$('a.skip-link[href="#main-content"]');
      assert.ok(skip, pageName + " should have a skip link targeting #main-content");
      const mainTabindex = await page.getAttribute("#main-content", "tabindex");
      assert.equal(mainTabindex, "-1", pageName + " main should be programmatically focusable (tabindex=-1)");
    });
  }

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nFocus / keyboard regression FAILED:");
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Focus & keyboard checks passed (" + resolveBrowserName() + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
