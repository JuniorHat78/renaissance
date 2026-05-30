/* Renaissance service worker. Served at /renaissance/sw.js, so its default
 * scope is /renaissance/ and every relative URL below resolves under it.
 *
 * Strategy:
 *  - Navigations: network-first (content stays fresh online), falling back to
 *    the cached page when offline. Matches ignore the query string, so
 *    essay.html?essay=X resolves to the cached essay.html shell — and because
 *    all essay text lives in the precached essays-data.js, every essay reads
 *    offline once the shell is cached, not just the ones already visited.
 *  - Static assets (css/js/icons): stale-while-revalidate — instant from cache,
 *    refreshed in the background so a later load picks up a new deploy.
 *  - A versioned cache; bump VERSION to force a clean re-precache.
 */

const VERSION = "v2";
const CACHE = "renaissance-" + VERSION;

const PRECACHE = [
  "./",
  "index.html",
  "essay.html",
  "section.html",
  "search.html",
  "404.html",
  "styles/site.css",
  "scripts/ast/index.js",
  "scripts/archive.js",
  "scripts/content.js",
  "scripts/essay.js",
  "scripts/essays-data.js",
  "scripts/meta.js",
  "scripts/preview-card.js",
  "scripts/reading-state.js",
  "scripts/router.js",
  "scripts/search-engine.js",
  "scripts/search-page.js",
  "scripts/section.js",
  "scripts/theme.js",
  "scripts/pwa.js",
  "site.webmanifest",
  "assets/icon.svg",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/icon-maskable-512.png",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/favicon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return; // let cross-origin requests pass straight through
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request, { ignoreSearch: true }).then(
            (cached) => cached || caches.match("404.html") || Response.error()
          )
        )
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
