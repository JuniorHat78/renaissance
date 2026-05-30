(function () {
  const MODES = ["contains", "exact_phrase", "fuzzy"];
  const SORTS = ["reading_order", "relevance"];
  const PAGE_SIZES = [25, 50, 100];
  const DEFAULT_PAGE_SIZE = 50;
  const MAX_SEARCH_CACHE_ENTRIES = 24;
  const MAX_FUZZY_QUERY_TOKENS = 8;
  const MAX_FUZZY_TOKEN_LENGTH = 48;
  const YIELD_EVERY_SECTIONS = 4;
  const FIELD_BOOSTS = {
    essay_title: 80,
    section_title: 60,
    section_label: 30,
    body: 0
  };

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

  function fuzzyBucketKey(length, first, last) {
    return String(length) + "\u001f" + first + "\u001f" + last;
  }

  function buildFuzzyBuckets(tokens) {
    const buckets = new Map();
    for (const token of tokens) {
      const value = token.lower;
      if (value.length < 3 || value.length > MAX_FUZZY_TOKEN_LENGTH) {
        continue;
      }

      const key = fuzzyBucketKey(value.length, value[0], value[value.length - 1]);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(token);
      } else {
        buckets.set(key, [token]);
      }
    }
    return buckets;
  }

  function fuzzyCandidatesForToken(section, queryToken) {
    if (!section.fuzzyBuckets) {
      return section.tokens || [];
    }

    const candidates = [];
    for (let length = queryToken.length - 1; length <= queryToken.length + 1; length += 1) {
      if (length < 3 || length > MAX_FUZZY_TOKEN_LENGTH) {
        continue;
      }

      const bucket = section.fuzzyBuckets.get(
        fuzzyBucketKey(length, queryToken[0], queryToken[queryToken.length - 1])
      );
      if (bucket) {
        candidates.push(...bucket);
      }
    }
    return candidates;
  }

  function boundedLevenshteinDistance(left, right, maxDistance) {
    if (left === right) {
      return 0;
    }
    if (!left.length) {
      return right.length;
    }
    if (!right.length) {
      return left.length;
    }
    if (Math.abs(left.length - right.length) > maxDistance) {
      return maxDistance + 1;
    }

    const previous = new Array(right.length + 1);
    const current = new Array(right.length + 1);

    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = column;
    }

    for (let row = 1; row <= left.length; row += 1) {
      current[0] = row;
      let rowBest = current[0];
      for (let column = 1; column <= right.length; column += 1) {
        const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
        current[column] = Math.min(
          previous[column] + 1,
          current[column - 1] + 1,
          previous[column - 1] + substitutionCost
        );
        rowBest = Math.min(rowBest, current[column]);
      }

      if (rowBest > maxDistance) {
        return maxDistance + 1;
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

    const queryTokens = Array.from(new Set(tokenizeQueryWords(trimmed).filter((token) =>
      token.length >= 3 && token.length <= MAX_FUZZY_TOKEN_LENGTH
    ))).slice(0, MAX_FUZZY_QUERY_TOKENS);
    if (!queryTokens.length) {
      return [];
    }

    const bestHits = new Map();
    for (const queryToken of queryTokens) {
      const threshold = fuzzyThreshold(queryToken.length);
      for (const token of fuzzyCandidatesForToken(section, queryToken)) {
        if (token.lower.length < 3 || token.lower.length > MAX_FUZZY_TOKEN_LENGTH) {
          continue;
        }

        const distance = boundedLevenshteinDistance(token.lower, queryToken, threshold);
        if (distance > threshold) {
          continue;
        }

        const key = String(token.index) + "\u001f" + token.raw;
        const previous = bestHits.get(key);
        if (!previous || distance < previous.distance) {
          bestHits.set(key, { token, distance });
        }
      }
    }

    return Array.from(bestHits.values())
      .sort((left, right) => left.token.index - right.token.index)
      .map(({ token, distance }) => ({
        index: token.index,
        length: token.raw.length,
        matchedText: token.raw,
        score: 130 - (distance * 15)
      }));
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
    const tokens = tokenizeWordSpans(sourceText);
    const section = {
      text: sourceText,
      lowerText: sourceText.toLowerCase(),
      tokens,
      fuzzyBuckets: buildFuzzyBuckets(tokens)
    };
    return findOccurrencesInTextRecord(section, query, options);
  }

  function findOccurrencesInSection(section, query, options) {
    const record = section || {};
    record.text = String(record.text || "");
    if (typeof record.lowerText !== "string") {
      record.lowerText = record.text.toLowerCase();
    }
    if (!Array.isArray(record.tokens)) {
      record.tokens = tokenizeWordSpans(record.text);
    }
    if (!record.fuzzyBuckets) {
      record.fuzzyBuckets = buildFuzzyBuckets(record.tokens);
    }
    return findOccurrencesInTextRecord(record, query, options);
  }

  function findOccurrencesInTextRecord(section, query, options) {
    const needle = String(query || "").trim();
    const settings = options || {};
    const mode = normalizeMode(settings.mode);
    const caseSensitive = Boolean(settings.caseSensitive);

    if (!needle) {
      return [];
    }

    if (mode === "exact_phrase") {
      return findExactPhraseOccurrences(section, needle, caseSensitive);
    }
    if (mode === "fuzzy") {
      return findFuzzyOccurrences(section, needle);
    }
    return findContainsOccurrences(section, needle, caseSensitive);
  }

  function searchField(field, text, query, options) {
    const sourceText = String(text || "");
    if (!sourceText) {
      return [];
    }
    const record = {
      text: sourceText,
      lowerText: sourceText.toLowerCase(),
      tokens: tokenizeWordSpans(sourceText)
    };
    record.fuzzyBuckets = buildFuzzyBuckets(record.tokens);
    const boost = FIELD_BOOSTS[field] || 0;
    return findOccurrencesInTextRecord(record, query, options).map((hit) => ({
      ...hit,
      field,
      score: hit.score + boost
    }));
  }

  function fieldSearchesForSection(section) {
    return [
      { field: "essay_title", text: section.essayTitle },
      { field: "section_title", text: section.sectionTitle },
      { field: "section_label", text: section.sectionLabel },
      { field: "body", text: section.text }
    ];
  }

  function searchSectionField(section, entry, query, options) {
    if (entry.field === "body") {
      return findOccurrencesInSection(section, query, options).map((hit) => ({
        ...hit,
        field: "body",
        score: hit.score + FIELD_BOOSTS.body
      }));
    }
    return searchField(entry.field, entry.text, query, options);
  }

  function snippetForHit(section, field, hit) {
    if (field === "body") {
      return makeSnippet(section.text, hit.index, hit.length);
    }
    const source = fieldSearchesForSection(section).find((entry) => entry.field === field);
    return source ? source.text : hit.matchedText;
  }

  function indexForHit(field, index) {
    if (field === "essay_title") {
      return -3000 + index;
    }
    if (field === "section_title") {
      return -2000 + index;
    }
    if (field === "section_label") {
      return -1000 + index;
    }
    return index;
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
    const resultCache = new Map();

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
          const tokens = tokenizeWordSpans(text);

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
            tokens,
            fuzzyBuckets: buildFuzzyBuckets(tokens)
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

    function cacheKeyForState(state, activeScope) {
      return [
        activeScope || state.scope,
        state.query,
        state.mode,
        state.sort,
        state.caseSensitive ? "1" : "0",
        String(state.page),
        String(state.pageSize)
      ].join("\u001f");
    }

    function rememberResult(key, result) {
      if (resultCache.has(key)) {
        resultCache.delete(key);
      }
      resultCache.set(key, result);
      while (resultCache.size > MAX_SEARCH_CACHE_ENTRIES) {
        const oldest = resultCache.keys().next().value;
        resultCache.delete(oldest);
      }
      return result;
    }

    function cachedResult(key) {
      if (!resultCache.has(key)) {
        return null;
      }
      const result = resultCache.get(key);
      resultCache.delete(key);
      resultCache.set(key, result);
      return result;
    }

    function yieldToBrowser() {
      return new Promise((resolve) => setTimeout(resolve, 0));
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

      const cacheKey = cacheKeyForState(state, activeScope);
      const cached = cachedResult(cacheKey);
      if (cached) {
        return cached;
      }

      const allHits = [];
      const sectionOccurrenceCounts = new Map();
      for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
        const section = sections[sectionIndex];
        if (sectionIndex > 0 && sectionIndex % YIELD_EVERY_SECTIONS === 0) {
          await yieldToBrowser();
        }

        const hitOptions = {
          mode: state.mode,
          caseSensitive: state.caseSensitive
        };
        const sectionHits = fieldSearchesForSection(section).flatMap((entry) =>
          searchSectionField(section, entry, state.query, hitOptions)
        );

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
            field: hit.field,
            index: indexForHit(hit.field, hit.index),
            length: hit.length,
            score: hit.score,
            occurrence,
            matchedText: hit.matchedText,
            snippet: snippetForHit(section, hit.field, hit)
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

      return rememberResult(cacheKey, {
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
      });
    }

    return {
      cacheSize() {
        return resultCache.size;
      },
      ensureIndex,
      search
    };
  }

  window.RenaissanceSearch = {
    buildSearchUrl,
    DEFAULT_PAGE_SIZE,
    FIELD_BOOSTS,
    MODES,
    PAGE_SIZES,
    SORTS,
    buildSectionUrl,
    createSearchEngine,
    escapeHtml,
    findOccurrencesInSection,
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
