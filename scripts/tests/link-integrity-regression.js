#!/usr/bin/env node
"use strict";

// Static link & path-case integrity. For every href/src in every HTML page:
//  - local file references must resolve on disk with EXACT case. GitHub Pages
//    serves from a case-sensitive Linux filesystem, so a `Styles/site.css` typo
//    404s only in production; on case-insensitive macOS/Windows it "works".
//    We walk each path segment against the real directory listing to catch it.
//  - in-page (#id) and cross-page (page.html#id) anchors must point at an id
//    (or name) that actually exists in the target document.
//  - external/mailto/tel/data/javascript and bare "#" are out of scope.
//
// Router-generated links (essay.html?essay=...) are produced by JS at runtime
// and are covered by the browser subpath/journey suites, not here.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const htmlFiles = fs.readdirSync(root).filter((f) => f.endsWith(".html"));

const failures = [];
function fail(message) {
  failures.push(message);
}

// Cache of directory listings for exact-case resolution.
const dirCache = new Map();
function listDir(absDir) {
  if (!dirCache.has(absDir)) {
    try {
      dirCache.set(absDir, new Set(fs.readdirSync(absDir)));
    } catch (error) {
      dirCache.set(absDir, null);
    }
  }
  return dirCache.get(absDir);
}

// Returns true only if every segment of relPath exists with exact case.
function existsExactCase(relPath) {
  const segments = relPath.split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const entries = listDir(current);
    if (!entries || !entries.has(segment)) {
      return false;
    }
    current = path.join(current, segment);
  }
  return true;
}

function idsIn(html) {
  const ids = new Set();
  const re = /\b(?:id|name)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

const htmlCache = new Map();
function readHtml(file) {
  if (!htmlCache.has(file)) {
    htmlCache.set(file, fs.readFileSync(path.join(root, file), "utf8"));
  }
  return htmlCache.get(file);
}

function refs(html) {
  const out = [];
  const re = /\b(?:href|src)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out;
}

const SKIP = /^(https?:|mailto:|tel:|data:|javascript:|#$)/i;

for (const page of htmlFiles) {
  const html = readHtml(page);
  for (const ref of refs(html)) {
    if (SKIP.test(ref) || ref === "#" || ref === "") {
      continue;
    }

    // Split off query and fragment.
    const hashIndex = ref.indexOf("#");
    const fragment = hashIndex >= 0 ? ref.slice(hashIndex + 1) : null;
    let filePart = hashIndex >= 0 ? ref.slice(0, hashIndex) : ref;
    filePart = filePart.split("?")[0];

    if (filePart === "") {
      // Pure in-page anchor (#id): target must exist in this page.
      if (fragment) {
        const ids = idsIn(html);
        if (!ids.has(fragment)) {
          fail(page + ': in-page anchor "#' + fragment + '" has no matching id');
        }
      }
      continue;
    }

    // Local file reference: must resolve on disk with exact case.
    if (!existsExactCase(filePart)) {
      fail(page + ': reference "' + ref + '" does not resolve on disk with exact case');
      continue;
    }

    // Cross-page anchor: target id must exist in the referenced HTML.
    if (fragment && filePart.endsWith(".html")) {
      const targetIds = idsIn(readHtml(filePart));
      if (!targetIds.has(fragment)) {
        fail(page + ': anchor "' + ref + '" points at an id not present in ' + filePart);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Link / path-case integrity FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("Link & path-case integrity checks passed (" + htmlFiles.length + " pages).");
