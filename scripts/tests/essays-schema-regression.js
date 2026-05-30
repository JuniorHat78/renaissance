#!/usr/bin/env node
"use strict";

// Gates the data contract behind the whole site. data/essays.json drives every
// page, the feeds, the sitemap and the OG cards, so a malformed entry (missing
// title, bad slug, a published essay with no date) should fail loud and early.
// Schema-validates against schema/essays.schema.json, then adds the cross-field
// checks JSON Schema can't express (every ordered section has metadata).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");

const root = path.join(__dirname, "..", "..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "schema", "essays.schema.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "essays.json"), "utf8"));

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

const failures = [];

if (!validate(data)) {
  for (const error of validate.errors) {
    failures.push("schema " + (error.instancePath || "(root)") + " " + error.message);
  }
} else {
  console.log("PASS essays.json matches the schema");
}

// Cross-field invariants beyond the schema's reach.
for (const essay of data.essays || []) {
  const label = essay && essay.slug ? essay.slug : "(unknown)";
  const order = (essay && essay.section_order) || [];
  const meta = (essay && essay.section_meta) || {};
  for (const n of order) {
    if (!Object.prototype.hasOwnProperty.call(meta, String(n))) {
      failures.push(label + ": section_order lists " + n + " but section_meta has no entry for it");
    }
  }
  for (const key of Object.keys(meta)) {
    if (!order.includes(Number(key))) {
      failures.push(label + ": section_meta has entry " + key + " not present in section_order");
    }
  }
}
if (failures.filter((f) => /section_/.test(f)).length === 0) {
  console.log("PASS section_order and section_meta are consistent");
}

if (failures.length > 0) {
  console.error("\nessays.json schema/contract FAILED:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("essays.json schema & contract checks passed (" + (data.essays || []).length + " essays).");
