const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const rootDir = path.join(__dirname, "..");
const rawDir = path.join(rootDir, "raw");
const outDir = path.join(rootDir, "exports");
const outPath = path.join(outDir, "etching-god-into-sand.txt");

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

function sectionFiles() {
  return fs
    .readdirSync(rawDir)
    .filter((name) => /^\d+\.txt$/i.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function loadSectionText(fileName) {
  const filePath = path.join(rawDir, fileName);
  const buffer = fs.readFileSync(filePath);
  return decodeText(buffer).replace(/\r\n/g, "\n").trimEnd();
}

function exportEssayText() {
  const files = sectionFiles();
  if (files.length === 0) {
    throw new Error("No section files found in raw/");
  }

  const sections = files.map((fileName) => loadSectionText(fileName));
  const output = sections.join("\n\n") + "\n";

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, output, "utf8");

  console.log(`Exported ${sections.length} sections to ${outPath}`);
}

exportEssayText();
