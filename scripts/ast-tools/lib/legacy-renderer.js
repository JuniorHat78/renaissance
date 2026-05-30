#!/usr/bin/env node
"use strict";

const HARD_BREAK_SENTINEL = "\x01";

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatInlineMarkdown(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\s*\u2014\s*/g, "\u2009\u2014\u2009")
    .replace(new RegExp(HARD_BREAK_SENTINEL + "\\n", "g"), "<br>")
    .replace(/\n/g, " ");
}

function cleanHeading(line) {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function parseBlocks(rawText) {
  const lines = String(rawText).split("\n");
  const blocks = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    const text = paragraphLines.join("\n");
    const stripped = text.replace(new RegExp(HARD_BREAK_SENTINEL, "g"), "").trim();
    const isPullQuote = !text.includes("\n") &&
      /^["\u201c]/.test(stripped) &&
      /["\u201d]$/.test(stripped);
    const block = { type: "p", text };
    if (isPullQuote) {
      block.pullQuote = true;
    }
    blocks.push(block);
    paragraphLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      flushParagraph();
      const level = Math.min(trimmed.match(/^#+/)[0].length, 3);
      blocks.push({ type: "h" + String(level), text: cleanHeading(trimmed) });
      continue;
    }

    if (trimmed === "---") {
      flushParagraph();
      blocks.push({ type: "hr" });
      continue;
    }

    const hasHardBreak = /  +$/.test(line);
    paragraphLines.push(hasHardBreak ? trimmed + HARD_BREAK_SENTINEL : trimmed);
  }

  flushParagraph();
  return blocks;
}

function serializeBlocks(blocks) {
  return blocks
    .map((block) => {
      if (block.type === "hr") {
        return "<hr>";
      }

      const safeText = formatInlineMarkdown(block.text || "");
      if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
        return "<" + block.type + ">" + safeText + "</" + block.type + ">";
      }

      const cls = block.pullQuote ? ' class="pull-quote"' : "";
      return "<p" + cls + ">" + safeText + "</p>";
    })
    .join("");
}

function searchableText(blocks) {
  return blocks
    .map((block) => {
      if (block.type === "hr") {
        return " ";
      }
      return String(block.text || "")
        .replace(new RegExp(HARD_BREAK_SENTINEL, "g"), "")
        .replace(/\*([^*]+)\*/g, "$1");
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  parseBlocks,
  searchableText,
  serializeBlocks,
};
