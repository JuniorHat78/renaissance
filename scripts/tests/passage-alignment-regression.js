#!/usr/bin/env node
"use strict";

// Seatbelt for the class of bug where the generated search index and the
// rendered reader disagree about passage identity. The index supplies passage
// IDs + offsets that Spotlight/search deep links rely on; the reader renders
// withoutLeadingHeadings(ast) and labels passages from that. If the two ever
// drift (a grammar change, a render tweak, a generator using the wrong AST),
// highlight anchors land on the wrong text. This loads each section in a real
// browser and asserts the rendered data-passage-id sequence + text match the
// index exactly. Node fixtures cannot catch this — it only exists in the DOM.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..", "..");
const index = JSON.parse(fs.readFileSync(path.join(root, "data", "search-index.json"), "utf8"));

function parseArgs(argv) {
  const options = { base: "http://127.0.0.1:8000" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) {
      options.base = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function sectionUrl(base, essaySlug, sectionNumber) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", essaySlug);
  url.searchParams.set("section", String(sectionNumber));
  return url.toString();
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function renderedPassages(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("#section-content [data-passage-id]"));
    return nodes.map((node) => ({
      id: node.getAttribute("data-passage-id"),
      text: node.textContent || ""
    }));
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  const failures = [];

  for (const essay of index.essays) {
    for (const section of essay.sections) {
      const label = essay.slug + " §" + section.sectionNumber;
      try {
        await page.goto(sectionUrl(options.base, essay.slug, section.sectionNumber), { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForSelector("#section-content [data-passage-id]", { timeout: 30000 });
        const dom = await renderedPassages(page);

        assert.equal(dom.length, section.passages.length, label + ": passage count mismatch (index " + section.passages.length + ", DOM " + dom.length + ")");

        section.passages.forEach((passage, position) => {
          const rendered = dom[position];
          assert.equal(rendered.id, passage.passageId, label + ": passage #" + (position + 1) + " id mismatch (index " + passage.passageId + ", DOM " + rendered.id + ")");
          assert.equal(
            normalize(rendered.text),
            normalize(passage.text),
            label + ": text mismatch at " + passage.passageId + " — anchors would land wrong"
          );
        });

        console.log("PASS " + label + " (" + dom.length + " passages aligned)");
      } catch (error) {
        failures.push(label + ": " + error.message);
        console.error("FAIL " + label + "\n  " + error.message);
      }
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error("\nPassage alignment regression FAILED:");
    failures.forEach((failure) => console.error("  - " + failure));
    process.exit(1);
  }
  console.log("Passage alignment regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
