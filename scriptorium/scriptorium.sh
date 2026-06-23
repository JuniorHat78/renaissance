#!/usr/bin/env sh
# Scriptorium launcher (macOS / Linux) — boots the local author server and opens
# the editor in your default browser. Zero dependencies: just Node. From there,
# use the browser's "Install app" to get a standalone desktop window (PWA).
cd "$(dirname "$0")" || exit 1
exec node server.js --open
