#!/usr/bin/env node
"use strict";

// Scriptorium project doctor — makes prose/metadata drift detectable.
//
// Scriptorium (docs/specs/SCRIPTORIUM.md) is the local authoring tool. Its whole
// reason for existing is to make the drifted state *unrepresentable*: the prose
// (raw/<slug>/<n>.txt) is the truth, but data/essays.json's section_order and
// section_meta are hand-maintained alongside it and rot — add 11.txt but forget
// 11 in section_order; rename a section in the prose but leave the stale title.
//
// This module is the §3 doctor: it refuses to bless a state where section_order,
// the files on disk, section_meta keys, and the raw manifest disagree. It also
// enforces the §6 quarantine — the one-way dependency rule that the shipped site
// must never import scriptorium.
//
// Zero dependencies. Built-ins only (fs, path). Mirrors the reporting tone of
// scripts/ast-tools/doctor.js and scripts/tests/essays-schema-regression.js.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPTORIUM_DIR = __dirname;

// A section file is "<n>.txt" for a positive integer n, no leading zeros.
const SECTION_FILE_RE = /^([1-9][0-9]*)\.txt$/;
const SLUG_RE = /^[a-z0-9-]+$/;
// Quarantine: any reference to the scriptorium folder, either slash style.
const SCRIPTORIUM_REF_RE = /scriptorium[\\/]/;

const SEVERITY = { CRITICAL: "critical", ERROR: "error", WARNING: "warning" };
const FAILING_SEVERITIES = new Set([SEVERITY.CRITICAL, SEVERITY.ERROR]);

// Severity print order + glyphs for the CLI report.
const SEVERITY_ORDER = [SEVERITY.CRITICAL, SEVERITY.ERROR, SEVERITY.WARNING];
const SEVERITY_GLYPH = {
  [SEVERITY.CRITICAL]: "✗",
  [SEVERITY.ERROR]: "✗",
  [SEVERITY.WARNING]: "!",
};

// ---------------------------------------------------------------------------
// small fs/path helpers — defensive, fail-loud only on truly broken state
// ---------------------------------------------------------------------------

function fromRoot() {
  return path.join(ROOT, ...Array.from(arguments));
}

function relativeToRoot(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, "/");
}

function readText(absPath) {
  return fs.readFileSync(absPath, "utf8");
}

function isDir(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch (_) {
    return false;
  }
}

function listDir(absPath) {
  try {
    return fs.readdirSync(absPath);
  } catch (_) {
    return [];
  }
}

// Recursively list *.js files under a dir, skipping any excluded absolute dirs.
function listJsFiles(absDir, excludedDirs) {
  const out = [];
  walk(absDir);
  return out;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirs.some((ex) => isSamePath(abs, ex))) continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(abs);
      }
    }
  }
}

function isSamePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

// ---------------------------------------------------------------------------
// issue collector
// ---------------------------------------------------------------------------

function createIssues() {
  const issues = [];
  return {
    issues,
    add(severity, code, message) {
      issues.push({ severity, code, message });
    },
  };
}

// ---------------------------------------------------------------------------
// DRIFT checks (spec §3) — prose vs. essays.json metadata
// ---------------------------------------------------------------------------

// Load and parse data/essays.json. A missing or malformed file is a hard,
// fail-loud error: every check downstream depends on it, so we stop here.
function loadEssays(collector) {
  const essaysPath = fromRoot("data", "essays.json");
  if (!isFile(essaysPath)) {
    collector.add(
      SEVERITY.ERROR,
      "essays-missing",
      "data/essays.json does not exist — nothing to check against."
    );
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(essaysPath));
  } catch (error) {
    collector.add(
      SEVERITY.ERROR,
      "essays-unparseable",
      "data/essays.json is not valid JSON: " + error.message
    );
    return null;
  }
  if (!parsed || !Array.isArray(parsed.essays)) {
    collector.add(
      SEVERITY.ERROR,
      "essays-shape",
      "data/essays.json has no \"essays\" array."
    );
    return null;
  }
  return parsed.essays;
}

