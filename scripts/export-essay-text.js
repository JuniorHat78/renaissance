const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const rootDir = path.join(__dirname, "..");
const essaysPath = path.join(rootDir, "data", "essays.json");
const outDir = path.join(rootDir, "exports");

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const windows1252Decoder = new TextDecoder("windows-1252", { fatal: false });

function encodingQualityScore(text) {
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const mojibakeCount = (text.match(/(?:\u00C3.|\u00C2.|\u00E2.)/g) || []).length;
  return -((replacementCount * 4) + mojibakeCount);
}

function decodeText(buffer) {
  const utf8 = utf8Decoder.decode(buffer);
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }

  const windows1252 = windows1252Decoder.decode(buffer);
  return encodingQualityScore(windows1252) > encodingQualityScore(utf8)
    ? windows1252
    : utf8;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toSectionNumber(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueSectionNumbers(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const number = toSectionNumber(value);
    if (number === null || seen.has(number)) {
      continue;
    }
    seen.add(number);
    out.push(number);
  }
  return out;
}

function sectionFilesInDir(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  return fs
    .readdirSync(sourcePath)
    .filter((name) => /^\d+\.txt$/i.test(name))
    .map((name) => toSectionNumber(name))
    .filter((number) => number !== null)
    .sort((a, b) => a - b);
}

function loadSectionText(filePath) {
  const buffer = fs.readFileSync(filePath);
  return decodeText(buffer).replace(/\r\n/g, "\n").trimEnd();
}

function loadEssays() {
  const payload = readJson(essaysPath);
  if (!payload || !Array.isArray(payload.essays)) {
    throw new Error("Invalid essays metadata in data/essays.json");
  }

  return payload.essays;
}

function exportEssay(essay) {
  const slug = String((essay && essay.slug) || "").trim();
  if (!slug) {
    throw new Error("Encountered essay without slug in data/essays.json");
  }

  const sourceDir = String((essay && essay.source_dir) || "").trim();
  if (!sourceDir) {
    throw new Error("Essay " + slug + " is missing source_dir");
  }

  const sourcePath = path.join(rootDir, sourceDir);
  if (!fs.existsSync(sourcePath)) {
    throw new Error("Essay " + slug + " source_dir not found: " + sourceDir);
  }

  let sections = uniqueSectionNumbers(Array.isArray(essay.section_order) ? essay.section_order : []);
  if (sections.length === 0) {
    sections = sectionFilesInDir(sourcePath);
  }

  if (sections.length === 0) {
    throw new Error("No section files found for essay " + slug + " in " + sourceDir);
  }

  const sectionTexts = sections.map((sectionNumber) => {
    const filePath = path.join(sourcePath, String(sectionNumber) + ".txt");
    if (!fs.existsSync(filePath)) {
      throw new Error("Missing section file for essay " + slug + ": " + sourceDir + "/" + String(sectionNumber) + ".txt");
    }
    return loadSectionText(filePath);
  });

  const output = sectionTexts.join("\n\n") + "\n";
  const outPath = path.join(outDir, slug + ".txt");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, output, "utf8");

  console.log(`Exported ${sectionTexts.length} sections to ${outPath}`);
}

function exportEssayText() {
  const essays = loadEssays();
  if (essays.length === 0) {
    throw new Error("No essays found in data/essays.json");
  }

  essays.forEach((essay) => exportEssay(essay));
}

exportEssayText();
