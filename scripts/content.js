(function () {
  const ESSAYS_PATH = "data/essays.json";
  const DEFAULT_FALLBACK_SLUG = "default-essay";
  const DEFAULT_FALLBACK_SOURCE_DIR = "raw";
  const EMBEDDED_CHAPTERS_PATH = "scripts/chapters-data.js";
  const AST = window.RenaissanceAst;
  if (!AST) {
    throw new Error("scripts/ast/index.js must load before scripts/content.js");
  }

  const EMBEDDED_ESSAYS = Array.isArray(window.RENAISSANCE_EMBEDDED_ESSAYS)
    ? window.RENAISSANCE_EMBEDDED_ESSAYS
    : [];

  const EMBEDDED_MAP = new Map();
  const SECTION_TEXT_CACHE = new Map();
  let essayCache = null;
  let embeddedChaptersPromise = null;

  function embeddedEssaySlugFallback() {
    for (const entry of EMBEDDED_ESSAYS) {
      const slug = String((entry && (entry.slug || entry.id)) || "").trim();
      if (slug) {
        return slug;
      }
    }
    return DEFAULT_FALLBACK_SLUG;
  }

  function embeddedSourceDirFallback() {
    for (const entry of EMBEDDED_ESSAYS) {
      const sourceDir = String((entry && entry.source_dir) || "").trim();
      if (sourceDir) {
        return sourceDir;
      }
    }
    return DEFAULT_FALLBACK_SOURCE_DIR;
  }

  function fallbackTitleFromSlug(slug) {
    return String(slug || "")
      .replace(/[-_]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(" ")
      || "Renaissance Essay";
  }

  function embeddedChapters() {
    return Array.isArray(window.RENAISSANCE_EMBEDDED_CHAPTERS)
      ? window.RENAISSANCE_EMBEDDED_CHAPTERS
      : [];
  }

  function embeddedKey(essaySlug, sectionNumber) {
    return String(essaySlug) + ":" + String(sectionNumber);
  }

  function refreshEmbeddedMap() {
    EMBEDDED_MAP.clear();
    for (const entry of embeddedChapters()) {
      const sectionNumber = parseNumber(
        entry && (entry.sectionNumber !== undefined ? entry.sectionNumber : entry.chapterNumber)
      );
      if (sectionNumber === null) {
        continue;
      }
      const essaySlug = String((entry && entry.essaySlug) || embeddedEssaySlugFallback()).trim();
      if (!essaySlug) {
        continue;
      }
      EMBEDDED_MAP.set(embeddedKey(essaySlug, sectionNumber), String(entry.rawText || ""));
    }
  }

  async function ensureEmbeddedChaptersLoaded() {
    if (EMBEDDED_MAP.size > 0) {
      return;
    }

    if (embeddedChaptersPromise) {
      return embeddedChaptersPromise;
    }

    if (typeof document !== "object" || !document.createElement) {
      throw new Error("Embedded chapter loader unavailable");
    }

    embeddedChaptersPromise = new Promise((resolve, reject) => {
      const existing = embeddedChapters();
      if (existing.length > 0) {
        refreshEmbeddedMap();
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = EMBEDDED_CHAPTERS_PATH;
      script.async = true;
      script.onload = () => {
        refreshEmbeddedMap();
        resolve();
      };
      script.onerror = () => {
        reject(new Error("Failed to load embedded chapter fallback"));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      embeddedChaptersPromise = null;
      throw error;
    });

    return embeddedChaptersPromise;
  }

  refreshEmbeddedMap();

  async function fetchAsText(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error("Failed to load " + path + " (" + response.status + ")");
    }

    return (await response.text()).replace(/\r\n?/g, "\n");
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

  function normalizeEssayDisplay(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { show_subtitles: true };
    }

    return {
      show_subtitles: value.show_subtitles !== false
    };
  }

  function embeddedManifestNumbers(essaySlug) {
    const fallbackSlug = embeddedEssaySlugFallback();
    const targetSlug = String(essaySlug || fallbackSlug).trim() || fallbackSlug;
    const numbers = new Set();
    for (const entry of embeddedChapters()) {
      const sectionNumber = parseNumber(
        entry && (entry.sectionNumber !== undefined ? entry.sectionNumber : entry.chapterNumber)
      );
      if (sectionNumber === null) {
        continue;
      }

      const entrySlug = String((entry && entry.essaySlug) || fallbackSlug).trim();
      if (entrySlug === targetSlug) {
        numbers.add(sectionNumber);
      }
    }

    return Array.from(numbers).sort((a, b) => a - b);
  }

  async function fallbackManifestNumbers(essaySlug) {
    const fromMap = embeddedManifestNumbers(essaySlug);
    if (fromMap.length > 0) {
      return fromMap;
    }

    try {
      await ensureEmbeddedChaptersLoaded();
    } catch (error) {
      return fromMap;
    }

    return embeddedManifestNumbers(essaySlug);
  }

  async function loadEssayManifestNumbers(sourceDir, essaySlug) {
    const manifestPath = String(sourceDir || embeddedSourceDirFallback()).replace(/\/+$/, "") + "/manifest.json";
    try {
      const manifest = JSON.parse(await fetchAsText(manifestPath));
      const numbers = normalizeSectionOrder(manifest.chapters);
      if (numbers.length > 0) {
        return numbers;
      }
      return fallbackManifestNumbers(essaySlug);
    } catch (error) {
      return fallbackManifestNumbers(essaySlug);
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

    const fallbackSlug = embeddedEssaySlugFallback();
    const fallbackSourceDir = embeddedSourceDirFallback();
    const sectionOrder = await loadEssayManifestNumbers(fallbackSourceDir, fallbackSlug);
    return [
      {
        id: fallbackSlug,
        slug: fallbackSlug,
        title: fallbackTitleFromSlug(fallbackSlug),
        summary: "",
        social_image: "assets/og-home.png",
        source_dir: fallbackSourceDir,
        section_order: sectionOrder,
        section_meta: {},
        display: {
          show_subtitles: true
        },
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
    const socialImage = String(essay.social_image || "").trim();
    const sectionOrder = normalizeSectionOrder(essay.section_order);
    const sectionMeta = normalizeSectionMeta(essay.section_meta);
    const display = normalizeEssayDisplay(essay.display);

    return {
      id: String(essay.id || slug).trim(),
      slug,
      title,
      summary,
      social_image: socialImage,
      source_dir: sourceDir,
      section_order: sectionOrder,
      section_meta: sectionMeta,
      display,
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

  function parseBlocks(rawText) {
    return AST.astToLegacyBlocks(AST.parseDocument(rawText));
  }

  function firstParagraph(input) {
    return AST.firstParagraphText(input);
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
    const subtitlesEnabled = !essay || !essay.display || essay.display.show_subtitles !== false;
    const subtitle = subtitlesEnabled ? (meta.subtitle || "") : "";
    const searchLabel = meta.title ? label + " | " + meta.title : label;

    return {
      label,
      title,
      subtitle,
      searchLabel
    };
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

  async function loadSectionText(essay, sectionNumber) {
    const cacheKey = essay.slug + ":" + String(sectionNumber);
    if (SECTION_TEXT_CACHE.has(cacheKey)) {
      return SECTION_TEXT_CACHE.get(cacheKey);
    }

    const relativePath = essay.source_dir + "/" + String(sectionNumber) + ".txt";

    try {
      const loaded = await fetchAsText(relativePath);
      SECTION_TEXT_CACHE.set(cacheKey, loaded);
      return loaded;
    } catch (error) {
      const entryKey = embeddedKey(essay.slug, sectionNumber);
      if (EMBEDDED_MAP.has(entryKey)) {
        const embedded = EMBEDDED_MAP.get(entryKey);
        SECTION_TEXT_CACHE.set(cacheKey, embedded);
        return embedded;
      }

      try {
        await ensureEmbeddedChaptersLoaded();
      } catch (fallbackError) {
        // Keep original error as the source failure.
      }

      if (EMBEDDED_MAP.has(entryKey)) {
        const embedded = EMBEDDED_MAP.get(entryKey);
        SECTION_TEXT_CACHE.set(cacheKey, embedded);
        return embedded;
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
    const ast = AST.parseDocument(rawText, { sourceName: essay.source_dir + "/" + String(section) + ".txt" });
    const contentAst = AST.withoutLeadingHeadings(ast);
    const blocks = AST.astToLegacyBlocks(ast);
    const contentBlocks = AST.astToLegacyBlocks(contentAst);
    const searchableText = AST.toSearchableText(contentAst);
    const firstParagraphText = AST.firstParagraphText(contentAst);
    const wordCount = AST.wordCount(searchableText);
    const readMinutes = estimateReadMinutes(wordCount);

    return {
      essay,
      sectionNumber: section,
      display: sectionDisplay(essay, section),
      rawText,
      ast,
      contentAst,
      blocks,
      contentBlocks,
      searchableText,
      firstParagraphText,
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
    AST.renderBlocks(container, blocks);
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
