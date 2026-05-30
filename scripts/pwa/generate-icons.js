#!/usr/bin/env node
"use strict";

// Rasterizes assets/icon.svg into the PNG sizes a PWA install + favicons need.
// Mirrors the OG-card approach (headless screenshot). Run once and commit the
// PNGs; they are not regenerated in CI. Maskable/apple/favicon render on a solid
// tile so platform masks and tiny favicons have full edge coverage; the "any"
// 192/512 keep the rounded transparent corners.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const rootDir = path.join(__dirname, "..", "..");
const svgPath = path.join(rootDir, "assets", "icon.svg");
const outDir = path.join(rootDir, "assets", "icons");
const SOLID_BG = "#8f4322";

const TARGETS = [
  { file: "icon-192.png", size: 192, solid: false },
  { file: "icon-512.png", size: 512, solid: false },
  { file: "icon-maskable-512.png", size: 512, solid: true },
  { file: "apple-touch-icon.png", size: 180, solid: true },
  { file: "favicon-32.png", size: 32, solid: true }
];

function pageHtml(svg, size, solid) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    .stage{width:${size}px;height:${size}px;${solid ? "background:" + SOLID_BG + ";" : ""}display:flex}
    .stage svg{width:100%;height:100%;display:block}
  </style></head><body><div class="stage">${svg}</div></body></html>`;
}

async function main() {
  const svg = fs.readFileSync(svgPath, "utf8");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const target of TARGETS) {
    const context = await browser.newContext({
      viewport: { width: target.size, height: target.size },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    await page.setContent(pageHtml(svg, target.size, target.solid), { waitUntil: "networkidle" });
    const el = await page.$(".stage");
    await el.screenshot({
      path: path.join(outDir, target.file),
      omitBackground: !target.solid
    });
    console.log("wrote assets/icons/" + target.file + " (" + target.size + "px)");
    await context.close();
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
