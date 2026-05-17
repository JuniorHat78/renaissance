#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const rootDir = path.join(__dirname, "..");
const scriptsDir = path.join(rootDir, "scripts");

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  const jsFiles = walk(scriptsDir).sort();
  const failures = [];

  for (const filePath of jsFiles) {
    const source = fs.readFileSync(filePath, "utf8").replace(/^#![^\n]*(\n|$)/, "");
    try {
      new vm.Script(source, { filename: filePath });
    } catch (error) {
      failures.push({
        filePath,
        output: String((error && error.stack) || error)
      });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error("Syntax check failed: " + path.relative(rootDir, failure.filePath));
      if (failure.output) {
        console.error(failure.output);
      }
    }
    process.exit(1);
  }

  console.log("JavaScript syntax check passed for " + String(jsFiles.length) + " files.");
}

main();
