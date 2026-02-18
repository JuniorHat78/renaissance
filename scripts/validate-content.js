const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const essaysPath = path.join(rootDir, "data", "essays.json");
const rawDir = path.join(rootDir, "raw");
const rawManifestPath = path.join(rawDir, "manifest.json");

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function toNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sectionFilesInDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath)
    .filter((name) => /^\d+\.txt$/i.test(name))
    .map((name) => toNumber(name))
    .filter((number) => number !== null)
    .sort((a, b) => a - b);
}

function uniqueNumbers(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const number = toNumber(value);
    if (number === null || seen.has(number)) {
      continue;
    }
    seen.add(number);
    out.push(number);
  }
  return out;
}

function validateManifest(errors) {
  if (!fs.existsSync(rawManifestPath)) {
    errors.push("Missing raw/manifest.json");
    return;
  }

  let manifest;
  try {
    manifest = readJson(rawManifestPath);
  } catch (error) {
    errors.push("Invalid JSON in raw/manifest.json");
    return;
  }

  const manifestSections = uniqueNumbers(Array.isArray(manifest.chapters) ? manifest.chapters : []);
  if (manifestSections.length === 0) {
    errors.push("raw/manifest.json has no valid chapter numbers");
    return;
  }

  const rawSections = sectionFilesInDir(rawDir);
  if (rawSections.length === 0) {
    errors.push("No section files found in raw/");
    return;
  }

  if (manifestSections.join(",") !== rawSections.join(",")) {
    errors.push(
      "raw/manifest.json chapters do not match raw/*.txt files " +
      "(manifest: " + manifestSections.join(",") + "; files: " + rawSections.join(",") + ")"
    );
  }
}

function validateEssays(errors) {
  if (!fs.existsSync(essaysPath)) {
    errors.push("Missing data/essays.json");
    return;
  }

  let parsed;
  try {
    parsed = readJson(essaysPath);
  } catch (error) {
    errors.push("Invalid JSON in data/essays.json");
    return;
  }

  const essays = parsed && Array.isArray(parsed.essays) ? parsed.essays : null;
  if (!essays || essays.length === 0) {
    errors.push("data/essays.json must contain a non-empty essays array");
    return;
  }

  const slugSeen = new Set();
  for (const essay of essays) {
    const slug = String((essay && essay.slug) || "").trim();
    if (!slug) {
      errors.push("Each essay requires a non-empty slug");
      continue;
    }

    if (slugSeen.has(slug)) {
      errors.push("Duplicate essay slug: " + slug);
    } else {
      slugSeen.add(slug);
    }

    const sourceDir = String((essay && essay.source_dir) || "").trim() || "raw";
    const sourcePath = path.join(rootDir, sourceDir);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      errors.push("Essay " + slug + " has missing source_dir: " + sourceDir);
      continue;
    }

    const sections = uniqueNumbers(Array.isArray(essay.section_order) ? essay.section_order : []);
    if (sections.length === 0) {
      errors.push("Essay " + slug + " has empty or invalid section_order");
      continue;
    }

    for (const sectionNumber of sections) {
      const filePath = path.join(sourcePath, String(sectionNumber) + ".txt");
      if (!fs.existsSync(filePath)) {
        errors.push(
          "Essay " + slug +
          " references missing section file: " + sourceDir + "/" + String(sectionNumber) + ".txt"
        );
      }
    }

    const sectionMeta = essay && essay.section_meta && typeof essay.section_meta === "object"
      ? essay.section_meta
      : {};
    for (const key of Object.keys(sectionMeta)) {
      const sectionNumber = toNumber(key);
      if (sectionNumber === null) {
        errors.push("Essay " + slug + " has non-numeric section_meta key: " + key);
        continue;
      }
      if (!sections.includes(sectionNumber)) {
        errors.push(
          "Essay " + slug +
          " has section_meta for section " + String(sectionNumber) +
          " not listed in section_order"
        );
      }
    }
  }
}

function main() {
  const errors = [];
  validateManifest(errors);
  validateEssays(errors);

  if (errors.length > 0) {
    console.error("Content validation failed:");
    for (const error of errors) {
      console.error("- " + error);
    }
    process.exit(1);
  }

  console.log("Content validation passed.");
}

main();
