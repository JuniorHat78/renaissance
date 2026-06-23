@echo off
REM Scriptorium launcher (Windows) — boots the local author server and opens the
REM editor in your default browser. Zero dependencies: just Node. From there,
REM use the browser's "Install app" to get a standalone desktop window (PWA).
cd /d "%~dp0"
node server.js --open
