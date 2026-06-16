#!/usr/bin/env node

// Pure node coverage for reading-state.js — the persistence contract, with no
// browser. reading-state.js is a window-global module, so we stand up a tiny
// localStorage shim on global.window before requiring it; the module's own
// IIFE then attaches its API to that window. This exercises the attention
// fields (attentionProgress, readParagraphs, attentionPartial) and the
// "you read it, not scrolled past it" completion rule that the browser-tier
// reading-state regression cannot assert deterministically.

const assert = require("node:assert/strict");

const store = new Map();
global.window = {
  localStorage: {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  }
};

// Loading the module attaches window.RenaissanceReadingState.
require("../reading-state.js");
const rs = global.window.RenaissanceReadingState;

const essay = { slug: "etching-god-into-sand", title: "Etching God into Sand", section_order: [1, 2, 3] };

const failures = [];

function test(name, fn) {
  store.clear();
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name);
  }
}

function save(extra) {
  return rs.saveSectionProgress(Object.assign({
    essaySlug: essay.slug,
    sectionNumber: 1,
    progress: 0.3,
    scrollY: 800,
    essayTitle: essay.title,
    sectionTitle: "The Oldest Material",
    sectionLabel: "Section I"
  }, extra));
}

test("attentionProgress persists and surfaces through continueTarget", () => {
  save({ attentionProgress: 0.42, readParagraphs: [1, 2] });
  const record = rs.getSectionRecord(essay.slug, 1);
  assert.equal(record.attentionProgress, 0.42, "record carries attentionProgress");
  assert.deepEqual(record.readParagraphs, [1, 2], "record carries the read-set");

  const target = rs.continueTarget([essay], null);
  assert.ok(target, "continue target exists");
  assert.equal(target.attentionProgress, 0.42, "continueTarget exposes attentionProgress for the archive");
  assert.equal(target.action, "continue", "an unfinished section continues");
});

test("attentionProgress is monotonic — a later lower save does not lower it", () => {
  save({ attentionProgress: 0.6, readParagraphs: [1, 2, 3] });
  save({ attentionProgress: 0.2, readParagraphs: [1] });
  const record = rs.getSectionRecord(essay.slug, 1);
  assert.equal(record.attentionProgress, 0.6, "high-water attention is retained");
  assert.deepEqual(record.readParagraphs, [1, 2, 3], "the read-set only grows (union)");
});

test("a save without attention data preserves the prior attention progress", () => {
  save({ attentionProgress: 0.5, readParagraphs: [1, 2] });
  save({ progress: 0.55 }); // e.g. a scroll-only save path
  const record = rs.getSectionRecord(essay.slug, 1);
  assert.equal(record.attentionProgress, 0.5, "missing attention does not wipe the stored value");
  assert.deepEqual(record.readParagraphs, [1, 2], "read-set survives an attention-less save");
});

test("scrolling to the end does NOT complete a section (the headline fix)", () => {
  // Scroll high-water hits the old completion threshold, but attention is low:
  // the reader scrubbed to check length. It must not read as completed.
  save({ progress: 0.96, attentionProgress: 0.25, readParagraphs: [1] });
  const record = rs.getSectionRecord(essay.slug, 1);
  assert.ok(record.maxProgress >= 0.92, "scroll high-water crossed the old threshold");
  assert.equal(record.completed, false, "low attention means not completed despite scrolling to the end");
});

test("reading the section through completes it", () => {
  save({ progress: 0.55, attentionProgress: 0.95, readParagraphs: [1, 2, 3] });
  const record = rs.getSectionRecord(essay.slug, 1);
  assert.equal(record.completed, true, "high attention completes the section");

  const target = rs.continueTarget([essay], null);
  assert.equal(target.action, "next", "a completed section advances to the next");
  assert.match(target.href, /section=2$/, "next target points at section 2");
});

test("legacy records without attention fall back to scroll-based completion", () => {
  // Simulate an old record written before the attention model existed.
  store.set("renaissance-reading-state:v1", JSON.stringify({
    version: 1,
    last: {
      essaySlug: essay.slug,
      sectionNumber: 1,
      progress: 0.94,
      maxProgress: 0.94,
      scrollY: 1200,
      updatedAt: 1700000000000
    },
    essays: {
      [essay.slug]: {
        1: {
          essaySlug: essay.slug,
          sectionNumber: 1,
          progress: 0.94,
          maxProgress: 0.94,
          scrollY: 1200,
          updatedAt: 1700000000000
        }
      }
    }
  }));
  const record = rs.getSectionRecord(essay.slug, 1);
  assert.equal(record.attentionProgress, null, "legacy record has no attention progress");
  assert.equal(record.completed, true, "legacy completion falls back to scroll high-water");
  assert.deepEqual(record.readParagraphs, [], "legacy record normalizes to an empty read-set");
});

test("attentionPartial round-trips and rejects garbage", () => {
  save({ attentionProgress: 0.3, readParagraphs: [1], attentionPartial: { index: 2, dwellMs: 4200 } });
  assert.deepEqual(rs.getSectionRecord(essay.slug, 1).attentionPartial, { index: 2, dwellMs: 4200 });

  save({ attentionProgress: 0.3, attentionPartial: { index: 0, dwellMs: -5 } });
  // Bad partial is rejected, but the previous valid one is preserved.
  assert.deepEqual(rs.getSectionRecord(essay.slug, 1).attentionPartial, { index: 2, dwellMs: 4200 },
    "an invalid incoming partial does not overwrite a good stored one");
});

if (failures.length > 0) {
  console.error("\nReading-state unit regression failures:");
  failures.forEach((failure) => console.error("- " + failure));
  process.exit(1);
}

console.log("\nReading-state unit regression checks passed.");
