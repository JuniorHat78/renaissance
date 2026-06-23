#!/usr/bin/env node
"use strict";

// Scriptorium — the local authoring server (see docs/specs/SCRIPTORIUM.md §7).
//
// A zero-dependency Node HTTP server, the writable counterpart to the project's
// `python -m http.server` dev flow. It serves the project root statically (so the
// browser editor can load scripts/ast/*, scriptorium/editor.html, data/*) and
// exposes a tiny JSON API that READS AND WRITES the two content sources of truth:
//   - prose:    raw/<slug>/<n>.txt
//   - metadata: data/essays.json
//
// Two properties are load-bearing and must never regress (spec §7):
//   1. ATOMIC WRITES ONLY — write a temp file in the same dir, fsync, rename into
//      place. A reader (the deploy build) must never observe a torn half-write.
//   2. PATH SAFETY — every client-supplied path is resolved and refused (400) if
//      it escapes its allowed root. No `..` traversal, no client absolute paths.
//
// Quarantine (spec §6): this lives entirely under scriptorium/ and is never
// shipped. The dependency arrow points one way — scriptorium may read the site,
// the site must never import scriptorium.
//
// Internals are exported (bottom of file) so the regression suite can unit-test
// path safety and atomic writes without standing up HTTP. The server only starts
// listening when run directly.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Roots & constants
// ---------------------------------------------------------------------------

// The project root is the repo checkout — one level up from scriptorium/.
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RAW_ROOT = path.join(PROJECT_ROOT, "raw");
const ESSAYS_PATH = path.join(PROJECT_ROOT, "data", "essays.json");

const DEFAULT_PORT = 4500;
const DEFAULT_ROUTE = "/scriptorium/editor.html";

// A slug names a content folder; keep it to the same alphabet the rest of the
// pipeline uses (lowercase, digits, hyphen) so it can never carry a path
// separator, a dot segment, or anything that resolves outside RAW_ROOT.
const SLUG_PATTERN = /^[a-z0-9-]+$/;

// Max bytes we will buffer for a request body before refusing. Sections are
// prose and essays.json is small; this is a guard against a runaway client, not
// a real limit on legitimate content.
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// ---------------------------------------------------------------------------
// Input normalization / validation
// ---------------------------------------------------------------------------

// A slug is valid only if it is a non-empty string matching SLUG_PATTERN.
// Returning the trimmed slug (or null) keeps callers branch-once.
function normalizeSlug(value) {
  const slug = String(value == null ? "" : value).trim();
  return SLUG_PATTERN.test(slug) ? slug : null;
}