// Slug sanity + required fields for one essay. Returns false when the entry is
// too broken to run the file/order/meta drift checks against.
function checkEssayShape(essay, index, collector) {
  const label = essay && essay.slug ? essay.slug : "essays[" + index + "]";

  if (!essay || typeof essay !== "object") {
    collector.add(
      SEVERITY.ERROR,
      "essay-shape",
      label + ": essay entry is not an object."
    );
    return false;
  }

  let usable = true;

  // Required fields the rest of the pipeline (and these checks) assume.
  for (const field of ["id", "slug", "title", "source_dir"]) {
    if (typeof essay[field] !== "string" || essay[field].trim() === "") {
      collector.add(
        SEVERITY.ERROR,
        "essay-missing-field",
        label + ": required field \"" + field + "\" is missing or empty."
      );
      if (field === "slug" || field === "source_dir") usable = false;
    }
  }

  if (typeof essay.slug === "string" && !SLUG_RE.test(essay.slug)) {
    collector.add(
      SEVERITY.ERROR,
      "slug-invalid",
      label + ": slug \"" + essay.slug + "\" is not a valid slug (^[a-z0-9-]+$)."
    );
  }

  if (!Array.isArray(essay.section_order)) {
    collector.add(
      SEVERITY.ERROR,
      "section-order-missing",
      label + ": section_order is missing or not an array."
    );
    usable = false;
  }

  if (!essay.section_meta || typeof essay.section_meta !== "object" || Array.isArray(essay.section_meta)) {
    collector.add(
      SEVERITY.ERROR,
      "section-meta-missing",
      label + ": section_meta is missing or not an object."
    );
    usable = false;
  }

  return usable;
}

// The core drift check for one (already shape-validated) essay: section_order
// vs files on disk vs section_meta keys vs the raw manifest.
function checkEssayDrift(essay, collector) {
  const label = essay.slug;
  // Prefer the declared source_dir; fall back to raw/<slug> if absent.
  const sourceDirRel = typeof essay.source_dir === "string" && essay.source_dir
    ? essay.source_dir
    : path.posix.join("raw", essay.slug);
  const sourceDirAbs = fromRoot(...sourceDirRel.split(/[\\/]/));

  if (!isDir(sourceDirAbs)) {
    collector.add(
      SEVERITY.ERROR,
      "source-dir-missing",
      label + ": source directory " + sourceDirRel + " does not exist on disk."
    );
    return;
  }

  // Normalize section_order to a clean integer list, flagging junk entries.
  const order = [];
  const seenInOrder = new Set();
  for (const raw of essay.section_order) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      collector.add(
        SEVERITY.ERROR,
        "section-order-invalid",
        label + ": section_order entry " + JSON.stringify(raw) + " is not a positive integer."
      );
      continue;
    }
    if (seenInOrder.has(n)) {
      collector.add(
        SEVERITY.ERROR,
        "section-order-duplicate",
        label + ": section_order lists section " + n + " more than once."
      );
      continue;
    }
    seenInOrder.add(n);
    order.push(n);
  }

  // Section files actually present on disk.
  const filesOnDisk = new Set();
  for (const name of listDir(sourceDirAbs)) {
    const match = SECTION_FILE_RE.exec(name);
    if (match) filesOnDisk.add(Number(match[1]));
  }

  // 1. Every ordered section must have its <n>.txt on disk.
  for (const n of order) {
    if (!filesOnDisk.has(n)) {
      collector.add(
        SEVERITY.ERROR,
        "missing-section-file",
        label + ": section_order lists " + n + " but " + sourceDirRel + "/" + n + ".txt is missing."
      );
    }
  }

  // 2. Every <n>.txt on disk must appear in section_order (no orphan files).
  for (const n of filesOnDisk) {
    if (!seenInOrder.has(n)) {
      collector.add(
        SEVERITY.ERROR,
        "orphan-section-file",
        label + ": " + sourceDirRel + "/" + n + ".txt exists on disk but is not in section_order."
      );
    }
  }

  // 3. Every section_meta key must be a section that exists in section_order.
  const meta = essay.section_meta || {};
  for (const key of Object.keys(meta)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n <= 0) {
      collector.add(
        SEVERITY.ERROR,
        "orphan-section-meta",
        label + ": section_meta key \"" + key + "\" is not a valid section number."
      );
      continue;
    }
    if (!seenInOrder.has(n)) {
      collector.add(
        SEVERITY.ERROR,
        "orphan-section-meta",
        label + ": section_meta has entry \"" + key + "\" not present in section_order."
      );
    }
  }

  // 4. If a manifest exists, its chapters must agree with section_order.
  checkManifest(label, sourceDirRel, sourceDirAbs, order, collector);
}

