#!/usr/bin/env node

// Automated accessibility audit, parametrized over environmental FACTORS so it
// can be ablated in a 2^k matrix. Walks the real reader journey (archive ->
// essay -> section) plus search-with-results and the custom 404, and runs
// axe-core against each surface. Fails on any serious/critical WCAG 2.0/2.1
// A/AA violation; moderate/minor findings are reported as advisory notes only.
//
// Factors (each a GitHub matrix axis; env-driven so one job pins one cell):
//   RENAISSANCE_A11Y_THEME    light | dark        (unset => audit both)
//   RENAISSANCE_A11Y_MOTION   reduce | no-preference   (default reduce)
//   RENAISSANCE_A11Y_VIEWPORT desktop | mobile         (default desktop)
//   RENAISSANCE_A11Y_FORCED   none | active            (default none; Windows
//                                                        high-contrast emulation)
//
// Theme is applied at LOAD via localStorage (see scripts/theme.js) rather than
// flipped after load, so no transition is ever in flight when axe samples colors
// — that makes motion=no-preference safe and the audit deterministic.

const { AxeBuilder } = require("@axe-core/playwright");
const { browserType, resolveBrowserName } = require("./lib/browser");

const GATING_IMPACTS = new Set(["serious", "critical"]);
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };

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

function envChoice(name, allowed, fallback) {
  const value = String(process.env[name] || "").toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

function summarizeViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes.slice(0, 3).map((n) => "      " + (n.target.join(" ") || "<node>")).join("\n");
      return "    [" + v.impact + "] " + v.id + " — " + v.help + "\n" + nodes;
    })
    .join("\n");
}

async function auditSurface(page, surface, condLabel, failures, exemptContrast) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (exemptContrast) {
    // Under forced-colors the user agent substitutes system colors, so WCAG
    // contrast (1.4.3) is not the author's responsibility and does not apply.
    // Every other rule still runs against the high-contrast rendering.
    builder = builder.disableRules(["color-contrast"]);
  }
  const results = await builder.analyze();
  const gating = results.violations.filter((v) => GATING_IMPACTS.has(v.impact));
  const advisory = results.violations.filter((v) => !GATING_IMPACTS.has(v.impact));
  const label = surface + " [" + condLabel + "]";
  if (advisory.length > 0) {
    console.log("NOTE " + label + " — " + advisory.length + " advisory (moderate/minor) finding(s)");
  }
  if (gating.length > 0) {
    failures.push(label + ":\n" + summarizeViolations(gating));
    console.error("FAIL " + label);
    return;
  }
  console.log("PASS " + label);
}

async function sweepTheme(browser, options, theme, conds) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: theme,
    reducedMotion: conds.motion,
    forcedColors: conds.forced,
    viewport: VIEWPORTS[conds.viewport]
  });
  // Boot every page already in the target theme so no theme transition runs.
  await context.addInitScript((t) => {
    try {
      localStorage.setItem("renaissance-theme", t);
    } catch (error) {
      /* localStorage may be unavailable; the explicit attribute set below covers it */
    }
  }, theme);

  const page = await context.newPage();
  const condLabel = [theme, conds.motion, conds.viewport, "forced:" + conds.forced].join(" | ");
  const failures = [];

  async function surface(name, arrive) {
    try {
      await arrive();
      // Idempotent belt-and-suspenders: theme is already set from localStorage,
      // so this matches the current value and triggers no transition.
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await auditSurface(page, name, condLabel, failures, conds.forced === "active");
    } catch (error) {
      failures.push(name + " [" + condLabel + "]: " + error.message);
      console.error("FAIL " + name + " [" + condLabel + "]\n  " + error.message);
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
  return failures;
}

async function main() {
  const options = parseArgs(process.argv);
  const themeChoice = envChoice("RENAISSANCE_A11Y_THEME", ["light", "dark"], null);
  const themes = themeChoice ? [themeChoice] : ["light", "dark"];
  const conds = {
    motion: envChoice("RENAISSANCE_A11Y_MOTION", ["reduce", "no-preference"], "reduce"),
    viewport: envChoice("RENAISSANCE_A11Y_VIEWPORT", ["desktop", "mobile"], "desktop"),
    forced: envChoice("RENAISSANCE_A11Y_FORCED", ["active", "none"], "none")
  };

  console.log(
    "Accessibility ablation cell: themes=[" + themes.join(",") + "] motion=" + conds.motion +
    " viewport=" + conds.viewport + " forced-colors=" + conds.forced + " engine=" + resolveBrowserName()
  );

  const browser = await browserType().launch({ headless: true });
  const failures = [];
  for (const theme of themes) {
    const themeFailures = await sweepTheme(browser, options, theme, conds);
    failures.push(...themeFailures);
  }
  await browser.close();

  if (failures.length > 0) {
    console.error("\nAccessibility audit FAILED:");
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Accessibility checks passed (" + resolveBrowserName() + ", " + themes.join("+") + ").");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
