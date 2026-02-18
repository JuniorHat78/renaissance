const fs = require("fs");
const path = require("path");

const rawDir = path.join(__dirname, "..", "raw");
const dataDir = path.join(__dirname, "..", "data");
const chaptersOutPath = path.join(__dirname, "chapters-data.js");
const essaysOutPath = path.join(__dirname, "essays-data.js");

function chapterFiles() {
  return fs
    .readdirSync(rawDir)
    .filter((name) => /^\d+\.txt$/i.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function escapeForTemplateLiteral(text) {
  return text.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function buildChapterOutput(files) {
  let out = "window.RENAISSANCE_EMBEDDED_CHAPTERS = [\n";
  for (const fileName of files) {
    const chapterNumber = Number.parseInt(fileName, 10);
    const filePath = path.join(rawDir, fileName);
    const rawText = fs.readFileSync(filePath, "utf8");
    out += `  { chapterNumber: ${chapterNumber}, rawText: \`${escapeForTemplateLiteral(rawText)}\` },\n`;
  }
  out += "];\n";
  return out;
}

function buildEssaysOutput() {
  const essayJsonPath = path.join(dataDir, "essays.json");
  const parsed = JSON.parse(fs.readFileSync(essayJsonPath, "utf8"));
  const essays = Array.isArray(parsed.essays) ? parsed.essays : [];

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

function writeOutputs(files) {
  const chapterOutput = buildChapterOutput(files);
  const essaysOutput = buildEssaysOutput();
  fs.writeFileSync(chaptersOutPath, chapterOutput, "utf8");
  fs.writeFileSync(essaysOutPath, essaysOutput, "utf8");
  console.log(`Wrote ${files.length} sections to ${chaptersOutPath}`);
  console.log(`Wrote essay metadata to ${essaysOutPath}`);
}

function checkOutputs(files) {
  const expectedChapterOutput = buildChapterOutput(files);
  const expectedEssaysOutput = buildEssaysOutput();
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
  const files = chapterFiles();
  const checkMode = process.argv.includes("--check");
  if (checkMode) {
    checkOutputs(files);
    return;
  }
  writeOutputs(files);
}

main();
