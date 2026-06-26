// Scriptorium service worker — LOCAL author tooling only (quarantine §6).
//
// Scoped to /scriptorium/ so it is completely isolated from the SHIPPED site's
// own service worker (scripts/.../sw.js, root scope): this one never controls a
// reader page and the site never registers it. Its only jobs are (a) make the
// editor an installable PWA (a manifest + a fetch handler is the install bar)
// so it gets a real desktop window with no Electron and no dependency, and
// (b) let the shell load offline. It is NOT shipped and NOT precached by the
// site.
//
// Strategy: network-FIRST for the shell, so iterating on editor.js/commands.js
// always serves the freshest code, with the cache only as an offline fallback.
// The author API (/api/*) and all non-GET requests are never intercepted — they
// must always hit the live server that reads and writes the disk.

// v2: dropped the deleted parse.js, added the wasm parser (glue + .wasm). The
// new name evicts any stale shell that still lists parse.js.
const CACHE = "scriptorium-shell-v2";
const SHELL = [
  "/scriptorium/editor.html",
  "/scriptorium/editor.css",
  "/scriptorium/editor.js",
  "/scriptorium/mapping.js",
  "/scriptorium/commands.js",
  "/scriptorium/manifest.webmanifest",
  "/scriptorium/icon.svg",
  "/scripts/ast/core.js",
  "/scripts/ast/render.js",
  // The parser is the Rust core as wasm (the parse.js cutover, §14.3): precache
  // the glue + the .wasm so the offline editor can still parse/preview.
  "/scriptorium/wasm-parser.js",
  "/scriptorium/scriptorium_parser.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never touch the author API or writes — always live.
  if (event.request.method !== "GET" || url.pathname.indexOf("/api/") === 0) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Refresh the cache copy in the background (best effort).
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
