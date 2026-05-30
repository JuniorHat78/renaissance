#!/usr/bin/env node
"use strict";

// Link-rot watch (WARNING-ONLY, never gates). Collects every external http(s)
// URL referenced by the committed HTML/XML/JSON and checks each is reachable.
// External targets are outside our control, so a dead link is something to
// glance at on a schedule — not a reason to fail a build. Always exits 0; it
// emits GitHub ::warning lines for anything that doesn't respond.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const TIMEOUT_MS = 12000;

function collectFiles() {
  const files = [];
  for (const entry of fs.readdirSync(root)) {
    if (/\.(html|xml)$/.test(entry)) {
      files.push(path.join(root, entry));
    }
  }
  const dataDir = path.join(root, "data");
  if (fs.existsSync(dataDir)) {
    for (const entry of fs.readdirSync(dataDir)) {
      if (entry.endsWith(".json")) {
        files.push(path.join(dataDir, entry));
      }
    }
  }
  return files;
}

function collectUrls() {
  const urls = new Map(); // url -> Set(sourceFile)
  const re = /https?:\/\/[^\s"'<>)]+/g;
  for (const file of collectFiles()) {
    const text = fs.readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(text)) !== null) {
      const url = m[0].replace(/[.,;]+$/, "");
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch (error) {
          return null;
        }
      })();
      if (!host || host === "127.0.0.1" || host === "localhost") {
        continue;
      }
      if (!urls.has(url)) {
        urls.set(url, new Set());
      }
      urls.get(url).add(path.relative(root, file));
    }
  }
  return urls;
}

async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    return { ok: response.ok || (response.status >= 200 && response.status < 400), status: response.status };
  } catch (error) {
    return { ok: false, status: error.name === "AbortError" ? "timeout" : error.code || error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const urls = collectUrls();
  console.log("Checking " + urls.size + " external URL(s)...");
  let warned = 0;
  for (const [url, sources] of urls) {
    const result = await reachable(url);
    if (result.ok) {
      console.log("OK   " + result.status + "  " + url);
    } else {
      warned += 1;
      const from = [...sources].join(", ");
      console.log("::warning title=Link rot::" + url + " -> " + result.status + " (referenced by " + from + ")");
      console.log("DEAD " + result.status + "  " + url);
    }
  }
  console.log(warned === 0 ? "All external links reachable." : warned + " external link(s) need a look (warning only).");
  // Warning-only: never fail.
  process.exit(0);
}

main().catch((error) => {
  console.error("link-check error (non-fatal): " + error.message);
  process.exit(0);
});
