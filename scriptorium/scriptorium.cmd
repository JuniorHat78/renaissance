@echo off
REM Scriptorium launcher (Windows) — boots the author server and opens the editor
REM in a chromeless app window (--app) via Chrome/Edge if present, else a normal
REM tab. Prefers the native (Rust) server binary when built — zero runtime deps,
REM no Node — and falls back to Node otherwise. Build the binary with:
REM   cargo build --release --manifest-path rust\Cargo.toml --bin scriptorium-server
cd /d "%~dp0\.."
set "BIN=rust\target\release\scriptorium-server.exe"
if exist "%BIN%" (
  "%BIN%" --app
) else (
  node scriptorium\server.js --app
)
