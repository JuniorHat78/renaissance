#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const rootDir = path.join(__dirname, "..", "..");
const essaysPath = path.join(rootDir, "data", "essays.json");
const cardsDir = path.join(rootDir, "assets", "og-cards");
const siteLabel = "juniorhat78.github.io/renaissance";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeSummary(summary, title) {
  const cleaned = String(summary || "").replace(/\s+/g, " ").trim();
  if (cleaned) {
    return cleaned;
  }
  return "Read " + String(title || "this essay") + " on Renaissance.";
}

function imagePathForEssay(essay) {
  const explicit = String((essay && essay.social_image) || "").trim();
  if (explicit) {
    return path.join(rootDir, explicit);
  }
  const slug = String((essay && essay.slug) || "").trim();
  return path.join(rootDir, "assets", "og-" + slug + ".png");
}

function htmlPathForEssay(essay) {
  const slug = String((essay && essay.slug) || "").trim();
  return path.join(cardsDir, slug + ".html");
}

function renderCardHtml(essay) {
  const title = escapeHtml(String(essay.title || "").trim());
  const summary = escapeHtml(normalizeSummary(essay.summary, essay.title));

  return (
    "<!doctype html>\n" +
    "<html lang=\"en\">\n" +
    "<head>\n" +
    "  <meta charset=\"UTF-8\">\n" +
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "  <title>OG Card</title>\n" +
    "  <style>\n" +
    "    :root {\n" +
    "      --canvas: #efe5d6;\n" +
    "      --paper: #f8f2e7;\n" +
    "      --text: #2a2018;\n" +
    "      --muted: #6d5d4a;\n" +
    "      --line: #cdbba3;\n" +
    "      --accent: #a34f2a;\n" +
    "      --font-title: \"Garamond\", \"Palatino Linotype\", \"Book Antiqua\", serif;\n" +
    "      --font-body: \"Iowan Old Style\", \"Palatino Linotype\", \"Book Antiqua\", serif;\n" +
    "      --font-ui: \"Optima\", \"Gill Sans MT\", \"Trebuchet MS\", sans-serif;\n" +
    "    }\n" +
    "    * { box-sizing: border-box; }\n" +
    "    html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }\n" +
    "    body {\n" +
    "      background-color: var(--canvas);\n" +
    "      background-image:\n" +
    "        linear-gradient(to bottom, rgba(255, 255, 255, 0.22), transparent 220px),\n" +
    "        radial-gradient(circle at 86% -8%, rgba(163, 79, 42, 0.18), transparent 48%),\n" +
    "        radial-gradient(circle at -10% 100%, rgba(112, 81, 54, 0.14), transparent 42%);\n" +
    "      color: var(--text);\n" +
    "      font-family: var(--font-body);\n" +
    "    }\n" +
    "    .frame {\n" +
    "      position: relative;\n" +
    "      width: calc(100% - 96px);\n" +
    "      height: calc(100% - 96px);\n" +
    "      margin: 48px;\n" +
    "      padding: 58px 64px;\n" +
    "      border: 1px solid var(--line);\n" +
    "      background: color-mix(in srgb, var(--paper) 94%, transparent);\n" +
    "      display: flex;\n" +
    "      flex-direction: column;\n" +
    "      justify-content: space-between;\n" +
    "    }\n" +
    "    .kicker {\n" +
    "      margin: 0;\n" +
    "      font-family: var(--font-ui);\n" +
    "      font-size: 20px;\n" +
    "      letter-spacing: 0.08em;\n" +
    "      color: var(--muted);\n" +
    "    }\n" +
    "    h1 {\n" +
    "      margin: 18px 0 0;\n" +
    "      max-width: 10.5em;\n" +
    "      font-family: var(--font-title);\n" +
    "      font-size: 82px;\n" +
    "      line-height: 1.02;\n" +
    "      font-weight: 500;\n" +
    "      letter-spacing: 0.01em;\n" +
    "    }\n" +
    "    .dek {\n" +
    "      margin: 28px 0 0;\n" +
    "      max-width: 42ch;\n" +
    "      color: var(--muted);\n" +
    "      font-size: 30px;\n" +
    "      line-height: 1.35;\n" +
    "    }\n" +
    "    .footer {\n" +
    "      margin-top: 26px;\n" +
    "      padding-top: 18px;\n" +
    "      border-top: 1px solid var(--line);\n" +
    "      display: flex;\n" +
    "      justify-content: space-between;\n" +
    "      align-items: center;\n" +
    "      gap: 20px;\n" +
    "      font-family: var(--font-ui);\n" +
    "      color: var(--muted);\n" +
    "      font-size: 21px;\n" +
    "      letter-spacing: 0.03em;\n" +
    "    }\n" +
    "    .brand { color: var(--accent); }\n" +
    "  </style>\n" +
    "</head>\n" +
    "<body>\n" +
    "  <main class=\"frame\">\n" +
    "    <div>\n" +
    "      <p class=\"kicker\">Renaissance &middot; Essay</p>\n" +
    "      <h1>" + title + "</h1>\n" +
    "      <p class=\"dek\">" + summary + "</p>\n" +
    "    </div>\n" +
    "    <p class=\"footer\">\n" +
    "      <span class=\"brand\">" + escapeHtml(siteLabel) + "</span>\n" +
    "      <span>Read Online</span>\n" +
    "    </p>\n" +
    "  </main>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

async function generateCards(essays) {
  fs.mkdirSync(cardsDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const manifest = [];

  try {
    for (const essay of essays) {
      const slug = String((essay && essay.slug) || "").trim();
      if (!slug) {
        continue;
      }

      const html = renderCardHtml(essay);
      const htmlPath = htmlPathForEssay(essay);
      const imagePath = imagePathForEssay(essay);

      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(htmlPath, html, "utf8");
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForTimeout(80);
      await page.screenshot({ path: imagePath, fullPage: false });

      manifest.push({
        slug,
        html: path.relative(rootDir, htmlPath).replace(/\\/g, "/"),
        image: path.relative(rootDir, imagePath).replace(/\\/g, "/")
      });
      console.log("Generated OG card for " + slug + " -> " + path.relative(rootDir, imagePath));
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const manifestPath = path.join(cardsDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ cards: manifest }, null, 2) + "\n", "utf8");
  console.log("Wrote OG manifest -> " + path.relative(rootDir, manifestPath));
}

async function main() {
  const payload = readJson(essaysPath);
  const essays = payload && Array.isArray(payload.essays) ? payload.essays : [];
  if (!essays.length) {
    throw new Error("No essays found in data/essays.json");
  }

  await generateCards(essays);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
