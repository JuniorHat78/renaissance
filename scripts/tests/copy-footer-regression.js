#!/usr/bin/env node

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:8000",
    essay: "etching-god-into-sand",
    section: 1
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    } else if (token === "--essay" && argv[index + 1]) {
      options.essay = argv[index + 1];
      index += 1;
    } else if (token === "--section" && argv[index + 1]) {
      options.section = Number.parseInt(argv[index + 1], 10) || options.section;
      index += 1;
    }
  }

  return options;
}

function sectionUrl(base, essay, section) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", essay);
  url.searchParams.set("section", String(section));
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

// Select exactly the first `count` words of the section prose, crossing
// text-node and paragraph boundaries as needed. This gives us deterministic
// word counts to exercise each citation tier.
async function selectFirstWords(page, count) {
  await page.evaluate((n) => {
    const root = document.querySelector("#section-content");
    const paragraphs = Array.from(root.querySelectorAll("p"));
    const textNodes = [];
    paragraphs.forEach((paragraph) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.trim().length > 0) {
          textNodes.push(node);
        }
      }
    });
    if (!textNodes.length) {
      throw new Error("no prose text nodes to select");
    }

    let startNode = null;
    let startOffset = 0;
    for (const node of textNodes) {
      const idx = node.nodeValue.search(/\S/);
      if (idx !== -1) {
        startNode = node;
        startOffset = idx;
        break;
      }
    }

    let endNode = null;
    let endOffset = 0;
    let counted = 0;
    let done = false;
    for (const node of textNodes) {
      const matcher = /\S+/g;
      let match;
      while ((match = matcher.exec(node.nodeValue))) {
        counted += 1;
        if (counted === n) {
          endNode = node;
          endOffset = match.index + match[0].length;
          done = true;
          break;
        }
      }
      if (done) {
        break;
      }
    }

    if (!startNode || !endNode) {
      throw new Error("not enough words: wanted " + n + ", found " + counted);
    }

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, count);
  await page.waitForTimeout(110);
}

async function readClipboard(page) {
  return page.evaluate(async () => navigator.clipboard.readText());
}

async function clearClipboard(page) {
  await page.evaluate(async () => {
    try {
      await navigator.clipboard.writeText("__cleared__");
    } catch (_error) {
      // ignore — best-effort reset between assertions
    }
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const origin = new URL(options.base).origin;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();

  await openSection(page, sectionUrl(options.base, options.essay, options.section));

  // Tier 1 — a short fragment copies clean, with no augmentation at all.
  await clearClipboard(page);
  await selectFirstWords(page, 3);
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(150);
  const shortCopy = await readClipboard(page);
  assert.ok(
    !/section\.html/.test(shortCopy),
    "Short selection should not append a source URL"
  );
  assert.ok(
    !/\n\n—/.test(shortCopy),
    "Short selection should not append an em-dash citation"
  );

  // Tier 2 — a sentence gets the em-dash source link, but no title/section line.
  await clearClipboard(page);
  await selectFirstWords(page, 14);
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(170);
  const mediumCopy = await readClipboard(page);
  assert.match(
    mediumCopy,
    /\n\n— https?:\/\/[^\n]*section\.html\?[^\n]*$/,
    "Medium selection should append an em-dash source link"
  );
  assert.ok(
    !/,\s+Section\s+[IVXLCDM]+/.test(mediumCopy),
    "Medium selection should not include the title/section citation line"
  );

  // Tier 3 — a paragraph-length quotation gets the full title + section citation.
  await clearClipboard(page);
  await selectFirstWords(page, 48);
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(190);
  const longCopy = await readClipboard(page);
  assert.match(
    longCopy,
    /\n\n— [^\n]*,\s+Section\s+[IVXLCDM]+\n {2}https?:\/\/[^\n]*section\.html\?/,
    "Long selection should append the full title/section citation"
  );

  // Explicit link copy (Ctrl+Alt+C / chip) copies the bare deep link, no citation text.
  await clearClipboard(page);
  await selectFirstWords(page, 14);
  await page.keyboard.press("Control+Alt+C");
  await page.waitForTimeout(190);
  const linkCopy = await readClipboard(page);
  assert.match(
    linkCopy,
    /^https?:\/\/[^\s]*section\.html\?/,
    "Explicit link copy should copy the bare deep link"
  );
  assert.ok(
    !/\n\n—/.test(linkCopy),
    "Explicit link copy should not include citation text"
  );

  await context.close();
  await browser.close();
  console.log("Copy footer regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
