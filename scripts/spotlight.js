(function () {
  const content = window.RenaissanceContent;
  const Search = window.RenaissanceSearch;
  const router = window.RenaissanceRouter;
  const readingState = window.RenaissanceReadingState;
  const oracle = window.RenaissanceOracle;

  if (!content || !Search || !router) {
    return;
  }

  const MAX_RESULTS = 9;
  const DEBOUNCE_MS = 80;
  const WARMUP_DELAY_MS = 1600;
  const WARMUP_IDLE_TIMEOUT_MS = 9000;
  const ROMAN_VALUES = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10
  };

  let engine = null;
  let oracleIndexPromise = null;
  let lexicon = null;
  let essaysPromise = null;
  let publishedEssays = [];
  let root = null;
  let input = null;
  let list = null;
  let status = null;
  let activeIndex = 0;
  let activeResults = [];
  let lastFocus = null;
  let debounceTimer = null;
  let searchRunId = 0;
  let warmupStarted = false;
  const prefetchedHrefs = new Set();

  function escapeHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizeSpaces(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isEditableTarget(element) {
    if (!element) {
      return false;
    }
    const tag = String(element.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
  }

  function ensureEngine() {
    if (!engine) {
      engine = Search.createSearchEngine(content);
    }
    return engine;
  }

  function queueIdleTask(task, timeout) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(task, { timeout: timeout || WARMUP_IDLE_TIMEOUT_MS });
      return;
    }
    window.setTimeout(task, 0);
  }

  function constrainedConnection() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection) {
      return false;
    }
    return Boolean(connection.saveData) || connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
  }

  function warmSpotlight() {
    if (warmupStarted || constrainedConnection()) {
      return;
    }
    warmupStarted = true;
    loadPublishedEssays()
      .then(() => ensureEngine().search({
        query: "__renaissance_warmup__",
        mode: "contains",
        sort: "relevance",
        scope: "all",
        caseSensitive: false,
        page: 1,
        pageSize: 25
      }))
      .catch(() => {
        // The visible search path has its own error fallback.
      });
  }

  function scheduleWarmup() {
    const start = () => {
      window.setTimeout(() => {
        queueIdleTask(warmSpotlight, WARMUP_IDLE_TIMEOUT_MS);
      }, WARMUP_DELAY_MS);
    };

    if (document.readyState === "complete" || document.documentElement.classList.contains("page-transition-ready")) {
      start();
      return;
    }
    window.addEventListener("renaissance:page-ready", start, { once: true });
    window.addEventListener("load", start, { once: true });
  }

  async function loadPublishedEssays() {
    if (!essaysPromise) {
      essaysPromise = content.loadEssays().then((essays) => {
        publishedEssays = essays.filter((essay) => essay.published !== false);
        return publishedEssays;
      });
    }
    return essaysPromise;
  }

  function currentRoute() {
    try {
      return router.parse();
    } catch (_error) {
      return { view: "archive" };
    }
  }

  function currentEssay() {
    const route = currentRoute();
    if (!route.essaySlug) {
      return null;
    }
    return publishedEssays.find((essay) => essay.slug === route.essaySlug) || null;
  }

  function routeLabel(route) {
    if (!route || !route.view) {
      return "Renaissance";
    }
    if (route.view === "section") {
      return "Reader";
    }
    if (route.view === "essay") {
      return "Essay";
    }
    if (route.view === "search") {
      return "Search";
    }
    return "Archive";
  }

  function actionResult(title, detail, href, kind) {
    return {
      title,
      detail,
      href,
      kind: kind || "action",
      score: 0
    };
  }

  function pushUnique(results, result, seen) {
    if (!result || !result.href) {
      return;
    }
    const key = result.href + "\u001f" + result.title;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(result);
  }

  function prefetchHref(href) {
    if (!href || prefetchedHrefs.has(href)) {
      return;
    }

    let url;
    try {
      url = new URL(href, window.location.href);
    } catch (_error) {
      return;
    }

    if (url.origin !== window.location.origin || url.href === window.location.href) {
      return;
    }

    prefetchedHrefs.add(href);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url.href;
    document.head.appendChild(link);
  }

  function sectionIntent(query) {
    const match = /^(?:section|chapter|part)?\s*([ivx]+|\d{1,2})$/i.exec(query);
    if (!match) {
      return null;
    }
    const token = match[1].toLowerCase();
    if (/^\d+$/.test(token)) {
      return Number.parseInt(token, 10);
    }
    return ROMAN_VALUES[token] || null;
  }

  function continueReadingResult() {
    if (!readingState || typeof readingState.continueTarget !== "function") {
      return null;
    }
    const target = readingState.continueTarget(publishedEssays, {
      sectionDisplay: content.sectionDisplay
    });
    if (!target || !target.href) {
      return null;
    }
    return actionResult(
      target.action === "next" ? "Next section" : "Continue reading",
      normalizeSpaces([target.essay && target.essay.title, target.sectionLabel, target.sectionTitle].filter(Boolean).join(" / ")),
      target.href,
      "continue"
    );
  }

  function quickResults() {
    const results = [];
    const seen = new Set();
    const continueResult = continueReadingResult();
    const essay = currentEssay();

    if (continueResult) {
      pushUnique(results, continueResult, seen);
    }
    if (essay) {
      pushUnique(results, actionResult(
        "Open essay contents",
        essay.title,
        router.build("essay", { essaySlug: essay.slug }),
        "route"
      ), seen);
    }

    pushUnique(results, actionResult("Archive", "All published essays", router.build("archive", {}), "route"), seen);
    pushUnique(results, actionResult("Full search", "Search page", router.build("search", {}), "route"), seen);

    publishedEssays.slice(0, 4).forEach((entry) => {
      pushUnique(results, actionResult(
        entry.title,
        entry.summary || "Essay",
        router.build("essay", { essaySlug: entry.slug }),
        "essay"
      ), seen);
    });

    return results.slice(0, MAX_RESULTS);
  }

  function hitHref(hit, query) {
    return router.build("section", {
      essaySlug: hit.essaySlug,
      sectionNumber: hit.sectionNumber,
      passageId: hit.passageId,
      rangeStart: hit.rangeStart,
      rangeEnd: hit.rangeEnd,
      query,
      occurrence: hit.occurrence,
      mode: "contains"
    });
  }

  function resultFromHit(hit, query) {
    const fieldCopy = hit.field === "body"
      ? hit.sectionSearchLabel
      : hit.field === "essay_title"
        ? "Essay title"
        : hit.field === "section_title"
          ? "Section title"
          : "Section label";
    const title = hit.field === "body"
      ? hit.sectionTitle
      : hit.essayTitle;

    return {
      title: normalizeSpaces(title || hit.sectionSearchLabel || hit.essayTitle),
      detail: normalizeSpaces([hit.essayTitle, fieldCopy, hit.snippet].filter(Boolean).join(" / ")),
      href: hitHref(hit, query),
      kind: hit.field === "body" ? "passage" : "match",
      score: hit.score
    };
  }

  // The oracle (generated index) is the primary search truth; the in-browser
  // engine stays as a fallback for offline-before-precache or fetch failure.
  function loadOracleIndex() {
    if (!oracle) {
      return Promise.resolve(null);
    }
    if (!oracleIndexPromise) {
      oracleIndexPromise = Promise.all([
        fetch("data/search-index.json").then((response) => (response.ok ? response.json() : null)),
        fetch("data/search-lexicon.json").then((response) => (response.ok ? response.json() : null)).catch(() => null)
      ])
        .then(([index, lex]) => {
          lexicon = lex;
          return index;
        })
        .catch(() => null);
    }
    return oracleIndexPromise;
  }

  function resultFromOracle(result, query) {
    const href = router.build("section", {
      essaySlug: result.essaySlug,
      sectionNumber: result.sectionNumber,
      passageId: result.passageId,
      query
    });
    const detail = normalizeSpaces([
      result.essayTitle,
      result.snippet && result.snippet.text
    ].filter(Boolean).join(" / "));
    const kind = result.kind === "passage"
      ? "passage"
      : result.kind === "section-jump"
        ? "section"
        : "match";
    return {
      title: normalizeSpaces(result.sectionTitle || result.essayTitle),
      detail,
      href,
      kind,
      score: result.score
    };
  }

  async function searchResults(query) {
    await loadPublishedEssays();
    const index = await loadOracleIndex();
    if (!index || !oracle) {
      return legacySearchResults(query);
    }

    const route = currentRoute();
    const essay = currentEssay();
    const ranked = oracle.rank(index, query, {
      essaySlug: essay && essay.slug,
      lexicon,
      limit: MAX_RESULTS - 1
    });

    const results = [];
    const seen = new Set();
    ranked.results.forEach((result) => {
      pushUnique(results, resultFromOracle(result, query), seen);
    });

    pushUnique(results, actionResult(
      'Search "' + query + '"',
      routeLabel(route) + " / full results",
      router.build("search", { query, sort: "relevance" }),
      "search"
    ), seen);

    return results.slice(0, MAX_RESULTS);
  }

  async function legacySearchResults(query) {
    await loadPublishedEssays();
    const route = currentRoute();
    const intentSection = sectionIntent(query);
    const results = [];
    const seen = new Set();
    const essay = currentEssay();

    if (intentSection && essay && essay.section_order.includes(intentSection)) {
      const display = content.sectionDisplay(essay, intentSection);
      pushUnique(results, actionResult(
        display.title,
        essay.title + " / " + display.label,
        router.build("section", { essaySlug: essay.slug, sectionNumber: intentSection }),
        "section"
      ), seen);
    }

    const result = await ensureEngine().search({
      query,
      mode: "contains",
      sort: "relevance",
      scope: "all",
      caseSensitive: false
    });

    result.hits.forEach((hit) => {
      if (results.length >= MAX_RESULTS - 1) {
        return;
      }
      pushUnique(results, resultFromHit(hit, query), seen);
    });

    pushUnique(results, actionResult(
      'Search "' + query + '"',
      routeLabel(route) + " / full results",
      router.build("search", { query, sort: "relevance" }),
      "search"
    ), seen);

    return results.slice(0, MAX_RESULTS);
  }

  function ensureDom() {
    if (root) {
      return;
    }

    root = document.createElement("div");
    root.className = "spotlight-root";
    root.hidden = true;
    root.innerHTML =
      '<div class="spotlight-backdrop" data-spotlight-close></div>' +
      '<section class="spotlight-panel" role="dialog" aria-modal="true" aria-label="Spotlight search">' +
        '<form class="spotlight-form" role="search">' +
          '<label class="sr-only" for="spotlight-input">Search Renaissance</label>' +
          '<input id="spotlight-input" class="spotlight-input" type="search" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="spotlight-results" placeholder="Search Renaissance">' +
        '</form>' +
        '<div id="spotlight-status" class="sr-only" role="status" aria-live="polite"></div>' +
        '<div id="spotlight-results" class="spotlight-results" role="listbox" aria-label="Spotlight results"></div>' +
      '</section>';
    document.body.appendChild(root);

    input = root.querySelector("#spotlight-input");
    list = root.querySelector("#spotlight-results");
    status = root.querySelector("#spotlight-status");

    root.addEventListener("click", (event) => {
      if (event.target && event.target.hasAttribute("data-spotlight-close")) {
        closeSpotlight(true);
      }
    });

    root.querySelector(".spotlight-form").addEventListener("submit", (event) => {
      event.preventDefault();
      activateCurrent();
    });

    input.addEventListener("input", () => {
      scheduleRender(input.value);
    });

    list.addEventListener("mousemove", (event) => {
      const item = event.target && event.target.closest ? event.target.closest(".spotlight-result") : null;
      if (!item) {
        return;
      }
      setActiveIndex(Number.parseInt(item.dataset.index, 10) || 0);
    });

    list.addEventListener("click", (event) => {
      const item = event.target && event.target.closest ? event.target.closest(".spotlight-result") : null;
      if (item) {
        closeSpotlight(false);
      }
    });
  }

  function openSpotlight(prefill) {
    ensureDom();
    lastFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add("spotlight-is-open");
    input.value = prefill || "";
    input.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
    render(input.value);
  }

  function closeSpotlight(restoreFocus) {
    if (!root || root.hidden) {
      return;
    }
    root.hidden = true;
    document.documentElement.classList.remove("spotlight-is-open");
    activeResults = [];
    activeIndex = 0;
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    if (restoreFocus && lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus({ preventScroll: true });
    }
  }

  function scheduleRender(query) {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      render(query);
    }, DEBOUNCE_MS);
  }

  function setActiveIndex(index) {
    if (!activeResults.length) {
      activeIndex = 0;
      return;
    }
    activeIndex = (index + activeResults.length) % activeResults.length;
    Array.from(list.querySelectorAll(".spotlight-result")).forEach((element, itemIndex) => {
      const selected = itemIndex === activeIndex;
      element.classList.toggle("is-active", selected);
      element.setAttribute("aria-selected", selected ? "true" : "false");
      element.tabIndex = selected ? 0 : -1;
      if (selected && input) {
        input.setAttribute("aria-activedescendant", element.id);
        prefetchHref(element.getAttribute("href"));
      }
    });
  }

  function renderResults(results, query) {
    activeResults = results;
    activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

    if (!results.length) {
      list.innerHTML = '<p class="spotlight-empty">No matches.</p>';
      status.textContent = "No matches.";
      if (input) {
        input.removeAttribute("aria-activedescendant");
      }
      return;
    }

    list.innerHTML = results.map((result, index) => (
      '<a id="spotlight-result-' + String(index) + '" class="spotlight-result" role="option" data-index="' + String(index) + '" href="' + escapeHtml(result.href) + '">' +
        '<span class="spotlight-result-main">' +
          '<span class="spotlight-result-title">' + escapeHtml(result.title) + "</span>" +
          '<span class="spotlight-result-detail">' + escapeHtml(result.detail) + "</span>" +
        "</span>" +
        '<span class="spotlight-result-kind">' + escapeHtml(result.kind) + "</span>" +
      "</a>"
    )).join("");
    status.textContent = String(results.length) + " results.";
    setActiveIndex(0);
    if (query) {
      root.dataset.hasQuery = "true";
    } else {
      delete root.dataset.hasQuery;
    }
  }

  function trapFocus(event) {
    const activeResult = list && list.querySelector(".spotlight-result.is-active");
    const targets = [input, activeResult].filter(Boolean);
    if (targets.length < 2) {
      event.preventDefault();
      input.focus({ preventScroll: true });
      return;
    }

    const first = targets[0];
    const last = targets[targets.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
      return;
    }
    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  async function render(rawQuery) {
    const query = normalizeSpaces(rawQuery);
    const runId = ++searchRunId;
    await loadPublishedEssays().catch(() => []);

    if (runId !== searchRunId || !root || root.hidden) {
      return;
    }

    if (!query) {
      renderResults(quickResults(), "");
      return;
    }

    status.textContent = "Searching.";
    try {
      const results = await searchResults(query);
      if (runId !== searchRunId || !root || root.hidden) {
        return;
      }
      renderResults(results, query);
    } catch (_error) {
      if (runId !== searchRunId) {
        return;
      }
      renderResults([
        actionResult('Search "' + query + '"', "Full search page", router.build("search", { query }), "search")
      ], query);
    }
  }

  function activateCurrent() {
    const link = list && list.querySelector(".spotlight-result.is-active");
    if (!link) {
      return;
    }
    link.click();
  }

  document.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    const primary = event.metaKey || event.ctrlKey;
    if (primary && key === "k") {
      event.preventDefault();
      if (root && !root.hidden) {
        closeSpotlight(true);
      } else {
        openSpotlight("");
      }
      return;
    }

    if (!root || root.hidden) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeSpotlight(true);
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(activeIndex - 1);
      return;
    }
    if (event.key === "Enter" && !isEditableTarget(document.activeElement)) {
      event.preventDefault();
      activateCurrent();
    }
  });

  window.RenaissanceSpotlight = {
    open: openSpotlight,
    close: closeSpotlight
  };

  scheduleWarmup();
})();
