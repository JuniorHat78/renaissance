#!/usr/bin/env node
"use strict";

// The Lighthouse SCORE is fickle (shared-runner noise) and is never gated. But
// the logic that decides WHEN to flag a drop is pure and must be correct, so we
// unit-test buildSummary with synthetic inputs. This is the deterministic core
// behind a non-gating measuring stick.

const assert = require("node:assert/strict");
const { buildSummary } = require("../lighthouse-warning-summary");

const entry = (label, score, over = {}) =>
  Object.assign({ label, score, lcp: "1.0 s", tbt: "0 ms", cls: "0" }, over);

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name + "\n  " + error.message);
  }
}

const baseline = { capturedAt: "2026-05-30", sourceRun: "42", scores: { Home: 99, Essay: 98, Section: 97 } };

check("a drastic drop (>= drasticDrop) emits exactly one drop warning", () => {
  const { warnings } = buildSummary({
    entries: [entry("Home", 90)], // 90 vs 99 = -9, drop >= 8
    baseline,
    threshold: 80,
    drasticDrop: 8
  });
  const drops = warnings.filter((w) => /drastic drop/i.test(w.title));
  assert.equal(drops.length, 1, "expected one drastic-drop warning");
  assert.match(drops[0].message, /9 points below baseline 99/);
});

check("a small dip below drasticDrop does NOT warn", () => {
  const { warnings } = buildSummary({
    entries: [entry("Home", 92)], // 92 vs 99 = -7, below the -8 flag
    baseline,
    threshold: 80,
    drasticDrop: 8
  });
  assert.equal(warnings.filter((w) => /drastic drop/i.test(w.title)).length, 0);
});

check("an improvement never warns and shows a +delta", () => {
  const { warnings, lines } = buildSummary({
    entries: [entry("Home", 100)], // +1 vs 99
    baseline,
    threshold: 80,
    drasticDrop: 8
  });
  assert.equal(warnings.length, 0, "improvement should not warn");
  assert.ok(lines.some((l) => /Δ \+1 vs baseline 99/.test(l)), "should render +1 delta");
});

check("absolute-threshold breach warns independently of baseline delta", () => {
  const { warnings } = buildSummary({
    entries: [entry("Essay", 78)], // -20 vs 98 (drastic) AND below threshold 80
    baseline,
    threshold: 80,
    drasticDrop: 8
  });
  assert.ok(warnings.some((w) => /performance low/i.test(w.title)), "expected absolute-threshold warning");
  assert.ok(warnings.some((w) => /drastic drop/i.test(w.title)), "expected drastic-drop warning");
});

check("no baseline => report-only, never warns on delta", () => {
  const { warnings, lines } = buildSummary({
    entries: [entry("Home", 70)],
    baseline: null,
    threshold: 60, // keep above-threshold so the only possible warning would be a delta
    drasticDrop: 8
  });
  assert.equal(warnings.filter((w) => /drastic drop/i.test(w.title)).length, 0);
  assert.ok(lines.some((l) => /No baseline committed/i.test(l)), "should note the missing baseline");
});

check("a missing score warns and is reported as unavailable", () => {
  const { warnings, lines } = buildSummary({
    entries: [entry("Section", null)],
    baseline,
    threshold: 90,
    drasticDrop: 8
  });
  assert.ok(warnings.some((w) => /score missing/i.test(w.title)));
  assert.ok(lines.some((l) => /Section: score unavailable/.test(l)));
});

check("category scores (a11y/best-practices/seo) render when present", () => {
  const withCats = Object.assign(entry("Home", 100), {
    categories: { accessibility: 96, "best-practices": 100, seo: 92 }
  });
  const { lines } = buildSummary({ entries: [withCats], baseline, threshold: 80, drasticDrop: 8 });
  assert.ok(
    lines.some((l) => /a11y 96 \/ best-practices 100 \/ seo 92/.test(l)),
    "should render the non-performance category scores"
  );
});

check("never throws and never signals a gate (warnings are advisory)", () => {
  const result = buildSummary({ entries: [entry("Home", 5)], baseline, threshold: 90, drasticDrop: 8 });
  assert.ok(Array.isArray(result.warnings) && Array.isArray(result.lines));
});

if (failures.length > 0) {
  console.error("\nLighthouse summary logic FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("Lighthouse summary logic checks passed.");
