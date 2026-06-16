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
  // offline before precache, or file://) so callers can fall back. A `scope`
  // of an essay slug restricts results to that essay (used by essay/home
  // inline search); "all" or absent searches everything.
  async function search(query, context) {
    const ctx = context || {};
    const { index, lexicon } = await loadData();
    if (!index || !oracle) {
      return null;
    }
    const ranked = oracle.rank(index, query, Object.assign({ lexicon }, ctx));
    if (ctx.scope && ctx.scope !== "all") {
      const results = ranked.results.filter((result) => result.essaySlug === ctx.scope);
      return { query: ranked.query, results, totalMatched: results.length };
    }
    return ranked;
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

  function sectionHref(result, query) {
    return router.build("section", {
      essaySlug: result.essaySlug,
      sectionNumber: result.sectionNumber,
      query
    });
  }

  // The oracle attaches the reasons a result scored ({label, points}); advanced
  // mode shows them so the ranking explains itself ("term: sand +18 · pull
  // quote +6"). Built as text nodes — no HTML strings.
  function appendReasons(row, result) {
    if (!Array.isArray(result.reasons) || !result.reasons.length) {
      return;
    }
    const reasons = document.createElement("span");
    reasons.className = "oracle-result-reasons";
    result.reasons.forEach((item, position) => {
      const chip = document.createElement("span");
      chip.className = "oracle-reason";
      const points = Number(item.points);
      chip.textContent = item.label + (Number.isFinite(points) ? " +" + points : "");
      reasons.appendChild(chip);
      if (position < result.reasons.length - 1) {
        reasons.appendChild(document.createTextNode(" · "));
      }
    });
    row.appendChild(reasons);
  }

  function resultRow(result, query, rowOptions) {
    const opts = rowOptions || {};
    const row = document.createElement("a");
    row.className = "oracle-result";
    row.href = buildHref(result, query);
    row.dataset.kind = result.kind;

    if (!opts.hideWhere) {
      const where = document.createElement("span");
      where.className = "oracle-result-where";
      where.textContent = whereLabel(result);
      row.appendChild(where);
    }

    if (result.snippet && result.snippet.text) {
      const snippet = document.createElement("span");
      snippet.className = "oracle-result-snippet";
      appendSnippet(snippet, result.snippet);
      row.appendChild(snippet);
    }

    if (opts.showReasons) {
      appendReasons(row, result);
    }
    return row;
  }

  function passageCountLabel(count) {
    return String(count) + (count === 1 ? " passage" : " passages");
  }

  // Advanced "show everything" view: group the (uncapped) results by section in
  // ranked order, with a per-section count and the self-explaining reasons on
  // each row. Within a group rows stay in ranked order; groups appear in the
  // order their best result ranked.
  function renderGrouped(container, results, query) {
    const groups = [];
    const byKey = new Map();
    for (const result of results) {
      const key = result.essaySlug + "#" + result.sectionNumber;
      let group = byKey.get(key);
      if (!group) {
        group = { key, lead: result, items: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.items.push(result);
    }

    const wrap = document.createElement("div");
    wrap.className = "oracle-groups";

    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "oracle-group";

      const header = document.createElement("a");
      header.className = "oracle-group-header";
      header.href = sectionHref(group.lead, query);

      const where = document.createElement("span");
      where.className = "oracle-group-where";
      where.textContent = group.lead.essayTitle + " · " + whereLabel(group.lead);
      header.appendChild(where);

      const count = document.createElement("span");
      count.className = "oracle-group-count";
      count.textContent = passageCountLabel(group.items.length);
      header.appendChild(count);

      section.appendChild(header);

      const list = document.createElement("div");
      list.className = "oracle-results";
      for (const result of group.items) {
        list.appendChild(resultRow(result, query, { showReasons: true, hideWhere: true }));
      }
      section.appendChild(list);
      wrap.appendChild(section);
    }

    container.appendChild(wrap);
    return results.length;
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

    if (settings.advanced) {
      return renderGrouped(container, shown, settings.query);
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
