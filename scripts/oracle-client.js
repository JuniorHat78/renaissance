(function () {
  // Shared browser client for oracle search: loads the generated index + lexicon
  // once, ranks through the oracle, and renders a single clean, relevance-first
  // result list. Every search surface (essay inline, home inline, full search)
  // uses this, so they share one ranking truth and one look. DOM is built with
  // nodes (no HTML strings), so it stays clear of the HTML-sink guard.
  const oracle = window.RenaissanceOracle;
  const router = window.RenaissanceRouter;

  let dataPromise = null;

  function loadData() {
    if (!dataPromise) {
      dataPromise = Promise.all([
        fetch("data/search-index.json").then((response) => (response.ok ? response.json() : null)),
        fetch("data/search-lexicon.json").then((response) => (response.ok ? response.json() : null)).catch(() => null)
      ])
        .then(([index, lexicon]) => ({ index, lexicon }))
        .catch(() => ({ index: null, lexicon: null }));
    }
    return dataPromise;
  }

  // Returns an oracle ranking, or null when the index is unavailable (e.g.
  // offline before precache, or file://) so callers can fall back.
  async function search(query, context) {
    const { index, lexicon } = await loadData();
    if (!index || !oracle) {
      return null;
    }
    return oracle.rank(index, query, Object.assign({ lexicon }, context || {}));
  }

  function buildHref(result, query) {
    if (result.kind === "essay") {
      return router.build("essay", { essaySlug: result.essaySlug });
    }
    return router.build("section", {
      essaySlug: result.essaySlug,
      sectionNumber: result.sectionNumber,
      passageId: result.passageId,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      query
    });
  }

  function whereLabel(result) {
    if (result.kind === "essay") {
      return result.essayTitle;
    }
    const section = "§" + result.sectionNumber;
    return result.sectionTitle ? section + " · " + result.sectionTitle : section;
  }

  // Append a snippet with the matched span wrapped in <mark>.
  function appendSnippet(target, snippet) {
    const text = (snippet && snippet.text) || "";
    const highlight = snippet && snippet.highlight;
    if (highlight && highlight.length > 0 && highlight.start >= 0 && highlight.start + highlight.length <= text.length) {
      target.append(text.slice(0, highlight.start));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(highlight.start, highlight.start + highlight.length);
      target.append(mark);
      target.append(text.slice(highlight.start + highlight.length));
    } else {
      target.textContent = text;
    }
  }

  function resultRow(result, query) {
    const row = document.createElement("a");
    row.className = "oracle-result";
    row.href = buildHref(result, query);
    row.dataset.kind = result.kind;

    const where = document.createElement("span");
    where.className = "oracle-result-where";
    where.textContent = whereLabel(result);
    row.appendChild(where);

    if (result.snippet && result.snippet.text) {
      const snippet = document.createElement("span");
      snippet.className = "oracle-result-snippet";
      appendSnippet(snippet, result.snippet);
      row.appendChild(snippet);
    }
    return row;
  }

  // Render a relevance-ranked list into container. options: { query, limit,
  // emptyText }. Returns the number of rows rendered.
  function renderResults(container, ranked, options) {
    const settings = options || {};
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    const results = ranked && Array.isArray(ranked.results) ? ranked.results : [];
    const shown = typeof settings.limit === "number" ? results.slice(0, settings.limit) : results;

    if (!shown.length) {
      if (settings.emptyText) {
        const empty = document.createElement("p");
        empty.className = "oracle-empty";
        empty.textContent = settings.emptyText;
        container.appendChild(empty);
      }
      return 0;
    }

    const list = document.createElement("div");
    list.className = "oracle-results";
    for (const result of shown) {
      list.appendChild(resultRow(result, settings.query));
    }
    container.appendChild(list);
    return shown.length;
  }

  window.RenaissanceOracleClient = {
    available: () => Boolean(oracle),
    loadData,
    search,
    renderResults
  };
})();
