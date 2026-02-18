(function () {
  const MODES = ["contains", "exact_phrase", "fuzzy"];
  const SORTS = ["reading_order", "relevance"];
  const PAGE_SIZES = [25, 50, 100];
  const DEFAULT_PAGE_SIZE = 50;

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeMode(value) {
    return MODES.includes(value) ? value : "contains";
  }

  function normalizeSort(value) {
    return SORTS.includes(value) ? value : "reading_order";
  }

  function normalizePage(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  function normalizePageSize(value) {
    const parsed = Number.parseInt(value, 10);
    return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
  }

  function parseBooleanFlag(value) {
    return value === "1" || value === "true";
  }

  function normalizeScope(value, allowedScopes) {
    if (!value || value === "all") {
      return "all";
    }

    return allowedScopes.includes(value) ? value : "all";
  }

  function normalizeState(rawState, allowedScopes) {
    const source = rawState || {};
    return {
      query: String(source.query || "").trim(),
      mode: normalizeMode(source.mode),
      sort: normalizeSort(source.sort),
      scope: normalizeScope(source.scope, allowedScopes || []),
      caseSensitive: Boolean(source.caseSensitive),
      page: normalizePage(source.page),
      pageSize: normalizePageSize(source.pageSize)
    };
  }

  function tokenizeWordSpans(text) {
    const spans = [];
    const matcher = /[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g;
    let match = matcher.exec(text);
    while (match) {
      spans.push({
        index: match.index,
        raw: match[0],
        lower: match[0].toLowerCase()
      });
      match = matcher.exec(text);
    }
    return spans;
  }

  function tokenizeQueryWords(text) {
    return tokenizeWordSpans(text).map((token) => token.lower);
  }

  function levenshteinDistance(left, right) {
    if (left === right) {
      return 0;
    }
    if (!left.length) {
      return right.length;
    }
    if (!right.length) {
      return left.length;
    }

    const previous = new Array(right.length + 1);
    const current = new Array(right.length + 1);

    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = column;
    }

    for (let row = 1; row <= left.length; row += 1) {
      current[0] = row;
      for (let column = 1; column <= right.length; column += 1) {
        const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
        current[column] = Math.min(
          previous[column] + 1,
          current[column - 1] + 1,
          previous[column - 1] + substitutionCost
        );
      }

      for (let column = 0; column <= right.length; column += 1) {
        previous[column] = current[column];
      }
    }

    return previous[right.length];
  }

  function fuzzyThreshold(length) {
    if (length <= 4) {
      return 2;
    }
    if (length <= 8) {
      return 2;
    }
    return 3;
  }

  function findContainsOccurrences(section, query, caseSensitive) {
    const target = caseSensitive ? section.text : section.lowerText;
    const needle = caseSensitive ? query : query.toLowerCase();
    if (!needle) {
      return [];
    }

    const hits = [];
    let fromIndex = 0;
    while (true) {
      const index = target.indexOf(needle, fromIndex);
      if (index === -1) {
        break;
      }

      const matchedText = section.text.slice(index, index + needle.length);
      hits.push({
        index,
        length: needle.length,
        matchedText,
        score: 200
      });

      fromIndex = index + Math.max(needle.length, 1);
    }
    return hits;
  }

  function findExactPhraseOccurrences(section, query, caseSensitive) {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
    if (!words.length) {
      return [];
    }
    const body = words.map((word) => escapeRegExp(word)).join("\\s+");
    const flags = caseSensitive ? "g" : "gi";
    const pattern = new RegExp("\\b" + body + "\\b", flags);
    const hits = [];

    let match = pattern.exec(section.text);
    while (match) {
      hits.push({
        index: match.index,
        length: match[0].length,
        matchedText: match[0],
        score: 300
      });

      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
      match = pattern.exec(section.text);
    }

    return hits;
  }

  function findFuzzyOccurrences(section, query) {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return [];
    }

    const queryTokens = Array.from(new Set(tokenizeQueryWords(trimmed).filter((token) => token.length >= 3)));
    if (!queryTokens.length) {
      return [];
    }

    const hits = [];
    for (const token of section.tokens) {
      if (token.lower.length < 3) {
        continue;
      }

      let bestDistance = Number.POSITIVE_INFINITY;
      for (const queryToken of queryTokens) {
        if (Math.abs(token.lower.length - queryToken.length) > 1) {
          continue;
        }
        if (token.lower[0] !== queryToken[0]) {
          continue;
        }
        if (token.lower[token.lower.length - 1] !== queryToken[queryToken.length - 1]) {
          continue;
        }
        const threshold = fuzzyThreshold(Math.max(token.lower.length, queryToken.length));
        const distance = levenshteinDistance(token.lower, queryToken);
        if (distance <= threshold && distance < bestDistance) {
          bestDistance = distance;
        }
      }

      if (Number.isFinite(bestDistance)) {
        hits.push({
          index: token.index,
          length: token.raw.length,
          matchedText: token.raw,
          score: 130 - (bestDistance * 15)
        });
      }
    }

    return hits;
  }

  function makeSnippet(text, startIndex, length) {
    const lead = 90;
    const tail = 130;
    const safeStart = Math.max(0, startIndex - lead);
    const safeEnd = Math.min(text.length, startIndex + length + tail);
    let snippet = text.slice(safeStart, safeEnd).trim();
    if (safeStart > 0) {
      snippet = "... " + snippet;
    }
    if (safeEnd < text.length) {
      snippet += " ...";
    }
    return snippet;
  }

  function highlightSnippet(snippet, term) {
    if (!term) {
      return escapeHtml(snippet);
    }
    const pattern = new RegExp("(" + escapeRegExp(term) + ")", "gi");
    return escapeHtml(snippet).replace(pattern, "<mark>$1</mark>");
  }

  function sortReadingOrder(left, right) {
    if (left.essayOrder !== right.essayOrder) {
      return left.essayOrder - right.essayOrder;
    }
    if (left.sectionOrder !== right.sectionOrder) {
      return left.sectionOrder - right.sectionOrder;
    }
    return left.index - right.index;
  }

  function sortRelevance(left, right) {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return sortReadingOrder(left, right);
  }

  function paginate(items, page, pageSize) {
    const total = items.length;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = total === 0 ? 0 : ((safePage - 1) * pageSize) + 1;
    const end = total === 0 ? 0 : Math.min(total, safePage * pageSize);
    const pageItems = total === 0 ? [] : items.slice(start - 1, end);

    return {
      page: safePage,
      pageSize,
      total,
      totalPages,
      start,
      end,
      items: pageItems
    };
  }

  function findOccurrencesInText(text, query, options) {
    const sourceText = String(text || "");
    const needle = String(query || "").trim();
    const settings = options || {};
    const mode = normalizeMode(settings.mode);
    const caseSensitive = Boolean(settings.caseSensitive);

    if (!needle) {
      return [];
    }

    const section = {
      text: sourceText,
      lowerText: sourceText.toLowerCase(),
      tokens: tokenizeWordSpans(sourceText)
    };

    if (mode === "exact_phrase") {
      return findExactPhraseOccurrences(section, needle, caseSensitive);
    }
    if (mode === "fuzzy") {
      return findFuzzyOccurrences(section, needle);
    }
    return findContainsOccurrences(section, needle, caseSensitive);
  }

  function buildSectionUrl(essaySlug, sectionNumber, query, options) {
    const settings = options || {};
    const params = new URLSearchParams();
    params.set("essay", essaySlug);
    params.set("section", String(sectionNumber));
    if (query) {
      params.set("q", query);
    }
    const occurrence = Number.parseInt(settings.occurrence, 10);
    if (Number.isFinite(occurrence) && occurrence > 0) {
      params.set("occ", String(occurrence));
    }
    const mode = normalizeMode(settings.mode);
    if (mode !== "contains") {
      params.set("mode", mode);
    }
    if (settings.caseSensitive) {
      params.set("case", "1");
    }
    return "section.html?" + params.toString();
  }

  function buildSearchUrl(rawState, options) {
    const settings = options || {};
    const scopeChoices = Array.isArray(settings.allowedScopes)
      ? settings.allowedScopes
      : [];
    const path = settings.path || "search.html";
    const state = normalizeState(rawState, scopeChoices);

    if (!state.query) {
      return path;
    }

    const params = new URLSearchParams();
    params.set("q", state.query);
    if (state.scope !== "all") {
      params.set("scope", state.scope);
    }
    if (state.mode !== "contains") {
      params.set("mode", state.mode);
    }
    if (state.sort !== "reading_order") {
      params.set("sort", state.sort);
    }
    if (state.caseSensitive) {
      params.set("case", "1");
    }
    if (state.page > 1) {
      params.set("page", String(state.page));
    }
    if (state.pageSize !== DEFAULT_PAGE_SIZE) {
      params.set("page_size", String(state.pageSize));
    }

    return path + "?" + params.toString();
  }

  function createSearchEngine(contentApi) {
    if (!contentApi) {
      throw new Error("Content API is required");
    }

    let indexPromise = null;

    async function buildIndex() {
      const essays = (await contentApi.loadEssays()).filter((essay) => essay.published !== false);
      const sections = [];

      for (let essayOrder = 0; essayOrder < essays.length; essayOrder += 1) {
        const essay = essays[essayOrder];
        const payload = await contentApi.loadEssaySections(essay.slug);

        for (let sectionOrder = 0; sectionOrder < payload.sections.length; sectionOrder += 1) {
          const section = payload.sections[sectionOrder];
          const display = contentApi.sectionDisplay(essay, section.sectionNumber);
          const text = section.searchableText || "";

          sections.push({
            essaySlug: essay.slug,
            essayTitle: essay.title,
            essaySummary: essay.summary || "",
            essayOrder,
            sectionNumber: section.sectionNumber,
            sectionOrder,
            sectionLabel: display.label,
            sectionTitle: display.title,
            sectionSearchLabel: display.searchLabel,
            text,
            lowerText: text.toLowerCase(),
            tokens: tokenizeWordSpans(text)
          });
        }
      }

      return { essays, sections };
    }

    async function ensureIndex() {
      if (!indexPromise) {
        indexPromise = buildIndex();
      }
      return indexPromise;
    }

    async function search(rawState, options) {
      const settings = options || {};
      const index = await ensureIndex();
      const allowedScopes = index.essays.map((essay) => essay.slug);
      const state = normalizeState(rawState, allowedScopes);

      const forcedScope = settings.forceEssaySlug ? String(settings.forceEssaySlug).trim() : "";
      const activeScope = forcedScope || state.scope;
      const sections = activeScope === "all"
        ? index.sections
        : index.sections.filter((section) => section.essaySlug === activeScope);

      if (!state.query) {
        return {
          state: {
            ...state,
            scope: activeScope || state.scope
          },
          hits: [],
          sectionCounts: [],
          essayCounts: [],
          totalHits: 0,
          totalSections: 0,
          totalEssays: 0,
          essays: index.essays
        };
      }

      const allHits = [];
      const sectionOccurrenceCounts = new Map();
      for (const section of sections) {
        const sectionHits = findOccurrencesInText(section.text, state.query, {
          mode: state.mode,
          caseSensitive: state.caseSensitive
        });

        for (const hit of sectionHits) {
          const sectionKey = section.essaySlug + ":" + String(section.sectionNumber);
          const occurrence = (sectionOccurrenceCounts.get(sectionKey) || 0) + 1;
          sectionOccurrenceCounts.set(sectionKey, occurrence);

          allHits.push({
            essaySlug: section.essaySlug,
            essayTitle: section.essayTitle,
            essaySummary: section.essaySummary,
            essayOrder: section.essayOrder,
            sectionNumber: section.sectionNumber,
            sectionOrder: section.sectionOrder,
            sectionLabel: section.sectionLabel,
            sectionTitle: section.sectionTitle,
            sectionSearchLabel: section.sectionSearchLabel,
            index: hit.index,
            length: hit.length,
            score: hit.score,
            occurrence,
            matchedText: hit.matchedText,
            snippet: makeSnippet(section.text, hit.index, hit.length)
          });
        }
      }

      const sortedHits = allHits
        .slice()
        .sort(state.sort === "relevance" ? sortRelevance : sortReadingOrder);

      const sectionCountsMap = new Map();
      const essayCountsMap = new Map();

      for (const hit of sortedHits) {
        const sectionKey = hit.essaySlug + ":" + String(hit.sectionNumber);
        const sectionCount = sectionCountsMap.get(sectionKey) || {
          essaySlug: hit.essaySlug,
          essayTitle: hit.essayTitle,
          essayOrder: hit.essayOrder,
          sectionNumber: hit.sectionNumber,
          sectionOrder: hit.sectionOrder,
          sectionSearchLabel: hit.sectionSearchLabel,
          count: 0
        };
        sectionCount.count += 1;
        sectionCountsMap.set(sectionKey, sectionCount);

        const essayCount = essayCountsMap.get(hit.essaySlug) || {
          essaySlug: hit.essaySlug,
          essayTitle: hit.essayTitle,
          essayOrder: hit.essayOrder,
          count: 0
        };
        essayCount.count += 1;
        essayCountsMap.set(hit.essaySlug, essayCount);
      }

      const sectionCounts = Array.from(sectionCountsMap.values()).sort((left, right) => {
        if (left.essayOrder !== right.essayOrder) {
          return left.essayOrder - right.essayOrder;
        }
        return left.sectionOrder - right.sectionOrder;
      });
      const essayCounts = Array.from(essayCountsMap.values()).sort((left, right) => left.essayOrder - right.essayOrder);

      return {
        state: {
          ...state,
          scope: activeScope || state.scope
        },
        hits: sortedHits,
        sectionCounts,
        essayCounts,
        totalHits: sortedHits.length,
        totalSections: sectionCounts.length,
        totalEssays: essayCounts.length,
        essays: index.essays
      };
    }

    return {
      ensureIndex,
      search
    };
  }

  window.RenaissanceSearch = {
    buildSearchUrl,
    DEFAULT_PAGE_SIZE,
    MODES,
    PAGE_SIZES,
    SORTS,
    buildSectionUrl,
    createSearchEngine,
    escapeHtml,
    findOccurrencesInText,
    highlightSnippet,
    normalizeMode,
    normalizePage,
    normalizePageSize,
    normalizeScope,
    normalizeSort,
    paginate,
    parseBooleanFlag
  };
})();
