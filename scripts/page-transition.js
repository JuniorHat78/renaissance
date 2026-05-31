(function () {
  const STORAGE_KEY = "renaissance:page-transition";
  const OUT_DURATION_MS = 16;
  const CONTENT_READY_FALLBACK_MS = 1200;
  const STORED_MOTION_MAX_AGE_MS = 8000;
  const SECTION_READER_NAV = "#prev-link, #next-link, #next-cta";

  const root = document.documentElement;
  const prefetched = new Set();
  let leaving = false;
  let ready = false;
  let hasIncomingMotion = false;
  let sourceAnchor = null;
  let primeClearTimer = null;

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  const reducedMotion = prefersReducedMotion();

  function currentView() {
    return viewForUrl(window.location.href);
  }

  function viewForUrl(href) {
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch (_error) {
      return "archive";
    }

    const path = url.pathname.toLowerCase();
    if (path.endsWith("/section.html") || path.endsWith("section.html")) {
      return "section";
    }
    if (path.endsWith("/essay.html") || path.endsWith("essay.html")) {
      return "essay";
    }
    if (path.endsWith("/search.html") || path.endsWith("search.html")) {
      return "search";
    }
    return "archive";
  }

  function motionForUrl(href) {
    const from = currentView();
    const to = viewForUrl(href);
    if (to === "archive") {
      return "home";
    }
    if (to === "search") {
      return "search";
    }
    if (from === "section" && to === "essay") {
      return "back";
    }
    if (to === "section") {
      return "forward";
    }
    if (from === "archive" && to === "essay") {
      return "forward";
    }
    return "settle";
  }

  function readIncomingMotion() {
    let motion = "settle";
    try {
      const stored = window.sessionStorage.getItem(STORAGE_KEY);
      window.sessionStorage.removeItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const createdAt = Number(parsed && parsed.createdAt);
        const age = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
        if (parsed && typeof parsed.motion === "string" && age <= STORED_MOTION_MAX_AGE_MS) {
          hasIncomingMotion = true;
          motion = parsed.motion;
          if (Number.isFinite(parsed.sourceX) && Number.isFinite(parsed.sourceY)) {
            root.style.setProperty("--page-source-x", String(Math.round(parsed.sourceX)) + "px");
            root.style.setProperty("--page-source-y", String(Math.round(parsed.sourceY)) + "px");
          }
        }
      }
    } catch (_error) {
      motion = "settle";
    }
    return motion;
  }

  function storeOutgoingMotion(motion, point) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        motion,
        sourceX: point && point.x,
        sourceY: point && point.y,
        createdAt: Date.now()
      }));
    } catch (_error) {
      // Storage is a hint only; navigation should never depend on it.
    }
  }

  function setMotion(motion) {
    root.setAttribute("data-page-motion", motion || "settle");
  }

  function revealPage(options) {
    const settings = options || {};
    const needsReveal = (
      root.classList.contains("page-transition-prep") ||
      root.classList.contains("page-transition-out") ||
      !root.classList.contains("page-transition-ready")
    );
    if (ready && !settings.force && !needsReveal) {
      return;
    }
    ready = true;
    leaving = false;
    clearSourceAnchor();
    root.classList.remove("page-transition-prep", "page-transition-out");
    root.classList.add("page-transition-ready");
    root.removeAttribute("aria-busy");
  }

  function markContentReady() {
    root.classList.add("page-transition-content-ready");
  }

  function clearSourceAnchor() {
    if (primeClearTimer) {
      window.clearTimeout(primeClearTimer);
      primeClearTimer = null;
    }
    if (sourceAnchor) {
      sourceAnchor.classList.remove("is-page-transition-source");
      sourceAnchor = null;
    }
    root.removeAttribute("data-page-source-motion");
  }

  function markSourceAnchor(anchor, motion) {
    clearSourceAnchor();
    sourceAnchor = anchor;
    sourceAnchor.classList.add("is-page-transition-source");

    const rect = sourceAnchor.getBoundingClientRect();
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);
    root.style.setProperty("--page-source-x", String(Math.round(centerX)) + "px");
    root.style.setProperty("--page-source-y", String(Math.round(centerY)) + "px");
    root.setAttribute("data-page-source-motion", motion || "settle");
    return { x: centerX, y: centerY };
  }

  function clearPrimeSoon() {
    if (primeClearTimer) {
      window.clearTimeout(primeClearTimer);
    }
    primeClearTimer = window.setTimeout(() => {
      primeClearTimer = null;
      if (!leaving) {
        clearSourceAnchor();
      }
    }, 180);
  }

  function pageIsSameDocument(url) {
    return (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      url.search === window.location.search
    );
  }

  function shouldHandleAnchor(anchor, event) {
    if (!anchor || event.defaultPrevented || leaving) {
      return false;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return false;
    }
    if (anchor.matches(SECTION_READER_NAV)) {
      return false;
    }
    if (anchor.target && anchor.target.toLowerCase() !== "_self") {
      return false;
    }
    if (anchor.hasAttribute("download") || anchor.hasAttribute("data-no-page-transition")) {
      return false;
    }

    let url;
    try {
      url = new URL(anchor.getAttribute("href") || "", window.location.href);
    } catch (_error) {
      return false;
    }

    if (url.origin !== window.location.origin) {
      return false;
    }
    if (!/\.html$/i.test(url.pathname) && url.pathname !== "/" && !url.pathname.endsWith("/")) {
      return false;
    }
    if (pageIsSameDocument(url)) {
      return false;
    }

    anchor.__renaissanceTransitionUrl = url;
    return true;
  }

  function handleLinkClick(event) {
    const anchor = event.target && event.target.closest
      ? event.target.closest("a[href]")
      : null;
    if (!shouldHandleAnchor(anchor, event)) {
      return;
    }

    const url = anchor.__renaissanceTransitionUrl;
    const motion = motionForUrl(url.href);
    leaving = true;
    setMotion(motion);
    const sourcePoint = markSourceAnchor(anchor, motion);
    storeOutgoingMotion(motion, sourcePoint);
    event.preventDefault();

    if (reducedMotion) {
      window.location.href = url.href;
      return;
    }

    root.classList.remove("page-transition-ready", "page-transition-prep");
    root.classList.add("page-transition-out");
    root.setAttribute("aria-busy", "true");

    window.setTimeout(() => {
      window.location.assign(url.href);
    }, OUT_DURATION_MS);
  }

  function handlePointerDown(event) {
    const anchor = event.target && event.target.closest
      ? event.target.closest("a[href]")
      : null;
    if (reducedMotion || !shouldHandleAnchor(anchor, event)) {
      return;
    }

    const url = anchor.__renaissanceTransitionUrl;
    const motion = motionForUrl(url.href);
    setMotion(motion);
    markSourceAnchor(anchor, motion);
    maybePrefetch(anchor);
  }

  function maybePrefetch(anchor) {
    if (!anchor || anchor.matches(SECTION_READER_NAV)) {
      return;
    }

    let url;
    try {
      url = new URL(anchor.getAttribute("href") || "", window.location.href);
    } catch (_error) {
      return;
    }

    if (url.origin !== window.location.origin || pageIsSameDocument(url) || prefetched.has(url.href)) {
      return;
    }
    if (!/\.html$/i.test(url.pathname) && url.pathname !== "/" && !url.pathname.endsWith("/")) {
      return;
    }

    prefetched.add(url.href);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url.href;
    document.head.appendChild(link);
  }

  function bindPrefetch() {
    document.addEventListener("pointerdown", handlePointerDown, { passive: true });
    document.addEventListener("pointerup", clearPrimeSoon, { passive: true });
    document.addEventListener("pointercancel", clearSourceAnchor, { passive: true });

    document.addEventListener("mouseover", (event) => {
      const anchor = event.target && event.target.closest
        ? event.target.closest("a[href]")
        : null;
      maybePrefetch(anchor);
    });

    document.addEventListener("focusin", (event) => {
      const anchor = event.target && event.target.closest
        ? event.target.closest("a[href]")
        : null;
      maybePrefetch(anchor);
    });
  }

  const incomingMotion = readIncomingMotion();
  setMotion(incomingMotion);
  if (hasIncomingMotion) {
    root.setAttribute("data-page-arrival", "navigation");
  }

  if (reducedMotion) {
    revealPage();
    markContentReady();
  } else {
    revealPage();
    window.addEventListener("renaissance:page-ready", markContentReady);
    window.setTimeout(markContentReady, CONTENT_READY_FALLBACK_MS);
  }

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      revealPage({ force: true });
    }
  });

  window.addEventListener("pagehide", () => {
    clearSourceAnchor();
  });

  document.addEventListener("click", handleLinkClick);
  bindPrefetch();

  window.RenaissancePageTransition = {
    outDelayMs: OUT_DURATION_MS,
    revealMode: "immediate",
    ready: revealPage
  };
})();
