@echo off
REM Scriptorium launcher (Windows) — boots the local author server and opens the
REM editor in a chromeless app window (--app) via Chrome/Edge if present, else a
REM normal tab. Zero dependencies: just Node. You can also "Install app" from the
REM browser for a standalone PWA window.
cd /d "%~dp0"
node server.js --app
