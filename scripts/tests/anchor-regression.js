#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sectionUrl(base, params) {
  const url = new URL("/section.html", base);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function openSection(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#section-content p", { timeout: 30000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("section-title");
    return title && !/loading/i.test(String(title.textContent || ""));
  }, null, { timeout: 30000 });
  await page.waitForTimeout(120);
}

async function getHighlightSnapshot(page) {
  return page.evaluate(() => {
    const marks = Array.from(document.querySelectorAll('mark[data-auto-highlight="1"]'));
    const note = document.getElementById("highlight-cap-note");
    return {
      marks: marks.map((mark) => String(mark.textContent || "").replace(/\s+/g, " ").trim()),
      note: note
        ? {
            hidden: Boolean(note.hidden),
            text: String(note.textContent || "").trim()
          }
        : null
    };
  });
}

async function runCase(name, callback, failures) {
  try {
    await callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL ${name}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();

  const failures = [];

  await runCase("q+occ highlights exactly one mark", async () => {
    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1,
      q: "sand",
      occ: 3
    });
    await openSection(page, url);
    const snapshot = await getHighlightSnapshot(page);
    assert.equal(snapshot.marks.length, 1, "Expected exactly one highlighted mark for q+occ");
    assert.match(snapshot.marks[0].toLowerCase(), /sand/, "Expected occurrence highlight to match query");
  }, failures);

  await runCase("q-only low-hit mode does not show cap note", async () => {
    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 7,
      q: "verdun"
    });
    await openSection(page, url);
    const snapshot = await getHighlightSnapshot(page);
    assert.ok(snapshot.marks.length >= 1, "Expected at least one query-only highlight");
    assert.ok(snapshot.marks.length < 160, "Expected low-hit query to stay below cap");
    assert.ok(!snapshot.note || snapshot.note.hidden, "Cap note should be hidden when not capped");
  }, failures);

  await runCase("dev highlight perf metric logs on localhost", async () => {
    const logs = [];
    const onConsole = (message) => {
      logs.push(message.text());
    };
    page.on("console", onConsole);

    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1,
      q: "sand"
    });
    await openSection(page, url);
    await page.waitForTimeout(120);

    page.off("console", onConsole);
    assert.ok(
      logs.some((line) => line.includes("[highlight-perf] anchor_query_only")),
      "Expected dev-only highlight perf metric to be logged on localhost"
    );
  }, failures);

  await runCase("q-only capped mode shows cap note", async () => {
    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1,
      q: "a"
    });
    await openSection(page, url);

    const totals = await page.evaluate(() => {
      const text = document.getElementById("section-content").textContent || "";
      const matches = window.RenaissanceSearch.findOccurrencesInText(text, "a", {
        mode: "contains",
        caseSensitive: false
      });
      return { total: matches.length };
    });
    const snapshot = await getHighlightSnapshot(page);

    assert.ok(totals.total > 160, "Expected a query with more than cap-sized match count");
    assert.equal(snapshot.marks.length, 160, "Expected q-only mode to cap highlights at 160");
    assert.ok(snapshot.note && !snapshot.note.hidden, "Expected cap note to be visible");
    assert.match(snapshot.note.text, /160/, "Cap note should include cap value");
  }, failures);

  await runCase("hl payload has precedence over q+occ", async () => {
    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1,
      hl: "first surprise",
      q: "sand",
      occ: 1
    });
    await openSection(page, url);
    const snapshot = await getHighlightSnapshot(page);
    assert.equal(snapshot.marks.length, 1, "Expected one mark when payload resolves");
    assert.match(snapshot.marks[0].toLowerCase(), /first surprise/, "Expected payload text to drive anchor");
  }, failures);

  await runCase("paragraph anchor has precedence over q+occ", async () => {
    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1,
      p: "2",
      q: "sand",
      occ: 1
    });
    await openSection(page, url);
    const snapshot = await getHighlightSnapshot(page);
    assert.equal(snapshot.marks.length, 1, "Expected one mark for paragraph anchor");
    assert.ok(snapshot.marks[0].length > 120, "Expected paragraph-level highlight, not single-term occurrence");
  }, failures);

  await runCase("range anchor has precedence over q+occ", async () => {
    const baseUrl = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1
    });
    await openSection(page, baseUrl);

    const range = await page.evaluate(() => {
      const text = document.getElementById("section-content").textContent || "";
      const needle = "first surprise";
      const start = text.toLowerCase().indexOf(needle);
      if (start < 0) {
        return null;
      }
      return {
        start,
        end: start + needle.length
      };
    });
    assert.ok(range, "Could not resolve deterministic range anchor text");

    const url = sectionUrl(options.base, {
      essay: "etching-god-into-sand",
      section: 1,
      r: `${range.start.toString(36)}-${range.end.toString(36)}`,
      q: "sand",
      occ: 1
    });
    await openSection(page, url);
    const snapshot = await getHighlightSnapshot(page);
    assert.equal(snapshot.marks.length, 1, "Expected one mark for range anchor");
    assert.match(snapshot.marks[0].toLowerCase(), /first surprise/, "Expected range anchor to win over occurrence");
  }, failures);

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error("\nAnchor regression failures:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log("\nAnchor regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
