(function () {
  'use strict';

  // A narrow soft-navigation adapter for the reading journey. Intercepts
  // essay↔section clicks, fetches the destination, swaps the <main> content and
  // shell elements in the CURRENT document (no reload, no script re-execution),
  // then drives the correct view controller via mount()/unmount().
  //
  // Design principles:
  //   - Enhancement, not dependency. Any failure falls back to hard navigation.
  //   - Same static HTML is the source of truth; scripts are never re-executed.
  //   - View modules own behaviour; the shell owns lifecycle and DOM surgery.
  //   - Router remains the URL grammar source of truth.
  //   - history.back()/forward() are safe: soft-nav entries are handled by
  //     reloading (trivial safe fallback; true popstate soft-nav is a follow-up).

  // Set to true by softNavigate() before lazy-loading a view script, so the
  // script's IIFE auto-mount is suppressed (the shell calls mount() instead).
  var _managing = false;

  // Prevents overlapping navigations.
  var _inFlight = false;

  // The reader owns section→section paging (#prev/#next/#next-cta): section.js
  // routes those through the router with immediate queued feedback and a
  // directional transition, and page-transition.js already skips them for that
  // reason. The soft-nav shell must skip them too — otherwise it intercepts the
  // click in the capture phase, stopPropagation()s it, and suppresses the
  // reader's queued feedback. Soft-nav is for essay↔section trips, not paging.
  var SECTION_READER_NAV = '#prev-link, #next-link, #next-cta';

  // ---- URL / view helpers ----

  function viewForUrl(href) {
    try {
      var url = new URL(href, window.location.href);
      var path = url.pathname.toLowerCase();
      if (path.endsWith('/section.html') || path === 'section.html') { return 'section'; }
      if (path.endsWith('/essay.html')   || path === 'essay.html')   { return 'essay'; }
    } catch (_) {}
    return null;
  }

  function currentView() {
    return viewForUrl(window.location.href);
  }

  function isEligibleUrl(url) {
    if (url.origin !== window.location.origin) { return false; }
    var dest = viewForUrl(url.href);
    if (!dest) { return false; }
    // Same-pathname+search = same-document (hash change) — not a soft nav.
    if (url.pathname === window.location.pathname && url.search === window.location.search) {
      return false;
    }
    return true;
  }

  // ---- Script loader ----

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () {
        reject(new Error('reading-shell: failed to load ' + src));
      };
      document.head.appendChild(script);
    });
  }

  // Ensure the view controller for destView is in memory. Sets _managing = true
  // before dynamic load so the script's auto-mount call is suppressed.
  async function ensureViewScript(destView) {
    if (destView === 'section' && !window.RenaissanceSectionView) {
      _managing = true;
      await loadScript('scripts/section.js');
      _managing = false;
    } else if (destView === 'essay' && !window.RenaissanceEssayView) {
      _managing = true;
      await loadScript('scripts/essay.js');
      _managing = false;
    }
  }

  // ---- View lifecycle ----

  function unmountCurrent() {
    var view = currentView();
    try {
      if (view === 'essay' && window.RenaissanceEssayView) {
        window.RenaissanceEssayView.unmount();
      } else if (view === 'section' && window.RenaissanceSectionView) {
        window.RenaissanceSectionView.unmount();
      }
    } catch (_) {}
  }

  async function mountDestination(destView) {
    try {
      if (destView === 'essay' && window.RenaissanceEssayView) {
        await window.RenaissanceEssayView.mount();
      } else if (destView === 'section' && window.RenaissanceSectionView) {
        await window.RenaissanceSectionView.mount();
      }
    } catch (_) {}
  }

  // ---- Shell element sync ----

  // Swap the nav link zone inside .header-inner (everything before #theme-toggle)
  // while leaving the theme-toggle in place to preserve its event handlers.
  function syncHeaderNav(destDoc) {
    var headerInner = document.querySelector('.header-inner');
    var destHeaderInner = destDoc.querySelector('.header-inner');
    if (!headerInner || !destHeaderInner) { return; }

    var themeToggle = headerInner.querySelector('#theme-toggle');

    // Remove every child that is not the theme-toggle.
    var child = headerInner.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child !== themeToggle) {
        headerInner.removeChild(child);
      }
      child = next;
    }

    // Insert destination nav nodes before the theme-toggle (or at end if absent).
    var destNodes = Array.from(destHeaderInner.childNodes);
    destNodes.forEach(function (node) {
      // Skip the theme-toggle clone from the destination doc.
      if (node.nodeType === 1 && node.id === 'theme-toggle') { return; }
      // Skip pure-whitespace text nodes that flank the theme-toggle.
      if (node.nodeType === 3 && !node.textContent.trim()) { return; }
      headerInner.insertBefore(document.importNode(node, true), themeToggle || null);
    });
  }

  // Add or remove the #reader-progress scroll bar (exists in section.html,
  // absent in essay.html).
  function syncReaderProgress(destDoc, destView) {
    var existing = document.getElementById('reader-progress');
    if (destView === 'section' && !existing) {
      var destProgress = destDoc.getElementById('reader-progress');
      if (destProgress) {
        var cloned = document.importNode(destProgress, true);
        var header = document.querySelector('.site-header');
        document.body.insertBefore(cloned, header || document.body.firstChild);
      }
    } else if (destView !== 'section' && existing) {
      existing.parentNode.removeChild(existing);
    }
  }

  // ---- Metadata sync ----

  function syncMeta(destDoc) {
    if (destDoc.title) { document.title = destDoc.title; }

    var destDesc = destDoc.querySelector('meta[name="description"]');
    var curDesc  = document.querySelector('meta[name="description"]');
    if (destDesc && curDesc) {
      curDesc.setAttribute('content', destDesc.getAttribute('content') || '');
    }

    var destCanonical = destDoc.querySelector('link[rel="canonical"]');
    var curCanonical  = document.querySelector('link[rel="canonical"]');
    if (destCanonical && curCanonical) {
      curCanonical.setAttribute('href', destCanonical.getAttribute('href') || '');
    }
  }

  // ---- Reveal wiring ----

  // page-transition.js owns the paper veil and the reveal classes. For soft nav
  // we replicate its composed-arrival pattern: register a once listener for
  // renaissance:page-ready (fired by the view controller when content is loaded),
  // then call RenaissancePageTransition.ready({force:true}) to lift the veil.
  // We also dispatch renaissance:page-revealed so continuity and other listeners
  // get the same signal they would from a hard navigation reveal.
  var REVEAL_CAP_MS = 700;

  function wireReveal() {
    var revealed = false;
    var capTimer = null;

    function doReveal() {
      if (revealed) { return; }
      revealed = true;
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }

      if (window.RenaissancePageTransition && typeof window.RenaissancePageTransition.ready === 'function') {
        window.RenaissancePageTransition.ready({ force: true });
      } else {
        var root = document.documentElement;
        root.classList.remove('page-transition-out', 'page-transition-prep');
        root.classList.add('page-transition-ready');
        root.removeAttribute('aria-busy');
      }
      // Dispatch so continuity and other page-revealed listeners fire.
      window.dispatchEvent(new CustomEvent('renaissance:page-revealed'));
    }

    window.addEventListener('renaissance:page-ready', doReveal, { once: true });
    capTimer = window.setTimeout(doReveal, REVEAL_CAP_MS);
  }

  // ---- Core soft-navigation ----

  async function softNavigate(destUrl, leave) {
    // 1. Fetch the destination document.
    var destDoc;
    try {
      var res = await fetch(destUrl, { cache: 'force-cache' });
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      var html = await res.text();
      destDoc = new DOMParser().parseFromString(html, 'text/html');
    } catch (_err) {
      window.location.assign(destUrl);
      return false;
    }

    var destMain = destDoc.querySelector('main');
    var currentMain = document.getElementById('main-content') || document.querySelector('main');
    if (!destMain || !currentMain) {
      window.location.assign(destUrl);
      return false;
    }

    var destView = viewForUrl(destUrl);
    if (!destView) {
      window.location.assign(destUrl);
      return false;
    }

    // 2. Unmount the current view before any DOM surgery.
    unmountCurrent();

    // 3. Sync out-of-<main> shell elements (header nav, reader progress bar).
    syncHeaderNav(destDoc);
    syncReaderProgress(destDoc, destView);

    // 4. Swap <main> using importNode (avoids innerHTML, preserves DOM semantics).
    var newMain = document.importNode(destMain, true);
    currentMain.replaceWith(newMain);

    // 5. Sync document metadata.
    syncMeta(destDoc);

    // 6. Push the destination URL BEFORE loading / mounting so view scripts
    //    read the correct URL from window.location.
    try {
      window.history.pushState(
        { renaissanceSoftNav: true, href: destUrl },
        document.title,
        destUrl
      );
    } catch (_) {}

    // 7. Ensure the destination view script is loaded in memory.
    try {
      await ensureViewScript(destView);
    } catch (_err) {
      // View script failed to load — can't mount; fall back safely.
      _managing = false;
      window.location.reload();
      return false;
    }

    // 8. Dispatch route event for any listeners (router, spotlight, etc.).
    window.dispatchEvent(new CustomEvent('renaissance:route', {
      detail: { href: destUrl }
    }));

    // 8b. Stamp the destination as a real internal-navigation arrival (motion +
    //     source geometry + data-page-arrival), matching a hard navigation, so
    //     the composed reveal and arrival listeners see identical signals.
    if (window.RenaissancePageTransition &&
        typeof window.RenaissancePageTransition.markArrival === 'function' && leave) {
      window.RenaissancePageTransition.markArrival(leave.motion, leave.point);
    }

    // 9. Wire the composed-arrival reveal BEFORE mounting so the view
    //    controller's announcePageReady() triggers the veil lift.
    wireReveal();

    // 10. Mount the destination view. The view calls announcePageReady() after
    //     content loads which triggers the reveal wired in step 9.
    await mountDestination(destView);

    // 11. Focus <main> for screen-reader / keyboard continuity.
    window.requestAnimationFrame(function () {
      var mainEl = document.getElementById('main-content') || document.querySelector('main');
      if (mainEl) { mainEl.focus({ preventScroll: true }); }
    });

    return true;
  }

  // ---- Click interception ----

  function handleClick(event) {
    if (_inFlight) { return; }
    if (event.defaultPrevented) { return; }
    if (event.button !== 0) { return; }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { return; }

    var anchor = event.target && event.target.closest
      ? event.target.closest('a[href]')
      : null;
    if (!anchor) { return; }
    if (anchor.matches && anchor.matches(SECTION_READER_NAV)) { return; }
    if (anchor.target && anchor.target.toLowerCase() !== '_self') { return; }
    if (anchor.hasAttribute('download')) { return; }
    if (anchor.hasAttribute('data-no-soft-nav') || anchor.hasAttribute('data-no-page-transition')) { return; }

    var href = anchor.getAttribute('href') || '';
    if (!href) { return; }

    var url;
    try {
      url = new URL(href, window.location.href);
    } catch (_) { return; }

    if (!isEligibleUrl(url)) { return; }

    // Intercept: prevent page-transition.js from hard-navigating.
    event.preventDefault();
    event.stopPropagation();

    _inFlight = true;

    var RPT = window.RenaissancePageTransition;
    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var outDelay = (RPT && RPT.outDelayMs) || 120;

    // Run the SAME outgoing choreography as a hard navigation (motion +
    // source-link mark + geometry + the out veil) through page-transition's
    // shared hook, so soft and hard nav are indistinguishable. Fall back to a
    // minimal out veil only if the hook is somehow unavailable.
    var leave;
    if (RPT && typeof RPT.beginLeave === 'function') {
      leave = RPT.beginLeave(anchor);
    } else {
      leave = { motion: 'settle', point: null };
      if (!reducedMotion) {
        var root = document.documentElement;
        root.classList.remove('page-transition-ready', 'page-transition-prep');
        root.classList.add('page-transition-out');
        root.setAttribute('aria-busy', 'true');
      }
    }

    var doNav = function () {
      softNavigate(url.href, leave)
        .then(function () { _inFlight = false; })
        .catch(function () {
          _inFlight = false;
          window.location.assign(url.href);
        });
    };

    if (reducedMotion) {
      doNav();
    } else {
      window.setTimeout(doNav, outDelay);
    }
  }

  // ---- Popstate (back/forward) ----

  window.addEventListener('popstate', function (event) {
    var state = event.state;
    if (!state || !state.renaissanceSoftNav) { return; }
    // Safe hard-reload fallback for back/forward through soft-nav history entries.
    // True popstate soft-nav is a follow-up improvement.
    if (!_inFlight) {
      window.location.reload();
    }
  });

  // ---- Registration ----

  // Capture phase so we fire before page-transition.js's bubble handler.
  // continuity.js also registers in capture and runs first (it is loaded earlier),
  // so its source-geometry capture completes before we stopPropagation().
  document.addEventListener('click', handleClick, { capture: true });

  // ---- Public API ----

  window.RenaissanceReadingShell = {
    softNavigate: softNavigate,
    // View scripts check this flag to suppress auto-mount when the shell is
    // performing a lazy script load and will call mount() itself.
    get _managing() { return _managing; }
  };
})();
