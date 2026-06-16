(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const {
    formatReadMinutes,
    formatWordCount,
    loadEssay,
    loadEssays,
    loadSection,
    renderBlocks,
    sectionDisplay
  } = window.RenaissanceContent;
  const { findOccurrencesInText, normalizeMode, parseBooleanFlag } = window.RenaissanceSearch;
  const router = window.RenaissanceRouter;
  const {
    canonicalSectionUrl,
    setPageMetadata,
    socialImageForEssay,
    toAbsoluteUrl
  } = window.RenaissanceMeta;
  const readingState = window.RenaissanceReadingState;
  const readingAttention = window.RenaissanceReadingAttention;
  const clipboardCitation = window.RenaissanceClipboardCitation;
  const recovery = window.RenaissanceRecovery;

  const backToEssay = document.getElementById("back-to-essay");
  const essayLine = document.getElementById("essay-line");
  const sectionKicker = document.getElementById("section-kicker");
  const sectionTitle = document.getElementById("section-title");
  const sectionSubtitle = document.getElementById("section-subtitle");
  const sectionMeta = document.getElementById("section-meta");
  const sectionContent = document.getElementById("section-content");
  const sectionTools = document.getElementById("section-tools");
  const prevLink = document.getElementById("prev-link");
  const nextLink = document.getElementById("next-link");
  const nextCta = document.getElementById("next-cta");
  const copyHighlightButton = document.getElementById("copy-highlight-link");
  const copyHighlightStatus = document.getElementById("copy-highlight-status");
  const highlightCapNote = document.getElementById("highlight-cap-note");
  const readerProgressBar = document.getElementById("reader-progress-bar");
  const readerLayout = document.querySelector(".reader-layout");
  const chapterArticle = document.querySelector(".chapter-article");
  let selectionCopyChip = document.getElementById("selection-copy-chip");
  let selectionCopyBar = document.getElementById("selection-copy-bar");
  let selectionCopyBarButton = document.getElementById("selection-copy-bar-button");
  const MAX_QUERY_ONLY_HIGHLIGHTS = 160;
  const CITATION_MIN_WORDS = 5;
  const CITATION_FULL_WORDS = 40;
  const COPY_HINT_STORAGE_KEY = "renaissance:copy-hint-seen";
  const COPY_HINT_VISIBLE_MS = 4000;
  const READING_LINE_RATIO = 0.36;
  const MIN_READING_LINE_Y = 80;
  const RESTORE_SAVE_SUPPRESS_MS = 720;
  const BOOKMARK_AUTO_CLEAR_MS = 5600;
  const SECTION_NAV_SELECTOR = "#prev-link, #next-link, #next-cta";
  // The attention heartbeat samples zone occupancy + scroll velocity on this
  // cadence; reading credit accrues per tick. The reading zone is a band of
  // +/- this fraction of the viewport around the sightline (the eyes are near
  // the reading line, not at the screen edges). Attention is persisted at most
  // this often while reading without scrolling.
  const READING_ATTENTION_HEARTBEAT_MS = 250;
  const READING_ATTENTION_ZONE_HALF = 0.18;
  const READING_ATTENTION_SAVE_MS = 2000;
  const SECTION_TURN_OUT_MS = 96;
  const SECTION_TURN_IN_MS = 220;
  const SECTION_PAYLOAD_CACHE_MAX = 10;

  let currentEssay = null;
  let currentSectionNumber = null;
  let currentDisplay = null;
  let clearStatusTimer = null;
  let hideContextualTimer = null;
  let copyToastTimer = null;
  let selectionSyncFrame = null;
  let progressFrame = null;
  let progressSaveTimer = null;
  let attentionModel = null;
  let attentionHeartbeat = null;
  let attentionLastSampleAt = null;
  let attentionLastScrollY = 0;
  let attentionLastSavedAt = null;
  let resumeBookmarkElement = null;
  let resumeBookmarkFadeTimer = null;
  let resumeBookmarkRemoveTimer = null;
  let resumeBookmarkDismissArmed = false;
  let restoreSaveSuppressTimer = null;
  let lastRestoreDebug = null;
  let readingStateDebugPanel = null;
  let activeSelectionDetails = null;
  let isSelectingPointer = false;
  let progressEventsBound = false;
  let suppressProgressSave = false;
  const CONTEXTUAL_LABEL_DEFAULT = "Copy link";
  const CONTEXTUAL_LABEL_COPIED = "Copied";
  const CONTEXTUAL_LABEL_ERROR = "Try copy again";
  let hasContextualShare = false;
  let copyToast = document.getElementById("copy-toast");
  let copyHintElement = null;
  let copyHintTimer = null;
  let copyHintActive = false;
  let pendingRouteTransition = false;
  let pendingRouteScrollTop = false;
  let pendingRouteDirection = "next";
  let routeLoadToken = 0;
  const prefetchedSections = new Map();
  const shouldLogHighlightPerf = (() => {
    const protocol = String(window.location.protocol || "").toLowerCase();
    if (protocol === "file:") {
      return true;
    }

    const host = String(window.location.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  })();

  function announcePageReady() {
    window.dispatchEvent(new CustomEvent("renaissance:page-ready"));
  }

  function cleanSpaces(text) {
    return String(text || "").replace(//g, "").replace(/\s+/g, " ").trim();
  }

  function truncateText(text, maxLength) {
    const cleaned = cleanSpaces(text);
    if (!cleaned) {
      return "";
    }
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return cleaned.slice(0, maxLength).trimEnd() + "...";
  }

  function descriptionForSection(essay, display, payload) {
    const firstParagraphText = String((payload && payload.firstParagraphText) || "").trim();
    if (firstParagraphText) {
      return truncateText(firstParagraphText, 200);
    }

    return "Read " + display.label + " of " + String(essay.title || "this essay") + " on Renaissance.";
  }

  function applySectionMetadata(essay, display, sectionNumber, payload) {
    const title = display.title + " | " + essay.title + " | Renaissance";
    const description = descriptionForSection(essay, display, payload);
    const canonical = canonicalSectionUrl(essay.slug, sectionNumber);
    const image = toAbsoluteUrl(socialImageForEssay(essay));

    setPageMetadata({
      title,
      description,
      canonical,
      image
    });
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function nowMs() {
    if (window.performance && typeof window.performance.now === "function") {
      return window.performance.now();
    }
    return Date.now();
  }

  function logHighlightPerf(label, startedAt, details) {
    if (!shouldLogHighlightPerf) {
      return;
    }

    const duration = Math.max(0, nowMs() - startedAt);
    const payload = details || {};
    console.debug(
      `[highlight-perf] ${label} ${duration.toFixed(1)}ms`,
      payload
    );
  }

  function clearHighlightCapNote() {
    if (!highlightCapNote) {
      return;
    }
    highlightCapNote.textContent = "";
    highlightCapNote.hidden = true;
  }

  function showHighlightCapNote(limit, totalHits) {
    if (!highlightCapNote) {
      return;
    }
    highlightCapNote.textContent = "Showing first " + String(limit) + " highlights out of " + String(totalHits) + ".";
    highlightCapNote.hidden = false;
  }

  function countWords(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length;
  }

  function citationTier(wordCount) {
    // A few words is a lookup, not a quotation — leave it clean.
    if (wordCount < CITATION_MIN_WORDS) {
      return "none";
    }
    // A sentence or two warrants a link back; a paragraph warrants a full citation.
    if (wordCount < CITATION_FULL_WORDS) {
      return "link";
    }
    return "full";
  }

  function citationSourceLabel() {
    const title = currentEssay ? String(currentEssay.title || "").trim() : "";
    const label = currentDisplay ? String(currentDisplay.label || "").trim() : "";
    if (title && label) {
      return title + ", " + label;
    }
    return title || label;
  }

  function citationPlainText(selectedText, url, tier) {
    if (clipboardCitation && typeof clipboardCitation.plainText === "function") {
      return clipboardCitation.plainText({
        selectedText,
        url,
        tier,
        sourceLabel: citationSourceLabel()
      });
    }

    const body = String(selectedText || "").replace(/^\s+|\s+$/g, "");
    return tier === "none" ? body : body + "\n\n\u2014 " + String(url || "");
  }

  function citationHtml(selectedText, url, tier) {
    if (tier === "none" || !selectedText) {
      return "";
    }

    if (clipboardCitation && typeof clipboardCitation.html === "function") {
      return clipboardCitation.html({
        selectedText,
        url,
        tier,
        sourceLabel: citationSourceLabel()
      });
    }

    return "<blockquote><p>" + escapeHtml(selectedText) + "</p></blockquote>";
  }

  function joinMetaParts(parts) {
    return parts
      .map((part) => '<span>' + escapeHtml(part) + "</span>")
      .join('<span class="meta-sep" aria-hidden="true">&middot;</span>');
  }

  function essayUrl(slug) {
    return router.build("essay", { essaySlug: slug });
  }

  function sectionUrl(slug, sectionNumber) {
    return router.build("section", { essaySlug: slug, sectionNumber });
  }

  function setLink(link, url, label) {
    if (!url) {
      link.classList.add("hidden");
      link.removeAttribute("href");
      return;
    }

    link.classList.remove("hidden");
    link.href = url;
    link.textContent = label;
  }

  function isPlainNavigationClick(event) {
    return event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey;
  }

  function routeFromLink(link) {
    if (!link || !link.href) {
      return null;
    }
    try {
      return router.parse(link.getAttribute("href"));
    } catch (_error) {
      return null;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function nextFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  }

  function sectionDirection(sectionNumber) {
    if (!currentSectionNumber) {
      return "next";
    }
    return Number(sectionNumber) < Number(currentSectionNumber) ? "previous" : "next";
  }

  function normalizedSectionDirection(value) {
    return value === "previous" ? "previous" : "next";
  }

  function clearSectionTurnClasses() {
    if (readerLayout) {
      readerLayout.classList.remove(
        "is-section-queued",
        "is-section-queued-next",
        "is-section-queued-previous",
        "is-section-turning",
        "is-section-turning-next",
        "is-section-turning-previous",
        "is-section-entering",
        "is-section-entering-next",
        "is-section-entering-previous"
      );
      readerLayout.removeAttribute("aria-busy");
    }
    document.documentElement.classList.remove("reader-section-is-turning");
  }

  function setSectionQueued(direction) {
    clearSectionTurnClasses();
    if (!readerLayout) {
      return;
    }
    const normalized = normalizedSectionDirection(direction);
    document.documentElement.classList.add("reader-section-is-turning");
    readerLayout.classList.add("is-section-queued", "is-section-queued-" + normalized);
    readerLayout.setAttribute("aria-busy", "true");
  }

  function setSectionTurnPhase(phase, direction) {
    clearSectionTurnClasses();
    if (!readerLayout || !phase) {
      return;
    }
    const normalized = normalizedSectionDirection(direction);
    document.documentElement.classList.add("reader-section-is-turning");
    readerLayout.classList.add("is-section-" + phase, "is-section-" + phase + "-" + normalized);
    readerLayout.setAttribute("aria-busy", "true");
  }

  function freezeArticleHeight() {
    if (!chapterArticle) {
      return;
    }
    const rect = chapterArticle.getBoundingClientRect();
    if (rect && rect.height > 0) {
      chapterArticle.style.minHeight = String(Math.ceil(rect.height)) + "px";
    }
  }

  function releaseArticleHeight() {
    if (chapterArticle) {
      chapterArticle.style.minHeight = "";
    }
  }

  async function swapSectionContent(callback, options) {
    const settings = options || {};
    if (
      settings.transition !== true ||
      prefersReducedMotion() ||
      !readerLayout ||
      !chapterArticle
    ) {
      callback();
      return;
    }

    const direction = normalizedSectionDirection(settings.direction);
    freezeArticleHeight();
    try {
      setSectionTurnPhase("turning", direction);
      await wait(SECTION_TURN_OUT_MS);

      callback();
      setSectionTurnPhase("entering", direction);
      void chapterArticle.offsetWidth;
      await nextFrame();

      clearSectionTurnClasses();
      await wait(SECTION_TURN_IN_MS);
    } finally {
      clearSectionTurnClasses();
      releaseArticleHeight();
    }
  }

  function sectionPayloadKey(essaySlug, sectionNumber) {
    return String(essaySlug) + ":" + String(sectionNumber);
  }

  function rememberSectionPayload(key, promise) {
    if (prefetchedSections.has(key)) {
      prefetchedSections.delete(key);
    }
    prefetchedSections.set(key, promise);
    while (prefetchedSections.size > SECTION_PAYLOAD_CACHE_MAX) {
      const oldest = prefetchedSections.keys().next().value;
      prefetchedSections.delete(oldest);
    }
    return promise;
  }

  function loadSectionPayload(essaySlug, sectionNumber) {
    const key = sectionPayloadKey(essaySlug, sectionNumber);
    const cached = prefetchedSections.get(key);
    if (cached) {
      return cached;
    }

    const promise = loadSection(essaySlug, sectionNumber);
    rememberSectionPayload(key, promise);
    promise.catch(() => {
      if (prefetchedSections.get(key) === promise) {
        prefetchedSections.delete(key);
      }
    });
    return promise;
  }

  function prefetchSectionRoute(route) {
    if (!route || route.view !== "section" || !route.essaySlug || !route.sectionNumber) {
      return null;
    }

    return loadSectionPayload(route.essaySlug, route.sectionNumber).catch(() => null);
  }

  function prefetchSectionFromLink(link) {
    return prefetchSectionRoute(routeFromLink(link));
  }

  function setFallbackVisible(isVisible) {
    if (!sectionTools) {
      return;
    }
    sectionTools.hidden = !isVisible;
  }

  function applyContextualButtonState(button, state) {
    if (!button) {
      return;
    }

    button.classList.remove("is-copied", "is-error");
    if (state === "copied") {
      button.classList.add("is-copied");
      button.innerHTML =
        '<span class="selection-copy-icon" aria-hidden="true">' +
          '<svg class="selection-copy-icon-svg" viewBox="0 0 16 16" focusable="false" aria-hidden="true">' +
            '<path d="M3.25 8.5L6.5 11.75L12.75 5.5"></path>' +
          "</svg>" +
        "</span>" +
        "<span>" + CONTEXTUAL_LABEL_COPIED + "</span>";
      button.setAttribute("aria-label", "Link copied");
      return;
    }

    if (state === "error") {
      button.classList.add("is-error");
      button.textContent = CONTEXTUAL_LABEL_ERROR;
      button.setAttribute("aria-label", CONTEXTUAL_LABEL_ERROR);
      return;
    }

    button.textContent = CONTEXTUAL_LABEL_DEFAULT;
    button.setAttribute("aria-label", CONTEXTUAL_LABEL_DEFAULT);
  }

  function setContextualButtonState(state) {
    const normalized = state === "copied" || state === "error" ? state : "default";
    applyContextualButtonState(selectionCopyChip, normalized);
    applyContextualButtonState(selectionCopyBarButton, normalized);
  }

  function ensureContextualShareControls() {
    if (!selectionCopyChip) {
      const chip = document.createElement("button");
      chip.id = "selection-copy-chip";
      chip.className = "selection-copy-chip button";
      chip.type = "button";
      chip.hidden = true;
      document.body.appendChild(chip);
      selectionCopyChip = chip;
    }

    if (!selectionCopyBar) {
      const bar = document.createElement("div");
      bar.id = "selection-copy-bar";
      bar.className = "selection-copy-bar";
      bar.hidden = true;
      document.body.appendChild(bar);
      selectionCopyBar = bar;
    }

    if (!selectionCopyBarButton) {
      const barButton = document.createElement("button");
      barButton.id = "selection-copy-bar-button";
      barButton.className = "button";
      barButton.type = "button";
      selectionCopyBar.appendChild(barButton);
      selectionCopyBarButton = barButton;
    } else if (selectionCopyBar && !selectionCopyBar.contains(selectionCopyBarButton)) {
      selectionCopyBar.appendChild(selectionCopyBarButton);
    }

    setContextualButtonState("default");

    hasContextualShare = typeof window.getSelection === "function" &&
      Boolean(selectionCopyChip && selectionCopyBar && selectionCopyBarButton);
  }

  function ensureCopyToast() {
    if (copyToast) {
      return;
    }

    const toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.className = "copy-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
    copyToast = toast;
  }

  function hideCopyToast() {
    if (!copyToast) {
      return;
    }
    copyToast.classList.remove("is-visible", "is-error");
    copyToast.hidden = true;
    if (copyToastTimer) {
      clearTimeout(copyToastTimer);
      copyToastTimer = null;
    }
  }

  function showCopyToast(message, isError, durationMs) {
    ensureCopyToast();
    if (!copyToast) {
      return;
    }

    if (copyToastTimer) {
      clearTimeout(copyToastTimer);
      copyToastTimer = null;
    }

    copyToast.hidden = false;
    copyToast.textContent = String(message || "");
    copyToast.classList.toggle("is-error", Boolean(isError));
    copyToast.classList.remove("is-visible");
    void copyToast.offsetWidth;
    copyToast.classList.add("is-visible");

    const duration = Number.isFinite(durationMs) ? durationMs : (isError ? 2200 : 1600);
    copyToastTimer = setTimeout(() => {
      hideCopyToast();
    }, duration);
  }

  function isMobileLayout() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function isMacPlatform() {
    const probe = String(
      (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.platform ||
        navigator.userAgent ||
        ""
    );
    return /mac|iphone|ipad|ipod/i.test(probe);
  }

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function copyHintAlreadySeen() {
    try {
      return window.localStorage.getItem(COPY_HINT_STORAGE_KEY) === "1";
    } catch (_error) {
      // No storage (private mode / sandbox): behave as already seen so we never nag.
      return true;
    }
  }

  function markCopyHintSeen() {
    try {
      window.localStorage.setItem(COPY_HINT_STORAGE_KEY, "1");
    } catch (_error) {
      // ignore
    }
  }

  function ensureCopyHintElement() {
    if (copyHintElement) {
      return copyHintElement;
    }
    const hint = document.createElement("div");
    hint.id = "selection-copy-hint";
    hint.className = "selection-copy-hint";
    hint.setAttribute("role", "status");
    hint.setAttribute("aria-live", "polite");
    hint.hidden = true;
    document.body.appendChild(hint);
    copyHintElement = hint;
    return hint;
  }

  function dismissCopyHint() {
    if (copyHintTimer) {
      clearTimeout(copyHintTimer);
      copyHintTimer = null;
    }
    copyHintActive = false;
    if (copyHintElement) {
      copyHintElement.classList.remove("is-visible");
      copyHintElement.hidden = true;
    }
  }

  function maybeShowCopyHint(rect) {
    if (copyHintActive || !rect || isMobileLayout() || copyHintAlreadySeen()) {
      return;
    }

    // First qualifying selection only — and only once, ever, per reader.
    copyHintActive = true;
    markCopyHintSeen();

    const hint = ensureCopyHintElement();
    const shortcut = isMacPlatform() ? "⌘C" : "Ctrl+C";
    hint.textContent = shortcut + " keeps a link back to this passage";

    hint.hidden = false;
    hint.style.visibility = "hidden";
    hint.style.left = "0px";
    hint.style.top = "0px";

    const hintRect = hint.getBoundingClientRect();
    const margin = 10;
    let left = rect.left + (rect.width / 2) - (hintRect.width / 2);
    left = clamp(left, margin, window.innerWidth - hintRect.width - margin);

    let top = rect.bottom + 12;
    if (top + hintRect.height > window.innerHeight - margin) {
      top = rect.top - hintRect.height - 12;
    }
    top = clamp(top, margin, window.innerHeight - hintRect.height - margin);

    hint.style.left = String(Math.round(left)) + "px";
    hint.style.top = String(Math.round(top)) + "px";
    hint.style.visibility = "visible";
    hint.classList.remove("is-visible");
    void hint.offsetWidth;
    hint.classList.add("is-visible");

    copyHintTimer = setTimeout(dismissCopyHint, COPY_HINT_VISIBLE_MS);
  }

  function clearContextualHideTimer() {
    if (hideContextualTimer) {
      clearTimeout(hideContextualTimer);
      hideContextualTimer = null;
    }
  }

  function hideContextualShare() {
    clearContextualHideTimer();
    dismissCopyHint();
    setContextualButtonState("default");
    if (selectionCopyChip) {
      selectionCopyChip.classList.remove("is-visible");
      selectionCopyChip.hidden = true;
      selectionCopyChip.style.visibility = "";
      selectionCopyChip.style.left = "";
      selectionCopyChip.style.top = "";
    }
    if (selectionCopyBar) {
      selectionCopyBar.classList.remove("is-visible");
      selectionCopyBar.hidden = true;
    }
  }

  function scheduleHideContextualShare(delayMs) {
    clearContextualHideTimer();
    hideContextualTimer = setTimeout(() => {
      hideContextualShare();
    }, delayMs);
  }

  function positionSelectionChip(rect) {
    if (!selectionCopyChip) {
      return;
    }
    const wasHidden = selectionCopyChip.hidden;
    selectionCopyChip.hidden = false;
    if (wasHidden) {
      selectionCopyChip.style.visibility = "hidden";
      selectionCopyChip.style.left = "0px";
      selectionCopyChip.style.top = "0px";
    }

    const chipRect = selectionCopyChip.getBoundingClientRect();
    const margin = 8;
    const verticalOffset = 10;
    let left = rect.left + (rect.width / 2) - (chipRect.width / 2);
    left = clamp(left, margin, window.innerWidth - chipRect.width - margin);

    let top = rect.top - chipRect.height - verticalOffset;
    if (top < margin) {
      top = rect.bottom + verticalOffset;
    }
    top = clamp(top, margin, window.innerHeight - chipRect.height - margin);

    selectionCopyChip.style.left = String(Math.round(left)) + "px";
    selectionCopyChip.style.top = String(Math.round(top)) + "px";
    selectionCopyChip.style.visibility = "visible";
    if (wasHidden) {
      selectionCopyChip.classList.remove("is-visible");
      void selectionCopyChip.offsetWidth;
      selectionCopyChip.classList.add("is-visible");
    }
  }

  function showContextualShare(rect) {
    clearContextualHideTimer();
    setContextualButtonState("default");
    if (isMobileLayout()) {
      if (selectionCopyChip) {
        selectionCopyChip.hidden = true;
      }
      if (selectionCopyBar) {
        const wasHidden = selectionCopyBar.hidden;
        selectionCopyBar.hidden = false;
        if (wasHidden) {
          selectionCopyBar.classList.remove("is-visible");
          void selectionCopyBar.offsetWidth;
          selectionCopyBar.classList.add("is-visible");
        }
      }
      return;
    }

    if (selectionCopyBar) {
      selectionCopyBar.hidden = true;
    }
    if (rect) {
      positionSelectionChip(rect);
    } else {
      selectionCopyChip.hidden = true;
    }
  }

  function queryParams() {
    return new URLSearchParams(window.location.search);
  }

  function setSectionSubtitle(text) {
    const value = String(text || "").trim();
    sectionSubtitle.textContent = value ? "(" + value + ")" : "";
    sectionSubtitle.hidden = !value;
  }

  function queryEssaySlug() {
    const value = queryParams().get("essay");
    return value ? value.trim() : "";
  }

  function querySectionNumber() {
    const value = queryParams().get("section");
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function querySearchTerm() {
    const value = queryParams().get("q");
    return value ? value.trim() : "";
  }

  function queryOccurrence() {
    const value = Number.parseInt(queryParams().get("occ"), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function queryMatchMode() {
    return normalizeMode(queryParams().get("mode"));
  }

  function queryCaseSensitive() {
    return parseBooleanFlag(queryParams().get("case"));
  }

  function queryReadingStateDebug() {
    const value = String(queryParams().get("debugReadingState") || "").toLowerCase();
    return value === "1" || value === "true";
  }

  function queryHighlightPayload() {
    const params = queryParams();
    const text = String(params.get("hl") || "").trim();
    const prefix = String(params.get("hlp") || "").trim();
    const suffix = String(params.get("hls") || "").trim();
    if (!text) {
      return null;
    }
    return { text, prefix, suffix };
  }

  function queryParagraphAnchor() {
    const value = String(queryParams().get("p") || "").trim();
    if (!value) {
      return null;
    }

    const parsePassageNumber = (part) => {
      const normalized = String(part || "").trim().toLowerCase().replace(/^p/, "");
      const parsed = Number.parseInt(normalized, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const parts = value.split("-");
    const start = parsePassageNumber(parts[0]);
    const end = parts.length > 1 ? parsePassageNumber(parts[1]) : start;
    if (start === null || end === null) {
      return null;
    }

    return {
      start: Math.min(start, end),
      end: Math.max(start, end)
    };
  }

  function queryRangeAnchor() {
    const value = String(queryParams().get("r") || "").trim();
    if (!value) {
      return null;
    }

    const parts = value.split("-");
    if (parts.length !== 2) {
      return null;
    }

    const start = Number.parseInt(parts[0], 36);
    const end = Number.parseInt(parts[1], 36);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return null;
    }

    return { start, end };
  }

  function queryPassageRangeOffsets() {
    const params = queryParams();
    if (!params.has("start") || !params.has("end")) {
      return null;
    }

    const start = Number.parseInt(params.get("start"), 10);
    const end = Number.parseInt(params.get("end"), 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return null;
    }

    return { start, end };
  }

  function hasReaderAnchorIntent() {
    const params = queryParams();
    return (
      params.has("p") ||
      params.has("start") ||
      params.has("end") ||
      params.has("r") ||
      params.has("hl") ||
      params.has("occ") ||
      params.has("q") ||
      String(window.location.hash || "").includes(":~:text=")
    );
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

  function showMessage(message, options) {
    const settings = options || {};
    const body = String(settings.body || "The requested page is not available.").trim();
    essayLine.textContent = "Renaissance";
    sectionKicker.textContent = "Reader";
    sectionTitle.textContent = message;
    setSectionSubtitle("");
    sectionMeta.textContent = "";
    clearNode(sectionContent);

    const paragraph = document.createElement("p");
    paragraph.className = "muted";
    paragraph.textContent = body;

    const actions = document.createElement("p");
    actions.className = "reader-message-actions";
    if (settings.closestEssay) {
      actions.appendChild(makeActionLink(
        essayUrl(settings.closestEssay.slug),
        "Open " + settings.closestEssay.title,
        "button"
      ));
      actions.appendChild(document.createTextNode(" "));
    }
    if (settings.closestSection && settings.closestEssayForSection) {
      const display = sectionDisplay(settings.closestEssayForSection, settings.closestSection);
      actions.appendChild(makeActionLink(
        sectionUrl(settings.closestEssayForSection.slug, settings.closestSection),
        "Open " + display.title,
        "button"
      ));
      actions.appendChild(document.createTextNode(" "));
    }
    if (settings.essayContents) {
      actions.appendChild(makeActionLink(
        essayUrl(settings.essayContents.slug),
        "Open " + settings.essayContents.title,
        settings.closestSection ? "button button-ghost" : "button"
      ));
      actions.appendChild(document.createTextNode(" "));
    }
    if (settings.query) {
      actions.appendChild(makeActionLink(
        router.build("search", { query: settings.query }),
        "Search \"" + settings.query + "\"",
        "button button-ghost"
      ));
      actions.appendChild(document.createTextNode(" "));
    }
    actions.appendChild(makeActionLink(router.build("archive", {}), "Return to the archive", "button"));
    actions.appendChild(document.createTextNode(" "));
    actions.appendChild(makeActionLink(router.build("search", {}), "Search the essays", "button button-ghost"));

    sectionContent.appendChild(paragraph);
    sectionContent.appendChild(actions);
    backToEssay.href = router.build("archive", {});
    backToEssay.textContent = "Archive";
    setRobotsNoIndex();
    setPageMetadata({
      title: message + " \u00b7 Renaissance",
      description: body,
      canonical: toAbsoluteUrl(router.build("archive", {})),
      image: toAbsoluteUrl("assets/og-home.png")
    });
    if (copyHighlightButton) {
      copyHighlightButton.disabled = true;
    }
    setFallbackVisible(false);
    copyHighlightStatus.textContent = "";
    clearHighlightCapNote();
    hideCopyToast();
    clearResumeBookmark({ fade: false });
    activeSelectionDetails = null;
    hideContextualShare();
    setLink(prevLink, null, "");
    setLink(nextLink, null, "");
    setLink(nextCta, null, "");
    setReaderProgress(0);
    announcePageReady();
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
  }

  function documentScrollY() {
    return window.scrollY || window.pageYOffset || 0;
  }

  function computeReadingProgress() {
    if (!sectionContent || !sectionContent.childElementCount) {
      return 0;
    }

    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const scrollY = documentScrollY();
    const rect = sectionContent.getBoundingClientRect();
    const contentTop = rect.top + scrollY;
    const contentBottom = rect.bottom + scrollY;
    const start = Math.max(0, contentTop - (viewportHeight * 0.18));
    const end = Math.max(start + 1, contentBottom - (viewportHeight * 0.62));
    return clamp((scrollY - start) / (end - start), 0, 1);
  }

  function readingLineY() {
    return Math.max(MIN_READING_LINE_Y, (window.innerHeight || 0) * READING_LINE_RATIO);
  }

  function paragraphIndexFromElement(paragraph) {
    if (!paragraph || !paragraph.dataset) {
      return null;
    }
    const index = Number.parseInt(paragraph.dataset.paragraphIndex, 10);
    return Number.isFinite(index) && index > 0 ? index : null;
  }

  function normalizeParagraphRatio(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, 0, 1) : null;
  }

  function paragraphByIndex(index) {
    const safeIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(safeIndex) || safeIndex <= 0) {
      return null;
    }
    return sectionContent.querySelector('p[data-paragraph-index="' + String(safeIndex) + '"]');
  }

  function passageElementByIndex(index) {
    const safeIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(safeIndex) || safeIndex <= 0) {
      return null;
    }
    const passageId = "p" + String(safeIndex);
    return sectionContent.querySelector(
      '[data-passage-index="' + String(safeIndex) + '"], ' +
      '[data-passage-id="' + passageId + '"], ' +
      'p[data-paragraph-index="' + String(safeIndex) + '"]'
    );
  }

  function paragraphSignatureFromElement(paragraph) {
    if (!paragraph || !readingState || typeof readingState.paragraphSignatureFromText !== "function") {
      return null;
    }
    return readingState.paragraphSignatureFromText(paragraph.textContent || "");
  }

  function paragraphSignatureMatches(paragraph, signature) {
    return Boolean(paragraph && signature && paragraphSignatureFromElement(paragraph) === signature);
  }

  function paragraphBySignature(signature) {
    if (!signature) {
      return null;
    }

    const paragraphs = Array.from(sectionContent.querySelectorAll("p[data-paragraph-index]"));
    return paragraphs.find((paragraph) => paragraphSignatureMatches(paragraph, signature)) || null;
  }

  function paragraphRatioAtY(paragraph, viewportY) {
    if (!paragraph) {
      return null;
    }

    const rect = paragraph.getBoundingClientRect();
    const height = Math.max(1, rect.height);
    return clamp((viewportY - rect.top) / height, 0, 1);
  }

  function nearestParagraphToReadingLine() {
    const paragraphs = Array.from(sectionContent.querySelectorAll("p[data-paragraph-index]"));
    if (!paragraphs.length) {
      return null;
    }

    const targetY = readingLineY();
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const paragraph of paragraphs) {
      const rect = paragraph.getBoundingClientRect();
      if (rect.top <= targetY && rect.bottom >= targetY) {
        return paragraph;
      }

      const distance = Math.min(Math.abs(rect.top - targetY), Math.abs(rect.bottom - targetY));
      if (distance < nearestDistance) {
        nearest = paragraph;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  function currentResumePointer() {
    const paragraph = nearestParagraphToReadingLine();
    if (!paragraph) {
      return null;
    }

    return {
      paragraph,
      paragraphIndex: paragraphIndexFromElement(paragraph),
      paragraphRatio: paragraphRatioAtY(paragraph, readingLineY()),
      paragraphSignature: paragraphSignatureFromElement(paragraph)
    };
  }

  function readerProgressOpacity(value) {
    const viewport = Math.max(1, window.innerHeight || 1);
    const scrolled = documentScrollY();
    // Hold the bar hidden until the reader is roughly a screen in — a thin
    // sliver at the very top is just noise — then let it recede again as they
    // cross into the final stretch and the count is all but done.
    const fadeIn = clamp((scrolled - viewport * 0.6) / (viewport * 0.4), 0, 1);
    const fadeOut = clamp((1 - value) / 0.18, 0, 1);
    return Math.min(fadeIn, fadeOut);
  }

  function setReaderProgress(progress) {
    if (!readerProgressBar) {
      return;
    }

    const value = clamp(progress, 0, 1);
    readerProgressBar.style.transform = "scaleX(" + value.toFixed(4) + ")";
    readerProgressBar.style.opacity = readerProgressOpacity(value).toFixed(3);
  }

  function saveReadingProgress(progress) {
    if (!readingState || !currentEssay || !currentSectionNumber || !currentDisplay || suppressProgressSave) {
      updateReadingStateDebug();
      return;
    }

    const pointer = currentResumePointer();
    const attention = attentionSnapshot();
    readingState.saveSectionProgress({
      essaySlug: currentEssay.slug,
      sectionNumber: currentSectionNumber,
      progress,
      scrollY: documentScrollY(),
      resumeParagraphIndex: pointer ? pointer.paragraphIndex : null,
      resumeParagraphRatio: pointer ? pointer.paragraphRatio : null,
      resumeParagraphSignature: pointer ? pointer.paragraphSignature : null,
      attentionProgress: attention ? attention.progress : null,
      readParagraphs: attention ? attention.readParagraphs : null,
      attentionPartial: attention ? attention.partial : null,
      essayTitle: currentEssay.title,
      sectionTitle: currentDisplay.title,
      sectionLabel: currentDisplay.label
    });
    updateReadingStateDebug();
  }

  function syncReadingProgress(options) {
    const settings = options || {};
    const progress = computeReadingProgress();
    setReaderProgress(progress);
    if (settings.save !== false) {
      saveReadingProgress(progress);
    }
    return progress;
  }

  function scheduleReadingProgressSync() {
    if (progressFrame) {
      return;
    }

    progressFrame = requestAnimationFrame(() => {
      progressFrame = null;
      const progress = syncReadingProgress({ save: false });
      if (progressSaveTimer) {
        clearTimeout(progressSaveTimer);
      }
      progressSaveTimer = setTimeout(() => {
        progressSaveTimer = null;
        saveReadingProgress(progress);
      }, 180);
    });
  }

  function flushReadingProgress() {
    if (progressFrame) {
      cancelAnimationFrame(progressFrame);
      progressFrame = null;
    }
    if (progressSaveTimer) {
      clearTimeout(progressSaveTimer);
      progressSaveTimer = null;
    }
    syncReadingProgress();
  }

  function bindReadingProgressEvents() {
    if (progressEventsBound) {
      return;
    }
    progressEventsBound = true;

    window.addEventListener("scroll", () => {
      scheduleReadingProgressSync();
      if (resumeBookmarkDismissArmed) {
        clearResumeBookmark({ fade: true });
      }
    }, { passive: true });
    window.addEventListener("resize", scheduleReadingProgressSync);
    window.addEventListener("pagehide", () => {
      stopAttentionHeartbeat();
      flushReadingProgress();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        flushReadingProgress();
      }
    });
  }

  // --- Reading-attention heartbeat -----------------------------------------
  // The scroll-fraction above answers "where am I on the page" and drives the
  // visual bar + resume geometry. The attention model answers a different
  // question — "how much did I actually read" — and supersedes scroll depth for
  // the archive's "Continue reading" percentage. It is a thin wiring layer: all
  // the intelligence lives in the pure RenaissanceReadingAttention core, which
  // is unit-tested in isolation. Here we only sample the DOM (zone occupancy,
  // scroll velocity, presence) and feed it ticks.

  function paragraphWordCount(paragraph) {
    const text = (paragraph.textContent || "").trim();
    if (!text) {
      return 0;
    }
    return text.split(/\s+/).length;
  }

  function attentionParagraphElements() {
    return sectionContent
      ? Array.from(sectionContent.querySelectorAll("p[data-paragraph-index]"))
      : [];
  }

  // Which paragraphs overlap the reading band, weighted by how much of the
  // band each one occupies — credit follows the eyes, not the screen edges.
  function readingZoneOccupancy() {
    const viewportHeight = Math.max(1, window.innerHeight || 0);
    const lineY = readingLineY();
    const band = Math.max(1, viewportHeight * READING_ATTENTION_ZONE_HALF);
    const top = lineY - band;
    const bottom = lineY + band;
    const span = Math.max(1, bottom - top);
    const zone = [];

    attentionParagraphElements().forEach((paragraph) => {
      const index = paragraphIndexFromElement(paragraph);
      if (index === null) {
        return;
      }
      const rect = paragraph.getBoundingClientRect();
      const overlap = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
      if (overlap > 0) {
        zone.push({ index, weight: clamp(overlap / span, 0, 1) });
      }
    });

    return zone;
  }

  function setupReadingAttention() {
    stopAttentionHeartbeat();
    attentionModel = null;
    attentionLastSampleAt = null;
    attentionLastSavedAt = null;
    attentionLastScrollY = documentScrollY();

    if (!readingAttention || typeof readingAttention.create !== "function" || !sectionContent) {
      return;
    }

    const paragraphs = attentionParagraphElements()
      .map((paragraph) => ({
        index: paragraphIndexFromElement(paragraph),
        words: paragraphWordCount(paragraph)
      }))
      .filter((entry) => entry.index !== null);

    if (!paragraphs.length) {
      return;
    }

    let state = null;
    if (readingState && currentEssay && currentSectionNumber) {
      const record = readingState.getSectionRecord(currentEssay.slug, currentSectionNumber);
      if (record && ((record.readParagraphs && record.readParagraphs.length) || record.attentionPartial)) {
        state = {
          readParagraphs: record.readParagraphs || [],
          partial: record.attentionPartial || null
        };
      }
    }

    attentionModel = readingAttention.create(paragraphs, state ? { state } : undefined);
  }

  function attentionSnapshot() {
    if (!attentionModel) {
      return null;
    }
    const summary = attentionModel.summary();
    const serialized = attentionModel.serialize();
    return {
      progress: summary.progress,
      readParagraphs: serialized.readParagraphs,
      partial: serialized.partial || null
    };
  }

  function attentionClock() {
    return (typeof performance === "object" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
  }

  function attentionTick() {
    if (!attentionModel) {
      return;
    }

    const now = attentionClock();
    const visible = !document.hidden;
    const scrollY = documentScrollY();
    let velocity = 0;
    if (attentionLastSampleAt !== null) {
      const dt = now - attentionLastSampleAt;
      if (dt > 0) {
        velocity = Math.abs(scrollY - attentionLastScrollY) / dt;
      }
    }
    attentionLastSampleAt = now;
    attentionLastScrollY = scrollY;

    attentionModel.tick({
      now,
      zone: visible ? readingZoneOccupancy() : [],
      velocity,
      visible
    });

    // Reading without scrolling fires no scroll event, so the heartbeat is the
    // only thing that would persist the accruing read-set — save on a throttle.
    if (!suppressProgressSave && (attentionLastSavedAt === null || now - attentionLastSavedAt >= READING_ATTENTION_SAVE_MS)) {
      attentionLastSavedAt = now;
      saveReadingProgress(computeReadingProgress());
    }
  }

  function startAttentionHeartbeat() {
    stopAttentionHeartbeat();
    if (!attentionModel) {
      return;
    }
    attentionHeartbeat = window.setInterval(attentionTick, READING_ATTENTION_HEARTBEAT_MS);
  }

  function stopAttentionHeartbeat() {
    if (attentionHeartbeat) {
      window.clearInterval(attentionHeartbeat);
      attentionHeartbeat = null;
    }
  }

  function maxDocumentScrollY() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  function ratioFromSavedScroll(record, paragraph) {
    if (!record || !paragraph || !(Number(record.scrollY) > 0)) {
      return null;
    }

    const rect = paragraph.getBoundingClientRect();
    const height = Math.max(1, rect.height);
    const paragraphTop = rect.top + documentScrollY();
    const paragraphBottom = paragraphTop + height;
    const savedReadingLine = Number(record.scrollY) + readingLineY();
    if (savedReadingLine < paragraphTop || savedReadingLine > paragraphBottom) {
      return null;
    }

    return clamp((savedReadingLine - paragraphTop) / height, 0, 1);
  }

  function scrollTargetForParagraph(paragraph, ratio) {
    const rect = paragraph.getBoundingClientRect();
    const paragraphTop = rect.top + documentScrollY();
    const paragraphHeight = Math.max(1, rect.height);
    const paragraphRatio = normalizeParagraphRatio(ratio) || 0;
    const documentTarget = paragraphTop + (paragraphHeight * paragraphRatio);
    return clamp(documentTarget - readingLineY(), 0, maxDocumentScrollY());
  }

  function resolveRestoreTarget(record) {
    const savedScrollY = clamp(Number(record && record.scrollY) || 0, 0, maxDocumentScrollY());
    const savedSignature = record && record.resumeParagraphSignature ? record.resumeParagraphSignature : null;
    const indexedParagraph = record && record.resumeParagraphIndex
      ? paragraphByIndex(record.resumeParagraphIndex)
      : null;
    const signatureParagraph = savedSignature ? paragraphBySignature(savedSignature) : null;
    const savedParagraph = signatureParagraph && !paragraphSignatureMatches(indexedParagraph, savedSignature)
      ? signatureParagraph
      : indexedParagraph || signatureParagraph;
    const usedSignatureFallback = Boolean(signatureParagraph && savedParagraph === signatureParagraph && savedParagraph !== indexedParagraph);

    if (savedParagraph) {
      const recordRatio = normalizeParagraphRatio(record.resumeParagraphRatio);
      const derivedRatio = ratioFromSavedScroll(record, savedParagraph);
      const paragraphRatio = recordRatio !== null
        ? recordRatio
        : derivedRatio !== null ? derivedRatio : 0;
      const paragraphIndex = paragraphIndexFromElement(savedParagraph);

      return {
        mode: usedSignatureFallback
          ? "semantic-signature"
          : recordRatio !== null ? "semantic" : derivedRatio !== null ? "semantic-derived" : "paragraph-top",
        paragraphElement: savedParagraph,
        paragraphIndex,
        paragraphRatio,
        paragraphSignature: paragraphSignatureFromElement(savedParagraph),
        scrollY: scrollTargetForParagraph(savedParagraph, paragraphRatio)
      };
    }

    if (savedScrollY > 0) {
      return {
        mode: "scroll-fallback",
        paragraphElement: null,
        paragraphIndex: null,
        paragraphRatio: null,
        scrollY: savedScrollY
      };
    }

    return null;
  }

  function targetFromCurrentReadingLine(mode) {
    const pointer = currentResumePointer();
    if (!pointer) {
      return null;
    }

    return {
      mode,
      paragraphElement: pointer.paragraph,
      paragraphIndex: pointer.paragraphIndex,
      paragraphRatio: pointer.paragraphRatio,
      paragraphSignature: pointer.paragraphSignature,
      scrollY: documentScrollY()
    };
  }

  function startRestoreSaveSuppression() {
    suppressProgressSave = true;
    if (restoreSaveSuppressTimer) {
      clearTimeout(restoreSaveSuppressTimer);
      restoreSaveSuppressTimer = null;
    }
  }

  function releaseRestoreSaveSuppressionSoon() {
    if (restoreSaveSuppressTimer) {
      clearTimeout(restoreSaveSuppressTimer);
    }
    restoreSaveSuppressTimer = setTimeout(() => {
      restoreSaveSuppressTimer = null;
      suppressProgressSave = false;
      updateReadingStateDebug();
    }, RESTORE_SAVE_SUPPRESS_MS);
  }

  function restoreDebugSnapshot(target) {
    if (!target) {
      return null;
    }

    return {
      mode: target.mode,
      paragraphIndex: target.paragraphIndex,
      paragraphRatio: target.paragraphRatio,
      paragraphSignature: target.paragraphSignature,
      scrollY: Math.round(target.scrollY)
    };
  }

  function restoreReadingPosition() {
    if (!readingState || !currentEssay || !currentSectionNumber) {
      return false;
    }

    const record = readingState.getSectionRecord(currentEssay.slug, currentSectionNumber);
    if (!readingState.shouldRestore(record)) {
      return false;
    }

    const initialTarget = resolveRestoreTarget(record);
    if (!initialTarget) {
      return false;
    }

    startRestoreSaveSuppression();
    lastRestoreDebug = restoreDebugSnapshot(initialTarget);
    updateReadingStateDebug();

    requestAnimationFrame(() => {
      const target = resolveRestoreTarget(record) || initialTarget;
      window.scrollTo({ top: target.scrollY, left: 0, behavior: "auto" });
      syncReadingProgress({ save: false });
      window.setTimeout(() => {
        const settledTarget = target.mode === "scroll-fallback"
          ? targetFromCurrentReadingLine("scroll-fallback")
          : resolveRestoreTarget(record) || target;
        if (settledTarget && Math.abs(settledTarget.scrollY - documentScrollY()) > 2) {
          window.scrollTo({ top: settledTarget.scrollY, left: 0, behavior: "auto" });
        }
        syncReadingProgress({ save: false });
        lastRestoreDebug = restoreDebugSnapshot(settledTarget || target);
        showResumeBookmark(settledTarget || target);
        updateReadingStateDebug();
        releaseRestoreSaveSuppressionSoon();
      }, 120);
    });
    return true;
  }

  function initializeReadingProgress(display) {
    currentDisplay = display;
    bindReadingProgressEvents();
    setupReadingAttention();
    startAttentionHeartbeat();
    syncReadingProgress({ save: false });
  }

  function clearResumeBookmark(options) {
    const settings = options || {};
    resumeBookmarkDismissArmed = false;
    if (resumeBookmarkFadeTimer) {
      clearTimeout(resumeBookmarkFadeTimer);
      resumeBookmarkFadeTimer = null;
    }
    if (resumeBookmarkRemoveTimer) {
      clearTimeout(resumeBookmarkRemoveTimer);
      resumeBookmarkRemoveTimer = null;
    }

    const target = resumeBookmarkElement;
    if (!target) {
      return;
    }

    const remove = () => {
      target.classList.remove("reader-resume-bookmark", "is-fading");
      target.style.removeProperty("--reader-bookmark-offset");
      if (resumeBookmarkElement === target) {
        resumeBookmarkElement = null;
      }
      updateReadingStateDebug();
    };

    if (settings.fade === false) {
      remove();
      return;
    }

    target.classList.add("is-fading");
    resumeBookmarkRemoveTimer = setTimeout(remove, 560);
  }

  function resumeBookmarkTarget(reference) {
    if (reference && reference.paragraphElement) {
      return reference.paragraphElement;
    }
    if (reference && reference.resumeParagraphIndex) {
      const saved = paragraphByIndex(reference.resumeParagraphIndex);
      if (saved) {
        return saved;
      }
    }
    const pointer = currentResumePointer();
    return pointer ? pointer.paragraph : null;
  }

  function bookmarkOffsetForTarget(target, reference) {
    const rect = target.getBoundingClientRect();
    const paragraphHeight = Math.max(1, rect.height);
    const ratio = normalizeParagraphRatio(reference && reference.paragraphRatio);
    const resolvedRatio = ratio !== null ? ratio : paragraphRatioAtY(target, readingLineY()) || 0;
    const maxOffset = Math.max(0, paragraphHeight - 42);
    return clamp((paragraphHeight * resolvedRatio) - 14, 0, maxOffset);
  }

  function showResumeBookmark(reference) {
    const target = resumeBookmarkTarget(reference);
    if (!target) {
      return;
    }

    clearResumeBookmark({ fade: false });
    resumeBookmarkElement = target;
    target.style.setProperty("--reader-bookmark-offset", bookmarkOffsetForTarget(target, reference).toFixed(1) + "px");
    target.classList.add("reader-resume-bookmark");

    resumeBookmarkFadeTimer = setTimeout(() => {
      clearResumeBookmark({ fade: true });
    }, BOOKMARK_AUTO_CLEAR_MS);

    setTimeout(() => {
      if (resumeBookmarkElement === target) {
        resumeBookmarkDismissArmed = true;
      }
    }, 900);
  }

  function ensureReadingStateDebugPanel() {
    if (!queryReadingStateDebug()) {
      return null;
    }
    if (readingStateDebugPanel) {
      return readingStateDebugPanel;
    }

    readingStateDebugPanel = document.createElement("aside");
    readingStateDebugPanel.className = "reading-state-debug";
    readingStateDebugPanel.setAttribute("aria-label", "Reading state debug");
    document.body.appendChild(readingStateDebugPanel);
    return readingStateDebugPanel;
  }

  function formatDebugValue(value) {
    if (value === null || value === undefined || value === "") {
      return "-";
    }
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    return String(value);
  }

  function updateReadingStateDebug() {
    const panel = ensureReadingStateDebugPanel();
    if (!panel) {
      return;
    }

    const record = readingState && currentEssay && currentSectionNumber
      ? readingState.getSectionRecord(currentEssay.slug, currentSectionNumber)
      : null;
    const pointer = currentResumePointer();
    const bookmarkIndex = resumeBookmarkElement ? paragraphIndexFromElement(resumeBookmarkElement) : null;
    const bookmarkOffset = resumeBookmarkElement
      ? resumeBookmarkElement.style.getPropertyValue("--reader-bookmark-offset")
      : "";

    panel.textContent = [
      "Reading state",
      "saved p: " + formatDebugValue(record && record.resumeParagraphIndex),
      "saved ratio: " + formatDebugValue(record && record.resumeParagraphRatio),
      "saved y: " + formatDebugValue(record && Math.round(record.scrollY)),
      "current p: " + formatDebugValue(pointer && pointer.paragraphIndex),
      "current ratio: " + formatDebugValue(pointer && pointer.paragraphRatio),
      "restore: " + formatDebugValue(lastRestoreDebug && lastRestoreDebug.mode),
      "restore p: " + formatDebugValue(lastRestoreDebug && lastRestoreDebug.paragraphIndex),
      "restore ratio: " + formatDebugValue(lastRestoreDebug && lastRestoreDebug.paragraphRatio),
      "bookmark p: " + formatDebugValue(bookmarkIndex),
      "bookmark offset: " + formatDebugValue(bookmarkOffset),
      "saving: " + (suppressProgressSave ? "suppressed" : "active")
    ].join("\n");
  }

  function clearAutoHighlights() {
    const marks = sectionContent.querySelectorAll('mark[data-auto-highlight="1"]');
    marks.forEach((mark) => {
      const text = document.createTextNode(mark.textContent || "");
      mark.replaceWith(text);
    });
    sectionContent.normalize();
  }

  function annotateParagraphIndices() {
    const paragraphs = sectionContent.querySelectorAll("p");
    paragraphs.forEach((paragraph, index) => {
      paragraph.dataset.paragraphIndex = String(index + 1);
      if (!paragraph.dataset.passageIndex) {
        paragraph.dataset.passageIndex = String(index + 1);
      }
      if (!paragraph.dataset.passageId) {
        paragraph.dataset.passageId = "p" + String(index + 1);
      }
    });
  }

  function buildNodeSpans(root) {
    const spans = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let cursor = 0;
    while (node) {
      const value = node.nodeValue || "";
      const length = value.length;
      if (length > 0) {
        spans.push({
          node,
          start: cursor,
          end: cursor + length
        });
        cursor += length;
      }
      node = walker.nextNode();
    }
    return {
      spans,
      text: spans.map((entry) => entry.node.nodeValue || "").join("")
    };
  }

  function locateStartOffset(spans, absoluteOffset) {
    for (const span of spans) {
      if (absoluteOffset >= span.start && absoluteOffset < span.end) {
        return {
          node: span.node,
          offset: absoluteOffset - span.start
        };
      }
    }

    if (spans.length > 0 && absoluteOffset === spans[spans.length - 1].end) {
      return {
        node: spans[spans.length - 1].node,
        offset: spans[spans.length - 1].node.nodeValue.length
      };
    }
    return null;
  }

  function locateEndOffset(spans, absoluteOffset) {
    for (const span of spans) {
      if (absoluteOffset >= span.start && absoluteOffset <= span.end) {
        return {
          node: span.node,
          offset: absoluteOffset - span.start
        };
      }
    }

    if (spans.length > 0 && absoluteOffset === spans[spans.length - 1].end) {
      return {
        node: spans[spans.length - 1].node,
        offset: spans[spans.length - 1].node.nodeValue.length
      };
    }
    return null;
  }

  function splitAndWrapTextNode(node, start, length) {
    if (!node || length <= 0) {
      return null;
    }

    const middle = node.splitText(start);
    middle.splitText(length);
    const mark = document.createElement("mark");
    mark.dataset.autoHighlight = "1";
    mark.className = "reader-highlight-target";
    mark.textContent = middle.nodeValue;
    middle.replaceWith(mark);
    return mark;
  }

  function wrapTextRange(root, start, length) {
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
      return null;
    }

    const index = buildNodeSpans(root || sectionContent);
    const end = start + length;
    const startPos = locateStartOffset(index.spans, start);
    const endPos = locateEndOffset(index.spans, end);
    if (!startPos || !endPos) {
      return null;
    }

    if (startPos.node === endPos.node) {
      return splitAndWrapTextNode(startPos.node, startPos.offset, length);
    }

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const mark = document.createElement("mark");
    mark.dataset.autoHighlight = "1";
    mark.className = "reader-highlight-target";

    try {
      range.surroundContents(mark);
      return mark;
    } catch (error) {
      const safeLength = Math.max(1, (startPos.node.nodeValue || "").length - startPos.offset);
      return splitAndWrapTextNode(startPos.node, startPos.offset, safeLength);
    }
  }

  function wrapAbsoluteRange(start, length) {
    return wrapTextRange(sectionContent, start, length);
  }

  // Bring an element to rest on the same sightline the reader resumes at
  // (READING_LINE_RATIO from the top), so a search hit and a resumed bookmark
  // land in the same place. Honours prefers-reduced-motion: no smooth glide.
  function scrollToReadingSightline(element, options) {
    if (!element) {
      return;
    }
    const settings = options || {};
    const rect = element.getBoundingClientRect();
    const target = clamp(
      rect.top + documentScrollY() - readingLineY(),
      0,
      maxDocumentScrollY()
    );
    const behavior = settings.behavior || (prefersReducedMotion() ? "auto" : "smooth");
    window.scrollTo({ top: target, left: 0, behavior });
  }

  function focusHighlight(mark) {
    if (!mark) {
      return;
    }
    mark.setAttribute("tabindex", "-1");

    // Continuity arrival: when the reader was reached by clicking a search
    // result, hand the arrival to the continuity transition — it flies the
    // clicked words to this highlight and owns scroll + motion. It returns true
    // only when it will actually fly (fresh, matching capture; motion allowed);
    // otherwise we run the normal arrival flourish below. The highlight itself
    // is already applied, so either path lands fully highlighted.
    var continuity = window.RenaissanceContinuity;
    if (continuity && continuity.claimArrival(mark, scrollToReadingSightline)) {
      return;
    }

    mark.classList.remove("reader-highlight-arrival");
    void mark.offsetWidth;
    mark.classList.add("reader-highlight-arrival");
    window.setTimeout(() => {
      mark.classList.remove("reader-highlight-arrival");
    }, 960);
    window.requestAnimationFrame(() => {
      scrollToReadingSightline(mark);
    });
  }

  function normalizeWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function absoluteOffsetFromDomPoint(container, offset) {
    const probe = document.createRange();
    probe.setStart(sectionContent, 0);
    probe.setEnd(container, offset);
    const fragment = probe.cloneContents();
    return (fragment.textContent || "").length;
  }

  function closestParagraph(node) {
    let current = node && node.nodeType === Node.ELEMENT_NODE ? node : node ? node.parentElement : null;
    while (current && current !== sectionContent) {
      if (current.tagName === "P" && current.dataset.paragraphIndex) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function rangeIsAtParagraphEdges(range, startParagraph, endParagraph) {
    if (!range || !startParagraph || !endParagraph) {
      return false;
    }

    const before = document.createRange();
    before.selectNodeContents(startParagraph);
    before.setEnd(range.startContainer, range.startOffset);
    if (normalizeWhitespace(before.cloneContents().textContent || "").length > 0) {
      return false;
    }

    const after = document.createRange();
    after.selectNodeContents(endParagraph);
    after.setStart(range.endContainer, range.endOffset);
    if (normalizeWhitespace(after.cloneContents().textContent || "").length > 0) {
      return false;
    }

    return true;
  }

  function paragraphAnchorFromRange(range) {
    const startParagraph = closestParagraph(range.startContainer);
    const endParagraph = closestParagraph(range.endContainer);
    if (!startParagraph || !endParagraph) {
      return null;
    }

    if (!rangeIsAtParagraphEdges(range, startParagraph, endParagraph)) {
      return null;
    }

    const startIndex = Number.parseInt(startParagraph.dataset.paragraphIndex, 10);
    const endIndex = Number.parseInt(endParagraph.dataset.paragraphIndex, 10);
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
      return null;
    }

    return {
      start: Math.min(startIndex, endIndex),
      end: Math.max(startIndex, endIndex)
    };
  }

  function findBestHighlightMatch(payload) {
    const index = buildNodeSpans(sectionContent);
    const renderedText = index.text;
    if (!renderedText) {
      return null;
    }

    const query = normalizeWhitespace(payload.text);
    if (!query) {
      return null;
    }

    const hits = findOccurrencesInText(renderedText, query, {
      mode: "contains",
      caseSensitive: false
    });
    if (hits.length === 0) {
      const words = query.split(/\s+/).filter((word) => word.length > 0);
      if (words.length >= 4) {
        const fallback = words.slice(0, 4).join(" ");
        const fallbackHits = findOccurrencesInText(renderedText, fallback, {
          mode: "contains",
          caseSensitive: false
        });
        return fallbackHits[0] || null;
      }
      return null;
    }

    if (!payload.prefix && !payload.suffix) {
      return hits[0];
    }

    const lowerText = renderedText.toLowerCase();
    const prefix = normalizeWhitespace(payload.prefix).toLowerCase();
    const suffix = normalizeWhitespace(payload.suffix).toLowerCase();

    let best = null;
    let bestScore = -1;
    for (const hit of hits) {
      let score = 0;
      if (prefix) {
        const start = Math.max(0, hit.index - Math.max(prefix.length + 8, 28));
        const left = lowerText.slice(start, hit.index);
        if (left.includes(prefix)) {
          score += 1;
        }
      }
      if (suffix) {
        const end = Math.min(lowerText.length, hit.index + hit.length + Math.max(suffix.length + 8, 28));
        const right = lowerText.slice(hit.index + hit.length, end);
        if (right.includes(suffix)) {
          score += 1;
        }
      }
      if (score > bestScore) {
        best = hit;
        bestScore = score;
      }
    }

    return best || hits[0];
  }

  function highlightFromPayload(payload) {
    const startedAt = nowMs();
    const match = findBestHighlightMatch(payload);
    if (!match) {
      logHighlightPerf("anchor_payload", startedAt, { applied: false });
      return false;
    }

    const mark = wrapAbsoluteRange(match.index, match.length);
    focusHighlight(mark);
    const applied = Boolean(mark);
    logHighlightPerf("anchor_payload", startedAt, {
      applied,
      length: match.length
    });
    return applied;
  }

  function highlightOccurrence(query, occurrence, mode, caseSensitive) {
    const startedAt = nowMs();
    const safeQuery = String(query || "");
    const safeOccurrence = Number.parseInt(occurrence, 10);
    if (!safeQuery || !Number.isFinite(safeOccurrence) || safeOccurrence <= 0) {
      logHighlightPerf("anchor_occurrence", startedAt, { applied: false, reason: "missing_query_or_occurrence" });
      return false;
    }

    const renderedText = sectionContent.textContent || "";
    const hits = findOccurrencesInText(renderedText, safeQuery, {
      mode,
      caseSensitive
    });
    const target = hits[safeOccurrence - 1];
    if (!target) {
      logHighlightPerf("anchor_occurrence", startedAt, {
        applied: false,
        hits: hits.length,
        occurrence: safeOccurrence
      });
      return false;
    }

    const mark = wrapAbsoluteRange(target.index, target.length);
    focusHighlight(mark);
    const applied = Boolean(mark);
    logHighlightPerf("anchor_occurrence", startedAt, {
      applied,
      hits: hits.length,
      occurrence: safeOccurrence
    });
    return applied;
  }

  function highlightQueryMatches(query, mode, caseSensitive) {
    const startedAt = nowMs();
    if (!query) {
      logHighlightPerf("anchor_query_only", startedAt, { applied: false, reason: "missing_query" });
      return {
        applied: false,
        totalHits: 0,
        highlighted: 0,
        capped: false
      };
    }

    const renderedText = sectionContent.textContent || "";
    const hits = findOccurrencesInText(renderedText, query, {
      mode,
      caseSensitive
    });
    if (!hits.length) {
      logHighlightPerf("anchor_query_only", startedAt, {
        applied: false,
        totalHits: 0,
        highlighted: 0,
        capped: false
      });
      return {
        applied: false,
        totalHits: 0,
        highlighted: 0,
        capped: false
      };
    }

    const limit = Math.min(hits.length, MAX_QUERY_ONLY_HIGHLIGHTS);
    let firstMark = null;
    for (let index = 0; index < limit; index += 1) {
      const hit = hits[index];
      const mark = wrapAbsoluteRange(hit.index, hit.length);
      if (!firstMark && mark) {
        firstMark = mark;
      }
    }

    if (firstMark) {
      focusHighlight(firstMark);
      const result = {
        applied: true,
        totalHits: hits.length,
        highlighted: limit,
        capped: hits.length > limit
      };
      logHighlightPerf("anchor_query_only", startedAt, result);
      return result;
    }
    const result = {
      applied: false,
      totalHits: hits.length,
      highlighted: 0,
      capped: hits.length > limit
    };
    logHighlightPerf("anchor_query_only", startedAt, result);
    return result;
  }

  function highlightAbsoluteRange(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return false;
    }

    const mark = wrapAbsoluteRange(start, end - start);
    focusHighlight(mark);
    return Boolean(mark);
  }

  function highlightParagraphAnchor(anchor) {
    if (!anchor) {
      return false;
    }

    const startPassage = passageElementByIndex(anchor.start);
    const endPassage = passageElementByIndex(anchor.end);
    if (!startPassage || !endPassage) {
      return false;
    }

    const start = absoluteOffsetFromDomPoint(startPassage, 0);
    const end = absoluteOffsetFromDomPoint(endPassage, endPassage.childNodes.length);
    return highlightAbsoluteRange(start, end);
  }

  function highlightPassageRangeAnchor(anchor, rangeOffsets) {
    if (!anchor || !rangeOffsets || anchor.start !== anchor.end) {
      return false;
    }

    const passage = passageElementByIndex(anchor.start);
    if (!passage) {
      return false;
    }

    const mark = wrapTextRange(passage, rangeOffsets.start, rangeOffsets.end - rangeOffsets.start);
    focusHighlight(mark);
    return Boolean(mark);
  }

  function resolveInitialAnchor() {
    const startedAt = nowMs();
    clearAutoHighlights();
    clearHighlightCapNote();

    const paragraphAnchor = queryParagraphAnchor();
    const passageRangeOffsets = queryPassageRangeOffsets();
    const rangeAnchor = queryRangeAnchor();
    const payload = queryHighlightPayload();
    const query = querySearchTerm();
    const occurrence = queryOccurrence();
    const mode = queryMatchMode();
    const caseSensitive = queryCaseSensitive();

    if (paragraphAnchor && passageRangeOffsets && highlightPassageRangeAnchor(paragraphAnchor, passageRangeOffsets)) {
      logHighlightPerf("resolve_anchor", startedAt, { strategy: "passage_range" });
      return;
    }

    if (paragraphAnchor && highlightParagraphAnchor(paragraphAnchor)) {
      logHighlightPerf("resolve_anchor", startedAt, { strategy: "paragraph" });
      return;
    }

    if (rangeAnchor && highlightAbsoluteRange(rangeAnchor.start, rangeAnchor.end)) {
      logHighlightPerf("resolve_anchor", startedAt, { strategy: "range" });
      return;
    }

    if (payload && highlightFromPayload(payload)) {
      logHighlightPerf("resolve_anchor", startedAt, { strategy: "payload" });
      return;
    }

    if (query && occurrence && highlightOccurrence(query, occurrence, mode, caseSensitive)) {
      logHighlightPerf("resolve_anchor", startedAt, { strategy: "occurrence" });
      return;
    }

    if (query) {
      const result = highlightQueryMatches(query, mode, caseSensitive);
      if (result.capped) {
        showHighlightCapNote(result.highlighted, result.totalHits);
      }
      logHighlightPerf("resolve_anchor", startedAt, {
        strategy: "query_only",
        capped: result.capped,
        highlighted: result.highlighted,
        totalHits: result.totalHits
      });
      return;
    }

    logHighlightPerf("resolve_anchor", startedAt, { strategy: "none" });
  }

  function setCopyStatus(message, isError, options) {
    const settings = options || {};
    const updateContextual = settings.updateContextualButton !== false;
    const showToast = settings.showToast !== false;
    const resetDelay = Number.isFinite(settings.resetDelayMs)
      ? settings.resetDelayMs
      : (isError ? 2100 : 1200);

    if (clearStatusTimer) {
      clearTimeout(clearStatusTimer);
      clearStatusTimer = null;
    }
    copyHighlightStatus.textContent = message;
    copyHighlightStatus.classList.toggle("status-error", Boolean(isError));

    if (showToast) {
      showCopyToast(message, isError, settings.toastDurationMs);
    }

    if (updateContextual && (!sectionTools || sectionTools.hidden)) {
      setContextualButtonState(isError ? "error" : "copied");
    }

    clearStatusTimer = setTimeout(() => {
      copyHighlightStatus.textContent = "";
      copyHighlightStatus.classList.remove("status-error");
      if (updateContextual) {
        setContextualButtonState("default");
      }
    }, resetDelay);
  }

  function rangeRect(range) {
    // Anchor to the END of the selection (its last line), not the bounding box
    // of the whole thing. A multi-line highlight's bounding box starts at the
    // first line, so anchoring there pins the chip far above — while the pointer
    // finished down at the last line. The last client rect is the end line for a
    // multi-line selection and the only rect for a single-line one.
    const rects = range.getClientRects();
    if (rects.length > 0) {
      const last = rects[rects.length - 1];
      if (last && (last.width > 0 || last.height > 0)) {
        return last;
      }
    }

    const direct = range.getBoundingClientRect();
    if (direct && (direct.width > 0 || direct.height > 0)) {
      return direct;
    }
    return null;
  }

  function selectionDetails() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    if (!sectionContent.contains(anchor)) {
      return null;
    }

    const selectedText = normalizeWhitespace(selection.toString());
    if (!selectedText || selectedText.length < 2) {
      return null;
    }

    const limitedText = selectedText.slice(0, 220);
    const startValue = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.nodeValue || ""
      : "";
    const endValue = range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.nodeValue || ""
      : "";

    const prefix = normalizeWhitespace(startValue.slice(Math.max(0, range.startOffset - 28), range.startOffset)).slice(-24);
    const suffix = normalizeWhitespace(endValue.slice(range.endOffset, range.endOffset + 28)).slice(0, 24);
    const start = absoluteOffsetFromDomPoint(range.startContainer, range.startOffset);
    const end = absoluteOffsetFromDomPoint(range.endContainer, range.endOffset);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    const paragraphAnchor = paragraphAnchorFromRange(range);

    const rect = rangeRect(range);
    return {
      payload: {
        text: limitedText,
        prefix,
        suffix
      },
      range: {
        start,
        end
      },
      paragraphAnchor,
      rect
    };
  }

  function preferredShareBaseUrl() {
    const protocol = String(window.location.protocol || "").toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      return new URL(window.location.href);
    }

    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      const href = String(canonical.getAttribute("href") || "").trim();
      if (/^https?:\/\//i.test(href)) {
        return new URL(href);
      }
    }

    return new URL(window.location.href);
  }

  function paragraphParam(anchor) {
    if (!anchor) {
      return "";
    }
    if (anchor.start === anchor.end) {
      return String(anchor.start);
    }
    return String(anchor.start) + "-" + String(anchor.end);
  }

  function rangeParam(range) {
    if (!range) {
      return "";
    }
    return range.start.toString(36) + "-" + range.end.toString(36);
  }

  function buildShareUrl(details) {
    const url = preferredShareBaseUrl();
    const params = new URLSearchParams();
    params.set("essay", currentEssay.slug);
    params.set("section", String(currentSectionNumber));

    if (details.paragraphAnchor) {
      params.set("p", paragraphParam(details.paragraphAnchor));
    } else if (details.range && details.range.end > details.range.start) {
      params.set("r", rangeParam(details.range));
    } else {
      params.set("hl", details.payload.text);
      if (details.payload.prefix.length >= 4) {
        params.set("hlp", details.payload.prefix);
      }
      if (details.payload.suffix.length >= 4) {
        params.set("hls", details.payload.suffix);
      }
    }

    url.search = params.toString();

    const shouldAttachFragment = !details.paragraphAnchor &&
      (!details.range || details.range.end <= details.range.start) &&
      details.payload.text.length <= 120;
    url.hash = shouldAttachFragment
      ? ":~:text=" + encodeURIComponent(details.payload.text)
      : "";

    return url.toString();
  }

  async function copyHighlightLink(detailsOverride) {
    if (!currentEssay || !currentSectionNumber) {
      setCopyStatus("Section still loading.", true);
      return;
    }

    const details = detailsOverride || selectionDetails();
    if (!details || !details.payload) {
      setCopyStatus("Select text first.", true);
      return;
    }
    const url = buildShareUrl(details);

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const helper = document.createElement("textarea");
        helper.value = url;
        helper.setAttribute("readonly", "readonly");
        helper.style.position = "fixed";
        helper.style.left = "-9999px";
        document.body.appendChild(helper);
        helper.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(helper);
        if (!copied) {
          throw new Error("copy failed");
        }
      }
      dismissCopyHint();
      setCopyStatus("Link copied.");
      scheduleHideContextualShare(1200);
    } catch (error) {
      setCopyStatus("Try copy again.", true);
    }
  }

  function syncContextualSelection() {
    if (!hasContextualShare) {
      return;
    }

    if (!currentEssay || !currentSectionNumber) {
      activeSelectionDetails = null;
      hideContextualShare();
      return;
    }

    const details = selectionDetails();
    if (!details) {
      if (isSelectingPointer) {
        return;
      }
      activeSelectionDetails = null;
      hideContextualShare();
      return;
    }

    if (!details.rect && !isMobileLayout() && isSelectingPointer) {
      return;
    }

    activeSelectionDetails = details;
    showContextualShare(details.rect);

    if (details.rect && citationTier(countWords(details.payload.text)) !== "none") {
      maybeShowCopyHint(details.rect);
    }
  }

  function scheduleSyncContextualSelection() {
    if (!hasContextualShare) {
      return;
    }

    if (selectionSyncFrame) {
      cancelAnimationFrame(selectionSyncFrame);
      selectionSyncFrame = null;
    }
    selectionSyncFrame = requestAnimationFrame(() => {
      selectionSyncFrame = null;
      syncContextualSelection();
    });
  }

  function isEditableTarget(target) {
    if (!target) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tag = String(target.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function selectionTextAndRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    if (!sectionContent.contains(anchor)) {
      return null;
    }

    const text = selection.toString();
    if (!text || !text.trim()) {
      return null;
    }

    return {
      selection,
      range,
      text
    };
  }

  function decorateClipboardWithSource(event) {
    if (!event.clipboardData || !currentEssay || !currentSectionNumber) {
      return;
    }

    const active = document.activeElement;
    if (isEditableTarget(active)) {
      return;
    }

    const selected = selectionTextAndRange();
    const details = selectionDetails();
    if (!selected || !details) {
      return;
    }

    const tier = citationTier(countWords(selected.text));

    // Short fragments copy verbatim. We deliberately leave the native copy
    // untouched rather than appending anything — no preventDefault, no branch
    // on device. The gesture (a few words) tells us it is a lookup.
    if (tier === "none") {
      dismissCopyHint();
      return;
    }

    const sourceUrl = buildShareUrl(details);
    event.clipboardData.setData("text/plain", citationPlainText(selected.text, sourceUrl, tier));

    const html = citationHtml(selected.text, sourceUrl, tier);
    if (html) {
      event.clipboardData.setData("text/html", html);
    }

    event.preventDefault();
    dismissCopyHint();
    setCopyStatus(tier === "full" ? "Copied with citation." : "Copied with source link.", false, {
      updateContextualButton: false,
      resetDelayMs: 1000,
      toastDurationMs: 1400
    });
  }

  function bindHighlightEvents() {
    if (copyHighlightButton) {
      copyHighlightButton.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      copyHighlightButton.addEventListener("click", () => {
        copyHighlightLink();
      });
    }

    if (!hasContextualShare) {
      return;
    }

    [selectionCopyChip, selectionCopyBarButton].filter((button) => Boolean(button)).forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", () => {
        copyHighlightLink(activeSelectionDetails);
      });
    });

    sectionContent.addEventListener("copy", (event) => {
      decorateClipboardWithSource(event);
    });

    document.addEventListener("selectionchange", () => {
      scheduleSyncContextualSelection();
    });

    sectionContent.addEventListener("pointerdown", (event) => {
      if (event.button === 0) {
        isSelectingPointer = true;
      }
    });

    document.addEventListener("pointerup", () => {
      if (!isSelectingPointer) {
        return;
      }
      isSelectingPointer = false;
      scheduleSyncContextualSelection();
    });

    document.addEventListener("pointercancel", () => {
      if (!isSelectingPointer) {
        return;
      }
      isSelectingPointer = false;
      scheduleSyncContextualSelection();
    });

    document.addEventListener("keydown", (event) => {
      const key = String(event.key || "").toLowerCase();
      const hasPrimaryModifier = event.ctrlKey || event.metaKey;
      const isShortcutPreferred = key === "c" && hasPrimaryModifier && event.altKey;
      const isShortcutLegacy = key === "c" && hasPrimaryModifier && event.shiftKey;
      if (isShortcutPreferred || isShortcutLegacy) {
        const active = document.activeElement;
        const isEditable = isEditableTarget(active);
        if (!isEditable && (activeSelectionDetails || selectionDetails())) {
          event.preventDefault();
          copyHighlightLink(activeSelectionDetails);
        }
        return;
      }

      if (event.key === "Escape") {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          selection.removeAllRanges();
        }
        isSelectingPointer = false;
        activeSelectionDetails = null;
        hideContextualShare();
      }
    });

    window.addEventListener("resize", () => {
      scheduleSyncContextualSelection();
    });

    document.addEventListener("scroll", () => {
      if (!activeSelectionDetails) {
        hideContextualShare();
        return;
      }
      scheduleSyncContextualSelection();
    }, { passive: true });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        isSelectingPointer = false;
        activeSelectionDetails = null;
        hideContextualShare();
        hideCopyToast();
      }
    });
  }

  function bindSectionNavigation() {
    document.addEventListener("click", (event) => {
      const link = event.target && event.target.closest
        ? event.target.closest(SECTION_NAV_SELECTOR)
        : null;
      if (!link || !link.href || !isPlainNavigationClick(event)) {
        return;
      }

      const route = routeFromLink(link);
      if (!route || route.view !== "section" || !route.essaySlug || !route.sectionNumber) {
        return;
      }

      event.preventDefault();
      prefetchSectionRoute(route);
      pendingRouteTransition = true;
      pendingRouteScrollTop = true;
      pendingRouteDirection = sectionDirection(route.sectionNumber);
      setSectionQueued(pendingRouteDirection);
      router.go("section", {
        essaySlug: route.essaySlug,
        sectionNumber: route.sectionNumber
      });
    });

    document.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) {
        return;
      }
      const link = event.target && event.target.closest
        ? event.target.closest(SECTION_NAV_SELECTOR)
        : null;
      if (link && link.href) {
        prefetchSectionFromLink(link);
      }
    }, { passive: true });

    document.addEventListener("touchstart", (event) => {
      const link = event.target && event.target.closest
        ? event.target.closest(SECTION_NAV_SELECTOR)
        : null;
      if (link && link.href) {
        prefetchSectionFromLink(link);
      }
    }, { passive: true });

    document.addEventListener("mouseover", (event) => {
      const link = event.target && event.target.closest
        ? event.target.closest(SECTION_NAV_SELECTOR)
        : null;
      if (link && link.href) {
        prefetchSectionFromLink(link);
      }
    });

    document.addEventListener("focusin", (event) => {
      const link = event.target && event.target.closest
        ? event.target.closest(SECTION_NAV_SELECTOR)
        : null;
      if (link && link.href) {
        prefetchSectionFromLink(link);
      }
    });

    window.addEventListener("renaissance:route", (event) => {
      const route = event.detail || router.parse();
      if (!route || route.view !== "section") {
        return;
      }

      const options = {
        transition: pendingRouteTransition,
        scrollToTop: pendingRouteScrollTop,
        skipRestore: pendingRouteScrollTop,
        direction: pendingRouteDirection
      };
      pendingRouteTransition = false;
      pendingRouteScrollTop = false;
      pendingRouteDirection = "next";
      loadCurrentSection(options);
    });
  }

  async function loadCurrentSection(options) {
    const settings = options || {};
    const token = routeLoadToken + 1;
    routeLoadToken = token;
    try {
      const essaySlug = await resolveEssaySlug();
      const essay = await loadEssay(essaySlug);
      if (token !== routeLoadToken) {
        return;
      }
      if (!essay) {
        clearSectionTurnClasses();
        const essays = await loadEssays().catch(() => []);
        const closest = recovery.closestEssay(essays, essaySlug);
        const query = recovery.normalizeWords(essaySlug).replace(/\s+/g, " ");
        showMessage("Essay not found.", {
          body: "That essay shelf mark is not published here. The archive can still look for the nearest entry.",
          closestEssay: closest,
          query
        });
        return;
      }

      if (!essay.section_order.length) {
        clearSectionTurnClasses();
        showMessage("No sections are available.", {
          body: "This essay exists, but it does not have any readable sections yet."
        });
        return;
      }

      const sectionNumber = querySectionNumber() || essay.section_order[0];
      if (!essay.section_order.includes(sectionNumber)) {
        clearSectionTurnClasses();
        const nearest = recovery.nearestSectionNumber(essay, sectionNumber);
        showMessage("Section not found.", {
          body: "That folio number is outside this essay. Use the nearest section or return to the essay contents.",
          closestEssayForSection: essay,
          closestSection: nearest,
          essayContents: essay
        });
        return;
      }

      const payload = await loadSectionPayload(essay.slug, sectionNumber);
      const display = sectionDisplay(essay, sectionNumber);
      const contentAst = payload.contentAst || payload.contentBlocks || payload.blocks;
      if (token !== routeLoadToken) {
        return;
      }

      const hasAnchor = hasReaderAnchorIntent();
      let didSwap = false;
      await swapSectionContent(() => {
        if (token !== routeLoadToken) {
          return;
        }
        currentEssay = essay;
        currentSectionNumber = sectionNumber;
        currentDisplay = display;
        didSwap = true;
        activeSelectionDetails = null;
        hideContextualShare();
        clearResumeBookmark({ fade: false });
        if (copyHighlightButton) {
          copyHighlightButton.disabled = false;
        }
        copyHighlightStatus.textContent = "";

        backToEssay.href = essayUrl(essay.slug);
        essayLine.textContent = essay.title;
        sectionKicker.textContent = display.label;
        sectionTitle.textContent = display.title;
        setSectionSubtitle(display.subtitle);
        sectionMeta.innerHTML = joinMetaParts([
          formatWordCount(payload.wordCount),
          formatReadMinutes(payload.readMinutes)
        ]);
        renderBlocks(sectionContent, contentAst);
        annotateParagraphIndices();
        applySectionMetadata(essay, display, sectionNumber, payload);
        if (settings.scrollToTop && !hasAnchor) {
          window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        }
      }, settings);
      if (!didSwap || token !== routeLoadToken) {
        return;
      }
      const shouldAttemptRestore = !settings.skipRestore && !hasAnchor && readingState &&
        readingState.shouldRestore(readingState.getSectionRecord(currentEssay.slug, currentSectionNumber));
      if (shouldAttemptRestore) {
        startRestoreSaveSuppression();
      }
      initializeReadingProgress(display);

      const currentIndex = essay.section_order.indexOf(sectionNumber);
      const previous = essay.section_order[currentIndex - 1];
      const next = essay.section_order[currentIndex + 1];

      setLink(prevLink, previous ? sectionUrl(essay.slug, previous) : null, "Previous Section");
      setLink(nextLink, next ? sectionUrl(essay.slug, next) : null, "Next Section");
      setLink(nextCta, next ? sectionUrl(essay.slug, next) : null, "Next Section");

      const didRestore = shouldAttemptRestore && restoreReadingPosition();
      if (shouldAttemptRestore && !didRestore) {
        releaseRestoreSaveSuppressionSoon();
      }
      resolveInitialAnchor();
      window.setTimeout(() => {
        syncReadingProgress({ save: didRestore ? false : undefined });
        updateReadingStateDebug();
      }, hasAnchor ? 900 : didRestore ? RESTORE_SAVE_SUPPRESS_MS + 160 : 180);
      announcePageReady();
    } catch (error) {
      clearSectionTurnClasses();
      releaseArticleHeight();
      showMessage("Unable to load this section.", {
        body: "The section could not be loaded right now. Try the archive or search page to keep reading."
      });
    }
  }

  async function init() {
    initThemeToggle();
    ensureContextualShareControls();
    ensureCopyToast();
    setFallbackVisible(!hasContextualShare);
    bindHighlightEvents();
    bindSectionNavigation();
    loadCurrentSection();
  }

  init();
})();