// A section number is a positive integer. We parse strictly: "1" is fine, "1.5",
// "01x", "-2", "" are not. Mirrors parseNumber in scripts/content.js so the
// editor and server agree on what counts as a section.
function normalizeSectionNumber(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const number = Number.parseInt(raw, 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// True iff `child` is the same path as `root` or lives strictly beneath it.
// Compares resolved absolute paths and guards the prefix with a separator so
// that e.g. `/raw-evil` is not treated as inside `/raw`.
function isInsideRoot(root, child) {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(child);
  if (resolvedChild === resolvedRoot) {
    return true;
  }
  const withSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  return resolvedChild.startsWith(withSep);
}

// Resolve the on-disk path for a section's prose, refusing anything that would
// escape RAW_ROOT. Validation is belt-and-suspenders: the slug/number are
// already alphabet-checked, but we still resolve and re-verify containment so a
// future caller that forgets to validate cannot punch a hole. Throws BadRequest
// on any invalid or escaping input; the caller maps that to a 400.
function safeSectionPath(slug, sectionNumber) {
  const safeSlug = normalizeSlug(slug);
  if (!safeSlug) {
    throw new BadRequestError("Invalid slug (expected [a-z0-9-]+).");
  }
  const safeNumber = normalizeSectionNumber(sectionNumber);
  if (safeNumber === null) {
    throw new BadRequestError("Invalid section number (expected a positive integer).");
  }

  const candidate = path.join(RAW_ROOT, safeSlug, safeNumber + ".txt");
  if (!isInsideRoot(RAW_ROOT, candidate)) {
    // Should be unreachable given the alphabet checks above; if it ever fires,
    // a guard upstream has rotted — refuse loudly rather than touch disk.
    throw new BadRequestError("Refusing path outside the content root.");
  }
  return candidate;
}

// Resolve the on-disk path for a static read of `urlPath` under PROJECT_ROOT.
// Returns null (caller -> 404/400) for any path that decodes badly or escapes
// the project root. We never serve outside PROJECT_ROOT — no traversal, no
// absolute client paths (a leading "/" is interpreted relative to the root).
function safeContentPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath == null ? "" : urlPath));
  } catch (error) {
    return null; // malformed percent-encoding
  }

  // Drop the query/hash if any slipped through, and a leading slash so join()
  // treats the path as relative to PROJECT_ROOT rather than the filesystem root.
  decoded = decoded.split("?")[0].split("#")[0];
  const relative = decoded.replace(/^\/+/, "");

  // A NUL byte in a path is always an attack/bug; refuse outright.
  if (relative.indexOf("\0") !== -1) {
    return null;
  }

  const candidate = path.resolve(PROJECT_ROOT, relative);
  if (!isInsideRoot(PROJECT_ROOT, candidate)) {
    return null;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

// Write `data` to `destPath` so a reader never sees a partial file:
//   1. write the bytes to a uniquely-named temp file IN THE SAME DIRECTORY
//      (rename is only atomic within a filesystem, so the temp must be a sibling),
//   2. fsync the file descriptor so the bytes are durable before the swap,
//   3. rename the temp over the destination (atomic on POSIX; on Windows the
//      JS rename replaces an existing file),
//   4. best-effort fsync the directory so the rename itself is durable.
// On any failure we remove the temp file so we never litter torn `.tmp` files.
function atomicWrite(destPath, data) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  const tempName =
    "." + path.basename(destPath) + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  const tempPath = path.join(dir, tempName);

  let fd;
  try {
    fd = fs.openSync(tempPath, "wx"); // wx: fail if the temp name somehow exists
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd); // durability: bytes hit disk before the rename
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tempPath, destPath); // the atomic swap

    // Durability of the rename: fsync the directory. Best-effort — not all
    // platforms permit opening a directory for fsync (notably Windows), and a
    // failure here does not mean the data is lost, so we swallow it.
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (dirError) {
      /* best-effort directory fsync */
    }
  } catch (error) {
    // Clean up: close a dangling fd and remove the temp so a failed save leaves
    // the destination untouched and no orphan temp behind.
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        /* already closing on the error path */
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (rmError) {
      /* temp may not exist */
    }
    throw error;
  }
}

// Pretty-print JSON exactly as the repo stores it: 2-space indent, trailing
// newline. Keeping this in one place means every JSON the server writes matches
// the on-disk convention (and produces clean diffs).
function serializeJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// A client-fault error: maps to an HTTP 4xx with a JSON body. Anything that is
// NOT a BadRequestError is a programmer/server fault and surfaces as a 500.
class BadRequestError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "BadRequestError";
    this.statusCode = statusCode || 400;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Author tooling — never let a stale API response be cached.
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: String(message) });
}

