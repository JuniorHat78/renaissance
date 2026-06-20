(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const { loadEssays, sectionDisplay } = window.RenaissanceContent;
  const {
    escapeHtml,
    normalizeMode,
    normalizeScope
  } = window.RenaissanceSearch;
  const router = window.RenaissanceRouter;
  const readingState = window.RenaissanceReadingState;

  const continuePanel = document.getElementById("continue-reading-panel");
  const continueLink = document.getElementById("continue-reading-link");
  const continueTitle = document.getElementById("continue-reading-heading");
  const continueDetail = document.getElementById("continue-reading-detail");
  const continueStatus = document.getElementById("continue-reading-status");
  const continueMeter = document.getElementById("continue-reading-meter");
  const continueAction = document.getElementById("continue-reading-action");
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
  let debounceTimer = null;
  let searchRunId = 0;

  const state = {
    query: "",
    mode: "contains",
    scope: "all",
    caseSensitive: false
  };

  function announcePageReady() {
    window.dispatchEvent(new CustomEvent("renaissance:page-ready"));
  }

  function allowedScopes() {
    return publishedEssays.map((essay) => essay.slug);
  }

  function essayLink(slug) {
    return router.build("essay", { essaySlug: slug });
  }

  function progressPercent(value) {
    return Math.max(1, Math.min(99, Math.round(Number(value || 0) * 100)));
  }

  function renderContinueReading(essays) {
    if (!readingState || !continuePanel || !continueLink) {
      return;
    }

    const target = readingState.continueTarget(essays, { sectionDisplay });
    if (!target) {
      continuePanel.hidden = true;
      return;
    }

    continueLink.href = target.href;
    continueTitle.textContent = target.essay.title || "Renaissance";
    const setActionLabel = (label) => {
      if (!continueAction) {
        return;
      }
      continueAction.innerHTML =
        '<span class="continue-action-label">' + escapeHtml(label) + "</span>" +
        '<span class="continue-action-glyph" aria-hidden="true">&rsaquo;</span>';
    };

    if (target.action === "next") {
      continueDetail.textContent = "Next: " + target.sectionLabel + ", " + target.sectionTitle;
      continueStatus.textContent = "Up next";
      setActionLabel("Next");
      if (continueMeter) {
        continueMeter.style.width = "100%";
      }
    } else {
      // Attention progress (read words / total) is the honest "Continue
      // reading" number; scroll `progress` is the legacy fallback.
      const readValue = target.attentionProgress !== null && target.attentionProgress !== undefined
        ? target.attentionProgress
        : target.progress;
      const percent = progressPercent(readValue);
      continueDetail.textContent = target.sectionLabel + ", " + target.sectionTitle;
      continueStatus.textContent = String(percent) + "%";
      setActionLabel("Resume");
      if (continueMeter) {
        continueMeter.style.width = String(percent) + "%";
      }
    }

    continuePanel.hidden = false;
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
        const summaryHtml = essay.summary
          ? '<p class="essay-summary">' + escapeHtml(essay.summary) + "</p>"
          : "";
        return (
          '<li class="essay-item">' +
            '<a href="' + essayLink(essay.slug) + '">' +
              '<h3 class="essay-title">' + escapeHtml(essay.title) + "</h3>" +
              summaryHtml +
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
    const route = router.parse();
    return {
      query: route.query,
      mode: route.mode,
      scope: normalizeScope(route.scope, allowedScopes()),
      caseSensitive: route.caseSensitive
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
    router.go("archive", {
      query: state.query,
      scope: state.scope,
      mode: state.mode,
      caseSensitive: state.caseSensitive
    }, { replace: true, throttle: true });
  }

  function clearSearchView() {
    searchPanel.hidden = true;
    searchHint.textContent = "Search across all published essays.";
    searchResults.innerHTML = "";
    searchViewFull.href = router.build("search", {});
  }

  async function executeSearch() {
    syncStateFromControls();
    if (!state.query) {
      clearSearchView();
      updateUrlState();
      return;
    }

    searchPanel.hidden = false;
    const runId = ++searchRunId;

    const client = window.RenaissanceOracleClient;
    if (client && client.available()) {
      let ranked;
      try {
        ranked = await client.search(state.query, { scope: state.scope, limit: 8 });
      } catch (_error) {
        ranked = null;
      }
      if (runId !== searchRunId) {
        return;
      }
      if (ranked) {
        const count = ranked.totalMatched || 0;
        client.renderResults(searchResults, ranked, {
          query: state.query,
          limit: 8,
          emptyText: "Nothing matches “" + state.query + "”."
        });
        searchHint.textContent = count === 0 ? "" : count + (count === 1 ? " passage" : " passages");
        searchViewFull.href = router.build("search", { query: state.query, scope: state.scope });
        updateUrlState();
        return;
      }
    }

    searchHint.textContent = "Search is unavailable right now.";
    searchResults.innerHTML = '<p class="muted">Unable to load search results.</p>';
    searchViewFull.href = router.build("search", { query: state.query, scope: state.scope });
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

    // Oracle search has no modes; the old advanced controls are hidden.
    if (window.RenaissanceOracleClient && window.RenaissanceOracleClient.available()) {
      advancedToggle.hidden = true;
    }
  }

  async function init() {
    initThemeToggle();
    bindEvents();

    try {
      const essays = await loadEssays();
      publishedEssays = essays.filter((essay) => essay.published !== false);
      renderContinueReading(publishedEssays);
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
    } finally {
      announcePageReady();
    }
  }

  init();
})();
