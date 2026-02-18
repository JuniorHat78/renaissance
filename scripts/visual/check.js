#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const { parseArgs } = require("./common");

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    cwd: process.cwd()
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function toArgs(rawArgs) {
  const args = [];
  Object.entries(rawArgs).forEach(([key, value]) => {
    if (value === false || value === undefined || value === null) {
      return;
    }
    const flag = `--${key}`;
    if (value === true) {
      args.push(flag);
      return;
    }
    args.push(flag, String(value));
  });
  return args;
}

function main() {
  const raw = parseArgs(process.argv);
  const captureArgs = {};
  const diffArgs = {};

  ["base", "scenarios", "only", "out"].forEach((key) => {
    if (raw[key] !== undefined) {
      captureArgs[key] = raw[key];
    }
  });

  ["scenarios", "only", "baseline", "current", "diff", "report", "report-md", "threshold", "warn-only"].forEach((key) => {
    if (raw[key] !== undefined) {
      diffArgs[key] = raw[key];
    }
  });

  if (captureArgs.out !== undefined && diffArgs.current === undefined) {
    diffArgs.current = captureArgs.out;
  }

  runNodeScript(path.resolve(__dirname, "capture.js"), toArgs(captureArgs));
  runNodeScript(path.resolve(__dirname, "diff.js"), toArgs(diffArgs));
}

main();
