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
    createSearchEngine,
    escapeHtml,
    highlightSnippet,
    normalizeMode
  } = window.RenaissanceSearch;
  const router = window.RenaissanceRouter;
  const {
    canonicalEssayUrl,
    setPageMetadata,
    socialImageForEssay,
    toAbsoluteUrl
  } = window.RenaissanceMeta;
  const readingState = window.RenaissanceReadingState;
  const recovery = window.RenaissanceRecovery;

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

  function announcePageReady() {
    window.dispatchEvent(new CustomEvent("renaissance:page-ready"));
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

    setPageMetadata({
      title,
      description,
      canonical,
      image
    });
  }

  function clearNode(element) {
    while (element && element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function makeActionLink(href, label, className) {
    const link = document.createElement("a");
    link.href = href;
    link.className = className;
    link.textContent = label;
    return link;
  }

  function setRobotsNoIndex() {
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement("meta");
      robots.setAttribute("name", "robots");
      document.head.appendChild(robots);
    }
    robots.setAttribute("content", "noindex");
  }

  function showEssayMessage(title, body, options) {
    const settings = options || {};
    const message = String(title || "Unable to load this essay.");
    const description = String(body || "The requested essay is not available.").trim();
    essayTitle.textContent = message;
    essaySummary.textContent = description;
    essaySummary.hidden = false;
    essayStats.textContent = "";
    clearNode(sectionList);

    const item = document.createElement("li");
    item.className = "muted";
    const paragraph = document.createElement("p");
    paragraph.textContent = settings.note || "Try a nearby drawer in the archive.";
    const actions = document.createElement("p");
    actions.className = "reader-message-actions";
    if (settings.closestEssay) {
      actions.appendChild(makeActionLink(
        router.build("essay", { essaySlug: settings.closestEssay.slug }),
        "Open " + settings.closestEssay.title,
        "button"
      ));
      actions.appendChild(document.createTextNode(" "));
    }
    if (settings.query) {
      actions.appendChild(makeActionLink(
        router.build("search", { query: settings.query }),
        "Search \"" + settings.query + "\"",
        settings.closestEssay ? "button button-ghost" : "button"
      ));
      actions.appendChild(document.createTextNode(" "));
    }
    actions.appendChild(makeActionLink(router.build("archive", {}), "Return to the archive", "button"));
    actions.appendChild(document.createTextNode(" "));
    actions.appendChild(makeActionLink(router.build("search", {}), "Search the essays", "button button-ghost"));
    item.appendChild(paragraph);
    item.appendChild(actions);
    sectionList.appendChild(item);

    setRobotsNoIndex();
    setPageMetadata({
      title: message + " \u00b7 Renaissance",
      description,
      canonical: toAbsoluteUrl(router.build("archive", {})),
      image: toAbsoluteUrl("assets/og-home.png")
    });
    clearSearchView();
  }

  function joinMetaParts(parts) {
    return parts
      .map((part) => '<span>' + escapeHtml(part) + "</span>")
      .join('<span class="meta-sep" aria-hidden="true">&middot;</span>');
  }

  function sectionUrl(slug, sectionNumber) {
    return router.build("section", { essaySlug: slug, sectionNumber });
  }

  function progressPercent(value) {
    return Math.max(1, Math.min(100, Math.round(Number(value || 0) * 100)));
  }

  function renderSectionProgress(essay, sectionNumber) {
    if (!readingState) {
      return "";
    }

    const record = readingState.getSectionRecord(essay.slug, sectionNumber);
    if (!record) {
      return "";
    }

    const percent = progressPercent(record.maxProgress || record.progress);
    const label = record.completed
      ? "Completed"
      : percent >= 4
        ? String(percent) + "% read"
        : "Started";
    const width = record.completed ? 100 : Math.max(8, Math.min(100, percent));
    const className = record.completed
      ? "chapter-item-progress is-complete"
      : "chapter-item-progress";

    return (
      '<span class="' + className + '">' +
        '<span class="chapter-item-progress-track" aria-hidden="true">' +
          '<span style="width: ' + String(width) + '%"></span>' +
        "</span>" +
        '<span class="chapter-item-progress-label">' + escapeHtml(label) + "</span>" +
      "</span>"
    );
  }

  function renderSectionList(essay, sections) {
    sectionList.innerHTML = sections
      .map((section) => {
        const display = sectionDisplay(essay, section.sectionNumber);
        const subtitleHtml = display.subtitle
          ? '<span class="chapter-item-subtitle">(' + escapeHtml(display.subtitle) + ")</span>"
          : "";
        const sectionStatsHtml = '<span class="chapter-item-meta">' + escapeHtml(formatWordCount(section.wordCount)) + "</span>";
        const progressHtml = renderSectionProgress(essay, section.sectionNumber);
        return (
          '<li class="toc-item">' +
            '<a href="' + sectionUrl(essay.slug, section.sectionNumber) + '">' +
              '<span class="chapter-item-number">' + escapeHtml(display.label.replace(/^Section\s+/i, "")) + "</span>" +
              '<span class="chapter-item-title-wrap">' +
                '<span class="chapter-item-title">' + escapeHtml(display.title) + "</span>" +
                subtitleHtml +
                sectionStatsHtml +
                progressHtml +
              "</span>" +
            "</a>" +
          "</li>"
        );
      })
      .join("");
  }

  function queryEssaySlug() {
    return router.parse().essaySlug;
  }

  function parseInitialSearchState() {
    const route = router.parse();
    return {
      query: route.query,
      mode: route.mode,
      caseSensitive: route.caseSensitive
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

    router.go("essay", {
      essaySlug,
      query: state.query,
      mode: state.mode,
      caseSensitive: state.caseSensitive
    }, { replace: true, throttle: true });
  }

  function clearSearchView() {
    searchPanel.hidden = true;
    searchHint.textContent = "Search preview is grouped by section and shows the first few hits.";
    searchResults.innerHTML = "";
    searchViewFull.href = currentEssay
      ? router.build("search", { scope: currentEssay.slug })
      : router.build("search", {});
  }

  function renderNoResults() {
    searchPanel.hidden = false;
    searchHint.textContent = "0 hits in 0 sections.";
    searchResults.innerHTML = '<p class="muted">No matches found.</p>';
    if (currentEssay) {
      searchViewFull.href = router.build("search", {
        query: state.query,
        scope: currentEssay.slug,
        mode: state.mode,
        caseSensitive: state.caseSensitive
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
        const sectionLink = router.build("section", {
          essaySlug: currentEssay.slug,
          sectionNumber: group.sectionNumber,
          query: state.query,
          mode: state.mode,
          caseSensitive: state.caseSensitive
        });
        const previewHitsHtml = group.hits
          .map((hit) => {
            const occurrenceLink = router.build("section", {
              essaySlug: currentEssay.slug,
              sectionNumber: hit.sectionNumber,
              query: state.query,
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

    searchViewFull.href = router.build("search", {
      query: state.query,
      scope: currentEssay.slug,
      mode: state.mode,
      caseSensitive: state.caseSensitive
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
      const message = String((error && error.message) || "");
      if (/essay not found/i.test(message)) {
        const requested = queryEssaySlug();
        const essays = await loadEssays().catch(() => []);
        const closest = recovery.closestEssay(essays, requested);
        const query = recovery.normalizeWords(requested).replace(/\s+/g, " ") || recovery.prettySlug(requested);
        showEssayMessage(
          "Essay not found.",
          "That essay shelf mark is not published here. The archive can still look for the nearest entry.",
          {
            closestEssay: closest,
            query,
            note: closest ? "This is the closest published essay I found." : "Search the archive for the missing shelf mark."
          }
        );
        return;
      }

      showEssayMessage(
        "Unable to load this essay.",
        "The essay could not be loaded right now. Try the archive or search page to keep reading."
      );
    } finally {
      announcePageReady();
    }
  }

  init();
})();
