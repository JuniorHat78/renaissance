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

function archiveUrl(base) {
  return new URL("/index.html", base).toString();
}

// Drop a probe element carrying an explicit transition + animation and read
// back what the cascade actually grants it. The global reduced-motion reset
// uses !important, so it must win over the probe's inline timing.
async function probeDurations(page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.transition = "opacity 300ms ease";
    probe.style.animation = "spin 900ms linear";
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe);
    const result = {
      transition: computed.transitionDuration,
      animation: computed.animationDuration
    };
    probe.remove();
    return result;
  });
}

function toMs(value) {
  // getComputedStyle returns seconds, e.g. "0.3s" or "0.00001s".
  return Math.round(parseFloat(value) * 1000 * 1000) / 1000;
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const failures = [];

  // Control: with motion allowed, the probe keeps its real durations.
  const motionContext = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "no-preference"
  });
  const motionPage = await motionContext.newPage();
  await motionPage.goto(archiveUrl(options.base), { waitUntil: "networkidle", timeout: 30000 });
  const allowed = await probeDurations(motionPage);
  await motionContext.close();

  try {
    assert.ok(toMs(allowed.transition) > 100, "with motion allowed, transitions should keep their duration");
    assert.ok(toMs(allowed.animation) > 100, "with motion allowed, animations should keep their duration");
    console.log("PASS motion-allowed keeps real durations");
  } catch (error) {
    failures.push(error.message);
    console.error("FAIL motion-allowed keeps real durations");
  }

  // Under reduced motion, the universal reset collapses both to ~0.
  const reduceContext = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const reducePage = await reduceContext.newPage();
  await reducePage.goto(archiveUrl(options.base), { waitUntil: "networkidle", timeout: 30000 });
  const reduced = await probeDurations(reducePage);
  await reduceContext.close();

  try {
    assert.ok(toMs(reduced.transition) < 5, "reduced motion should collapse transition duration");
    assert.ok(toMs(reduced.animation) < 5, "reduced motion should collapse animation duration");
    console.log("PASS reduced-motion collapses all timing");
  } catch (error) {
    failures.push(error.message);
    console.error("FAIL reduced-motion collapses all timing");
  }

  await browser.close();

  if (failures.length > 0) {
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Reduced-motion regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
