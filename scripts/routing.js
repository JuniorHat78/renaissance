(function () {
  const MODES = ["contains", "exact_phrase", "fuzzy"];
  const SORTS = ["reading_order", "relevance"];
  const DEFAULT_PAGE_SIZE = 50;

  const isLocalFileContext = window.location.protocol === "file:";

  const PAGE_MAP = {
    archive: "index.html",
    essay: "essay.html",
    section: "section.html",
    search: "search.html"
  };

  const subscribers = [];
  let historyThrottleTimer = null;

  function resolvePath(filename) {
    return isLocalFileContext ? `./${filename}` : `/${filename}`;
  }

  const parsers = {
    essaySlug: (val) => String(val || "").trim(),
    sectionNumber: (val) => {
      const parsed = Number.parseInt(val, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    },
    query: (val) => String(val || "").trim(),
    mode: (val) => (MODES.includes(val) ? val : "contains"),
    sort: (val) => (SORTS.includes(val) ? val : "reading_order"),
    caseSensitive: (val) => val === "1" || val === "true" || val === true,
    page: (val) => {
      const parsed = Number.parseInt(val, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    },
    pageSize: (val) => {
      const parsed = Number.parseInt(val, 10);
      return [25, 50, 100].includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
    }
  };

  function parseCurrentRoute() {
    const params = new URLSearchParams(window.location.search);
    const pathname = window.location.pathname.toLowerCase();

    let page = "archive";
    for (const [key, filename] of Object.entries(PAGE_MAP)) {
      if (pathname.endsWith(filename.toLowerCase())) {
        page = key;
        break;
      }
    }

    const route = {
      page,
      essaySlug: parsers.essaySlug(params.get("essay")),
      sectionNumber: parsers.sectionNumber(params.get("section")),
      query: parsers.query(params.get("q")),
      mode: parsers.mode(params.get("mode")),
      sort: parsers.sort(params.get("sort")),
      caseSensitive: parsers.caseSensitive(params.get("case")),
      page: parsers.page(params.get("page")),
      pageSize: parsers.pageSize(params.get("page_size"))
    };

    return Object.freeze(route);
  }

  function buildUrl(page, routeParams) {
    const filename = PAGE_MAP[page] || PAGE_MAP.archive;
    const path = resolvePath(filename);
    const params = routeParams || {};

    const search = new URLSearchParams();

    if (params.essaySlug) {
      search.set("essay", parsers.essaySlug(params.essaySlug));
    }
    if (params.sectionNumber !== undefined && params.sectionNumber !== null) {
      const section = parsers.sectionNumber(params.sectionNumber);
      if (section !== null) {
        search.set("section", String(section));
      }
    }
    if (params.query) {
      search.set("q", parsers.query(params.query));
    }

    if (params.mode && params.mode !== "contains") {
      search.set("mode", parsers.mode(params.mode));
    }
    if (params.sort && params.sort !== "reading_order") {
      search.set("sort", parsers.sort(params.sort));
    }
    if (params.caseSensitive) {
      search.set("case", "1");
    }
    if (params.page && parsers.page(params.page) > 1) {
      search.set("page", String(parsers.page(params.page)));
    }
    if (params.pageSize && parsers.pageSize(params.pageSize) !== DEFAULT_PAGE_SIZE) {
      search.set("page_size", String(parsers.pageSize(params.pageSize)));
    }

    const queryStr = search.toString();
    return queryStr ? `${path}?${queryStr}` : path;
  }

  function notifySubscribers(route) {
    subscribers.slice().forEach((callback) => callback(route));
  }

  function transitionTo(page, params, options) {
    const settings = options || {};
    const url = buildUrl(page, params);

    const executeUpdate = () => {
      if (settings.replace) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
      }

      if (!settings.redirect) {
        notifySubscribers(parseCurrentRoute());
      }
    };

    if (settings.redirect) {
      window.location.href = url;
      return;
    }

    if (settings.replace && settings.throttle) {
      if (historyThrottleTimer) {
        clearTimeout(historyThrottleTimer);
      }
      historyThrottleTimer = setTimeout(executeUpdate, 80);
    } else {
      if (historyThrottleTimer) {
        clearTimeout(historyThrottleTimer);
        historyThrottleTimer = null;
      }
      executeUpdate();
    }
  }

  function subscribe(element, callback) {
    if (typeof callback !== "function") {
      throw new Error("Callback must be a function");
    }

    const wrapper = (nextRoute) => {
      if (element && !document.body.contains(element)) {
        unsubscribe();
        return;
      }
      try {
        callback(nextRoute);
      } catch (error) {
        console.error("Error in route subscription callback:", error);
      }
    };

    subscribers.push(wrapper);

    const unsubscribe = () => {
      const index = subscribers.indexOf(wrapper);
      if (index > -1) {
        subscribers.splice(index, 1);
      }
    };

    return unsubscribe;
  }

  window.addEventListener("popstate", () => {
    if (historyThrottleTimer) {
      clearTimeout(historyThrottleTimer);
      historyThrottleTimer = null;
    }
    notifySubscribers(parseCurrentRoute());
  });

  // Self-Healing URL initialization check
  try {
    const params = new URLSearchParams(window.location.search);
    const sanitizedState = parseCurrentRoute();
    let needsCorrection = false;

    // Mode check
    const rawMode = params.get("mode");
    if (rawMode && rawMode !== sanitizedState.mode) {
      needsCorrection = true;
    }

    // Sort check
    const rawSort = params.get("sort");
    if (rawSort && rawSort !== sanitizedState.sort) {
      needsCorrection = true;
    }

    // Page check
    const rawPage = params.get("page");
    if (rawPage && parsers.page(rawPage) !== sanitizedState.page) {
      needsCorrection = true;
    }

    // Page size check
    const rawPageSize = params.get("page_size");
    if (rawPageSize && parsers.pageSize(rawPageSize) !== sanitizedState.pageSize) {
      needsCorrection = true;
    }

    // Section check
    const rawSection = params.get("section");
    if (rawSection && parsers.sectionNumber(rawSection) !== sanitizedState.sectionNumber) {
      needsCorrection = true;
    }

    if (needsCorrection) {
      if (rawMode && rawMode !== sanitizedState.mode) {
        params.set("mode", sanitizedState.mode);
      }
      if (rawSort && rawSort !== sanitizedState.sort) {
        params.set("sort", sanitizedState.sort);
      }

      const parsedPage = parsers.page(rawPage);
      if (rawPage && parsedPage !== sanitizedState.page) {
        if (sanitizedState.page > 1) {
          params.set("page", String(sanitizedState.page));
        } else {
          params.delete("page");
        }
      }

      const parsedPageSize = parsers.pageSize(rawPageSize);
      if (rawPageSize && parsedPageSize !== sanitizedState.pageSize) {
        if (sanitizedState.pageSize !== DEFAULT_PAGE_SIZE) {
          params.set("page_size", String(sanitizedState.pageSize));
        } else {
          params.delete("page_size");
        }
      }

      const parsedSection = parsers.sectionNumber(rawSection);
      if (rawSection && parsedSection !== sanitizedState.sectionNumber) {
        if (sanitizedState.sectionNumber !== null) {
          params.set("section", String(sanitizedState.sectionNumber));
        } else {
          params.delete("section");
        }
      }

      const filename = PAGE_MAP[sanitizedState.page] || PAGE_MAP.archive;
      const path = resolvePath(filename);
      const queryStr = params.toString();
      const nextUrl = queryStr ? `${path}?${queryStr}` : path;

      window.history.replaceState(null, "", nextUrl);
    }
  } catch (error) {
    // Fail silently in case of highly restricted environment issues
  }

  window.RenaissanceRouter = {
    parseCurrentRoute,
    buildUrl,
    transitionTo,
    subscribe,
    DEFAULT_PAGE_SIZE,
    MODES,
    SORTS
  };
})();
