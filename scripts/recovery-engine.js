(function initRenaissanceRecovery(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.RenaissanceRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function buildRenaissanceRecovery() {
  "use strict";

  const ASSET_EXTENSIONS = /\.(?:html?|txt|png|jpe?g|webp|svg|pdf|xml|json|css|js)$/i;

  function normalizeWords(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function prettySlug(slug) {
    return String(slug || "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function publishedEssays(essays) {
    return (Array.isArray(essays) ? essays : []).filter((essay) => essay && essay.published !== false);
  }

  function scoreNeedle(needle, haystack) {
    const query = normalizeWords(needle);
    const target = normalizeWords(haystack);
    if (!query || !target) {
      return 0;
    }
    if (target.includes(query)) {
      return query.length + 20;
    }
    return query.split(/\s+/).reduce((score, word) => {
      return score + (word.length > 2 && target.includes(word) ? word.length : 0);
    }, 0);
  }

  function closestEssay(essays, seed) {
    let best = null;
    publishedEssays(essays).forEach((essay) => {
      const score = scoreNeedle(seed, [essay.slug, essay.title, essay.summary].join(" "));
      if (score > 0 && (!best || score > best.score)) {
        best = { essay, score };
      }
    });
    return best ? best.essay : null;
  }

  function nearestSectionNumber(essay, sectionNumber) {
    const order = Array.isArray(essay && essay.section_order) ? essay.section_order : [];
    if (!order.length) {
      return null;
    }
    const target = Number(sectionNumber);
    if (!Number.isFinite(target)) {
      return order[0];
    }
    return order.reduce((best, candidate) => {
      return Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best;
    }, order[0]);
  }

  function routeRecovery(input) {
    const state = input || {};
    const params = new URLSearchParams(String(state.search || "").replace(/^\?/, ""));
    const path = String(state.path || "");
    const online = state.online !== false;
    const essaySlug = params.get("essay") || "";
    const sectionNumber = Number.parseInt(params.get("section") || "", 10);
    const query = params.get("q") || params.get("query") || params.get("search") || "";

    if (!online) {
      return { mode: "offline", query: query || prettifyPath(path) };
    }

    if (essaySlug && Number.isFinite(sectionNumber)) {
      return { mode: "section", essaySlug, sectionNumber, query: prettySlug(essaySlug) };
    }

    if (essaySlug) {
      return { mode: "essay", essaySlug, query: prettySlug(essaySlug) };
    }

    if (query || /search/i.test(path)) {
      return { mode: "search", query: query || prettifyPath(path) };
    }

    if (ASSET_EXTENSIONS.test(path)) {
      return { mode: "asset", query: prettifyPath(path) };
    }

    return { mode: "unknown", query: prettifyPath(path) };
  }

  function prettifyPath(path) {
    return String(path || "")
      .split(/[/?#]/)
      .filter(Boolean)
      .pop()
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim();
  }

  return Object.freeze({
    closestEssay,
    nearestSectionNumber,
    normalizeWords,
    prettySlug,
    publishedEssays,
    routeRecovery,
    scoreNeedle
  });
});
