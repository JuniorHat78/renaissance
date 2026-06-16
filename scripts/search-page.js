(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const { loadEssays } = window.RenaissanceContent;
  const {
    DEFAULT_PAGE_SIZE,
    createSearchEngine,
    escapeHtml,
    highlightSnippet,
    normalizeMode,
    normalizePage,
    normalizePageSize,
    normalizeScope,
    normalizeSort,
    paginate
  } = window.RenaissanceSearch;
  const router = window.RenaissanceRouter;

  const searchForm = document.getElementById("search-page-form");
  const searchInput = document.getElementById("search-page-input");
  const searchScope = document.getElementById("search-page-scope");
  const searchMode = document.getElementById("search-page-mode");
  const searchSort = document.getElementById("search-page-sort");
  const searchPageSize = document.getElementById("search-page-page-size");
  const searchCase = document.getElementById("search-page-case");
  const advancedToggle = document.getElementById("search-page-advanced-toggle");
  const advancedPanel = document.getElementById("search-page-advanced");

  const searchHint = document.getElementById("search-page-hint");
  const searchCounts = document.getElementById("search-page-counts");
  const searchResults = document.getElementById("search-page-results");
  const searchPagination = document.getElementById("search-page-pagination");
  const searchPrev = document.getElementById("search-page-prev");
  const searchNext = document.getElementById("search-page-next");
  const searchStatus = document.getElementById("search-page-status");

  let publishedEssays = [];
  let searchEngine = null;
  let latestResult = null;
  let debounceTimer = null;
  let searchRunId = 0;

  const state = {
    query: "",
    mode: "contains",
    sort: "reading_order",
    scope: "all",
    caseSensitive: false,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE
  };

  function announcePageReady() {
    window.dispatchEvent(new CustomEvent("renaissance:page-ready"));
  }

  function allowedScopes() {
    return publishedEssays.map((essay) => essay.slug);
  }

  function parseInitialState() {
    const route = router.parse();
    return {
      query: route.query,
      mode: route.mode,
      sort: route.sort,
      scope: normalizeScope(route.scope, allowedScopes()),
      caseSensitive: route.caseSensitive,
      page: route.page,
      pageSize: route.pageSize
    };
  }

  function applyState(nextState) {
    state.query = String(nextState.query || "").trim();
    state.mode = normalizeMode(nextState.mode);
    state.sort = normalizeSort(nextState.sort);
    state.scope = normalizeScope(nextState.scope, allowedScopes());
    state.caseSensitive = Boolean(nextState.caseSensitive);
    state.page = normalizePage(nextState.page);
    state.pageSize = normalizePageSize(nextState.pageSize);
  }

  function syncControlsFromState() {
    searchInput.value = state.query;
    searchScope.value = state.scope;
    searchMode.value = state.mode;
    searchSort.value = state.sort;
    searchPageSize.value = String(state.pageSize);
    searchCase.checked = state.caseSensitive;
  }

  function syncStateFromControls() {
    state.query = searchInput.value.trim();
    state.scope = normalizeScope(searchScope.value, allowedScopes());
    state.mode = normalizeMode(searchMode.value);
    state.sort = normalizeSort(searchSort.value);
    state.pageSize = normalizePageSize(searchPageSize.value);
    state.caseSensitive = searchCase.checked;
  }

  function hasAdvancedState() {
    return (
      state.scope !== "all" ||
      state.mode !== "contains" ||
      state.sort !== "reading_order" ||
      state.caseSensitive ||
      state.pageSize !== DEFAULT_PAGE_SIZE
    );
  }

  function setAdvancedOpen(isOpen) {
    advancedPanel.hidden = !isOpen;
    advancedToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function updateUrlState() {
    router.go("search", {
      query: state.query,
      scope: state.scope,
      mode: state.mode,
      sort: state.sort,
      caseSensitive: state.caseSensitive,
      page: state.page,
      pageSize: state.pageSize
    }, { replace: true, throttle: true });
  }

  function clearSearchView() {
    latestResult = null;
    searchHint.textContent = "Enter a query to search all published essays.";
    searchCounts.innerHTML = "";
    searchResults.innerHTML = "";
    searchStatus.textContent = "";
    searchPagination.hidden = true;
  }

  function renderSearchSummary(result) {
    const hitLabel = result.totalHits === 1 ? "1 hit" : String(result.totalHits) + " hits";
    const essayLabel = result.totalEssays === 1 ? "1 essay" : String(result.totalEssays) + " essays";
    const sectionLabel = result.totalSections === 1 ? "1 section" : String(result.totalSections) + " sections";
    searchHint.textContent = hitLabel + " in " + essayLabel + " and " + sectionLabel + ".";
  }

  function renderSearchCounts(result) {
    const maxRows = 16;
    const visible = result.sectionCounts.slice(0, maxRows);
    const rows = visible.map((entry) => {
      const countCopy = entry.count === 1 ? "1 hit" : String(entry.count) + " hits";
      const href = router.build("section", {
        essaySlug: entry.essaySlug,
        sectionNumber: entry.sectionNumber,
        query: state.query,
        mode: state.mode,
        caseSensitive: state.caseSensitive
      });
      return (
        '<p class="search-count-row">' +
          '<a href="' + href + '">' +
            escapeHtml(entry.essayTitle + " . " + entry.sectionSearchLabel) +
          "</a>" +
          '<span class="muted">' + escapeHtml(countCopy) + "</span>" +
        "</p>"
      );
    });

    if (result.sectionCounts.length > maxRows) {
      rows.push(
        '<p class="search-count-row search-count-row-note">' +
          '<span class="muted">More sections match this query.</span>' +
        "</p>"
      );
    }

    searchCounts.innerHTML = rows.join("");
  }

  function renderSearchPage(result) {
    const pageData = paginate(result.hits, state.page, state.pageSize);
    state.page = pageData.page;

    searchResults.innerHTML = pageData.items
      .map((hit) => {
        const resultTitle = hit.sectionSearchLabel + " . Occurrence " + String(hit.occurrence);
        const href = router.build("section", {
          essaySlug: hit.essaySlug,
          sectionNumber: hit.sectionNumber,
          passageId: hit.passageId,
          rangeStart: hit.rangeStart,
          rangeEnd: hit.rangeEnd,
          query: state.query,
          occurrence: hit.occurrence,
          mode: state.mode,
          caseSensitive: state.caseSensitive
        });
        return (
          '<article class="result-card">' +
            '<h3><a href="' + href + '">' +
              '<span class="search-result-kicker">' + escapeHtml(hit.essayTitle) + "</span>" +
              '<span class="search-result-title">' + escapeHtml(resultTitle) + "</span>" +
            "</a></h3>" +
            "<p>" + highlightSnippet(hit.snippet, hit.matchedText) + "</p>" +
          "</article>"
        );
      })
      .join("");

    searchStatus.textContent =
      "Showing " +
      String(pageData.start) +
      "-" +
      String(pageData.end) +
      " of " +
      String(pageData.total) +
      " results";
    searchPrev.disabled = pageData.page <= 1;
    searchNext.disabled = pageData.page >= pageData.totalPages;
    searchPagination.hidden = pageData.total <= 0;
  }

  function renderNoResults() {
    searchHint.textContent = "0 hits in 0 essays and 0 sections.";
    searchCounts.innerHTML = "";
    searchResults.innerHTML = '<p class="muted">No matches found.</p>';
    searchStatus.textContent = "";
    searchPagination.hidden = true;
  }

  async function executeSearch() {
    syncStateFromControls();
    if (!state.query) {
      clearSearchView();
      updateUrlState();
      return;
    }

    const runId = ++searchRunId;

    const client = window.RenaissanceOracleClient;
    if (client && client.available()) {
      let ranked;
      try {
        ranked = await client.search(state.query, { scope: state.scope, limit: 60 });
      } catch (_error) {
        ranked = null;
      }
      if (runId !== searchRunId) {
        return;
      }
      if (ranked) {
        // Oracle-native: one flat, relevance-ranked list. No mode/sort/page-size
        // knobs, no per-section counts rail, no pagination — the oracle ranks so
        // well that density became noise (see the sprint doc rationale).
        //
        // SEAM: with a single essay, the cross-essay "map" is unnecessary. When
        // index.stats.essays > 1 and triage-across-essays earns its rent, the
        // re-entry point is the scope selector (already wired, auto-populated) —
        // not a counts rail. Grow that spoke; don't resurrect the old density.
        const count = ranked.totalMatched || 0;
        searchCounts.textContent = "";
        searchPagination.hidden = true;
        client.renderResults(searchResults, ranked, {
          query: state.query,
          emptyText: "Nothing matches “" + state.query + "”."
        });
        const hint = count === 0
          ? "No matches."
          : count + (count === 1 ? " passage" : " passages") + " for “" + state.query + "”";
        searchHint.textContent = hint;
        searchStatus.textContent = hint;
        updateUrlState();
        return;
      }
    }

    // Fallback: legacy engine (oracle index unavailable, e.g. file:///offline).
    searchHint.textContent = "Searching...";
    let result;
    try {
      result = await searchEngine.search({
        query: state.query,
        mode: state.mode,
        sort: state.sort,
        scope: state.scope,
        caseSensitive: state.caseSensitive
      });
    } catch (error) {
      if (runId !== searchRunId) {
        return;
      }
      searchHint.textContent = "Search is unavailable right now.";
      searchCounts.innerHTML = "";
      searchResults.innerHTML = '<p class="muted">Unable to load search results.</p>';
      searchStatus.textContent = "";
      searchPagination.hidden = true;
      updateUrlState();
      return;
    }

    if (runId !== searchRunId) {
      return;
    }

    latestResult = result;
    state.scope = result.state.scope;
    searchScope.value = state.scope;

    if (result.totalHits === 0) {
      renderNoResults();
      updateUrlState();
      return;
    }

    renderSearchSummary(result);
    renderSearchCounts(result);
    renderSearchPage(result);
    updateUrlState();
  }

  function scheduleSearchWithReset() {
    state.page = 1;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      executeSearch();
    }, 180);
  }

  function populateScopeOptions(essays) {
    searchScope.innerHTML = ['<option value="all">All essays</option>']
      .concat(
        essays.map((essay) => '<option value="' + escapeHtml(essay.slug) + '">' + escapeHtml(essay.title) + "</option>")
      )
      .join("");
  }

  function bindEvents() {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.page = 1;
      executeSearch();
    });

    searchInput.addEventListener("input", () => {
      if (!searchInput.value.trim()) {
        state.query = "";
        clearSearchView();
        updateUrlState();
        return;
      }
      scheduleSearchWithReset();
    });

    [searchScope, searchMode, searchSort, searchPageSize, searchCase].forEach((element) => {
      element.addEventListener("change", () => {
        state.page = 1;
        executeSearch();
      });
    });

    searchPrev.addEventListener("click", () => {
      if (!latestResult) {
        return;
      }
      state.page = Math.max(1, state.page - 1);
      renderSearchPage(latestResult);
      updateUrlState();
    });

    searchNext.addEventListener("click", () => {
      if (!latestResult) {
        return;
      }
      state.page += 1;
      renderSearchPage(latestResult);
      updateUrlState();
    });

    advancedToggle.addEventListener("click", () => {
      setAdvancedOpen(advancedPanel.hidden);
    });

    // Oracle search is mode/sort/page-size-free; hide the advanced controls
    // unless we fall back to the legacy engine (file:// / offline).
    if (window.RenaissanceOracleClient && window.RenaissanceOracleClient.available()) {
      advancedToggle.hidden = true;
    }
  }

  async function init() {
    initThemeToggle();
    bindEvents();
    searchEngine = createSearchEngine(window.RenaissanceContent);

    try {
      const essays = await loadEssays();
      publishedEssays = essays.filter((essay) => essay.published !== false);
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
      clearSearchView();
      searchHint.textContent = "Search is unavailable right now.";
      searchResults.innerHTML = '<p class="muted">Unable to load search index.</p>';
    } finally {
      announcePageReady();
    }
  }

  init();
})();
