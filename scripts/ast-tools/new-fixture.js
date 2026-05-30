#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const fixtures = require("./lib/fixtures");
const files = require("./lib/files");

const name = String(process.argv[2] || "").trim();
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error("Usage: node scripts/ast-tools/new-fixture.js my-fixture-name");
  console.error("Fixture names must use lowercase letters, numbers, and hyphens.");
  process.exit(1);
}

const dir = fixtures.fixtureDir(name);
const inputPath = fixtures.fixtureInputPath(name);

if (files.exists(dir)) {
  console.error("Fixture already exists: " + files.relative(dir));
  process.exit(1);
}

files.ensureDir(dir);
files.writeText(inputPath, "# " + name.replace(/-/g, " ") + "\n\nWrite the focused fixture here.\n");
files.writeText(path.join(dir, "README.md"), "# " + name + "\n\nDescribe the parser behavior this fixture protects.\n");

const manifestPath = fixtures.manifestPath();
const manifest = fixtures.loadManifest();
manifest.fixtures.push({ name, purpose: "TODO" });
manifest.fixtures.sort((a, b) => a.name.localeCompare(b.name));
files.writeJson(manifestPath, manifest);

const scriptPath = files.fromRoot("scripts", "ast-tools", "update-fixtures.js");
require(scriptPath);

console.log("Created " + files.relative(dir));
if (!fs.existsSync(inputPath)) {
  console.error("Failed to create " + files.relative(inputPath));
  process.exit(1);
}
