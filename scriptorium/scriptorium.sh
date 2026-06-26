#!/usr/bin/env sh
# Scriptorium launcher (macOS / Linux) — boots the author server and opens the
# editor in a chromeless app window (--app) via Chrome/Edge/Chromium if present,
# else a normal tab. Prefers the native (Rust) server binary when built — zero
# runtime deps, no Node — and falls back to Node otherwise. Build the binary with:
#   cargo build --release --manifest-path rust/Cargo.toml --bin scriptorium-server
cd "$(dirname "$0")/.." || exit 1
bin="rust/target/release/scriptorium-server"
if [ -x "$bin" ]; then
  exec "$bin" --app
fi
exec node scriptorium/server.js --app
