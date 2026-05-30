"use strict";

// Lighthouse is a MEASURING STICK, never a gate. This summarizer reports the
// performance score per page and, when a committed baseline exists, the delta
// against it. A drastic drop (default >= 8 points) is surfaced as a GitHub
// ::warning for a human to glance at — it never fails the build. Lighthouse
// scores on shared CI runners are noisy, so the drastic threshold is loose by
// design: we want to catch "something fell off a cliff", not chase jitter.

const fs = require("fs");
const path = require("path");

const REPORTS = [
  { label: "Home", file: ".lighthouseci/index.json" },
  { label: "Essay", file: ".lighthouseci/essay.json" },
  { label: "Section", file: ".lighthouseci/section.json" }
];

const BASELINE_FILE = path.join("qa", "lighthouse", "baseline.json");

function parseThreshold(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 90;
}

function parseDrasticDrop(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 8;
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

function scoreFromReport(data) {
  return categoryScore(data, "performance");
}

function categoryScore(data, id) {
  const category = data && data.categories && data.categories[id];
  const raw = category && category.score;
  return Number.isFinite(raw) ? Math.round(raw * 100) : null;
}

function show(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

// Pure, deterministic core so the flagging logic can be unit-tested without
// ever invoking Lighthouse. Returns the markdown lines plus the warnings to
// emit. Emitting warnings (vs failing) is the caller's job — this never throws.
function buildSummary({ entries, baseline, threshold, drasticDrop }) {
  const baseScores = (baseline && baseline.scores) || {};
  const hasBaseline = baseline && baseline.scores && Object.keys(baseScores).length > 0;
  const lines = [
    "## Lighthouse (measuring stick — non-gating)",
    "",
    "Absolute warn threshold: " + threshold + " · Drastic-drop flag: -" + drasticDrop + " vs baseline",
    ""
  ];
  if (hasBaseline) {
    lines.push("Baseline captured: " + (baseline.capturedAt || "unknown") +
      (baseline.sourceRun ? " (run " + baseline.sourceRun + ")" : ""));
  } else {
    lines.push("_No baseline committed — reporting current scores only. Run `npm run lighthouse:baseline` from a trusted run to set one._");
  }
  lines.push("");

  const warnings = [];

  for (const entry of entries) {
    if (entry.score === null || entry.score === undefined) {
      warnings.push({
        title: "Lighthouse score missing (" + entry.label + ")",
        message: "Performance score unavailable for " + entry.label + "."
      });
      lines.push("- " + entry.label + ": score unavailable");
      continue;
    }

    let deltaText = "";
    const base = baseScores[entry.label];
    if (hasBaseline && Number.isFinite(base)) {
      const delta = entry.score - base;
      const sign = delta > 0 ? "+" : "";
      deltaText = " (Δ " + sign + delta + " vs baseline " + base + ")";
      if (delta <= -drasticDrop) {
        warnings.push({
          title: "Lighthouse drastic drop (" + entry.label + ")",
          message: "Score " + entry.score + " is " + Math.abs(delta) +
            " points below baseline " + base + " (flag threshold " + drasticDrop + "). Worth a human look — not a gate."
        });
      }
    }

    const cat = entry.categories;
    const catText = cat
      ? " · a11y " + show(cat.accessibility) + " / best-practices " + show(cat["best-practices"]) + " / seo " + show(cat.seo)
      : "";
    lines.push("- " + entry.label + ": perf " + entry.score + deltaText + catText +
      " (LCP " + entry.lcp + ", TBT " + entry.tbt + ", CLS " + entry.cls + ")");

    if (entry.score < threshold) {
      warnings.push({
        title: "Lighthouse performance low (" + entry.label + ")",
        message: "Score " + entry.score + " is below the absolute warn threshold " + threshold + "."
      });
    }
  }

  return { lines, warnings };
}

function readEntries() {
  return REPORTS.map((report) => {
    const data = readJsonSafe(path.resolve(report.file));
    if (!data) {
      return { label: report.label, score: null, lcp: "n/a", tbt: "n/a", cls: "n/a", missing: true };
    }
    const audits = data.audits || {};
    return {
      label: report.label,
      score: scoreFromReport(data),
      categories: {
        accessibility: categoryScore(data, "accessibility"),
        "best-practices": categoryScore(data, "best-practices"),
        seo: categoryScore(data, "seo")
      },
      lcp: metric(audits, "largest-contentful-paint", "n/a"),
      tbt: metric(audits, "total-blocking-time", "n/a"),
      cls: metric(audits, "cumulative-layout-shift", "n/a")
    };
  });
}

function main() {
  const threshold = parseThreshold(process.env.LIGHTHOUSE_WARN_THRESHOLD);
  const drasticDrop = parseDrasticDrop(process.env.LIGHTHOUSE_DRASTIC_DROP);
  const baseline = readJsonSafe(path.resolve(BASELINE_FILE));
  const entries = readEntries();

  const { lines, warnings } = buildSummary({ entries, baseline, threshold, drasticDrop });

  warnings.forEach((warning) => {
    console.log("::warning title=" + warning.title + "::" + warning.message);
  });
  console.log(lines.join("\n"));

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", "utf8");
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildSummary, parseThreshold, parseDrasticDrop, scoreFromReport, BASELINE_FILE };