// Read a full request body and parse it as JSON. Rejects (BadRequestError) on an
// over-large body or invalid JSON so handlers can assume a clean object.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(new BadRequestError("Request body too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) {
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        reject(new BadRequestError("Expected a JSON request body."));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new BadRequestError("Request body is not valid JSON."));
      }
    });

    req.on("error", (error) => {
      if (!aborted) {
        reject(error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// API handlers — the contract shared with the editor UI agent.
// Each returns the JSON payload (object); the dispatcher serializes it. They
// throw BadRequestError for client faults; anything else bubbles to a 500.
// ---------------------------------------------------------------------------

// GET /api/essays -> the parsed contents of data/essays.json.
function handleGetEssays() {
  let raw;
  try {
    raw = fs.readFileSync(ESSAYS_PATH, "utf8");
  } catch (error) {
    throw new Error("Unable to read data/essays.json: " + error.message);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // The file is on disk but corrupt — a real server-side problem, not a bad
    // request. Surface it as a 500 with a clear message.
    throw new Error("data/essays.json is not valid JSON: " + error.message);
  }
}

// PUT /api/essays -> body is the new essays.json object; write it atomically,
// pretty-printed (2-space). The body must be a JSON object (not an array or
// scalar) since essays.json is `{ "essays": [...] }`.
async function handlePutEssays(req) {
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Expected a JSON object for essays.json.");
  }
  atomicWrite(ESSAYS_PATH, serializeJson(body));
  return { ok: true };
}

// GET /api/section?slug=<slug>&n=<num> -> { slug, n, text }. Returns an empty
// string for a section that has not been written to disk yet (so the editor can
// open a brand-new section without a 404 dance).
function handleGetSection(query) {
  const slug = normalizeSlug(query.slug);
  if (!slug) {
    throw new BadRequestError("Invalid or missing slug.");
  }
  const n = normalizeSectionNumber(query.n);
  if (n === null) {
    throw new BadRequestError("Invalid or missing section number (n).");
  }

  const filePath = safeSectionPath(slug, n);
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      text = ""; // not written yet — a clean empty section, not an error
    } else {
      throw error;
    }
  }
  return { slug, n, text };
}

// PUT /api/section -> body { slug, n, text }; atomically write raw/<slug>/<n>.txt.
async function handlePutSection(req) {
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Expected a JSON object { slug, n, text }.");
  }

  const slug = normalizeSlug(body.slug);
  if (!slug) {
    throw new BadRequestError("Invalid or missing slug.");
  }
  const n = normalizeSectionNumber(body.n);
  if (n === null) {
    throw new BadRequestError("Invalid or missing section number (n).");
  }
  if (typeof body.text !== "string") {
    throw new BadRequestError("Field 'text' must be a string.");
  }

  const filePath = safeSectionPath(slug, n);
  atomicWrite(filePath, body.text);
  return { ok: true };
}

// GET /api/doctor -> runDoctor() from ./doctor.js if present. The doctor module
// is owned by another agent and may not exist yet; we require it lazily inside a
// try/catch and degrade to a clean "not present" response rather than 500.
async function handleGetDoctor() {
  let doctor;
  try {
    // Lazy require so a missing module is caught here, not at server boot, and
    // so edits to doctor.js are picked up without restarting (require cache
    // aside — see note below).
    doctor = require("./doctor.js");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      return { ok: true, issues: [], note: "doctor module not present yet" };
    }
    // The module exists but failed to load (syntax error, throw at top level) —
    // that is a real fault worth surfacing, not a silent "all clear".
    throw error;
  }

  if (!doctor || typeof doctor.runDoctor !== "function") {
    return {
      ok: true,
      issues: [],
      note: "doctor module present but exports no runDoctor()"
    };
  }

  // runDoctor may be sync or async; await normalizes both.
  return await doctor.runDoctor();
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || DEFAULT_CONTENT_TYPE;
}

