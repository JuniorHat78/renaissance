#!/usr/bin/env node
"use strict";

// Differential oracle for the native server (SCRIPTORIUM-RUST-PARSER.md R2):
// boot the Node server (the reference) and the candidate against ISOLATED copies
// of the content, fire the same request sequence at both, and assert behavioural
// equivalence — status codes, JSON-semantic response bodies, static bytes, and
// the bytes each writes to disk. /api/doctor is out of scope (JS-only) and not
// compared.
//
// Candidate = the Rust server if SCRIPTORIUM_SERVER_BIN is set (CI), else a
// second Node server (a local self-check that also proves the harness + Node
// determinism). Fail-closed: any divergence exits nonzero.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const shared = require("./lib/parser-oracle-corpus.js");
const ROOT = shared.ROOT;

const SLUG = "etching-god-into-sand";
const NODE_SERVER = path.join(ROOT, "scriptorium", "server.js");
const RUST_BIN = process.env.SCRIPTORIUM_SERVER_BIN && process.env.SCRIPTORIUM_SERVER_BIN.trim()
  ? path.resolve(process.env.SCRIPTORIUM_SERVER_BIN.trim())
  : null;

function makeTempRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptorium-srv-" + tag + "-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "data", "essays.json"), path.join(dir, "data", "essays.json"));
  fs.cpSync(path.join(ROOT, "raw"), path.join(dir, "raw"), { recursive: true });
  // The Node server runs from inside the temp root (PROJECT_ROOT = __dirname/..).
  fs.mkdirSync(path.join(dir, "scriptorium"), { recursive: true });
  fs.copyFileSync(NODE_SERVER, path.join(dir, "scriptorium", "server.js"));
  const doctor = path.join(ROOT, "scriptorium", "doctor.js");
  if (fs.existsSync(doctor)) {
    fs.copyFileSync(doctor, path.join(dir, "scriptorium", "doctor.js"));
  }
  return dir;
}

function bootNode(root, port) {
  return spawn(process.execPath, [path.join(root, "scriptorium", "server.js")], {
    env: Object.assign({}, process.env, { SCRIPTORIUM_PORT: String(port) }),
    stdio: "ignore",
  });
}

function bootRust(root, port) {
  return spawn(RUST_BIN, [], {
    env: Object.assign({}, process.env, { SCRIPTORIUM_PORT: String(port), SCRIPTORIUM_ROOT: root }),
    stdio: "ignore",
  });
}

