#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveLighthouseEnv } = require("./resolve-lighthouse-target");

// Lighthouse drives a real Chrome via chrome-launcher, which probes standard
// install locations. CI installs Playwright's chromium (not in those paths), so
// without a hint Lighthouse finds nothing and silently produces no report. Point
// it at the chromium we already installed by exporting CHROME_PATH when unset.
function ensureChromePath() {
  if (process.env.CHROME_PATH) {
    return;
  }
  try {
    const { chromium } = require("playwright");
    const execPath = chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      process.env.CHROME_PATH = execPath;
      console.log("Using CHROME_PATH=" + execPath + " for Lighthouse.");
    }
  } catch (error) {
    console.log("::warning title=Lighthouse Chrome path::Could not resolve a Chrome binary (" + error.message + "). Lighthouse may not run.");
  }
}

function parseArgs(argv) {
  const options = {
    base: process.env.RENAISSANCE_BASE_URL || "http://127.0.0.1:4175"
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function route(base, pathname) {
  return new URL(pathname, base).toString();
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=?&+-]+$/.test(text)) {
    return text;
  }
  return '"' + text.replace(/"/g, '\\"') + '"';
}

function runLighthouse(target) {
  const args = [
    "--yes",
    "lighthouse",
    target.url,
    "--only-categories=performance,accessibility,best-practices,seo",
    "--quiet",
    "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",
    "--output=json",
    "--output-path=" + target.out
  ];

  const result = process.platform === "win32"
    ? spawnSync(["npx", ...args].map((part) => quoteWindowsArg(part)).join(" "), {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true
      })
    : spawnSync("npx", args, {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: false
      });

  if (result.status !== 0) {
    console.log(
      "::warning title=Lighthouse run failed (" + target.label + ")::Could not run Lighthouse for " + target.url
    );
  }
}

function main() {
  const options = parseArgs(process.argv);
  ensureChromePath();
  const essays = readJson(path.resolve("data", "essays.json"));
  const target = resolveLighthouseEnv(essays);

  fs.mkdirSync(".lighthouseci", { recursive: true });

  const targets = [
    {
      label: "Home",
      url: route(options.base, "/index.html"),
      out: ".lighthouseci/index.json"
    },
    {
      label: "Essay",
      url: route(options.base, "/essay.html?essay=" + encodeURIComponent(target.slug)),
      out: ".lighthouseci/essay.json"
    },
    {
      label: "Section",
      url: route(
        options.base,
        "/section.html?essay=" + encodeURIComponent(target.slug) + "&section=" + String(target.sectionNumber)
      ),
      out: ".lighthouseci/section.json"
    }
  ];

  targets.forEach(runLighthouse);

  const summary = spawnSync(process.execPath, ["scripts/lighthouse-warning-summary.js"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (summary.status !== 0) {
    process.exit(summary.status || 1);
  }
}

main();
