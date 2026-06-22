#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Ast = require("../ast");
const files = require("./lib/files");
const fixtures = require("./lib/fixtures");

const failures = [];

// The four reader shells. They load only the browser-shipped AST modules.
const SHELLS = ["index.html", "essay.html", "section.html", "search.html"];

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

check("parser does not ship to the browser", () => {
  // P5's enforceable guarantee. The tokenizer (parse.js: parseDocument,
  // parseInline, the inline scanners, the legacy bridge) is Node/build-time
  // only. The browser loads core + render, and neither defines the parser, so
  // the reader literally cannot tokenize raw text.
  const forbidden = [
    /function\s+parseDocument\b/,
    /function\s+parseInline\b/,
    /function\s+parseLinkToken\b/,
    /function\s+legacyBlocksToAst\b/,
  ];
  for (const file of ["core.js", "render.js"]) {
    const source = files.readText(files.fromRoot("scripts", "ast", file));
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), file + " must not define the parser (" + pattern + ")");
    }
  }
  for (const page of SHELLS) {
    const html = files.readText(files.fromRoot(page));
    assert.ok(!html.includes("scripts/ast/parse.js"), page + " must not load the Node-only parser");
    assert.ok(!html.includes("scripts/ast/index.js"), page + " must load core + render, not the Node merge");
  }
  const sw = files.readText(files.fromRoot("sw.js"));
  assert.ok(!sw.includes('"scripts/ast/parse.js"'), "sw.js must not precache the Node-only parser");
  assert.ok(!sw.includes('"scripts/ast/index.js"'), "sw.js must not precache the Node merge");
});

check("shells load core then render before content", () => {
  for (const page of SHELLS) {
    const html = files.readText(files.fromRoot(page));
    const coreIndex = html.indexOf('src="scripts/ast/core.js"');
    const renderIndex = html.indexOf('src="scripts/ast/render.js"');
    const contentIndex = html.indexOf('src="scripts/content.js"');
    assert.ok(coreIndex !== -1, page + " does not load scripts/ast/core.js");
    assert.ok(renderIndex !== -1, page + " does not load scripts/ast/render.js");
    assert.ok(contentIndex !== -1, page + " does not load scripts/content.js");
    assert.ok(coreIndex < renderIndex, page + " must load core before render");
    assert.ok(renderIndex < contentIndex, page + " must load render before content.js");
  }
});

check("service worker precaches the shipped AST runtime", () => {
  const sw = files.readText(files.fromRoot("sw.js"));
  assert.ok(sw.includes('"scripts/ast/core.js"'), "sw.js PRECACHE is missing scripts/ast/core.js");
  assert.ok(sw.includes('"scripts/ast/render.js"'), "sw.js PRECACHE is missing scripts/ast/render.js");
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