// raw/<slug>/manifest.json (when present) carries a `chapters` array that must
// be the same set, in the same order, as section_order.
function checkManifest(label, sourceDirRel, sourceDirAbs, order, collector) {
  const manifestAbs = path.join(sourceDirAbs, "manifest.json");
  if (!isFile(manifestAbs)) return; // manifest is optional

  const manifestRel = sourceDirRel + "/manifest.json";
  let manifest;
  try {
    manifest = JSON.parse(readText(manifestAbs));
  } catch (error) {
    collector.add(
      SEVERITY.ERROR,
      "manifest-unparseable",
      label + ": " + manifestRel + " is not valid JSON: " + error.message
    );
    return;
  }

  if (!manifest || !Array.isArray(manifest.chapters)) {
    collector.add(
      SEVERITY.ERROR,
      "manifest-shape",
      label + ": " + manifestRel + " has no \"chapters\" array."
    );
    return;
  }

  const chapters = manifest.chapters.map((c) => Number(c));
  const sameLength = chapters.length === order.length;
  const sameSequence = sameLength && chapters.every((c, i) => c === order[i]);
  if (!sameSequence) {
    collector.add(
      SEVERITY.ERROR,
      "manifest-mismatch",
      label +
        ": " +
        manifestRel +
        " chapters [" +
        chapters.join(", ") +
        "] disagree with section_order [" +
        order.join(", ") +
        "]."
    );
  }
}

// Slugs must be unique across essays. The compiler writes data/compiled/<slug>.json
// keyed by slug, so two essays sharing a slug collide: the compiler is last-wins,
// the reader is first-wins, and the two disagree forever (SCRIPTORIUM.md §12
// blocker 3). The server refuses an ambiguous slug at request time; this catches
// the same drift statically, before a build ever runs.
function checkSlugUniqueness(essays, collector) {
  const firstIndexBySlug = new Map();
  essays.forEach((essay, index) => {
    const slug = essay && typeof essay.slug === "string" ? essay.slug.trim() : "";
    if (!slug) return; // a missing/empty slug is already flagged by checkEssayShape
    if (firstIndexBySlug.has(slug)) {
      collector.add(
        SEVERITY.ERROR,
        "slug-duplicate",
        "slug \"" + slug + "\" is used by more than one essay (essays[" +
          firstIndexBySlug.get(slug) + "] and essays[" + index + "]) — slugs must " +
          "be unique; duplicates collide on data/compiled/" + slug + ".json " +
          "(compiler last-wins, reader first-wins → guaranteed divergence)."
      );
    } else {
      firstIndexBySlug.set(slug, index);
    }
  });
}

function runDriftChecks(collector) {
  const essays = loadEssays(collector);
  if (!essays) return;
  checkSlugUniqueness(essays, collector);
  essays.forEach((essay, index) => {
    const usable = checkEssayShape(essay, index, collector);
    if (usable) checkEssayDrift(essay, collector);
  });
}

// ---------------------------------------------------------------------------
// QUARANTINE check (spec §6) — the site must never import scriptorium
// ---------------------------------------------------------------------------

