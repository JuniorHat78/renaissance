#!/usr/bin/env node

// Automated accessibility audit. Walks the real reader journey (archive ->
// essay -> section), plus search-with-results and the custom 404, and runs
// axe-core against each surface in BOTH light and dark themes. The build fails
// on any serious/critical WCAG 2.0/2.1 A/AA violation. Moderate/minor findings
// are reported but do not gate (they are judgement calls, not hard breakage).
//
// Theme is driven by the data-theme attribute on <html> (see scripts/theme.js),
// so we audit as-loaded (light) then flip the attribute to dark and re-audit —
// the palette is pure CSS variables, no re-render needed.

const assert = require("node:assert/strict");
const { AxeBuilder } = require("@axe-core/playwright");
const { browserType, resolveBrowserName } = require("./lib/browser");

const GATING_IMPACTS = new Set(["serious", "critical"]);
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function parseArgs(argv) {
  const options = { base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4179" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

function summarizeViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes.slice(0, 3).map((n) => "      " + (n.target.join(" ") || "<node>")).join("\n");
      return "    [" + v.impact + "] " + v.id + " — " + v.help + "\n" + nodes;
    })
    .join("\n");
}

async function audit(page, surface, theme) {
  if (theme === "dark") {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  } else {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  }
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const gating = results.violations.filter((v) => GATING_IMPACTS.has(v.impact));
  const advisory = results.violations.filter((v) => !GATING_IMPACTS.has(v.impact));
  const label = surface + " (" + theme + ")";
  if (advisory.length > 0) {
    console.log("NOTE " + label + " — " + advisory.length + " advisory (moderate/minor) finding(s)");
  }
  assert.equal(
    gating.length,
    0,
    "serious/critical a11y violations on " + label + ":\n" + summarizeViolations(gating)
  );
  console.log("PASS " + label);
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await browserType().launch({ headless: true });
  // reducedMotion collapses the site's transitions (see the prefers-reduced-motion
  // safety net in site.css) to ~instant, so a theme flip settles before axe samples
  // colors — otherwise we'd audit a mid-transition blended background and flake.
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();

  const failures = [];
  async function surface(name, arrive) {
    try {
      await arrive();
      await audit(page, name, "light");
      await audit(page, name, "dark");
    } catch (error) {
      failures.push(name + ": " + error.message);
      console.error("FAIL " + name + "\n  " + error.message);
    }
  }

  await surface("archive", async () => {
    await page.goto(options.base + "/index.html", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#essay-list .essay-item a", { timeout: 30000 });
  });

  await surface("essay", async () => {
    await page.click('#essay-list a[href*="essay.html"]');
    await page.waitForURL(/essay\.html/, { timeout: 30000 });
    await page.waitForSelector("#essay-title", { timeout: 30000 });
  });

  await surface("section", async () => {
    await page.click('a[href*="section.html"]');
    await page.waitForURL(/section\.html/, { timeout: 30000 });
    await page.waitForSelector("#section-content p", { timeout: 30000 });
  });

  await surface("search", async () => {
    await page.goto(options.base + "/search.html", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#search-page-input", { timeout: 30000 });
    await page.fill("#search-page-input", "sand");
    await page.waitForSelector("#search-page-results .result-card", { timeout: 30000 });
  });

  await surface("not-found", async () => {
    await page.goto(options.base + "/this-page-does-not-exist", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("h1", { timeout: 30000 });
  });

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nAccessibility audit FAILED:");
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Accessibility checks passed (" + resolveBrowserName() + ", light + dark).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
