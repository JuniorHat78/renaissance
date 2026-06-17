(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const { loadEssays } = window.RenaissanceContent;
  const {
    escapeHtml,
    normalizeMode,
    normalizePage,
    normalizePageSize,
    normalizeScope,
    normalizeSort
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
  const searchStatus = document.getElementById("search-page-status");

  let publishedEssays = [];
  let debounceTimer = null;
  let searchRunId = 0;

  const state = {
    query: "",
    mode: "contains",
    sort: "reading_order",
    scope: "all",
    caseSensitive: false,
    page: 1,
    pageSize: window.RenaissanceRouter.DEFAULT_PAGE_SIZE,
    // Advanced "show everything" mode: uncap the oracle's per-section limit and
    // render the full, grouped, self-explaining result set. Curated by default.
    exhaustive: false
  };

  function oracleMode() {
    return Boolean(window.RenaissanceOracleClient && window.RenaissanceOracleClient.available());
  }

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
      state.pageSize !== window.RenaissanceRouter.DEFAULT_PAGE_SIZE
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
    searchHint.textContent = "Enter a query to search all published essays.";
    searchCounts.innerHTML = "";
    searchResults.innerHTML = "";
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
        const searchOptions = state.exhaustive
          ? { scope: state.scope, perSection: Infinity, limit: 5000 }
          : { scope: state.scope, limit: 60 };
        ranked = await client.search(state.query, searchOptions);
      } catch (_error) {
        ranked = null;
      }
      if (runId !== searchRunId) {
        return;
      }
      if (ranked) {
        // Oracle-native: one relevance-ranked list. Curated by default (the
        // oracle's per-section cap keeps it tight); advanced mode uncaps it into
        // the full, section-grouped, self-explaining "show everything" view.
        //
        // SEAM: with a single essay, the cross-essay "map" is unnecessary. When
        // index.stats.essays > 1 and triage-across-essays earns its rent, the
        // re-entry point is the scope selector (already wired, auto-populated).
        const count = ranked.totalMatched || 0;
        searchCounts.textContent = "";
        searchPagination.hidden = true;
        client.renderResults(searchResults, ranked, {
          query: state.query,
          advanced: state.exhaustive,
          emptyText: "Nothing matches “" + state.query + "”."
        });
        const passages = count + (count === 1 ? " passage" : " passages");
        const hint = count === 0
          ? "No matches."
          : state.exhaustive
            ? "Everything: " + passages + " for “" + state.query + "”"
            : passages + " for “" + state.query + "”";
        searchHint.textContent = hint;
        searchStatus.textContent = hint;
        updateUrlState();
        return;
      }
    }

    if (runId !== searchRunId) {
      return;
    }

    searchHint.textContent = "Search is unavailable right now.";
    searchCounts.innerHTML = "";
    searchResults.innerHTML = '<p class="muted">Unable to load search results.</p>';
    searchStatus.textContent = "";
    searchPagination.hidden = true;
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

    advancedToggle.addEventListener("click", () => {
      if (oracleMode()) {
        setExhaustive(!state.exhaustive);
        return;
      }
      setAdvancedOpen(advancedPanel.hidden);
    });

    // In oracle mode the legacy mode/sort/page-size knobs are meaningless, so
    // the advanced toggle is repurposed into the "show everything" switch: one
    // click expands the curated list into every matching passage, grouped by
    // section with the oracle's ranking reasons shown. The legacy panel stays
    // closed; the toggle is a pressed-state button, not a disclosure.
    if (oracleMode()) {
      advancedPanel.hidden = true;
      advancedToggle.removeAttribute("aria-controls");
      advancedToggle.removeAttribute("aria-expanded");
      setExhaustive(state.exhaustive, { silent: true });
    }
  }

  function setExhaustive(on, options) {
    const settings = options || {};
    state.exhaustive = Boolean(on);
    advancedToggle.setAttribute("aria-pressed", state.exhaustive ? "true" : "false");
    advancedToggle.textContent = state.exhaustive ? "Show top matches" : "Show everything";
    if (!settings.silent && state.query) {
      state.page = 1;
      executeSearch();
    }
  }

  async function init() {
    initThemeToggle();
    bindEvents();

    try {
      const essays = await loadEssays();
      publishedEssays = essays.filter((essay) => essay.published !== false);
      populateScopeOptions(publishedEssays);

      applyState(parseInitialState());
      syncControlsFromState();
      // In oracle mode the legacy options panel is unused; the advanced toggle
      // is the "show everything" switch instead (set up in bindEvents).
      if (!oracleMode()) {
        setAdvancedOpen(hasAdvancedState());
      }

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
