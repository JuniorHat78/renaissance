#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Recovery = require("../recovery-engine");

const essays = [
  {
    slug: "etching-god-into-sand",
    title: "Etching God into Sand",
    summary: "Sand, silicon, language, and cognition.",
    published: true,
    section_order: [1, 2, 10]
  },
  {
    slug: "shadows",
    title: "SHADOWS",
    summary: "Unpublished draft.",
    published: false,
    section_order: [1]
  }
];

check("closestEssay ranks published catalogue entries", () => {
  const closest = Recovery.closestEssay(essays, "etching god snad");
  assert.equal(closest.slug, "etching-god-into-sand");
});

check("closestEssay excludes unpublished essays", () => {
  const closest = Recovery.closestEssay(essays, "shadows");
  assert.equal(closest, null);
});

check("nearestSectionNumber picks closest published section number", () => {
  assert.equal(Recovery.nearestSectionNumber(essays[0], 9), 10);
  assert.equal(Recovery.nearestSectionNumber(essays[0], "not-a-number"), 1);
});

check("routeRecovery classifies core not-found modes", () => {
  assert.equal(Recovery.routeRecovery({ path: "/missing", search: "" }).mode, "unknown");
  assert.equal(Recovery.routeRecovery({ path: "/old-link.html", search: "?essay=etching-god-into-sand" }).mode, "essay");
  assert.equal(Recovery.routeRecovery({ path: "/old-link.html", search: "?essay=etching-god-into-sand&section=99" }).mode, "section");
  assert.equal(Recovery.routeRecovery({ path: "/old-search.html", search: "?query=amber" }).mode, "search");
  assert.equal(Recovery.routeRecovery({ path: "/assets/missing-card.png", search: "" }).mode, "asset");
  assert.equal(Recovery.routeRecovery({ path: "/missing", search: "", online: false }).mode, "offline");
});

console.log("Recovery engine regression checks passed.");

function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    console.error("FAIL " + name + "\n  " + error.message);
    process.exit(1);
  }
}
