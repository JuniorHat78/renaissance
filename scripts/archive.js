(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const { loadEssays } = window.RenaissanceContent;
  const {
    buildSearchUrl,
    buildSectionUrl,
    createSearchEngine,
    escapeHtml,
    highlightSnippet,
    normalizeMode,
    normalizeScope,
    parseBooleanFlag
  } = window.RenaissanceSearch;

  const PREVIEW_LIMIT = 3;

  const essayList = document.getElementById("essay-list");
  const searchForm = document.getElementById("global-search-form");
  const searchInput = document.getElementById("global-search-input");
  const advancedToggle = document.getElementById("global-search-advanced-toggle");
  const advancedPanel = document.getElementById("global-search-advanced");
  const searchScope = document.getElementById("global-search-scope");
  const searchMode = document.getElementById("global-search-mode");
  const searchCase = document.getElementById("global-search-case");
  const searchPanel = document.getElementById("global-search-panel");
  const searchHint = document.getElementById("global-search-hint");
  const searchResults = document.getElementById("global-search-results");
  const searchViewFull = document.getElementById("global-search-view-full");

  let publishedEssays = [];
  let searchEngine = null;
  let debounceTimer = null;
  let searchRunId = 0;

  const state = {
    query: "",
    mode: "contains",
    scope: "all",
    caseSensitive: false
  };

  function allowedScopes() {
    return publishedEssays.map((essay) => essay.slug);
  }

  function essayLink(slug) {
    return "essay.html?essay=" + encodeURIComponent(slug);
  }

  function renderEssays(essays) {
    if (!essays.length) {
      essayList.innerHTML = '<li class="muted">No essays published yet.</li>';
      return;
    }

    essayList.innerHTML = essays
      .map((essay) => {
        const sectionCount = essay.section_order.length;
        const sectionCopy = sectionCount === 1 ? "1 section" : String(sectionCount) + " sections";
        return (
          '<li class="essay-item">' +
            '<a href="' + essayLink(essay.slug) + '">' +
              '<h3 class="essay-title">' + escapeHtml(essay.title) + "</h3>" +
              '<p class="essay-summary">' + escapeHtml(essay.summary || "") + "</p>" +
              '<p class="essay-meta">' + escapeHtml(sectionCopy) + "</p>" +
            "</a>" +
          "</li>"
        );
      })
      .join("");
  }

  function populateScopeOptions(essays) {
    searchScope.innerHTML = ['<option value="all">All essays</option>']
      .concat(
        essays.map((essay) => '<option value="' + escapeHtml(essay.slug) + '">' + escapeHtml(essay.title) + "</option>")
      )
      .join("");
  }

  function parseInitialState() {
    const params = new URLSearchParams(window.location.search);
    return {
      query: String(params.get("q") || "").trim(),
      mode: normalizeMode(params.get("mode")),
      scope: normalizeScope(params.get("scope"), allowedScopes()),
      caseSensitive: parseBooleanFlag(params.get("case"))
    };
  }

  function applyState(nextState) {
    state.query = String(nextState.query || "").trim();
    state.mode = normalizeMode(nextState.mode);
    state.scope = normalizeScope(nextState.scope, allowedScopes());
    state.caseSensitive = Boolean(nextState.caseSensitive);
  }

  function syncControlsFromState() {
    searchInput.value = state.query;
    searchMode.value = state.mode;
    searchScope.value = state.scope;
    searchCase.checked = state.caseSensitive;
  }

  function syncStateFromControls() {
    state.query = searchInput.value.trim();
    state.mode = normalizeMode(searchMode.value);
    state.scope = normalizeScope(searchScope.value, allowedScopes());
    state.caseSensitive = searchCase.checked;
  }

  function hasAdvancedState() {
    return state.mode !== "contains" || state.scope !== "all" || state.caseSensitive;
  }

  function setAdvancedOpen(isOpen) {
    advancedPanel.hidden = !isOpen;
    advancedToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function updateUrlState() {
    const params = new URLSearchParams(window.location.search);
    ["q", "mode", "scope", "case", "sort", "page", "page_size"].forEach((key) => params.delete(key));

    if (state.query) {
      params.set("q", state.query);
      if (state.scope !== "all") {
        params.set("scope", state.scope);
      }
      if (state.mode !== "contains") {
        params.set("mode", state.mode);
      }
      if (state.caseSensitive) {
        params.set("case", "1");
      }
    }

    const query = params.toString();
    const nextUrl = window.location.pathname + (query ? "?" + query : "");
    window.history.replaceState(null, "", nextUrl);
  }

  function clearSearchView() {
    searchPanel.hidden = true;
    searchHint.textContent = "Search across all published essays.";
    searchResults.innerHTML = "";
    searchViewFull.href = "search.html";
  }

  function renderNoResults() {
    searchPanel.hidden = false;
    searchHint.textContent = "0 hits in 0 essays and 0 sections.";
    searchResults.innerHTML = '<p class="muted">No matches found.</p>';
    searchViewFull.href = buildSearchUrl({
      query: state.query,
      scope: state.scope,
      mode: state.mode,
      caseSensitive: state.caseSensitive
    }, {
      allowedScopes: allowedScopes()
    });
  }

  function readingOrder(left, right) {
    if (left.essayOrder !== right.essayOrder) {
      return left.essayOrder - right.essayOrder;
    }
    if (left.sectionOrder !== right.sectionOrder) {
      return left.sectionOrder - right.sectionOrder;
    }
    return left.index - right.index;
  }

  function groupPreviewHits(result) {
    const groups = new Map();
    const hits = result.hits.slice().sort(readingOrder);

    for (const hit of hits) {
      const key = hit.essaySlug + ":" + String(hit.sectionNumber);
      let group = groups.get(key);
      if (!group) {
        group = {
          essaySlug: hit.essaySlug,
          essayTitle: hit.essayTitle,
          essayOrder: hit.essayOrder,
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

    return Array.from(groups.values()).sort((left, right) => {
      if (left.essayOrder !== right.essayOrder) {
        return left.essayOrder - right.essayOrder;
      }
      return left.sectionOrder - right.sectionOrder;
    });
  }

  function renderPreview(result) {
    searchPanel.hidden = false;

    const hitLabel = result.totalHits === 1 ? "1 hit" : String(result.totalHits) + " hits";
    const essayLabel = result.totalEssays === 1 ? "1 essay" : String(result.totalEssays) + " essays";
    const sectionLabel = result.totalSections === 1 ? "1 section" : String(result.totalSections) + " sections";
    searchHint.textContent = hitLabel + " in " + essayLabel + " and " + sectionLabel + ".";

    const grouped = groupPreviewHits(result);
    searchResults.innerHTML = grouped
      .map((group) => {
        const sectionCountCopy = group.total === 1 ? "1 hit" : String(group.total) + " hits";
        const sectionLink = buildSectionUrl(group.essaySlug, group.sectionNumber, state.query, {
          mode: state.mode,
          caseSensitive: state.caseSensitive
        });
        const previewHitsHtml = group.hits
          .map((hit) => {
            const occurrenceLink = buildSectionUrl(hit.essaySlug, hit.sectionNumber, state.query, {
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
            '<h3>' +
              '<a href="' + sectionLink + '">' + escapeHtml(group.essayTitle + " . " + group.sectionSearchLabel) + "</a>" +
            "</h3>" +
            '<p class="search-preview-meta muted">' + escapeHtml(sectionCountCopy) + "</p>" +
            '<ol class="search-preview-hit-list">' + previewHitsHtml + "</ol>" +
            remainingHtml +
          "</article>"
        );
      })
      .join("");

    searchViewFull.href = buildSearchUrl({
      query: state.query,
      scope: state.scope,
      mode: state.mode,
      caseSensitive: state.caseSensitive
    }, {
      allowedScopes: allowedScopes()
    });
  }

  async function executeSearch() {
    syncStateFromControls();
    if (!state.query) {
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
        scope: state.scope,
        caseSensitive: state.caseSensitive
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

    state.scope = result.state.scope;
    searchScope.value = state.scope;

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

    [searchMode, searchScope, searchCase].forEach((element) => {
      element.addEventListener("change", () => {
        executeSearch();
      });
    });

    advancedToggle.addEventListener("click", () => {
      setAdvancedOpen(advancedPanel.hidden);
    });
  }

  async function init() {
    initThemeToggle();
    bindEvents();
    searchEngine = createSearchEngine(window.RenaissanceContent);

    try {
      const essays = await loadEssays();
      publishedEssays = essays.filter((essay) => essay.published !== false);
      renderEssays(publishedEssays);
      populateScopeOptions(publishedEssays);

      applyState(parseInitialState());
      syncControlsFromState();
      setAdvancedOpen(hasAdvancedState());

      if (state.query) {
        await executeSearch();
      } else {
        clearSearchView();
      }
    } catch (error) {
      essayList.innerHTML = '<li class="muted">Unable to load essays.</li>';
      clearSearchView();
    }
  }

  init();
})();
