#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeAssetPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function toNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueNumbers(values) {
  const seen = new Set();
  const out = [];
  if (!Array.isArray(values)) {
    return out;
  }
  for (const value of values) {
    const number = toNumber(value);
    if (number === null || seen.has(number)) {
      continue;
    }
    seen.add(number);
    out.push(number);
  }
  return out;
}

function loadEssays() {
  const payload = readJson(path.join(root, "data", "essays.json"));
  return Array.isArray(payload.essays) ? payload.essays : [];
}

function sectionMeta(essay, sectionNumber) {
  const meta = essay && essay.section_meta && typeof essay.section_meta === "object"
    ? essay.section_meta[String(sectionNumber)]
    : null;
  return meta && typeof meta === "object" ? meta : {};
}

function sectionEntries(essay) {
  return uniqueNumbers(essay && essay.section_order).map((sectionNumber) => {
    const meta = sectionMeta(essay, sectionNumber);
    return {
      number: sectionNumber,
      title: String(meta.title || "Section " + String(sectionNumber)),
      subtitle: meta.subtitle ? String(meta.subtitle) : ""
    };
  });
}

function publishedEssays(essays) {
  return essays.filter((essay) => essay && essay.published !== false && essay.slug);
}

function essayRoute(slug) {
  return "essay.html?essay=" + encodeURIComponent(slug);
}

function sectionRoute(slug, sectionNumber) {
  return essayRoute(slug).replace("essay.html", "section.html") + "&section=" + String(sectionNumber);
}

function recoveryCatalogue(essays) {
  return {
    version: 1,
    essays: publishedEssays(essays).map((essay) => ({
      slug: String(essay.slug),
      title: String(essay.title || essay.slug),
      summary: String(essay.summary || ""),
      route: essayRoute(essay.slug),
      sections: sectionEntries(essay).map((section) => ({
        number: section.number,
        title: section.title,
        subtitle: section.subtitle,
        route: sectionRoute(essay.slug, section.number)
      }))
    }))
  };
}

function routeRegistry(essays) {
  const routes = [
    { kind: "shell", path: "./", title: "Renaissance" },
    { kind: "shell", path: "index.html", title: "Renaissance" },
    { kind: "shell", path: "search.html", title: "Search" },
    { kind: "shell", path: "404.html", title: "Page not found" },
    { kind: "feed", path: "feed.xml", title: "Atom feed" },
    { kind: "feed", path: "rss.xml", title: "RSS feed" },
    { kind: "sitemap", path: "sitemap.xml", title: "Sitemap" },
    { kind: "metadata", path: "robots.txt", title: "Robots" },
    { kind: "metadata", path: "site.webmanifest", title: "Web manifest" }
  ];

  for (const essay of publishedEssays(essays)) {
    const slug = String(essay.slug);
    routes.push({
      kind: "essay",
      path: essayRoute(slug),
      essay: slug,
      title: String(essay.title || slug)
    });
    for (const section of sectionEntries(essay)) {
      routes.push({
        kind: "section",
        path: sectionRoute(slug, section.number),
        essay: slug,
        section: section.number,
        title: section.title
      });
    }
  }

  return {
    version: 1,
    routes: routes.sort((a, b) => a.path.localeCompare(b.path)),
    recovery: recoveryCatalogue(essays),
    stats: {
      essays: publishedEssays(essays).length,
      sections: publishedEssays(essays).reduce((count, essay) => count + sectionEntries(essay).length, 0),
      routes: routes.length
    }
  };
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

module.exports = {
  root,
  readJson,
  normalizeAssetPath,
  toNumber,
  uniqueNumbers,
  loadEssays,
  sectionEntries,
  publishedEssays,
  essayRoute,
  sectionRoute,
  recoveryCatalogue,
  routeRegistry,
  stableJson
};
