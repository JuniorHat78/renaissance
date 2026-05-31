(function () {
  const content = window.RenaissanceContent;
  const router = window.RenaissanceRouter;
  if (!content || !router) {
    return;
  }

  // Hover is a pointer affordance. On touch there is no hover intent to read,
  // and a long-press preview would fight the native selection menu, so we bow out.
  const coarsePointer =
    window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (coarsePointer) {
    return;
  }

  const SELECTOR = 'a[href*="index.html"], a[href*="essay.html"], a[href*="section.html"]';
  const HOVER_DELAY_MS = 200;
  const GRACE_MS = 100;
  const PREVIEW_CHARS = 140;
  const EDGE_MARGIN = 16;

  let card = null;
  let kickerEl = null;
  let titleEl = null;
  let bodyEl = null;

  let showTimer = null;
  let hideTimer = null;
  let pendingAnchor = null;
  let activeAnchor = null;
  let resolveToken = 0;

  const cache = new Map();

  function ensureCard() {
    if (card) {
      return card;
    }
    card = document.createElement("div");
    card.className = "link-preview-card";
    card.setAttribute("role", "tooltip");
    card.hidden = true;

    kickerEl = document.createElement("span");
    kickerEl.className = "link-preview-kicker";
    titleEl = document.createElement("span");
    titleEl.className = "link-preview-title";
    bodyEl = document.createElement("p");
    bodyEl.className = "link-preview-body";

    card.appendChild(kickerEl);
    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    document.body.appendChild(card);
    return card;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function firstParagraphExcerpt(payload) {
    const paragraph = String((payload && payload.firstParagraphText) || "");
    return content.shortExcerpt(paragraph, PREVIEW_CHARS);
  }

  async function essaySummary(essay) {
    const summary = String(essay.summary || "").trim();
    if (summary) {
      return content.shortExcerpt(summary, PREVIEW_CHARS);
    }
    // No blurb on the manifest — borrow the opening of the first section.
    const first = (essay.section_order || [])[0];
    if (!first) {
      return "";
    }
    try {
      const payload = await content.loadSection(essay.slug, first);
      return firstParagraphExcerpt(payload);
    } catch (_error) {
      return "";
    }
  }

  async function resolvePreview(href) {
    if (cache.has(href)) {
      return cache.get(href);
    }

    let data = null;
    try {
      const route = router.parse(href);
      if (route.view === "archive") {
        data = {
          kicker: "Archive",
          title: "Renaissance",
          body: "A growing log of long-form essays."
        };
      } else if (route.view === "essay" && route.essaySlug) {
        const essay = await content.loadEssay(route.essaySlug);
        if (essay) {
          data = {
            kicker: "Essay",
            title: essay.title,
            body: await essaySummary(essay)
          };
        }
      } else if (route.view === "section" && route.essaySlug && route.sectionNumber) {
        const payload = await content.loadSection(route.essaySlug, route.sectionNumber);
        if (payload) {
          const display = payload.display || {};
          data = {
            kicker: payload.essay ? payload.essay.title : "Section",
            title: display.title || display.label || "Section",
            body: firstParagraphExcerpt(payload)
          };
        }
      }
    } catch (_error) {
      data = null;
    }

    cache.set(href, data);
    return data;
  }

  function positionCard(anchor) {
    const rect = anchor.getBoundingClientRect();
    const wasHidden = card.hidden;
    card.hidden = false;
    if (wasHidden) {
      card.style.visibility = "hidden";
      card.style.left = "0px";
      card.style.top = "0px";
    }

    const cardRect = card.getBoundingClientRect();
    let left = rect.left;
    left = clamp(left, EDGE_MARGIN, window.innerWidth - cardRect.width - EDGE_MARGIN);

    // Prefer sitting above the link; drop below if there is not enough headroom.
    let top = rect.top - cardRect.height - 10;
    if (top < EDGE_MARGIN) {
      top = rect.bottom + 10;
    }
    top = clamp(top, EDGE_MARGIN, window.innerHeight - cardRect.height - EDGE_MARGIN);

    card.style.left = String(Math.round(left)) + "px";
    card.style.top = String(Math.round(top)) + "px";
    card.style.visibility = "visible";
  }

  function renderCard(data) {
    kickerEl.textContent = data.kicker || "";
    kickerEl.hidden = !data.kicker;
    titleEl.textContent = data.title || "";
    bodyEl.textContent = data.body || "";
    bodyEl.hidden = !data.body;
  }

  function hideCard() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    pendingAnchor = null;
    activeAnchor = null;
    resolveToken += 1;
    if (card) {
      card.classList.remove("is-visible");
      card.hidden = true;
    }
  }

  function scheduleHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
    }
    hideTimer = setTimeout(() => {
      hideTimer = null;
      hideCard();
    }, GRACE_MS);
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  async function showForAnchor(anchor) {
    const href = anchor.getAttribute("href");
    if (!href) {
      return;
    }

    const token = ++resolveToken;
    const data = await resolvePreview(href);
    // A newer hover (or a hide) superseded this one while content loaded.
    if (token !== resolveToken || pendingAnchor !== anchor) {
      return;
    }
    if (!data || (!data.title && !data.body)) {
      return;
    }

    ensureCard();
    renderCard(data);
    activeAnchor = anchor;
    positionCard(anchor);
    card.classList.remove("is-visible");
    void card.offsetWidth;
    card.classList.add("is-visible");
  }

  function scheduleShow(anchor) {
    cancelHide();
    if (anchor === activeAnchor || anchor === pendingAnchor) {
      return;
    }
    pendingAnchor = anchor;
    if (showTimer) {
      clearTimeout(showTimer);
    }
    showTimer = setTimeout(() => {
      showTimer = null;
      showForAnchor(anchor);
    }, HOVER_DELAY_MS);
  }

  function anchorFrom(target) {
    return target && target.closest ? target.closest(SELECTOR) : null;
  }

  document.addEventListener("mouseover", (event) => {
    const anchor = anchorFrom(event.target);
    if (anchor) {
      scheduleShow(anchor);
    }
  });

  document.addEventListener("mouseout", (event) => {
    const anchor = anchorFrom(event.target);
    if (!anchor) {
      return;
    }
    const related = event.relatedTarget;
    if (related && anchor.contains(related)) {
      return;
    }
    if (anchor === pendingAnchor || anchor === activeAnchor) {
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      pendingAnchor = null;
      scheduleHide();
    }
  });

  // Keyboard parity: a focused link previews too.
  document.addEventListener("focusin", (event) => {
    const anchor = anchorFrom(event.target);
    if (anchor) {
      scheduleShow(anchor);
    }
  });

  document.addEventListener("focusout", (event) => {
    const anchor = anchorFrom(event.target);
    if (anchor && (anchor === pendingAnchor || anchor === activeAnchor)) {
      scheduleHide();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && card && !card.hidden) {
      hideCard();
    }
  });

  // A repositioned card would lie about where it points, so dismiss on scroll.
  window.addEventListener("scroll", () => {
    if (card && !card.hidden) {
      hideCard();
    }
  }, { passive: true });

  window.addEventListener("resize", () => {
    if (card && !card.hidden) {
      hideCard();
    }
  });
})();