// Serve a static file from the project root. Resolves + containment-checks the
// path (safeContentPath), refuses traversal (400), 404s missing files, and
// streams the file with a sensible content-type. Directories are not listed.
function serveStatic(req, res, pathname) {
  const filePath = safeContentPath(pathname);
  if (filePath === null) {
    sendError(res, 400, "Refusing path outside the project root.");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    sendError(res, 404, "Not found.");
    return;
  }

  if (stat.isDirectory()) {
    // No directory listings — keep the surface small and predictable.
    sendError(res, 404, "Not found.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": stat.size,
    // Local author tooling: always serve fresh so an edited asset shows up on
    // reload without cache-busting.
    "Cache-Control": "no-store"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    // The stat succeeded but the read failed (race, permissions). Headers are
    // already sent, so the best we can do is terminate the response.
    res.destroy();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

// Route one request. API routes are matched first; everything else is a static
// read of the project root. All handler failures funnel through one place so the
// error contract (BadRequestError -> 4xx, anything else -> 500) is uniform.
async function handleRequest(req, res) {
  let parsed;
  try {
    parsed = url.parse(req.url, true);
  } catch (error) {
    sendError(res, 400, "Malformed request URL.");
    return;
  }

  const pathname = parsed.pathname || "/";
  const query = parsed.query || {};
  const method = req.method || "GET";

  try {
    // ---- API surface -----------------------------------------------------
    if (pathname === "/api/essays") {
      if (method === "GET") {
        sendJson(res, 200, handleGetEssays());
        return;
      }
      if (method === "PUT") {
        sendJson(res, 200, await handlePutEssays(req));
        return;
      }
      sendError(res, 405, "Method not allowed for /api/essays.");
      return;
    }

    if (pathname === "/api/section") {
      if (method === "GET") {
        sendJson(res, 200, handleGetSection(query));
        return;
      }
      if (method === "PUT") {
        sendJson(res, 200, await handlePutSection(req));
        return;
      }
      sendError(res, 405, "Method not allowed for /api/section.");
      return;
    }

    if (pathname === "/api/doctor") {
      if (method === "GET") {
        sendJson(res, 200, await handleGetDoctor());
        return;
      }
      sendError(res, 405, "Method not allowed for /api/doctor.");
      return;
    }

    // Any other /api/* path is a contract miss — be explicit rather than
    // falling through to the static file server and returning a confusing 404
    // for a route the editor expected to exist.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendError(res, 404, "Unknown API route: " + pathname);
      return;
    }

    // ---- Static surface --------------------------------------------------
    if (method !== "GET" && method !== "HEAD") {
      sendError(res, 405, "Method not allowed.");
      return;
    }

    // Default route: send the author straight to the editor.
    if (pathname === "/" || pathname === "") {
      res.writeHead(302, { Location: DEFAULT_ROUTE });
      res.end();
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    if (error instanceof BadRequestError) {
      sendError(res, error.statusCode || 400, error.message);
      return;
    }
    // Unexpected — a server/programmer fault. Log it loudly (this is local
    // tooling; the operator is the author at a terminal) and return a 500.
    // eslint-disable-next-line no-console
    console.error("[scriptorium] 500 on " + method + " " + pathname + ":", error);
    sendError(res, 500, "Internal server error.");
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

// Build (but do not start) the HTTP server. Exposed so tests can drive it
// against an ephemeral port without the file's run-directly side effects.
function createServer() {
  return http.createServer((req, res) => {
    // handleRequest is async; a rejection here would otherwise be an unhandled
    // promise rejection that crashes the process. Catch it as a last resort.
    Promise.resolve(handleRequest(req, res)).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[scriptorium] unhandled request error:", error);
      if (!res.headersSent) {
        sendError(res, 500, "Internal server error.");
      } else {
        res.destroy();
      }
    });
  });
}

function resolvePort() {
  const fromEnv = Number.parseInt(process.env.SCRIPTORIUM_PORT || "", 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Entry point — only listen when run directly (`node scriptorium/server.js`).
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = resolvePort();
  const server = createServer();
  server.listen(port, () => {
    const editorUrl = "http://localhost:" + port + DEFAULT_ROUTE;
    // eslint-disable-next-line no-console
    console.log("Scriptorium server running.");
    // eslint-disable-next-line no-console
    console.log("  Project root: " + PROJECT_ROOT);
    // eslint-disable-next-line no-console
    console.log("  Open the editor: " + editorUrl);
  });
}

// Exported internals for the regression suite (spec §8 P0 — atomic-write +
// path-safety are the load-bearing bits to unit-test without HTTP).
module.exports = {
  createServer,
  atomicWrite,
  safeContentPath,
  safeSectionPath,
  serializeJson,
  isInsideRoot,
  normalizeSlug,
  normalizeSectionNumber,
  handleRequest,
  BadRequestError,
  // Roots, so tests can assert/anchor against the same paths the server uses.
  PROJECT_ROOT,
  RAW_ROOT,
  ESSAYS_PATH
};
