#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const forwardedArgs = process.argv.slice(2);
  run(path.resolve(__dirname, "chapter-redirect-regression.js"), forwardedArgs);
  run(path.resolve(__dirname, "anchor-regression.js"), forwardedArgs);
  run(path.resolve(__dirname, "copy-footer-regression.js"), forwardedArgs);
}

main();
