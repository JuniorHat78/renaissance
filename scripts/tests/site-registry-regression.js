#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "data", "site-registry.json"), "utf8"));
const essaysPayload = JSON.parse(fs.readFileSync(path.join(root, "data", "essays.json"), "utf8"));
const essays = Array.isArray(essaysPayload.essays) ? essaysPayload.essays : [];
const published = essays.filter((essay) => essay && essay.published !== false);
const unpublished = essays.filter((essay) => essay && essay.published === false);

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

function filePart(routePath) {
  if (routePath === "./") {
    return "index.html";
  }
  return String(routePath).split("?")[0].split("#")[0];
}

check("registry has deterministic shape", () => {
  assert.equal(registry.version, 1);
  assert.ok(Array.isArray(registry.routes), "routes must be an array");
  assert.ok(registry.recovery && Array.isArray(registry.recovery.essays), "recovery catalogue is required");
  assert.equal(registry.stats.routes, registry.routes.length);
});

check("routes are unique and point at existing shell files", () => {
  const seen = new Set();
  for (const route of registry.routes) {
    assert.ok(route.path, "route requires path");
    assert.ok(!seen.has(route.path), "duplicate route: " + route.path);
    seen.add(route.path);
    const localFile = filePart(route.path);
    assert.ok(fs.existsSync(path.join(root, localFile)), "route target missing on disk: " + route.path);
  }
});

check("published essays and sections are routable", () => {
  for (const essay of published) {
    assert.ok(
      registry.routes.some((route) => route.path === "essay.html?essay=" + encodeURIComponent(essay.slug)),
      "published essay missing route: " + essay.slug
    );
    for (const section of essay.section_order || []) {
      assert.ok(
        registry.routes.some((route) => route.path === "section.html?essay=" + encodeURIComponent(essay.slug) + "&section=" + String(section)),
        "published section missing route: " + essay.slug + "/" + String(section)
      );
    }
  }
});

check("unpublished essays do not appear in public recovery catalogue", () => {
  const recoveryText = JSON.stringify(registry.recovery);
  for (const essay of unpublished) {
    assert.ok(!recoveryText.includes(String(essay.slug)), "unpublished slug leaked into recovery: " + essay.slug);
    assert.ok(!recoveryText.includes(String(essay.title)), "unpublished title leaked into recovery: " + essay.title);
  }
});

if (failures.length > 0) {
  console.error("\nSite registry regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("Site registry regression checks passed.");
