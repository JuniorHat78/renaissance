#!/usr/bin/env node
"use strict";

// Minimal static file server with an optional mount prefix, so tests can
// exercise the site exactly as GitHub *project* Pages serves it: under a
// subpath like /renaissance/. Deterministic (no parent-dir exposure), runs as
// a child process so run-with-server.js can manage its lifecycle like python's.

const http = require("http");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const options = { host: "127.0.0.1", port: 4176, root: process.cwd(), mount: "" };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--host" && next) { options.host = next; index += 1; }
    else if (token === "--port" && next) { options.port = Number.parseInt(next, 10); index += 1; }
    else if (token === "--root" && next) { options.root = path.resolve(next); index += 1; }
    else if (token === "--mount" && next) { options.mount = next; index += 1; }
  }
  return options;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function contentType(filePath) {
  return TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function main() {
  const options = parseArgs(process.argv);
  const rootResolved = path.resolve(options.root);
  const mount = options.mount.replace(/\/+$/, ""); // "/renaissance" or ""

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);

      if (mount) {
        if (pathname === mount) {
          pathname = "/";
        } else if (pathname.startsWith(mount + "/")) {
          pathname = pathname.slice(mount.length);
        } else {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
      }

      if (pathname.endsWith("/")) {
        pathname += "index.html";
      }

      const normalized = path.normalize(pathname).replace(/^([/\\])+/, "");
      const filePath = path.join(rootResolved, normalized);
      if (!filePath.startsWith(rootResolved)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          // Mirror GitHub Pages: serve the site's 404.html (with a 404 status)
          // for any missing path, so local runs exercise real 404 behaviour.
          fs.readFile(path.join(rootResolved, "404.html"), (notFoundErr, notFoundData) => {
            res.statusCode = 404;
            if (notFoundErr) {
              res.end("Not found");
              return;
            }
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(notFoundData);
          });
          return;
        }
        res.setHeader("Content-Type", contentType(filePath));
        res.end(data);
      });
    } catch (_error) {
      res.statusCode = 500;
      res.end("Server error");
    }
  });

  server.listen(options.port, options.host, () => {
    console.log("static-server listening on " + options.host + ":" + options.port + (mount ? " mount=" + mount : ""));
  });
}

main();
