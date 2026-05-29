#!/usr/bin/env node
"use strict";

// Standalone (no browser): validates the generated discoverability artifacts —
// sitemap.xml, feed.xml (Atom), rss.xml — plus robots.txt and the feed <link>
// tags in the page heads. Asserts structure, that published essays appear and
// unpublished ones don't, and that ampersands are XML-escaped.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const CANONICAL = "https://juniorhat78.github.io/renaissance/";
const PUBLISHED_SLUG = "etching-god-into-sand";
const UNPUBLISHED_SLUG = "shadows";

function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name);
  }
}

// No XML parser in core; assert no stray unescaped ampersands instead.
function assertNoRawAmpersand(xml, label) {
  const stray = xml.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/);
  assert.equal(stray, null, label + " must escape all ampersands (found a raw '&')");
}

check("sitemap.xml is well-formed and lists published URLs only", () => {
  const xml = read("sitemap.xml");
  assert.ok(xml.startsWith("<?xml"), "sitemap should start with an XML declaration");
  assert.ok(xml.includes("<urlset") && xml.includes("</urlset>"), "sitemap needs a urlset root");
  assert.ok(xml.includes(CANONICAL + "essay.html?essay=" + PUBLISHED_SLUG), "sitemap should list the published essay");
  assert.ok(xml.includes("section.html?essay=" + PUBLISHED_SLUG + "&amp;section=10"), "sitemap should list sections with escaped &");
  assert.ok(!xml.includes(UNPUBLISHED_SLUG), "sitemap must not list the unpublished essay");
  assertNoRawAmpersand(xml, "sitemap.xml");
});

check("feed.xml (Atom) is well-formed with the published entry", () => {
  const xml = read("feed.xml");
  assert.ok(xml.startsWith("<?xml"), "atom should start with an XML declaration");
  assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'), "atom needs a feed root");
  assert.ok(xml.includes("</feed>"), "atom feed must be closed");
  assert.ok(xml.includes("<entry>") && xml.includes("</entry>"), "atom should have at least one entry");
  assert.ok(xml.includes(CANONICAL + "essay.html?essay=" + PUBLISHED_SLUG), "atom entry should link the published essay");
  assert.ok(/<updated>\d{4}-\d{2}-\d{2}T/.test(xml), "atom needs an RFC3339 updated date");
  assert.ok(!xml.includes(UNPUBLISHED_SLUG), "atom must not include the unpublished essay");
  assertNoRawAmpersand(xml, "feed.xml");
});

check("rss.xml is well-formed with the published item", () => {
  const xml = read("rss.xml");
  assert.ok(xml.startsWith("<?xml"), "rss should start with an XML declaration");
  assert.ok(xml.includes('<rss version="2.0"'), "rss needs an rss root");
  assert.ok(xml.includes("</rss>"), "rss must be closed");
  assert.ok(xml.includes("<item>") && xml.includes("</item>"), "rss should have at least one item");
  assert.ok(/<pubDate>[A-Z][a-z]{2}, \d{2} /.test(xml), "rss needs an RFC822 pubDate");
  assert.ok(!xml.includes(UNPUBLISHED_SLUG), "rss must not include the unpublished essay");
  assertNoRawAmpersand(xml, "rss.xml");
});

check("robots.txt allows crawling and points at the sitemap", () => {
  const txt = read("robots.txt");
  assert.match(txt, /User-agent:\s*\*/, "robots should target all agents");
  assert.match(txt, /Allow:\s*\//, "robots should allow crawling");
  assert.ok(txt.includes("Sitemap: " + CANONICAL + "sitemap.xml"), "robots should reference the absolute sitemap URL");
});

check("every page head advertises the feeds", () => {
  for (const page of ["index.html", "essay.html", "section.html", "search.html"]) {
    const html = read(page);
    assert.ok(
      html.includes('rel="alternate"') && html.includes('href="feed.xml"'),
      page + " should advertise the Atom feed via a <link rel=alternate>"
    );
    assert.ok(html.includes('href="rss.xml"'), page + " should advertise the RSS feed");
  }
});

if (failures.length > 0) {
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}
console.log("Discoverability regression checks passed.");
