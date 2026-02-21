const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const chaptersOutPath = path.join(__dirname, "chapters-data.js");
const essaysOutPath = path.join(__dirname, "essays-data.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueNumbers(values) {
  if (!Array.isArray(values)) {
    return [];
  }

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

function loadEssays() {
  const essayJsonPath = path.join(dataDir, "essays.json");
  const parsed = readJson(essayJsonPath);
  return Array.isArray(parsed.essays) ? parsed.essays : [];
}

function escapeForTemplateLiteral(text) {
  return text.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function embeddedSectionEntries(essays) {
  const entries = [];

  for (const essay of essays) {
    const slug = String((essay && essay.slug) || "").trim();
    if (!slug) {
      continue;
    }

    const sourceDir = String((essay && essay.source_dir) || "").trim() || "raw";
    const sourcePath = path.join(rootDir, sourceDir);
    const sections = uniqueNumbers(essay && essay.section_order);

    for (const sectionNumber of sections) {
      const filePath = path.join(sourcePath, String(sectionNumber) + ".txt");
      if (!fs.existsSync(filePath)) {
        throw new Error(
          "Missing section file for embedded output: " +
          sourceDir + "/" + String(sectionNumber) + ".txt (" + slug + ")"
        );
      }

      const rawText = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
      entries.push({
        essaySlug: slug,
        sectionNumber,
        rawText
      });
    }
  }

  return entries;
}

function buildChapterOutput(entries) {
  let out = "window.RENAISSANCE_EMBEDDED_CHAPTERS = [\n";
  for (const entry of entries) {
    out +=
      "  { essaySlug: " + JSON.stringify(entry.essaySlug) +
      ", sectionNumber: " + String(entry.sectionNumber) +
      ", rawText: `" + escapeForTemplateLiteral(entry.rawText) + "` },\n";
  }
  out += "];\n";
  return out;
}

function buildEssaysOutput(essays) {
  return (
    "window.RENAISSANCE_EMBEDDED_ESSAYS = " +
    JSON.stringify(essays, null, 2) +
    ";\n"
  );
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeOutputs(essays, entries) {
  const chapterOutput = buildChapterOutput(entries);
  const essaysOutput = buildEssaysOutput(essays);
  fs.writeFileSync(chaptersOutPath, chapterOutput, "utf8");
  fs.writeFileSync(essaysOutPath, essaysOutput, "utf8");
  console.log(`Wrote ${entries.length} embedded sections to ${chaptersOutPath}`);
  console.log(`Wrote ${essays.length} essay metadata entries to ${essaysOutPath}`);
}

function checkOutputs(essays, entries) {
  const expectedChapterOutput = buildChapterOutput(entries);
  const expectedEssaysOutput = buildEssaysOutput(essays);
  const actualChapterOutput = readTextIfExists(chaptersOutPath);
  const actualEssaysOutput = readTextIfExists(essaysOutPath);

  const hasChapterDiff = actualChapterOutput !== expectedChapterOutput;
  const hasEssaysDiff = actualEssaysOutput !== expectedEssaysOutput;

  if (!hasChapterDiff && !hasEssaysDiff) {
    console.log("Embedded data files are up to date.");
    return;
  }

  if (hasChapterDiff) {
    console.error("Out of date: scripts/chapters-data.js");
  }
  if (hasEssaysDiff) {
    console.error("Out of date: scripts/essays-data.js");
  }
  console.error("Run: node scripts/generate-embedded-data.js");
  process.exit(1);
}

function main() {
  const essays = loadEssays();
  const entries = embeddedSectionEntries(essays);
  const checkMode = process.argv.includes("--check");
  if (checkMode) {
    checkOutputs(essays, entries);
    return;
  }
  writeOutputs(essays, entries);
}

main();
