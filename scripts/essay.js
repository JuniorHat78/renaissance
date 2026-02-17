(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const {
    formatReadDuration,
    formatWordCount,
    loadEssaySections,
    loadEssays,
    sectionDisplay
  } = window.RenaissanceContent;

  const essayTitle = document.getElementById("essay-title");
  const essaySummary = document.getElementById("essay-summary");
  const essayStats = document.getElementById("essay-stats");
  const sectionList = document.getElementById("section-list");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const searchHint = document.getElementById("search-hint");
  const searchCounts = document.getElementById("search-counts");
  const searchResults = document.getElementById("search-results");

  let currentEssay = null;
  let currentSections = [];

  function escapeHtml(text) {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function joinMetaParts(parts) {
    return parts
      .map((part) => '<span>' + escapeHtml(part) + "</span>")
      .join('<span class="meta-sep" aria-hidden="true">·</span>');
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

  function findAllOccurrences(haystack, needle) {
    const indexes = [];
    if (!needle) {
      return indexes;
    }

    let fromIndex = 0;
    while (true) {
      const index = haystack.indexOf(needle, fromIndex);
      if (index === -1) {
        break;
      }

      indexes.push(index);
      fromIndex = index + needle.length;
    }

    return indexes;
  }

  function makeSnippet(text, startIndex, needleLength) {
    const lead = 90;
    const tail = 130;
    const safeStart = Math.max(0, startIndex - lead);
    const safeEnd = Math.min(text.length, startIndex + needleLength + tail);

    let snippet = text.slice(safeStart, safeEnd).trim();
    if (safeStart > 0) {
      snippet = "... " + snippet;
    }
    if (safeEnd < text.length) {
      snippet += " ...";
    }
    return snippet;
  }

  function highlightSnippet(snippet, query) {
    if (!query) {
      return escapeHtml(snippet);
    }

    const pattern = new RegExp("(" + escapeRegExp(query) + ")", "gi");
    return escapeHtml(snippet).replace(pattern, "<mark>$1</mark>");
  }

  function clearSearchResults() {
    searchCounts.innerHTML = "";
    searchResults.innerHTML = "";
    searchHint.textContent = "Search runs within this essay and returns one row per occurrence.";
  }

  function searchEssay(query) {
    const term = query.trim().toLowerCase();
    if (!term) {
      clearSearchResults();
      return;
    }

    const sectionCounts = [];
    const hits = [];

    for (const section of currentSections) {
      const source = section.searchableText;
      const lower = source.toLowerCase();
      const indexes = findAllOccurrences(lower, term);

      if (indexes.length === 0) {
        continue;
      }

      sectionCounts.push({
        sectionNumber: section.sectionNumber,
        count: indexes.length
      });

      indexes.forEach((index, offset) => {
        hits.push({
          sectionNumber: section.sectionNumber,
          occurrence: offset + 1,
          index,
          snippet: makeSnippet(source, index, term.length)
        });
      });
    }

    if (hits.length === 0) {
      searchCounts.innerHTML = "";
      searchResults.innerHTML = '<p class="muted">No matches found.</p>';
      searchHint.textContent = "0 hits in 0 sections.";
      return;
    }

    searchHint.textContent =
      String(hits.length) +
      (hits.length === 1 ? " hit" : " hits") +
      " in " +
      String(sectionCounts.length) +
      (sectionCounts.length === 1 ? " section." : " sections.");

    searchCounts.innerHTML = sectionCounts
      .map((entry) => {
        const display = sectionDisplay(currentEssay, entry.sectionNumber);
        const countLabel = entry.count === 1 ? "1 hit" : String(entry.count) + " hits";
        return (
          '<p class="search-count-row">' +
            '<a href="' + sectionUrl(currentEssay.slug, entry.sectionNumber) + '">' + escapeHtml(display.searchLabel) + "</a>" +
            '<span class="muted">' + escapeHtml(countLabel) + "</span>" +
          "</p>"
        );
      })
      .join("");

    searchResults.innerHTML = hits
      .map((hit) => {
        const display = sectionDisplay(currentEssay, hit.sectionNumber);
        return (
          '<article class="result-card">' +
            '<h3><a href="' + sectionUrl(currentEssay.slug, hit.sectionNumber) + '">' +
              '<span class="search-result-kicker">' + escapeHtml(display.searchLabel) + "</span>" +
              '<span class="search-result-title">Occurrence ' + String(hit.occurrence) + "</span>" +
            "</a></h3>" +
            "<p>" + highlightSnippet(hit.snippet, term) + "</p>" +
          "</article>"
        );
      })
      .join("");
  }

  function bindSearch() {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      searchEssay(searchInput.value);
    });

    searchInput.addEventListener("input", () => {
      if (!searchInput.value.trim()) {
        clearSearchResults();
      }
    });
  }

  function queryEssaySlug() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("essay");
    return value ? value.trim() : "";
  }

  function querySearchTerm() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("q");
    return value ? value.trim() : "";
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
    bindSearch();

    try {
      const essaySlug = await resolveEssaySlug();
      const payload = await loadEssaySections(essaySlug);
      currentEssay = payload.essay;
      currentSections = payload.sections;

      essayTitle.textContent = currentEssay.title;
      essaySummary.textContent = currentEssay.summary;
      const sectionCount = currentSections.length;
      const sectionLabel = sectionCount === 1 ? "1 section" : String(sectionCount) + " sections";
      essayStats.innerHTML = joinMetaParts([
        sectionLabel,
        formatWordCount(payload.stats.totalWords),
        formatReadDuration(payload.stats.totalReadMinutes)
      ]);
      renderSectionList(currentEssay, currentSections);
      document.title = currentEssay.title + " | Renaissance";

      const initialTerm = querySearchTerm();
      if (initialTerm) {
        searchInput.value = initialTerm;
        searchEssay(initialTerm);
      } else {
        clearSearchResults();
      }
    } catch (error) {
      essayTitle.textContent = "Unable to load this essay.";
      essaySummary.textContent = "";
      essayStats.textContent = "";
      sectionList.innerHTML = '<li class="muted">Sections unavailable.</li>';
      clearSearchResults();
    }
  }

  init();
})();
