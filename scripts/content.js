(function () {
  const ESSAYS_PATH = "data/essays.json";
  const RAW_MANIFEST_PATH = "raw/manifest.json";

  const EMBEDDED_CHAPTERS = Array.isArray(window.RENAISSANCE_EMBEDDED_CHAPTERS)
    ? window.RENAISSANCE_EMBEDDED_CHAPTERS
    : [];
  const EMBEDDED_ESSAYS = Array.isArray(window.RENAISSANCE_EMBEDDED_ESSAYS)
    ? window.RENAISSANCE_EMBEDDED_ESSAYS
    : [];

  const EMBEDDED_MAP = new Map(
    EMBEDDED_CHAPTERS.map((entry) => [entry.chapterNumber, entry.rawText])
  );

  let essayCache = null;

  function escapeHtml(text) {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatInlineMarkdown(text) {
    const escaped = escapeHtml(text);
    return escaped.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  }

  function encodingQualityScore(text) {
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const mojibakeCount = (text.match(/(?:\u00C3.|\u00C2.|\u00E2.)/g) || []).length;
    return -((replacementCount * 4) + mojibakeCount);
  }

  function decodeText(buffer) {
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (!utf8.includes("\uFFFD")) {
      return utf8;
    }

    const windows1252 = new TextDecoder("windows-1252").decode(buffer);
    return encodingQualityScore(windows1252) > encodingQualityScore(utf8)
      ? windows1252
      : utf8;
  }

  async function fetchAsText(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Failed to load " + path + " (" + response.status + ")");
    }

    const buffer = await response.arrayBuffer();
    return decodeText(buffer).replace(/\r\n/g, "\n");
  }

  function parseNumber(value) {
    const section = Number.parseInt(value, 10);
    return Number.isFinite(section) && section > 0 ? section : null;
  }

  function normalizeSectionOrder(values) {
    if (!Array.isArray(values)) {
      return [];
    }

    const seen = new Set();
    const order = [];
    for (const value of values) {
      const number = parseNumber(value);
      if (number === null || seen.has(number)) {
        continue;
      }
      seen.add(number);
      order.push(number);
    }

    return order;
  }

  function normalizeSectionMeta(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    const normalized = {};
    for (const [key, meta] of Object.entries(value)) {
      const sectionNumber = parseNumber(key);
      if (sectionNumber === null || !meta || typeof meta !== "object") {
        continue;
      }

      const title = String(meta.title || "").trim();
      const subtitle = String(meta.subtitle || "").trim();
      if (!title && !subtitle) {
        continue;
      }

      normalized[sectionNumber] = {
        title,
        subtitle
      };
    }

    return normalized;
  }

  function embeddedManifestNumbers() {
    return EMBEDDED_CHAPTERS
      .map((entry) => parseNumber(entry.chapterNumber))
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
  }

  async function loadRawManifestNumbers() {
    try {
      const manifest = JSON.parse(await fetchAsText(RAW_MANIFEST_PATH));
      const numbers = normalizeSectionOrder(manifest.chapters);
      if (numbers.length > 0) {
        return numbers;
      }
      return embeddedManifestNumbers();
    } catch (error) {
      return embeddedManifestNumbers();
    }
  }

  async function defaultEssays() {
    if (EMBEDDED_ESSAYS.length > 0) {
      const embedded = EMBEDDED_ESSAYS
        .map((entry) => normalizeEssay(entry))
        .filter((entry) => entry !== null);
      if (embedded.length > 0) {
        return embedded;
      }
    }

    const sectionOrder = await loadRawManifestNumbers();
    return [
      {
        id: "etching-god-into-sand",
        slug: "etching-god-into-sand",
        title: "Etching God into Sand",
        summary: "A long-form essay in ten sections tracing sand, silicon, language, and cognition.",
        source_dir: "raw",
        section_order: sectionOrder,
        section_meta: {},
        published: true
      }
    ];
  }

  function normalizeEssay(essay) {
    if (!essay || typeof essay !== "object") {
      return null;
    }

    const slug = String(essay.slug || "").trim();
    if (!slug) {
      return null;
    }

    const sourceDir = String(essay.source_dir || "").trim() || "raw";
    const title = String(essay.title || slug).trim();
    const summary = String(essay.summary || "").trim();
    const sectionOrder = normalizeSectionOrder(essay.section_order);
    const sectionMeta = normalizeSectionMeta(essay.section_meta);

    return {
      id: String(essay.id || slug).trim(),
      slug,
      title,
      summary,
      source_dir: sourceDir,
      section_order: sectionOrder,
      section_meta: sectionMeta,
      published: essay.published !== false
    };
  }

  async function loadEssayRegistry() {
    try {
      const payload = JSON.parse(await fetchAsText(ESSAYS_PATH));
      if (!payload || !Array.isArray(payload.essays)) {
        throw new Error("Invalid essays metadata");
      }

      const essays = payload.essays
        .map((entry) => normalizeEssay(entry))
        .filter((entry) => entry !== null);

      if (essays.length === 0) {
        throw new Error("No essays available");
      }

      return essays;
    } catch (error) {
      if (EMBEDDED_ESSAYS.length > 0) {
        const embedded = EMBEDDED_ESSAYS
          .map((entry) => normalizeEssay(entry))
          .filter((entry) => entry !== null);
        if (embedded.length > 0) {
          return embedded;
        }
      }
      return defaultEssays();
    }
  }

  async function loadEssays() {
    if (essayCache) {
      return essayCache;
    }

    essayCache = await loadEssayRegistry();
    return essayCache;
  }

  async function loadEssay(slug) {
    const essays = await loadEssays();
    return essays.find((essay) => essay.slug === slug) || null;
  }

  function cleanHeading(line) {
    return line.replace(/^#{1,6}\s+/, "").trim();
  }

  function toSearchableText(rawText) {
    return rawText
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*---\s*$/gm, " ")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseBlocks(rawText) {
    const lines = rawText.split("\n");
    const blocks = [];
    let paragraphLines = [];

    const flushParagraph = () => {
      if (paragraphLines.length === 0) {
        return;
      }
      blocks.push({
        type: "p",
        text: paragraphLines.join(" ").replace(/\s+/g, " ").trim()
      });
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
        blocks.push({
          type: "h" + String(level),
          text: cleanHeading(trimmed)
        });
        continue;
      }

      if (trimmed === "---") {
        flushParagraph();
        blocks.push({ type: "hr" });
        continue;
      }

      paragraphLines.push(trimmed);
    }

    flushParagraph();
    return blocks;
  }

  function firstParagraph(blocks) {
    const paragraph = blocks.find((block) => block.type === "p");
    return paragraph ? paragraph.text : "";
  }

  function shortExcerpt(text, maxLength) {
    const targetLength = maxLength || 180;
    if (text.length <= targetLength) {
      return text;
    }

    const trimmed = text.slice(0, targetLength).trimEnd();
    return trimmed + "...";
  }

  function toRoman(number) {
    if (!Number.isFinite(number) || number <= 0) {
      return "";
    }

    const table = [
      [1000, "M"],
      [900, "CM"],
      [500, "D"],
      [400, "CD"],
      [100, "C"],
      [90, "XC"],
      [50, "L"],
      [40, "XL"],
      [10, "X"],
      [9, "IX"],
      [5, "V"],
      [4, "IV"],
      [1, "I"]
    ];

    let value = number;
    let roman = "";
    for (const [digit, symbol] of table) {
      while (value >= digit) {
        roman += symbol;
        value -= digit;
      }
    }
    return roman;
  }

  function sectionLabel(sectionNumber) {
    const roman = toRoman(sectionNumber);
    if (roman) {
      return "Section " + roman;
    }
    return "Section " + String(sectionNumber);
  }

  function getSectionMeta(essay, sectionNumber) {
    if (!essay || !essay.section_meta) {
      return { title: "", subtitle: "" };
    }

    const meta = essay.section_meta[sectionNumber];
    if (!meta) {
      return { title: "", subtitle: "" };
    }

    return {
      title: String(meta.title || "").trim(),
      subtitle: String(meta.subtitle || "").trim()
    };
  }

  function sectionDisplay(essay, sectionNumber) {
    const label = sectionLabel(sectionNumber);
    const meta = getSectionMeta(essay, sectionNumber);
    const title = meta.title || label;
    const subtitle = meta.subtitle || "";
    const searchLabel = meta.title ? label + " | " + meta.title : label;

    return {
      label,
      title,
      subtitle,
      searchLabel
    };
  }

  function countWords(text) {
    if (!text || typeof text !== "string") {
      return 0;
    }

    const tokens = text.trim().split(/\s+/).filter((value) => value.length > 0);
    return tokens.length;
  }

  function estimateReadMinutes(wordCount) {
    const wordsPerMinute = 220;
    return Math.max(1, Math.round(wordCount / wordsPerMinute));
  }

  function formatWordCount(wordCount) {
    return Number(wordCount || 0).toLocaleString("en-US") + " words";
  }

  function formatReadMinutes(minutes) {
    const totalMinutes = Math.max(1, Number(minutes || 0));
    if (totalMinutes < 60) {
      return String(totalMinutes) + " min";
    }

    const hours = Math.max(1, Math.floor(totalMinutes / 60));
    return String(hours) + "h";
  }

  function formatReadDuration(minutes) {
    return formatReadMinutes(minutes) + " read";
  }

  function removeLeadingHeadings(blocks) {
    let startIndex = 0;
    while (startIndex < blocks.length) {
      const block = blocks[startIndex];
      if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
        startIndex += 1;
        continue;
      }
      break;
    }
    return blocks.slice(startIndex);
  }

  async function loadSectionText(essay, sectionNumber) {
    const relativePath = essay.source_dir + "/" + String(sectionNumber) + ".txt";

    try {
      return await fetchAsText(relativePath);
    } catch (error) {
      if (essay.source_dir === "raw" && EMBEDDED_MAP.has(sectionNumber)) {
        return EMBEDDED_MAP.get(sectionNumber);
      }
      throw error;
    }
  }

  async function loadSection(essaySlug, sectionNumber) {
    const essay = await loadEssay(essaySlug);
    if (!essay) {
      throw new Error("Essay not found: " + essaySlug);
    }

    const section = parseNumber(sectionNumber);
    if (section === null) {
      throw new Error("Invalid section number");
    }

    if (!essay.section_order.includes(section)) {
      throw new Error("Section not found for essay");
    }

    const rawText = await loadSectionText(essay, section);
    const blocks = parseBlocks(rawText);
    const searchableText = toSearchableText(rawText);
    const wordCount = countWords(searchableText);
    const readMinutes = estimateReadMinutes(wordCount);

    return {
      essay,
      sectionNumber: section,
      display: sectionDisplay(essay, section),
      rawText,
      blocks,
      contentBlocks: removeLeadingHeadings(blocks),
      searchableText,
      wordCount,
      readMinutes
    };
  }

  async function loadEssaySections(essaySlug) {
    const essay = await loadEssay(essaySlug);
    if (!essay) {
      throw new Error("Essay not found: " + essaySlug);
    }

    const sections = await Promise.all(
      essay.section_order.map((sectionNumber) => loadSection(essay.slug, sectionNumber))
    );

    const totalWords = sections.reduce((sum, section) => sum + section.wordCount, 0);
    const totalReadMinutes = estimateReadMinutes(totalWords);

    return {
      essay,
      sections,
      stats: {
        totalWords,
        totalReadMinutes
      }
    };
  }

  function renderBlocks(container, blocks) {
    const html = blocks
      .map((block) => {
        if (block.type === "hr") {
          return "<hr>";
        }

        const safeText = formatInlineMarkdown(block.text || "");
        if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
          return "<" + block.type + ">" + safeText + "</" + block.type + ">";
        }

        return "<p>" + safeText + "</p>";
      })
      .join("");

    container.innerHTML = html;
  }

  window.RenaissanceContent = {
    firstParagraph,
    formatReadDuration,
    formatReadMinutes,
    formatWordCount,
    loadEssay,
    loadEssays,
    loadEssaySections,
    loadSection,
    parseBlocks,
    renderBlocks,
    sectionDisplay,
    sectionLabel,
    shortExcerpt
  };
})();
