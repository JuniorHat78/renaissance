#!/usr/bin/env node
"use strict";

// Generates sitemap.xml, feed.xml (Atom 1.0) and rss.xml from data/essays.json,
// using the same canonical URL shape the pages declare. Deterministic output (no
// build-time "now") so a committed copy can be validated with --check, exactly
// like the embedded-data generator.

const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const dataPath = path.join(rootDir, "data", "essays.json");

const CANONICAL = "https://juniorhat78.github.io/renaissance/";
const SITE_TITLE = "Renaissance";
const SITE_SUBTITLE = "A growing log of long-form essays.";

const OUTPUTS = {
  sitemap: path.join(rootDir, "sitemap.xml"),
  atom: path.join(rootDir, "feed.xml"),
  rss: path.join(rootDir, "rss.xml")
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function publishedEssays() {
  const parsed = readJson(dataPath);
  const essays = Array.isArray(parsed.essays) ? parsed.essays : [];
  return essays.filter((essay) => essay && essay.published !== false && essay.slug);
}

function xmlEscape(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function essayUrl(slug) {
  return CANONICAL + "essay.html?essay=" + encodeURIComponent(slug);
}

function sectionUrl(slug, sectionNumber) {
  return CANONICAL + "section.html?essay=" + encodeURIComponent(slug) + "&section=" + String(sectionNumber);
}

function publishedDate(essay) {
  // Bare ISO date in the manifest; default keeps output deterministic if absent.
  const raw = String(essay.published_at || "1970-01-01").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "1970-01-01";
}

function toRfc3339(dateStr) {
  return dateStr + "T00:00:00Z";
}

function toRfc822(dateStr) {
  return new Date(dateStr + "T00:00:00Z").toUTCString();
}

function latestDate(essays) {
  return essays
    .map(publishedDate)
    .sort()
    .slice(-1)[0] || "1970-01-01";
}

function buildSitemap(essays) {
  const urls = [{ loc: CANONICAL }];
  for (const essay of essays) {
    const lastmod = publishedDate(essay);
    urls.push({ loc: essayUrl(essay.slug), lastmod });
    for (const sectionNumber of essay.section_order || []) {
      urls.push({ loc: sectionUrl(essay.slug, sectionNumber), lastmod });
    }
  }

  const body = urls
    .map((entry) => {
      const lastmod = entry.lastmod ? "    <lastmod>" + entry.lastmod + "</lastmod>\n" : "";
      return "  <url>\n    <loc>" + xmlEscape(entry.loc) + "</loc>\n" + lastmod + "  </url>";
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    body +
    "\n</urlset>\n"
  );
}

function buildAtom(essays) {
  const updated = toRfc3339(latestDate(essays));
  const entries = essays
    .map((essay) => {
      const url = essayUrl(essay.slug);
      const date = toRfc3339(publishedDate(essay));
      return (
        "  <entry>\n" +
        "    <title>" + xmlEscape(essay.title) + "</title>\n" +
        '    <link href="' + xmlEscape(url) + '"/>\n' +
        "    <id>" + xmlEscape(url) + "</id>\n" +
        "    <updated>" + date + "</updated>\n" +
        "    <published>" + date + "</published>\n" +
        "    <summary>" + xmlEscape(essay.summary || essay.title) + "</summary>\n" +
        "  </entry>"
      );
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
    "  <title>" + xmlEscape(SITE_TITLE) + "</title>\n" +
    "  <subtitle>" + xmlEscape(SITE_SUBTITLE) + "</subtitle>\n" +
    '  <link href="' + xmlEscape(CANONICAL + "feed.xml") + '" rel="self"/>\n' +
    '  <link href="' + xmlEscape(CANONICAL) + '"/>\n' +
    "  <id>" + xmlEscape(CANONICAL) + "</id>\n" +
    "  <updated>" + updated + "</updated>\n" +
    "  <author><name>" + xmlEscape(SITE_TITLE) + "</name></author>\n" +
    entries +
    "\n</feed>\n"
  );
}

function buildRss(essays) {
  const lastBuild = toRfc822(latestDate(essays));
  const items = essays
    .map((essay) => {
      const url = essayUrl(essay.slug);
      return (
        "    <item>\n" +
        "      <title>" + xmlEscape(essay.title) + "</title>\n" +
        "      <link>" + xmlEscape(url) + "</link>\n" +
        '      <guid isPermaLink="true">' + xmlEscape(url) + "</guid>\n" +
        "      <pubDate>" + toRfc822(publishedDate(essay)) + "</pubDate>\n" +
        "      <description>" + xmlEscape(essay.summary || essay.title) + "</description>\n" +
        "    </item>"
      );
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    "  <channel>\n" +
    "    <title>" + xmlEscape(SITE_TITLE) + "</title>\n" +
    "    <link>" + xmlEscape(CANONICAL) + "</link>\n" +
    "    <description>" + xmlEscape(SITE_SUBTITLE) + "</description>\n" +
    '    <atom:link href="' + xmlEscape(CANONICAL + "rss.xml") + '" rel="self" type="application/rss+xml"/>\n' +
    "    <lastBuildDate>" + lastBuild + "</lastBuildDate>\n" +
    items +
    "\n  </channel>\n</rss>\n"
  );
}

function buildAll() {
  const essays = publishedEssays();
  return {
    sitemap: buildSitemap(essays),
    atom: buildAtom(essays),
    rss: buildRss(essays)
  };
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function main() {
  const built = buildAll();
  const map = [
    [OUTPUTS.sitemap, built.sitemap, "sitemap.xml"],
    [OUTPUTS.atom, built.atom, "feed.xml"],
    [OUTPUTS.rss, built.rss, "rss.xml"]
  ];

  if (process.argv.includes("--check")) {
    let stale = false;
    for (const [filePath, expected, label] of map) {
      if (readTextIfExists(filePath) !== expected) {
        console.error("Out of date: " + label);
        stale = true;
      }
    }
    if (stale) {
      console.error("Run: node scripts/generate-discoverability.js");
      process.exit(1);
    }
    console.log("Discoverability files (sitemap/feed/rss) are up to date.");
    return;
  }

  for (const [filePath, content, label] of map) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log("Wrote " + label);
  }
}

main();
