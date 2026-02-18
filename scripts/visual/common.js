"use strict";

const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveScenarios(configPath, onlyIds) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  const payload = readJson(resolvedPath);
  const defaults = payload.defaults || {};
  const all = Array.isArray(payload.scenarios) ? payload.scenarios : [];
  const filter = new Set(splitCsv(onlyIds));

  const scenarios = all
    .filter((scenario) => !filter.size || filter.has(scenario.id))
    .map((scenario) => ({
      waitMs: defaults.waitMs || 0,
      scroll: "top",
      theme: "light",
      ...scenario
    }));

  if (!scenarios.length) {
    throw new Error("No visual scenarios resolved from " + resolvedPath);
  }

  return {
    configPath: resolvedPath,
    version: payload.version || 1,
    scenarios
  };
}

function toTargetUrl(base, route) {
  if (/^https?:\/\//i.test(route)) {
    return route;
  }
  return new URL(route, base).toString();
}

module.exports = {
  ensureDir,
  parseArgs,
  readJson,
  resolveScenarios,
  splitCsv,
  toTargetUrl
};
