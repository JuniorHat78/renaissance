/* Renaissance service worker. Served at /renaissance/sw.js, so its default
 * scope is /renaissance/ and every relative URL below resolves under it.
 *
 * Strategy:
 *  - Navigations: network-first (content stays fresh online), falling back to
 *    the cached page when offline. Matches ignore the query string, so
 *    essay.html?essay=X resolves to the cached essay.html shell. Raw essay text
 *    is cached from data/offline-assets.json during install so unread sections
 *    can still open offline without parsing one monolithic JS data blob.
 *  - Static assets (css/js/icons): stale-while-revalidate — instant from cache,
 *    refreshed in the background so a later load picks up a new deploy.
 *  - A versioned cache; bump VERSION to force a clean re-precache.
 */

const VERSION = "asset-b9151baea87f";
const CACHE = "renaissance-" + VERSION;
const OFFLINE_ASSET_MANIFEST = "data/offline-assets.json";
const NAVIGATION_NETWORK_TIMEOUT_MS = 4500;

const PRECACHE = [
  "./",
  "index.html",
  "essay.html",
  "section.html",
  "search.html",
  "404.html",
  "data/offline-assets.json",
  "styles/site.css",
  "scripts/ast/index.js",
  "scripts/archive.js",
  "scripts/clipboard-citation.js",
  "scripts/content.js",
  "scripts/essay.js",
  "scripts/essays-data.js",
  "scripts/meta.js",
  "scripts/archive-select.js",
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
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).then(() => cacheOfflineAssets(cache)))
      .then(() => self.skipWaiting())
  );
});

async function cacheOfflineAssets(cache) {
  try {
    const response = await fetch(OFFLINE_ASSET_MANIFEST, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const manifest = await response.json();
    const assets = Array.isArray(manifest.assets)
      ? manifest.assets.filter((asset) => typeof asset === "string" && asset.length > 0)
      : [];
    if (assets.length > 0) {
      await cache.addAll(assets);
    }
  } catch (error) {
    // Shell precache still gives a useful offline fallback if content caching
    // fails during install.
  }
}

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
    event.respondWith(networkFirstNavigation(request));
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

function timeoutAfter(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error("navigation network timeout")), ms);
  });
}

function cachedNavigationFallback(request) {
  return caches.match(request, { ignoreSearch: true }).then(
    (cached) => cached || caches.match("404.html") || Response.error()
  );
}

function networkFirstNavigation(request) {
  const network = fetch(request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
    return response;
  });

  return Promise.race([network, timeoutAfter(NAVIGATION_NETWORK_TIMEOUT_MS)])
    .catch(() => cachedNavigationFallback(request));
}
