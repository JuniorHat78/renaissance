(function () {
  // Register the service worker for offline reading. Relative "sw.js" resolves
  // against the page URL, so under /renaissance/ the worker scope is /renaissance/.
  // Failures are swallowed: the site works fine without it.
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () {
      /* offline support is a progressive enhancement; ignore registration errors */
    });
  });
})();
