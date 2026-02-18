const fs = require("fs");
const path = require("path");

const REPORTS = [
  { label: "Home", file: ".lighthouseci/index.json" },
  { label: "Essay", file: ".lighthouseci/essay.json" },
  { label: "Section", file: ".lighthouseci/section.json" }
];

function parseThreshold(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 90;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function metric(audits, id, fallback) {
  const value = audits && audits[id] && audits[id].displayValue;
  return value ? String(value) : fallback;
}

function emitWarning(title, message) {
  console.log(`::warning title=${title}::${message}`);
}

function main() {
  const threshold = parseThreshold(process.env.LIGHTHOUSE_WARN_THRESHOLD);
  const summaryLines = [
    "## Lighthouse (warning-only)",
    "",
    `Warning threshold: ${threshold}`,
    ""
  ];

  for (const report of REPORTS) {
    const filePath = path.resolve(report.file);
    const data = readJsonSafe(filePath);
    if (!data) {
      emitWarning(
        `Lighthouse report missing (${report.label})`,
        `Could not read ${report.file}.`
      );
      summaryLines.push(`- ${report.label}: report unavailable`);
      continue;
    }

    const scoreRaw = data &&
      data.categories &&
      data.categories.performance &&
      data.categories.performance.score;
    const score = Number.isFinite(scoreRaw) ? Math.round(scoreRaw * 100) : null;

    if (score === null) {
      emitWarning(
        `Lighthouse score missing (${report.label})`,
        `Performance score is unavailable in ${report.file}.`
      );
      summaryLines.push(`- ${report.label}: score unavailable`);
      continue;
    }

    const audits = data.audits || {};
    const lcp = metric(audits, "largest-contentful-paint", "n/a");
    const tbt = metric(audits, "total-blocking-time", "n/a");
    const cls = metric(audits, "cumulative-layout-shift", "n/a");

    summaryLines.push(`- ${report.label}: ${score} (LCP ${lcp}, TBT ${tbt}, CLS ${cls})`);

    if (score < threshold) {
      emitWarning(
        `Lighthouse performance low (${report.label})`,
        `Score ${score} is below warning threshold ${threshold}.`
      );
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join("\n") + "\n", "utf8");
  }
}

main();