async function waitReady(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/api/essays");
      if (r.status) {
        await r.text();
        return true;
      }
    } catch (_) {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// One request against one server → a normalized shape for comparison.
async function hit(port, spec) {
  const url = "http://127.0.0.1:" + port + spec.path;
  const init = { method: spec.method || "GET", redirect: "manual" };
  if (spec.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
  }
  const res = await fetch(url, init);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get("content-type") || "";
  let json = null;
  if (ctype.includes("application/json")) {
    try { json = JSON.parse(buf.toString("utf8")); } catch (_) { json = "<bad-json>"; }
  }
  return {
    status: res.status,
    location: res.headers.get("location"),
    json,
    bytes: buf,
    isJson: ctype.includes("application/json"),
  };
}

// The request sequence. Order matters (writes then reads).
const CASES = [
  { name: "GET essays", path: "/api/essays" },
  { name: "GET section 1", path: "/api/section?slug=" + SLUG + "&n=1" },
  { name: "GET unwritten section", path: "/api/section?slug=" + SLUG + "&n=987" },
  { name: "GET section bad slug", path: "/api/section?slug=Bad!Slug&n=1" },
  { name: "GET section bad n", path: "/api/section?slug=" + SLUG + "&n=0" },
  { name: "GET unknown api", path: "/api/nope" },
  { name: "GET root redirect", path: "/" },
  { name: "GET static section file", path: "/raw/" + SLUG + "/1.txt" },
  { name: "GET static 404", path: "/does-not-exist.txt" },
  { name: "GET static traversal", path: "/../../etc/passwd" },
  { name: "PUT section (write)", method: "PUT", path: "/api/section",
    body: { slug: SLUG, n: 987, text: "fresh\r\nsection\r\nbody  \nwith CRLF" },
    writeFile: "raw/" + SLUG + "/987.txt" },
  { name: "GET section after write", path: "/api/section?slug=" + SLUG + "&n=987" },
  { name: "PUT section bad body", method: "PUT", path: "/api/section", body: "not json" },
  { name: "PUT essays (write)", method: "PUT", path: "/api/essays", body: "__ESSAYS__",
    writeFile: "data/essays.json" },
  { name: "GET essays after write", path: "/api/essays" },
];

function compare(a, b, caseSpec) {
  if (a.status !== b.status) {
    return "status " + a.status + " vs " + b.status;
  }
  if (a.location !== b.location) {
    return "Location " + JSON.stringify(a.location) + " vs " + JSON.stringify(b.location);
  }
  if (a.status >= 200 && a.status < 300) {
    if (a.isJson && b.isJson) {
      const d = shared.diffDeep(a.json, b.json, "$body");
      if (d) return "body at " + d.path + " — " + d.why + " (" + JSON.stringify(d.a) + " vs " + JSON.stringify(d.b) + ")";
    } else if (!a.bytes.equals(b.bytes)) {
      return "static bytes differ (" + a.bytes.length + " vs " + b.bytes.length + ")";
    }
  } else {
    // Error responses: same status is the contract; if both JSON, both must flag ok:false.
    if (a.isJson && b.isJson) {
      if ((a.json && a.json.ok) !== (b.json && b.json.ok)) {
        return "error ok-flag " + JSON.stringify(a.json) + " vs " + JSON.stringify(b.json);
      }
    }
  }
  return null;
}

async function main() {
  const refRoot = makeTempRoot("ref");
  const candRoot = makeTempRoot("cand");
  const refPort = 4611;
  const candPort = 4612;
  const candIsRust = !!(RUST_BIN && fs.existsSync(RUST_BIN));

  const refProc = bootNode(refRoot, refPort);
  const candProc = candIsRust ? bootRust(candRoot, candPort) : bootNode(candRoot, candPort);

  let failures = 0;
  try {
    const okRef = await waitReady(refPort);
    const okCand = await waitReady(candPort);
    if (!okRef || !okCand) {
      console.error("rust-server-oracle: a server did not come up (ref=" + okRef + ", cand=" + okCand + ").");
      process.exitCode = 1;
      return;
    }

    // Materialize the PUT-essays body from the actual file (round-trips it).
    const essaysObj = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "essays.json"), "utf8"));

    for (const c of CASES) {
      const spec = Object.assign({}, c);
      if (spec.body === "__ESSAYS__") spec.body = essaysObj;
      const ra = await hit(refPort, spec);
      const rb = await hit(candPort, spec);
      const diff = compare(ra, rb, spec);
      if (diff) {
        failures += 1;
        console.error("FAIL [" + c.name + "] " + diff);
      }
      // For writes, compare the bytes each server put on disk.
      if (c.writeFile) {
        const fa = readMaybe(path.join(refRoot, c.writeFile));
        const fb = readMaybe(path.join(candRoot, c.writeFile));
        if (!buffersEqual(fa, fb)) {
          failures += 1;
          console.error("FAIL [" + c.name + "] written file differs: " + c.writeFile +
            " (" + (fa ? fa.length : "missing") + " vs " + (fb ? fb.length : "missing") + ")");
        }
      }
    }
  } finally {
    refProc.kill();
    candProc.kill();
    await sleep(150);
    fs.rmSync(refRoot, { recursive: true, force: true });
    fs.rmSync(candRoot, { recursive: true, force: true });
  }

  const mode = candIsRust ? "node vs rust" : "node vs node (self-check; set SCRIPTORIUM_SERVER_BIN for rust)";
  if (failures > 0) {
    console.error("\nrust-server-oracle: " + failures + " divergence(s) [" + mode + "].");
    process.exitCode = 1;
    return;
  }
  console.log("rust-server-oracle: " + CASES.length + " cases equivalent [" + mode + "].");
  if (candIsRust) console.log("Rust server ≡ Node server.");
}

function readMaybe(p) {
  try { return fs.readFileSync(p); } catch (_) { return null; }
}
function buffersEqual(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

main().catch((e) => {
  console.error("rust-server-oracle: harness error: " + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
