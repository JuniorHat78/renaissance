(function () {
  const ESSAYS_PATH = "data/essays.json";
  const DEFAULT_FALLBACK_SLUG = "default-essay";
  const DEFAULT_FALLBACK_SOURCE_DIR = "raw";
  const AST = window.RenaissanceAst;
  if (!AST) {
    throw new Error("scripts/ast/core.js and scripts/ast/render.js must load before scripts/content.js");
  }

  const EMBEDDED_ESSAYS = Array.isArray(window.RENAISSANCE_EMBEDDED_ESSAYS)
    ? window.RENAISSANCE_EMBEDDED_ESSAYS
    : [];

  const COMPILED_PATH_PREFIX = "data/compiled/";
  const COMPILED_ESSAY_CACHE = new Map();
  let essayCache = null;

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

  async function loadEssayManifestNumbers(sourceDir) {
    const manifestPath = String(sourceDir || embeddedSourceDirFallback()).replace(/\/+$/, "") + "/manifest.json";
    try {
      const manifest = JSON.parse(await fetchAsText(manifestPath));
      return normalizeSectionOrder(manifest.chapters);
    } catch (error) {
      return [];
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
    const sectionOrder = await loadEssayManifestNumbers(fallbackSourceDir);
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

  // The compiler (scripts/generate-content-ast.js) emits one artifact per
  // published essay holding each section's content AST exactly as the reader
  // renders it. We hydrate that here — the reader never parses. Returns null
  // (never throws) when the artifact is missing, offline-uncached, malformed, or
  // built against an older AST grammar; loadSection turns that into a clean error
  // since there is no client parser to fall back to.
  async function loadCompiledEssay(slug) {
    if (COMPILED_ESSAY_CACHE.has(slug)) {
      return COMPILED_ESSAY_CACHE.get(slug);
    }

    const promise = (async () => {
      let artifact;
      try {
        artifact = JSON.parse(await fetchAsText(COMPILED_PATH_PREFIX + slug + ".json"));
      } catch (error) {
        return null;
      }

      if (!artifact || !Array.isArray(artifact.sections)) {
        return null;
      }

      // Grammar-drift guard: a compiled artifact from an older AST version must
      // not be trusted to render. Returning null surfaces a clean reload error
      // rather than rendering against a grammar the reader no longer speaks; the
      // next deploy rebuilds the artifact at the current version.
      if (String(artifact.astVersion || "") !== String(AST.VERSION)) {
        return null;
      }

      return artifact;
    })().catch(() => null);

    COMPILED_ESSAY_CACHE.set(slug, promise);
    return promise;
  }

  function hydrateSectionFromArtifact(essay, sectionNumber, artifact) {
    if (!artifact || !Array.isArray(artifact.sections)) {
      return null;
    }

    const record = artifact.sections.find(
      (entry) => parseNumber(entry && entry.sectionNumber) === sectionNumber
    );
    const contentAst = record && record.ast;
    if (!contentAst || contentAst.type !== AST.BLOCK_TYPES.DOCUMENT) {
      return null;
    }

    // The stored AST is the single truth; every projection is recomputed from it
    // with the same functions the parse path uses, so a hydrated section is the
    // section a fresh parse would have produced — same DOM, passages, and IDs.
    const contentBlocks = AST.astToLegacyBlocks(contentAst);
    const searchableText = AST.toSearchableText(contentAst);
    const passages = AST.passagesFromDocument(contentAst);
    const firstParagraphText = AST.firstParagraphText(contentAst);
    const wordCount = AST.wordCount(searchableText);

    return {
      essay,
      sectionNumber,
      display: sectionDisplay(essay, sectionNumber),
      // rawText/full ast (with leading headings) are source-only; the reader
      // renders contentAst, and no shipped consumer reads them. Keeping `blocks`
      // as the content blocks preserves the legacy contentBlocks||blocks alias.
      rawText: null,
      ast: contentAst,
      contentAst,
      blocks: contentBlocks,
      contentBlocks,
      passages,
      searchableText,
      firstParagraphText,
      wordCount,
      readMinutes: estimateReadMinutes(wordCount),
      source: "compiled"
    };
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

    // The reader hydrates the precompiled content AST — it never parses. The
    // artifact is the deploy contract: build:artifacts emits one per published
    // essay and the equivalence oracle proves it matches a live parse, so a
    // hydrated section renders byte-for-byte what the parser would. A missing or
    // stale artifact is a deploy bug, surfaced as a clean error rather than a
    // silent reparse — there is no client parser to fall back to.
    const artifact = await loadCompiledEssay(essay.slug);
    const hydrated = hydrateSectionFromArtifact(essay, section, artifact);
    if (hydrated) {
      return hydrated;
    }

    throw new Error("Unable to load this section.");
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
    renderBlocks,
    sectionDisplay,
    sectionLabel,
    shortExcerpt
  };
})();
