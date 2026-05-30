#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Ast = require("../ast");
const files = require("./lib/files");
const fixtures = require("./lib/fixtures");

const failures = [];

check("runtime exports expected API", () => {
  [
    "parseDocument",
    "renderBlocks",
    "serializeDocument",
    "toSearchableText",
    "validateDocument",
    "withoutLeadingHeadings",
  ].forEach((name) => assert.equal(typeof Ast[name], "function", name + " export missing"));
});

check("fixture manifest exists and names are unique", () => {
  const manifest = fixtures.loadManifest();
  const names = new Set();
  assert.ok(manifest.fixtures.length > 0, "no AST fixtures are listed");
  for (const fixture of manifest.fixtures) {
    assert.match(fixture.name, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(!names.has(fixture.name), "duplicate fixture: " + fixture.name);
    names.add(fixture.name);
  }
});

check("runtime source stays dependency-free", () => {
  const source = files.readText(files.fromRoot("scripts", "ast", "index.js"));
  assert.ok(!/\brequire\s*\(/.test(source), "browser runtime must not require modules");
  assert.ok(!/\bimport\s+/.test(source), "browser runtime must not import modules");
});

check("shell pages load AST before content", () => {
  for (const page of ["index.html", "essay.html", "section.html", "search.html"]) {
    const html = files.readText(files.fromRoot(page));
    const astIndex = html.indexOf('src="scripts/ast/index.js"');
    const contentIndex = html.indexOf('src="scripts/content.js"');
    assert.ok(astIndex !== -1, page + " does not load scripts/ast/index.js");
    assert.ok(contentIndex !== -1, page + " does not load scripts/content.js");
    assert.ok(astIndex < contentIndex, page + " must load AST before content.js");
  }
});

check("service worker precaches AST runtime", () => {
  const sw = files.readText(files.fromRoot("sw.js"));
  assert.ok(sw.includes('"scripts/ast/index.js"'), "sw.js PRECACHE is missing scripts/ast/index.js");
});

if (failures.length > 0) {
  console.error("\nAST doctor FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("AST doctor passed.");

function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name + "\n  " + error.message);
  }
}
