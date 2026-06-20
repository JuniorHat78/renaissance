(function () {
  // Continuity transition: the words you click in a search result physically
  // fly to their home in the reader and settle onto the live highlight.
  //
  // Two roles in one file, no page detection needed:
  //   capture  (search / essay / home): on a result click, measure the clicked
  //            <mark>'s rect + colour + identity and stash it in sessionStorage.
  //   replay   (section reader): the reader's focusHighlight() hands us the
  //            settled highlight via claimArrival(); if a fresh, matching capture
  //            exists we FLIP the real <mark> from the source rect to its home
  //            with a luxe spring, then settle onto the highlight. We fall back
  //            to the reader's normal arrival whenever anything is off (reduced
  //            motion, stale/mismatched payload, a multi-line mark, direct nav).
  //
  // FLIP-on-real is reflow-safe because the motion is pure `transform` (a
  // composited property): the mark stays in layout flow, siblings never move.
  // The only layout touch is display:inline-block during the flight (inline
  // boxes can't be transformed); we bail when the mark wraps across lines, so
  // that path can never reflow the paragraph.
  //
  // The cross-document handoff reuses the same sessionStorage pattern the page
  // transition already relies on; the payload is a hint only and navigation /
  // highlighting never depend on it.

  var STORAGE_KEY = "renaissance:continuity";
  var MAX_AGE_MS = 8000;
  var DURATION_MS = 480; // luxe: settle into the text, do not snap to it.
  var EASING = "cubic-bezier(0.22, 1, 0.36, 1)"; // spring-ish ease-out

  var root = document.documentElement;

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function sectionHrefIdentity(href) {
    var url;
    try {
      url = new URL(href, window.location.href);
    } catch (_error) {
      return null;
    }
    if (!/section\.html$/i.test(url.pathname)) {
      return null;
    }
    var essay = url.searchParams.get("essay");
    var section = url.searchParams.get("section");
    if (!essay || !section) {
      return null;
    }
    return { essay: essay, section: String(section) };
  }

  // ---- capture (source surfaces: search / essay / home) ----

  function captureFromClick(event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) {
      return;
    }
    var mark = anchor.querySelector("mark");
    if (!mark) {
      return;
    }
    var identity = sectionHrefIdentity(anchor.getAttribute("href") || "");
    if (!identity) {
      return;
    }
    var rect = mark.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    var style = window.getComputedStyle(mark);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        color: style.color,
        background: style.backgroundColor,
        text: String(mark.textContent || "").replace(/\s+/g, " ").trim(),
        essay: identity.essay,
        section: identity.section,
        createdAt: Date.now()
      }));
    } catch (_error) {
      // Storage is a hint only; never let it affect the click.
    }
  }

  function readPayload() {
    var raw;
    try {
      raw = window.sessionStorage.getItem(STORAGE_KEY);
    } catch (_error) {
      return null;
    }
    if (!raw) {
      return null;
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      consume();
      return null;
    }
    var age = Date.now() - Number(parsed && parsed.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
      consume();
      return null;
    }
    return parsed;
  }

  function consume() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (_error) {
      // ignore
    }
  }

  // ---- replay (reader) ----

  function currentIdentity() {
    var params = new URLSearchParams(window.location.search);
    var essay = params.get("essay");
    var section = params.get("section");
    if (!essay || !section) {
      return null;
    }
    return { essay: essay, section: String(section) };
  }

  // The contract the reader's focusHighlight() calls. Returns true when
  // continuity will own the arrival (it scrolls + animates); false hands control
  // straight back to the reader's normal arrival flourish. Whatever happens, the
  // deep-link highlight has already been applied, so a false return is always a
  // safe, fully-highlighted landing.
  function claimArrival(mark, scrollToSightline) {
    if (!mark || prefersReducedMotion()) {
      return false;
    }
    var payload = readPayload();
    if (!payload) {
      return false;
    }
    // A capture flies at most once; spend it the moment it is a candidate.
    consume();

    var here = currentIdentity();
    if (!here || here.essay !== payload.essay || here.section !== payload.section) {
      return false;
    }
    // A mark that wraps across lines cannot become inline-block without changing
    // the paragraph's wrapping. Fall back rather than reflow.
    if (typeof mark.getClientRects === "function" && mark.getClientRects().length > 1) {
      return false;
    }

    // The reader is held under the paper veil until it composes in, so defer the
    // flight to the reveal — the words are then seen flying, not animating under
    // the veil. start() always scrolls the highlight into place first (scroll-
    // then-measure), so even if the flight measurement is degenerate the landing
    // is still correct; claiming the arrival is therefore always safe.
    var start = function () {
      if (typeof scrollToSightline === "function") {
        scrollToSightline(mark, { behavior: "auto" });
      }
      var last = mark.getBoundingClientRect();
      if (!last.width || !last.height) {
        return;
      }
      var source = payload.rect;
      var dx = source.left - last.left;
      var dy = source.top - last.top;
      var scale = source.height / last.height;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(scale) || scale <= 0) {
        return;
      }
      fly(mark, dx, dy, scale, payload);
    };

    if (root.classList.contains("page-transition-ready")) {
      start();
    } else {
      window.addEventListener("renaissance:page-revealed", start, { once: true });
    }
    return true;
  }

  function fly(mark, dx, dy, scale, payload) {
    var prev = {
      transform: mark.style.transform,
      transformOrigin: mark.style.transformOrigin,
      transition: mark.style.transition,
      display: mark.style.display,
      position: mark.style.position,
      zIndex: mark.style.zIndex,
      willChange: mark.style.willChange,
      color: mark.style.color,
      backgroundColor: mark.style.backgroundColor
    };

    // INVERT synchronously, in the same task the highlight was applied, so the
    // first painted frame already shows the words at the source — no flash of
    // the home highlight before the flight starts.
    mark.style.display = "inline-block";
    mark.style.position = "relative";
    mark.style.zIndex = "1";
    mark.style.transformOrigin = "left top";
    mark.style.willChange = "transform";
    mark.style.transition = "none";
    mark.style.transform = "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")";
    if (payload.color) {
      mark.style.color = payload.color;
    }
    if (payload.background) {
      mark.style.backgroundColor = payload.background;
    }
    void mark.offsetWidth; // flush the inverted state

    root.setAttribute("data-continuity-flight", "1");
    // Stable evidence that a flight ran (left in place for tests / debugging).
    root.setAttribute("data-continuity-arrived", "1");

    // PLAY to home on the next frame.
    window.requestAnimationFrame(function () {
      mark.style.transition =
        "transform " + DURATION_MS + "ms " + EASING +
        ", color " + DURATION_MS + "ms " + EASING +
        ", background-color " + DURATION_MS + "ms " + EASING;
      mark.style.transform = "none";
      mark.style.color = prev.color;
      mark.style.backgroundColor = prev.backgroundColor;
    });

    var done = false;
    function settle() {
      if (done) {
        return;
      }
      done = true;
      mark.style.transform = prev.transform;
      mark.style.transformOrigin = prev.transformOrigin;
      mark.style.transition = prev.transition;
      mark.style.display = prev.display;
      mark.style.position = prev.position;
      mark.style.zIndex = prev.zIndex;
      mark.style.willChange = prev.willChange;
      mark.style.color = prev.color;
      mark.style.backgroundColor = prev.backgroundColor;
      root.removeAttribute("data-continuity-flight");
      // A gentle final settle onto the real highlight, reusing the reader's
      // existing arrival pulse so continuity and a resumed bookmark feel alike.
      mark.classList.add("reader-highlight-arrival");
      window.setTimeout(function () {
        mark.classList.remove("reader-highlight-arrival");
      }, 720);
    }

    mark.addEventListener("transitionend", function onEnd(event) {
      if (event.target === mark && event.propertyName === "transform") {
        mark.removeEventListener("transitionend", onEnd);
        settle();
      }
    });
    // Safety net: never strand inline styles if transitionend does not fire.
    window.setTimeout(settle, DURATION_MS + 240);
  }

  document.addEventListener("click", captureFromClick, true);

  window.RenaissanceContinuity = {
    claimArrival: claimArrival
  };
})();
