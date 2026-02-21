const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const essaysPath = path.join(rootDir, "data", "essays.json");

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

function numberSetKey(values) {
  return Array.from(new Set(values))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
    .join(",");
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

function sourceManifestSections(sourcePath, slug, sourceDir, errors) {
  const manifestPath = path.join(sourcePath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push("Essay " + slug + " is missing manifest: " + sourceDir + "/manifest.json");
    return [];
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    errors.push("Essay " + slug + " has invalid JSON in " + sourceDir + "/manifest.json");
    return [];
  }

  const sections = uniqueNumbers(Array.isArray(manifest.chapters) ? manifest.chapters : []);
  if (sections.length === 0) {
    errors.push("Essay " + slug + " has no valid chapter numbers in " + sourceDir + "/manifest.json");
    return [];
  }
  return sections;
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

    if (Object.prototype.hasOwnProperty.call(essay || {}, "social_image")) {
      if (typeof essay.social_image !== "string") {
        errors.push("Essay " + slug + " has non-string social_image");
      } else if (!String(essay.social_image).trim()) {
        errors.push("Essay " + slug + " has empty social_image");
      }
    }

    const sectionFiles = sectionFilesInDir(sourcePath);
    if (sectionFiles.length === 0) {
      errors.push("Essay " + slug + " has no section files in source_dir: " + sourceDir);
      continue;
    }

    if (numberSetKey(sectionFiles) !== numberSetKey(sections)) {
      errors.push(
        "Essay " + slug +
        " section_order does not match section files in " + sourceDir +
        " (section_order: " + sections.join(",") + "; files: " + sectionFiles.join(",") + ")"
      );
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

    const manifestSections = sourceManifestSections(sourcePath, slug, sourceDir, errors);
    if (manifestSections.length > 0 && numberSetKey(manifestSections) !== numberSetKey(sections)) {
      errors.push(
        "Essay " + slug +
        " manifest chapters do not match section_order " +
        "(manifest: " + manifestSections.join(",") + "; section_order: " + sections.join(",") + ")"
      );
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

    const display = essay && essay.display && typeof essay.display === "object"
      ? essay.display
      : null;
    if (display && Object.prototype.hasOwnProperty.call(display, "show_subtitles")) {
      if (typeof display.show_subtitles !== "boolean") {
        errors.push("Essay " + slug + " has non-boolean display.show_subtitles");
      }
    }
  }
}

function main() {
  const errors = [];
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
