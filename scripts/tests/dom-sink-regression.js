#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const sinkPattern = /(?:\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\()/;

const allowedSinks = [
  ["scripts/archive.js", "continueAction.innerHTML =", "escaped continue label plus static glyph"],
  ["scripts/archive.js", "essayList.innerHTML = '<li", "static empty-state markup"],
  ["scripts/archive.js", "essayList.innerHTML = essays", "essay cards escape data before joining"],
  ["scripts/archive.js", "searchScope.innerHTML = ['<option", "option values/titles are escaped"],
  ["scripts/archive.js", "searchResults.innerHTML = \"\";", "clear existing results"],
  ["scripts/archive.js", "searchResults.innerHTML = '<p", "static empty-state markup"],
  ["scripts/archive.js", "searchResults.innerHTML = grouped", "search snippets are escaped before highlighting"],
  ["scripts/archive.js", "searchResults.innerHTML = '<p", "static error-state markup"],
  ["scripts/archive.js", "essayList.innerHTML = '<li", "static error-state markup"],

  ["scripts/content.js", "container.innerHTML = html;", "legacy fallback renders escaped inline markdown only"],

  ["scripts/essay.js", "sectionList.innerHTML = sections", "section list values are escaped before joining"],
  ["scripts/essay.js", "searchResults.innerHTML = \"\";", "clear existing results"],
  ["scripts/essay.js", "searchResults.innerHTML = '<p", "static empty-state markup"],
  ["scripts/essay.js", "searchResults.innerHTML = grouped", "search snippets are escaped before highlighting"],
  ["scripts/essay.js", "searchResults.innerHTML = '<p", "static error-state markup"],
  ["scripts/essay.js", "essayStats.innerHTML = joinMetaParts([", "metadata parts are escaped in joinMetaParts"],

  ["scripts/search-page.js", "searchCounts.innerHTML = \"\";", "clear existing counts"],
  ["scripts/search-page.js", "searchResults.innerHTML = \"\";", "clear existing results"],
  ["scripts/search-page.js", "searchCounts.innerHTML = rows.join(\"\");", "count rows escape labels before joining"],
  ["scripts/search-page.js", "searchResults.innerHTML = pageData.items", "result cards escape text before highlighting"],
  ["scripts/search-page.js", "searchCounts.innerHTML = \"\";", "clear existing counts"],
  ["scripts/search-page.js", "searchResults.innerHTML = '<p", "static empty-state markup"],
  ["scripts/search-page.js", "searchCounts.innerHTML = \"\";", "clear existing counts"],
  ["scripts/search-page.js", "searchResults.innerHTML = '<p", "static error-state markup"],
  ["scripts/search-page.js", "searchScope.innerHTML = ['<option", "option values/titles are escaped"],
  ["scripts/search-page.js", "searchResults.innerHTML = '<p", "static index-error markup"],

  ["scripts/section.js", "button.innerHTML =", "static icon markup for injected copy controls"],
  ["scripts/section.js", "sectionMeta.innerHTML = joinMetaParts([", "metadata parts are escaped in joinMetaParts"]
];

function trackedRuntimeFiles() {
  const output = childProcess.execFileSync("git", ["ls-files", "scripts/*.js"], {
    cwd: root,
    encoding: "utf8"
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /^scripts\/[^/]+\.js$/.test(file))
    .sort();
}

function allowanceKey(file, snippet) {
  return file + "\0" + snippet;
}

function countAllowances() {
  const counts = new Map();
  allowedSinks.forEach(([file, snippet]) => {
    const key = allowanceKey(file, snippet);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function checkDomSinks() {
  const expected = countAllowances();
  const seen = new Map();
  const failures = [];

  trackedRuntimeFiles().forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    source.split(/\r?\n/).forEach((line, index) => {
      if (!sinkPattern.test(line)) {
        return;
      }

      const matches = allowedSinks.filter(([allowedFile, snippet]) =>
        allowedFile === file && line.includes(snippet)
      );

      if (matches.length === 0) {
        failures.push(file + ":" + String(index + 1) + " has an unreviewed HTML sink: " + line.trim());
        return;
      }

      const key = allowanceKey(matches[0][0], matches[0][1]);
      seen.set(key, (seen.get(key) || 0) + 1);
    });
  });

  for (const [key, count] of expected.entries()) {
    const actual = seen.get(key) || 0;
    assert.equal(actual, count, "allowlist entry count drifted for " + key.replace("\0", " :: "));
  }

  assert.deepEqual(failures, [], failures.join("\n"));
}

function checkClipboardHtmlGuard() {
  const source = fs.readFileSync(path.join(root, "scripts", "section.js"), "utf8");
  assert.ok(!/function\s+htmlFromRange\b/.test(source), "clipboard copy must not rebuild rich HTML from a cloned range");
  assert.ok(!/\bselectedHtml\b/.test(source), "clipboard citation code should not pass selected HTML around");
  assert.ok(
    !/clipboardData\.setData\(\s*["']text\/html["'][\s\S]{0,120}cloneContents/.test(source),
    "text/html clipboard payload must not come from Range.cloneContents"
  );
}

function checkAstRendererGuard() {
  const source = fs.readFileSync(path.join(root, "scripts", "ast", "index.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/.test(source), "AST renderer should stay DOM-node based");
}

checkDomSinks();
checkClipboardHtmlGuard();
checkAstRendererGuard();

console.log("DOM sink regression checks passed.");
