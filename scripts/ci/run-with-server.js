#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("Usage: run-with-server.js [--port 4173] [--host 127.0.0.1] -- <command>");
  }

  const options = {
    host: "127.0.0.1",
    port: 4173,
    root: process.cwd(),
    timeoutMs: 20000,
    mount: ""
  };

  for (let index = 2; index < separator; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (token === "--port" && next) {
      options.port = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--root" && next) {
      options.root = path.resolve(process.cwd(), next);
      index += 1;
    } else if (token === "--timeout-ms" && next) {
      options.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--mount" && next) {
      // Serve the site under a subpath (e.g. /renaissance/) to mirror GitHub
      // project Pages. Switches the static server from python to the bundled
      // Node server, which understands the mount prefix.
      options.mount = "/" + String(next).replace(/^\/+|\/+$/g, "");
      index += 1;
    } else {
      throw new Error("Unknown option: " + token);
    }
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("Invalid port.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Invalid timeout.");
  }

  return {
    options,
    command: argv.slice(separator + 1)
  };
}

function pythonCommand() {
  if (process.env.PYTHON) {
    return process.env.PYTHON;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function probe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const request = http.get(url, (response) => {
      response.resume();
      finish(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on("error", () => finish(false));
    request.setTimeout(1000, () => {
      request.destroy();
      finish(false);
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for " + url);
}

function runCommand(command, env) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const child = isWindows
      ? spawn(command.map((part) => quoteWindowsArg(part)).join(" "), {
          cwd: process.cwd(),
          env,
          stdio: "inherit",
          shell: true
        })
      : spawn(command[0], command.slice(1), {
          cwd: process.cwd(),
          env,
          stdio: "inherit",
          shell: false
        });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=?&+-]+$/.test(text)) {
    return text;
  }
  return '"' + text.replace(/"/g, '\\"') + '"';
}

function startServer(options) {
  if (options.mount) {
    const serverScript = path.resolve(__dirname, "static-server.js");
    return spawn(
      process.execPath,
      [
        serverScript,
        "--host", options.host,
        "--port", String(options.port),
        "--root", options.root,
        "--mount", options.mount
      ],
      { cwd: options.root, stdio: ["ignore", "pipe", "pipe"], shell: false }
    );
  }
  return spawn(pythonCommand(), ["-m", "http.server", String(options.port), "--bind", options.host], {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
}

async function main() {
  const { options, command } = parseArgs(process.argv);
  const baseUrl = "http://" + options.host + ":" + String(options.port) + options.mount;
  const server = startServer(options);

  let serverOutput = "";
  const capture = (chunk) => {
    serverOutput = (serverOutput + String(chunk)).slice(-4000);
  };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);

  try {
    await waitForServer(baseUrl + "/index.html", options.timeoutMs);
    const code = await runCommand(command, {
      ...process.env,
      RENAISSANCE_BASE_URL: baseUrl
    });
    process.exitCode = code;
  } catch (error) {
    console.error(error.message);
    if (serverOutput) {
      console.error(serverOutput);
    }
    process.exitCode = 1;
  } finally {
    if (!server.killed) {
      server.kill();
    }
  }
}

main();
