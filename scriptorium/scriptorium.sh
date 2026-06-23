#!/usr/bin/env sh
# Scriptorium launcher (macOS / Linux) — boots the local author server and opens
# the editor in a chromeless app window (--app) via Chrome/Edge/Chromium if
# present, else a normal tab. Zero dependencies: just Node. You can also "Install
# app" from the browser for a standalone PWA window.
cd "$(dirname "$0")" || exit 1
exec node server.js --app
