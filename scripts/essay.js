(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const {
    formatReadDuration,
    formatWordCount,
    loadEssaySections,
    loadEssays,
    sectionDisplay
  } = window.RenaissanceContent;
  const {
    buildSearchUrl,
    buildSectionUrl,
    createSearchEngine,
    escapeHtml,
    highlightSnippet,
    normalizeMode,
    parseBooleanFlag
  } = window.RenaissanceSearch;

  const PREVIEW_LIMIT = 3;

  const essayTitle = document.getElementById("essay-title");
  const essaySummary = document.getElementById("essay-summary");
  const essayStats = document.getElementById("essay-stats");
  const sectionList = document.getElementById("section-list");

  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const searchHint = document.getElementById("search-hint");
  const searchResults = document.getElementById("search-results");
  const searchPanel = document.getElementById("search-panel");
  const searchViewFull = document.getElementById("search-view-full");

  const advancedToggle = document.getElementById("search-advanced-toggle");
  const advancedPanel = document.getElementById("search-advanced");
  const searchMode = document.getElementById("search-mode");
  const searchCase = document.getElementById("search-case");

  let currentEssay = null;
  let currentSections = [];
  let searchEngine = null;
  let debounceTimer = null;
  let searchRunId = 0;

  const state = {
    query: "",
    mode: "contains",
    caseSensitive: false
  };

  function siteRootUrl() {
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      try {
        const url = new URL(canonical.href);
        url.search = "";
        url.hash = "";
        url.pathname = url.pathname.replace(/[^/]*$/, "");
        return url.toString();
      } catch (error) {
        // Fall through to runtime URL fallback.
      }
    }

    const fallback = new URL("./", window.location.href);
    fallback.search = "";
    fallback.hash = "";
    return fallback.toString();
  }

  const SITE_ROOT = siteRootUrl();

  function toAbsoluteUrl(relativePath) {
    return new URL(relativePath, SITE_ROOT).toString();
  }

  function canonicalEssayUrl(slug) {
    return toAbsoluteUrl("essay.html?essay=" + encodeURIComponent(slug));
  }

  function setMetaByName(name, content) {
    const element = document.querySelector('meta[name="' + name + '"]');
    if (element) {
      element.setAttribute("content", content);
    }
  }

  function setMetaByProperty(property, content) {
    const element = document.querySelector('meta[property="' + property + '"]');
    if (element) {
      element.setAttribute("content", content);
    }
  }

  function setCanonical(url) {
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      canonical.setAttribute("href", url);
    }
  }

  function socialImageForEssay(essay) {
    const explicit = String((essay && essay.social_image) || "").trim();
    if (explicit) {
      return explicit;
    }
    return "assets/og-home.png";
  }

  function descriptionForEssay(essay) {
    const summary = String((essay && essay.summary) || "").trim();
    if (summary) {
      return summary;
    }
    return "Read " + String(essay.title || "this essay") + " on Renaissance.";
  }

  function applyEssayMetadata(essay) {
    const title = String(essay.title || "Essay").trim() + " | Renaissance";
    const description = descriptionForEssay(essay);
    const canonical = canonicalEssayUrl(essay.slug);
    const image = toAbsoluteUrl(socialImageForEssay(essay));

    document.title = title;
    setCanonical(canonical);
    setMetaByName("description", description);
    setMetaByProperty("og:title", title);
    setMetaByProperty("og:description", description);
    setMetaByProperty("og:url", canonical);
    setMetaByProperty("og:image", image);
    setMetaByName("twitter:title", title);
    setMetaByName("twitter:description", description);
    setMetaByName("twitter:image", image);
  }

  function joinMetaParts(parts) {
    return parts
      .map((part) => '<span>' + escapeHtml(part) + "</span>")
      .join('<span class="meta-sep" aria-hidden="true">&middot;</span>');
  }

  function sectionUrl(slug, sectionNumber) {
    return "section.html?essay=" + encodeURIComponent(slug) + "&section=" + String(sectionNumber);
  }

  function renderSectionList(essay, sections) {
    sectionList.innerHTML = sections
      .map((section) => {
        const display = sectionDisplay(essay, section.sectionNumber);
        const subtitleHtml = display.subtitle
          ? '<span class="chapter-item-subtitle">(' + escapeHtml(display.subtitle) + ")</span>"
          : "";
        const sectionStatsHtml = '<span class="chapter-item-meta">' + escapeHtml(formatWordCount(section.wordCount)) + "</span>";
        return (
          '<li class="toc-item">' +
            '<a href="' + sectionUrl(essay.slug, section.sectionNumber) + '">' +
              '<span class="chapter-item-number">' + escapeHtml(String(section.sectionNumber).padStart(2, "0")) + "</span>" +
              '<span class="chapter-item-title-wrap">' +
                '<span class="chapter-item-title">' + escapeHtml(display.title) + "</span>" +
                subtitleHtml +
                sectionStatsHtml +
              "</span>" +
            "</a>" +
          "</li>"
        );
      })
      .join("");
  }

  function queryEssaySlug() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("essay");
    return value ? value.trim() : "";
  }

  function parseInitialSearchState() {
    const params = new URLSearchParams(window.location.search);
    return {
      query: String(params.get("q") || "").trim(),
      mode: normalizeMode(params.get("mode")),
      caseSensitive: parseBooleanFlag(params.get("case"))
    };
  }

  function applyState(nextState) {
    state.query = String(nextState.query || "").trim();
    state.mode = normalizeMode(nextState.mode);
    state.caseSensitive = Boolean(nextState.caseSensitive);
  }

  function syncControlsFromState() {
    searchInput.value = state.query;
    searchMode.value = state.mode;
    searchCase.checked = state.caseSensitive;
  }

  function syncStateFromControls() {
    state.query = searchInput.value.trim();
    state.mode = normalizeMode(searchMode.value);
    state.caseSensitive = searchCase.checked;
  }

  function hasAdvancedState() {
    return state.mode !== "contains" || state.caseSensitive;
  }

  function setAdvancedOpen(isOpen) {
    advancedPanel.hidden = !isOpen;
    advancedToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function updateUrlState() {
    const essaySlug = currentEssay ? currentEssay.slug : queryEssaySlug();
    if (!essaySlug) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    params.set("essay", essaySlug);
    ["q", "mode", "case", "sort", "page", "page_size", "scope"].forEach((key) => params.delete(key));

    if (state.query) {
      params.set("q", state.query);
      if (state.mode !== "contains") {
        params.set("mode", state.mode);
      }
      if (state.caseSensitive) {
        params.set("case", "1");
      }
    }

    const next = "essay.html?" + params.toString();
    window.history.replaceState(null, "", next);
  }

  function clearSearchView() {
    searchPanel.hidden = true;
    searchHint.textContent = "Search preview is grouped by section and shows the first few hits.";
    searchResults.innerHTML = "";
    searchViewFull.href = currentEssay
      ? buildSearchUrl({ query: "", scope: currentEssay.slug })
      : "search.html";
  }

  function renderNoResults() {
    searchPanel.hidden = false;
    searchHint.textContent = "0 hits in 0 sections.";
    searchResults.innerHTML = '<p class="muted">No matches found.</p>';
    if (currentEssay) {
      searchViewFull.href = buildSearchUrl({
        query: state.query,
        scope: currentEssay.slug,
        mode: state.mode,
        caseSensitive: state.caseSensitive
      }, {
        allowedScopes: [currentEssay.slug]
      });
    }
  }

  function groupPreviewHits(result) {
    const groups = new Map();
    const hits = result.hits.slice().sort((left, right) => {
      if (left.sectionOrder !== right.sectionOrder) {
        return left.sectionOrder - right.sectionOrder;
      }
      return left.index - right.index;
    });

    for (const hit of hits) {
      const key = String(hit.sectionNumber);
      let group = groups.get(key);
      if (!group) {
        group = {
          sectionNumber: hit.sectionNumber,
          sectionOrder: hit.sectionOrder,
          sectionSearchLabel: hit.sectionSearchLabel,
          total: 0,
          hits: []
        };
        groups.set(key, group);
      }

      group.total += 1;
      if (group.hits.length < PREVIEW_LIMIT) {
        group.hits.push(hit);
      }
    }

    return Array.from(groups.values()).sort((left, right) => left.sectionOrder - right.sectionOrder);
  }

  function renderPreview(result) {
    searchPanel.hidden = false;

    const hitLabel = result.totalHits === 1 ? "1 hit" : String(result.totalHits) + " hits";
    const sectionLabel = result.totalSections === 1 ? "1 section" : String(result.totalSections) + " sections";
    searchHint.textContent = hitLabel + " in " + sectionLabel + ".";

    const grouped = groupPreviewHits(result);
    searchResults.innerHTML = grouped
      .map((group) => {
        const sectionCountCopy = group.total === 1 ? "1 hit" : String(group.total) + " hits";
        const sectionLink = buildSectionUrl(currentEssay.slug, group.sectionNumber, state.query, {
          mode: state.mode,
          caseSensitive: state.caseSensitive
        });
        const previewHitsHtml = group.hits
          .map((hit) => {
            const occurrenceLink = buildSectionUrl(currentEssay.slug, hit.sectionNumber, state.query, {
              occurrence: hit.occurrence,
              mode: state.mode,
              caseSensitive: state.caseSensitive
            });
            return (
              '<li class="search-preview-hit">' +
                '<a href="' + occurrenceLink + '">' +
                  '<span class="search-preview-hit-title">Occurrence ' + String(hit.occurrence) + "</span>" +
                  '<span class="search-preview-hit-snippet">' + highlightSnippet(hit.snippet, hit.matchedText) + "</span>" +
                "</a>" +
              "</li>"
            );
          })
          .join("");

        const remaining = group.total - group.hits.length;
        const remainingHtml = remaining > 0
          ? '<p class="search-preview-more muted">+' + String(remaining) + " more in this section</p>"
          : "";

        return (
          '<article class="search-preview-group">' +
            '<h3><a href="' + sectionLink + '">' + escapeHtml(group.sectionSearchLabel) + "</a></h3>" +
            '<p class="search-preview-meta muted">' + escapeHtml(sectionCountCopy) + "</p>" +
            '<ol class="search-preview-hit-list">' + previewHitsHtml + "</ol>" +
            remainingHtml +
          "</article>"
        );
      })
      .join("");

    searchViewFull.href = buildSearchUrl({
      query: state.query,
      scope: currentEssay.slug,
      mode: state.mode,
      caseSensitive: state.caseSensitive
    }, {
      allowedScopes: [currentEssay.slug]
    });
  }

  async function executeSearch() {
    syncStateFromControls();
    if (!state.query || !currentEssay) {
      clearSearchView();
      updateUrlState();
      return;
    }

    searchPanel.hidden = false;
    searchHint.textContent = "Searching...";

    const runId = ++searchRunId;
    let result;
    try {
      result = await searchEngine.search({
        query: state.query,
        mode: state.mode,
        scope: currentEssay.slug,
        caseSensitive: state.caseSensitive
      }, {
        forceEssaySlug: currentEssay.slug
      });
    } catch (error) {
      if (runId !== searchRunId) {
        return;
      }
      searchHint.textContent = "Search is unavailable right now.";
      searchResults.innerHTML = '<p class="muted">Unable to load search results.</p>';
      searchViewFull.href = "search.html";
      updateUrlState();
      return;
    }

    if (runId !== searchRunId) {
      return;
    }

    if (result.totalHits === 0) {
      renderNoResults();
      updateUrlState();
      return;
    }

    renderPreview(result);
    updateUrlState();
  }

  function scheduleSearch() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      executeSearch();
    }, 180);
  }

  function bindEvents() {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      executeSearch();
    });

    searchInput.addEventListener("input", () => {
      if (!searchInput.value.trim()) {
        state.query = "";
        clearSearchView();
        updateUrlState();
        return;
      }
      scheduleSearch();
    });

    [searchMode, searchCase].forEach((element) => {
      element.addEventListener("change", () => {
        executeSearch();
      });
    });

    advancedToggle.addEventListener("click", () => {
      setAdvancedOpen(advancedPanel.hidden);
    });
  }

  async function resolveEssaySlug() {
    const explicit = queryEssaySlug();
    if (explicit) {
      return explicit;
    }

    const essays = await loadEssays();
    if (!essays.length) {
      throw new Error("No essays available");
    }
    return essays[0].slug;
  }

  async function init() {
    initThemeToggle();
    bindEvents();
    searchEngine = createSearchEngine(window.RenaissanceContent);

    try {
      const essaySlug = await resolveEssaySlug();
      const payload = await loadEssaySections(essaySlug);
      currentEssay = payload.essay;
      currentSections = payload.sections;

      essayTitle.textContent = currentEssay.title;
      essaySummary.textContent = currentEssay.summary;
      essaySummary.hidden = !currentEssay.summary;
      const sectionCount = currentSections.length;
      const sectionLabel = sectionCount === 1 ? "1 section" : String(sectionCount) + " sections";
      essayStats.innerHTML = joinMetaParts([
        sectionLabel,
        formatWordCount(payload.stats.totalWords),
        formatReadDuration(payload.stats.totalReadMinutes)
      ]);
      renderSectionList(currentEssay, currentSections);
      applyEssayMetadata(currentEssay);

      applyState(parseInitialSearchState());
      syncControlsFromState();
      setAdvancedOpen(hasAdvancedState());

      if (state.query) {
        await executeSearch();
      } else {
        clearSearchView();
      }
    } catch (error) {
      essayTitle.textContent = "Unable to load this essay.";
      essaySummary.textContent = "";
      essaySummary.hidden = true;
      essayStats.textContent = "";
      sectionList.innerHTML = '<li class="muted">Sections unavailable.</li>';
      clearSearchView();
    }
  }

  init();
})();
