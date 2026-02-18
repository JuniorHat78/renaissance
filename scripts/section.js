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
  let selectionCopyChip = document.getElementById("selection-copy-chip");
  let selectionCopyBar = document.getElementById("selection-copy-bar");
  let selectionCopyBarButton = document.getElementById("selection-copy-bar-button");
  const MAX_QUERY_ONLY_HIGHLIGHTS = 160;
  const SOURCE_FOOTER_LABEL = "[Source] ";

  let currentEssay = null;
  let currentSectionNumber = null;
  let clearStatusTimer = null;
  let hideContextualTimer = null;
  let copyToastTimer = null;
  let selectionSyncFrame = null;
  let activeSelectionDetails = null;
  let isSelectingPointer = false;
  const CONTEXTUAL_LABEL_DEFAULT = "Copy link";
  const CONTEXTUAL_LABEL_COPIED = "Copied";
  const CONTEXTUAL_LABEL_ERROR = "Try copy again";
  let hasContextualShare = false;
  let copyToast = document.getElementById("copy-toast");
  const shouldLogHighlightPerf = (() => {
    const protocol = String(window.location.protocol || "").toLowerCase();
    if (protocol === "file:") {
      return true;
    }

    const host = String(window.location.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  })();

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

  function sourceFooterText(url) {
    return SOURCE_FOOTER_LABEL + String(url || "");
  }

  function joinMetaParts(parts) {
    return parts
      .map((part) => '<span>' + escapeHtml(part) + "</span>")
      .join('<span class="meta-sep" aria-hidden="true">&middot;</span>');
  }

  function essayUrl(slug) {
    return "essay.html?essay=" + encodeURIComponent(slug);
  }

  function sectionUrl(slug, sectionNumber) {
    return "section.html?essay=" + encodeURIComponent(slug) + "&section=" + String(sectionNumber);
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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clearContextualHideTimer() {
    if (hideContextualTimer) {
      clearTimeout(hideContextualTimer);
      hideContextualTimer = null;
    }
  }

  function hideContextualShare() {
    clearContextualHideTimer();
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

    const parts = value.split("-");
    const start = Number.parseInt(parts[0], 10);
    const end = parts.length > 1 ? Number.parseInt(parts[1], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) {
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

  function showMessage(message) {
    essayLine.textContent = "Renaissance";
    sectionKicker.textContent = "Reader";
    sectionTitle.textContent = message;
    sectionSubtitle.textContent = "";
    sectionMeta.textContent = "";
    sectionContent.innerHTML = '<p><a href="index.html">Return to Home</a></p>';
    backToEssay.href = "index.html";
    backToEssay.textContent = "Home";
    if (copyHighlightButton) {
      copyHighlightButton.disabled = true;
    }
    setFallbackVisible(false);
    copyHighlightStatus.textContent = "";
    clearHighlightCapNote();
    hideCopyToast();
    activeSelectionDetails = null;
    hideContextualShare();
    setLink(prevLink, null, "");
    setLink(nextLink, null, "");
    setLink(nextCta, null, "");
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
    const tail = middle.splitText(length);
    const mark = document.createElement("mark");
    mark.dataset.autoHighlight = "1";
    mark.className = "reader-highlight-target";
    mark.textContent = middle.nodeValue;
    middle.replaceWith(mark);
    return mark;
  }

  function wrapAbsoluteRange(start, length) {
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
      return null;
    }

    const index = buildNodeSpans(sectionContent);
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

  function focusHighlight(mark) {
    if (!mark) {
      return;
    }
    mark.setAttribute("tabindex", "-1");
    mark.classList.remove("reader-highlight-arrival");
    void mark.offsetWidth;
    mark.classList.add("reader-highlight-arrival");
    window.setTimeout(() => {
      mark.classList.remove("reader-highlight-arrival");
    }, 960);
    window.requestAnimationFrame(() => {
      mark.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest"
      });
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
    if (!query || !occurrence) {
      logHighlightPerf("anchor_occurrence", startedAt, { applied: false, reason: "missing_query_or_occurrence" });
      return false;
    }

    const renderedText = sectionContent.textContent || "";
    const hits = findOccurrencesInText(renderedText, query, {
      mode,
      caseSensitive
    });
    const target = hits[occurrence - 1];
    if (!target) {
      logHighlightPerf("anchor_occurrence", startedAt, {
        applied: false,
        hits: hits.length,
        occurrence
      });
      return false;
    }

    const mark = wrapAbsoluteRange(target.index, target.length);
    focusHighlight(mark);
    const applied = Boolean(mark);
    logHighlightPerf("anchor_occurrence", startedAt, {
      applied,
      hits: hits.length,
      occurrence
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

    const startParagraph = sectionContent.querySelector('p[data-paragraph-index="' + String(anchor.start) + '"]');
    const endParagraph = sectionContent.querySelector('p[data-paragraph-index="' + String(anchor.end) + '"]');
    if (!startParagraph || !endParagraph) {
      return false;
    }

    const start = absoluteOffsetFromDomPoint(startParagraph, 0);
    const end = absoluteOffsetFromDomPoint(endParagraph, endParagraph.childNodes.length);
    return highlightAbsoluteRange(start, end);
  }

  function resolveInitialAnchor() {
    const startedAt = nowMs();
    clearAutoHighlights();
    clearHighlightCapNote();

    const paragraphAnchor = queryParagraphAnchor();
    const rangeAnchor = queryRangeAnchor();
    const payload = queryHighlightPayload();
    const query = querySearchTerm();
    const occurrence = queryOccurrence();
    const mode = queryMatchMode();
    const caseSensitive = queryCaseSensitive();

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
    const direct = range.getBoundingClientRect();
    if (direct && (direct.width > 0 || direct.height > 0)) {
      return direct;
    }

    const rects = range.getClientRects();
    if (rects.length > 0) {
      return rects[0];
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
    const footer = sourceFooterText(url);

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(footer);
      } else {
        const helper = document.createElement("textarea");
        helper.value = footer;
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
      setCopyStatus("Source link copied.");
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

  function htmlFromRange(range) {
    if (!range) {
      return "";
    }

    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    return container.innerHTML;
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

    const sourceUrl = buildShareUrl(details);
    const plain = selected.text + "\n\n" + sourceFooterText(sourceUrl);
    event.clipboardData.setData("text/plain", plain);

    const selectedHtml = htmlFromRange(selected.range);
    if (selectedHtml) {
      const sourceHtml =
        '<p><br><span>' + escapeHtml(SOURCE_FOOTER_LABEL) + "</span>" +
        '<a href="' + escapeHtml(sourceUrl) + '" rel="noopener noreferrer">' + escapeHtml(sourceUrl) + "</a></p>";
      event.clipboardData.setData("text/html", selectedHtml + sourceHtml);
    }

    event.preventDefault();
    setCopyStatus("Copied with source link.", false, {
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

  async function init() {
    initThemeToggle();
    ensureContextualShareControls();
    ensureCopyToast();
    setFallbackVisible(!hasContextualShare);
    bindHighlightEvents();

    try {
      const essaySlug = await resolveEssaySlug();
      const essay = await loadEssay(essaySlug);
      if (!essay) {
        showMessage("Essay not found.");
        return;
      }

      if (!essay.section_order.length) {
        showMessage("No sections are available.");
        return;
      }

      const sectionNumber = querySectionNumber() || essay.section_order[0];
      if (!essay.section_order.includes(sectionNumber)) {
        showMessage("Section not found.");
        return;
      }

      const payload = await loadSection(essay.slug, sectionNumber);
      const display = sectionDisplay(essay, sectionNumber);
      const blocks = payload.contentBlocks.length ? payload.contentBlocks : payload.blocks;
      currentEssay = essay;
      currentSectionNumber = sectionNumber;
      activeSelectionDetails = null;
      hideContextualShare();
      if (copyHighlightButton) {
        copyHighlightButton.disabled = false;
      }
      copyHighlightStatus.textContent = "";

      backToEssay.href = essayUrl(essay.slug);
      essayLine.textContent = essay.title;
      sectionKicker.textContent = display.label;
      sectionTitle.textContent = display.title;
      sectionSubtitle.textContent = display.subtitle ? "(" + display.subtitle + ")" : "";
      sectionMeta.innerHTML = joinMetaParts([
        formatWordCount(payload.wordCount),
        formatReadMinutes(payload.readMinutes)
      ]);
      renderBlocks(sectionContent, blocks);
      annotateParagraphIndices();
      document.title = display.title + " | " + essay.title + " | Renaissance";

      const currentIndex = essay.section_order.indexOf(sectionNumber);
      const previous = essay.section_order[currentIndex - 1];
      const next = essay.section_order[currentIndex + 1];

      setLink(prevLink, previous ? sectionUrl(essay.slug, previous) : null, "Previous Section");
      setLink(nextLink, next ? sectionUrl(essay.slug, next) : null, "Next Section");
      setLink(nextCta, next ? sectionUrl(essay.slug, next) : null, "Next Section");

      resolveInitialAnchor();
    } catch (error) {
      showMessage("Unable to load this section.");
    }
  }

  init();
})();
