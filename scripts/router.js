(function () {
  const MODES = ["contains", "exact_phrase", "fuzzy"];
  const SORTS = ["reading_order", "relevance"];
  const PAGE_SIZES = [25, 50, 100];
  const DEFAULT_PAGE_SIZE = 50;

  const VIEW_FILES = {
    archive: "index.html",
    essay: "essay.html",
    section: "section.html",
    search: "search.html"
  };

  const NAV_PARAM_ORDER = [
    "essay",
    "section",
    "scope",
    "q",
    "occ",
    "mode",
    "sort",
    "case",
    "page",
    "page_size"
  ];

  const isLocalFile = window.location.protocol === "file:";

  function resolvePath(filename) {
    // Relative paths keep navigation working whether the site is served from
    // the domain root or a project subpath (e.g. GitHub Pages at /renaissance/).
    // Every page lives in the same directory, so a bare filename always resolves
    // correctly; a root-absolute "/essay.html" would 404 under a subpath.
    return isLocalFile ? "./" + filename : filename;
  }

  function detectViewFromPath(pathname) {
    const lower = String(pathname || "").toLowerCase();
    if (lower.endsWith("/essay.html") || lower.endsWith("essay.html")) {
      return "essay";
    }
    if (lower.endsWith("/section.html") || lower.endsWith("section.html")) {
      return "section";
    }
    if (lower.endsWith("/search.html") || lower.endsWith("search.html")) {
      return "search";
    }
    return "archive";
  }

  const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

  function parseSlug(raw) {
    const value = String(raw || "").trim();
    return SLUG_PATTERN.test(value) ? value : "";
  }

  function parsePositiveInt(raw) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function parseQuery(raw) {
    return String(raw || "").trim();
  }

  function parseMode(raw) {
    const value = String(raw || "");
    return MODES.includes(value) ? value : "contains";
  }

  function parseSort(raw) {
    const value = String(raw || "");
    return SORTS.includes(value) ? value : "reading_order";
  }

  function parseScope(raw) {
    const value = String(raw || "").trim();
    if (!value) {
      return "all";
    }
    if (value === "all") {
      return "all";
    }
    return SLUG_PATTERN.test(value) ? value : "all";
  }

  function parseBool(raw) {
    return raw === "1" || raw === "true" || raw === true;
  }

  function parsePage(raw) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  function parsePageSize(raw) {
    const parsed = Number.parseInt(raw, 10);
    return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
  }

  function parseLocationLike(source) {
    let pathname;
    let searchParams;

    if (source && typeof source === "object" && "pathname" in source) {
      pathname = source.pathname;
      searchParams = new URLSearchParams(source.search || "");
    } else if (typeof source === "string" && source.length > 0) {
      const fakeBase = "http://x.invalid/";
      const url = new URL(source, fakeBase);
      pathname = url.pathname;
      searchParams = url.searchParams;
    } else {
      pathname = window.location.pathname;
      searchParams = new URLSearchParams(window.location.search);
    }

    return { pathname, searchParams };
  }

  function parse(source) {
    const { pathname, searchParams } = parseLocationLike(source);
    const route = {
      view: detectViewFromPath(pathname),
      essaySlug: parseSlug(searchParams.get("essay")),
      sectionNumber: parsePositiveInt(searchParams.get("section")),
      scope: parseScope(searchParams.get("scope")),
      query: parseQuery(searchParams.get("q")),
      occurrence: parsePositiveInt(searchParams.get("occ")),
      mode: parseMode(searchParams.get("mode")),
      sort: parseSort(searchParams.get("sort")),
      caseSensitive: parseBool(searchParams.get("case")),
      page: parsePage(searchParams.get("page")),
      pageSize: parsePageSize(searchParams.get("page_size"))
    };
    return Object.freeze(route);
  }

  function appendIfPresent(out, key, value) {
    if (value === undefined || value === null || value === "") {
      return;
    }
    out.push(key + "=" + encodeURIComponent(value));
  }

  function build(view, params) {
    const filename = VIEW_FILES[view] || VIEW_FILES.archive;
    const path = resolvePath(filename);
    const source = params || {};
    const pairs = [];

    const essaySlug = parseSlug(source.essaySlug);
    const sectionNumber = parsePositiveInt(source.sectionNumber);
    const scope = source.scope === undefined ? "all" : parseScope(source.scope);
    const query = parseQuery(source.query);
    const occurrence = parsePositiveInt(source.occurrence);
    const mode = parseMode(source.mode || "contains");
    const sort = parseSort(source.sort || "reading_order");
    const caseSensitive = Boolean(source.caseSensitive);
    const page = parsePage(source.page || 1);
    const pageSize = parsePageSize(source.pageSize || DEFAULT_PAGE_SIZE);

    const accumulator = {};
    if (essaySlug) {
      accumulator.essay = essaySlug;
    }
    if (sectionNumber !== null) {
      accumulator.section = String(sectionNumber);
    }
    if (scope && scope !== "all") {
      accumulator.scope = scope;
    }
    if (query) {
      accumulator.q = query;
    }
    if (occurrence !== null && query) {
      accumulator.occ = String(occurrence);
    }
    if (mode !== "contains") {
      accumulator.mode = mode;
    }
    if (sort !== "reading_order") {
      accumulator.sort = sort;
    }
    if (caseSensitive) {
      accumulator["case"] = "1";
    }
    if (page > 1) {
      accumulator.page = String(page);
    }
    if (pageSize !== DEFAULT_PAGE_SIZE) {
      accumulator.page_size = String(pageSize);
    }

    NAV_PARAM_ORDER.forEach((key) => {
      appendIfPresent(pairs, key, accumulator[key]);
    });

    if (source.extras && typeof source.extras === "object") {
      Object.keys(source.extras).forEach((key) => {
        if (NAV_PARAM_ORDER.indexOf(key) !== -1) {
          return;
        }
        const value = source.extras[key];
        if (value === undefined || value === null || value === "") {
          return;
        }
        pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
      });
    }

    return pairs.length === 0 ? path : path + "?" + pairs.join("&");
  }

  let throttleTimer = null;
  let pendingHistoryAction = null;

  function flushHistory() {
    if (!pendingHistoryAction) {
      return;
    }
    const action = pendingHistoryAction;
    pendingHistoryAction = null;
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    saveCurrentScroll();
    if (action.replace) {
      window.history.replaceState(action.state, "", action.url);
    } else {
      window.history.pushState(action.state, "", action.url);
    }
    dispatchRouteEvent();
  }

  function saveCurrentScroll() {
    try {
      const existing = window.history.state || {};
      const next = Object.assign({}, existing, { scrollY: window.scrollY });
      window.history.replaceState(next, "");
    } catch (_error) {
      // ignore in sandboxed contexts
    }
  }

  function dispatchRouteEvent() {
    const detail = parse();
    window.RenaissanceRouter.current = detail;
    window.dispatchEvent(new CustomEvent("renaissance:route", { detail }));
  }

  function go(view, params, opts) {
    const settings = opts || {};
    const url = build(view, params);
    const state = settings.state || null;
    const action = {
      replace: Boolean(settings.replace),
      url,
      state
    };

    const commit = () => {
      pendingHistoryAction = action;
      flushHistory();
    };

    const runWithTransition = () => {
      // View transitions are opt-in via `transition: true`. Default keeps the URL
      // update synchronous, which is important for throttled search nav and for
      // tests that read window.location right after go().
      if (
        settings.transition === true &&
        typeof document.startViewTransition === "function"
      ) {
        document.startViewTransition(() => {
          commit();
        });
      } else {
        commit();
      }
    };

    if (settings.throttle) {
      pendingHistoryAction = action;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        runWithTransition();
      }, 250);
      return;
    }

    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    runWithTransition();
  }

  function restoreScrollFromState() {
    const state = window.history.state;
    if (state && typeof state.scrollY === "number") {
      window.scrollTo({ top: state.scrollY, behavior: "auto" });
    }
  }

  window.addEventListener("popstate", () => {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
      pendingHistoryAction = null;
    }
    dispatchRouteEvent();
    requestAnimationFrame(restoreScrollFromState);
  });

  window.addEventListener("beforeunload", () => {
    if (pendingHistoryAction) {
      flushHistory();
    }
    saveCurrentScroll();
  });

  function selfHealOnLoad() {
    try {
      const params = new URLSearchParams(window.location.search);
      const view = detectViewFromPath(window.location.pathname);

      const knownNavKeys = new Set(NAV_PARAM_ORDER);
      const extras = {};
      params.forEach((value, key) => {
        if (!knownNavKeys.has(key)) {
          extras[key] = value;
        }
      });

      const cleanedUrl = build(view, {
        essaySlug: params.get("essay"),
        sectionNumber: params.get("section"),
        scope: params.get("scope"),
        query: params.get("q"),
        occurrence: params.get("occ"),
        mode: params.get("mode"),
        sort: params.get("sort"),
        caseSensitive: parseBool(params.get("case")),
        page: params.get("page"),
        pageSize: params.get("page_size"),
        extras
      });

      // Compare only the query string and rewrite in place against the current
      // pathname. This keeps self-heal subpath-safe (it must never strip the
      // /renaissance/ prefix) and preserves any text-fragment hash for the
      // reader's anchor logic to pick up.
      const expected = new URL(cleanedUrl, "http://x.invalid/");
      const cleanedSearch = expected.search;

      if (window.location.search !== cleanedSearch) {
        const state = window.history.state || {};
        window.history.replaceState(
          state,
          "",
          window.location.pathname + cleanedSearch + window.location.hash
        );
      }
    } catch (_error) {
      // self-heal must never throw
    }
  }

  selfHealOnLoad();

  window.RenaissanceRouter = {
    parse,
    build,
    go,
    saveScroll: saveCurrentScroll,
    restoreScroll: restoreScrollFromState,
    current: parse(),
    MODES: MODES.slice(),
    SORTS: SORTS.slice(),
    PAGE_SIZES: PAGE_SIZES.slice(),
    DEFAULT_PAGE_SIZE
  };
})();
