"use strict";

// Shared browser selection for the Playwright tests. The engine is chosen via
// the RENAISSANCE_BROWSER env var (chromium | firefox | webkit), defaulting to
// chromium. This lets the CI matrix run the same engine-safe suites (subpath,
// 404, core journey) across all three engines without per-test edits.

const playwright = require("playwright");

function resolveBrowserName() {
  const name = String(process.env.RENAISSANCE_BROWSER || "chromium").toLowerCase();
  return ["chromium", "firefox", "webkit"].includes(name) ? name : "chromium";
}

function browserType() {
  return playwright[resolveBrowserName()];
}

module.exports = { resolveBrowserName, browserType };