// Collect the site-source files in scope: top-level *.html and scripts/**/*.js,
// excluding scripts/tests/ and the scriptorium/ dir itself.
function siteSourceFiles() {
  const files = [];

  for (const name of listDir(ROOT)) {
    if (name.endsWith(".html")) {
      const abs = fromRoot(name);
      if (isFile(abs)) files.push(abs);
    }
  }

  const scriptsDir = fromRoot("scripts");
  const excluded = [fromRoot("scripts", "tests"), SCRIPTORIUM_DIR];
  files.push(...listJsFiles(scriptsDir, excluded));

  return files;
}

// Any reference to scriptorium/ (require/import/fetch/src/string) from a shipped
// site source file is a CRITICAL quarantine breach. We report file + line.
function runQuarantineCheck(collector) {
  for (const abs of siteSourceFiles()) {
    let source;
    try {
      source = readText(abs);
    } catch (_) {
      continue;
    }
    const rel = relativeToRoot(abs);
    const lines = source.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (SCRIPTORIUM_REF_RE.test(line)) {
        collector.add(
          SEVERITY.CRITICAL,
          "quarantine-breach",
          rel + ":" + (i + 1) + " references scriptorium/ — the shipped site must never import scriptorium (spec §6): " + line.trim()
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// runDoctor() -> { ok, issues: [{ severity, code, message }] }
// ok is false when any issue is severity 'critical' or 'error'.
function runDoctor() {
  const collector = createIssues();
  runDriftChecks(collector);
  runQuarantineCheck(collector);
  const ok = !collector.issues.some((issue) => FAILING_SEVERITIES.has(issue.severity));
  return { ok, issues: collector.issues };
}

// ---------------------------------------------------------------------------
// CLI mode
// ---------------------------------------------------------------------------

// The named checks, in report order, so a clean run prints one ✓ line each.
const CHECK_CODES = {
  drift: [
    "essays-missing",
    "essays-unparseable",
    "essays-shape",
    "essay-shape",
    "essay-missing-field",
    "slug-invalid",
    "slug-duplicate",
    "section-order-missing",
    "section-meta-missing",
    "source-dir-missing",
    "section-order-invalid",
    "section-order-duplicate",
    "missing-section-file",
    "orphan-section-file",
    "orphan-section-meta",
    "manifest-unparseable",
    "manifest-shape",
    "manifest-mismatch",
  ],
  quarantine: ["quarantine-breach"],
};

function report(result) {
  const { ok, issues } = result;
  console.log("Scriptorium project doctor");
  console.log("==========================\n");

  // Per-check ✓ when that group is clean.
  printCheckStatus("prose/metadata drift (spec §3)", CHECK_CODES.drift, issues);
  printCheckStatus("quarantine: site does not import scriptorium (spec §6)", CHECK_CODES.quarantine, issues);

  if (issues.length === 0) {
    console.log("\nAll checks clean.");
    return;
  }

  // Group the issues we did find by severity.
  console.log("");
  for (const severity of SEVERITY_ORDER) {
    const group = issues.filter((issue) => issue.severity === severity);
    if (group.length === 0) continue;
    console.log(severity.toUpperCase() + " (" + group.length + "):");
    for (const issue of group) {
      console.log("  " + SEVERITY_GLYPH[severity] + " [" + issue.code + "] " + issue.message);
    }
    console.log("");
  }

  console.log(ok ? "Doctor passed (warnings only)." : "Doctor FAILED.");
}

function printCheckStatus(name, codes, issues) {
  const codeSet = new Set(codes);
  const hits = issues.filter((issue) => codeSet.has(issue.code));
  if (hits.length === 0) {
    console.log("✓ " + name);
  } else {
    console.log("✗ " + name + " (" + hits.length + " issue" + (hits.length === 1 ? "" : "s") + ")");
  }
}

if (require.main === module) {
  const result = runDoctor();
  report(result);
  const failing = result.issues.some((issue) => FAILING_SEVERITIES.has(issue.severity));
  process.exit(failing ? 1 : 0);
}

module.exports = { runDoctor, checkSlugUniqueness };
