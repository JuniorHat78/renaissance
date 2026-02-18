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

function sectionUrl(base) {
  const url = new URL("/section.html", base);
  url.searchParams.set("essay", "etching-god-into-sand");
  url.searchParams.set("section", "1");
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

async function createSelection(page) {
  await page.evaluate(() => {
    const paragraph = document.querySelector("#section-content p");
    if (!paragraph || !paragraph.firstChild || paragraph.firstChild.nodeType !== Node.TEXT_NODE) {
      throw new Error("Unable to create deterministic selection");
    }

    const text = paragraph.firstChild.nodeValue || "";
    const start = Math.max(0, text.toLowerCase().indexOf("sand"));
    const end = Math.min(text.length, start + 18);
    const range = document.createRange();
    range.setStart(paragraph.firstChild, start);
    range.setEnd(paragraph.firstChild, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.waitForTimeout(100);
}

async function readClipboard(page) {
  return page.evaluate(async () => {
    return navigator.clipboard.readText();
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

  await openSection(page, sectionUrl(options.base));
  await createSelection(page);

  await page.keyboard.press("Control+C");
  await page.waitForTimeout(140);
  const normalCopy = await readClipboard(page);
  assert.match(normalCopy, /\[Source\]\s+https?:\/\/.+section\.html\?/, "Normal copy should append canonical source footer");

  await createSelection(page);
  await page.keyboard.press("Control+Alt+C");
  await page.waitForTimeout(180);
  const linkCopy = await readClipboard(page);
  assert.match(linkCopy, /^\[Source\]\s+https?:\/\/.+section\.html\?/, "Explicit highlight copy should use source footer format");

  await context.close();
  await browser.close();
  console.log("Copy footer regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
