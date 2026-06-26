#!/usr/bin/env node
"use strict";

// R1's last mile (SCRIPTORIUM-RUST-PARSER.md §9; closes SCRIPTORIUM.md §12
// blocker 1): in a REAL browser, parse a set of inputs with BOTH the browser AST
// authority (core+render+parse.js globals) and the wasm parser, and assert:
//   (a) browser-JS ≡ wasm-in-browser  — the editor's two engines agree, and
//   (b) wasm-in-browser ≡ the committed golden snapshot (§14.3) — in-browser
//       determinism vs the frozen JS authority, the original browser-vs-Node
//       concern now anchored to the goldens rather than a live Node parse.
// Structural comparison (JSON-parsed), same canonical-form contract as the other
// oracles. Run via run-with-server (serves the project + the built/copied wasm).

const path = require("node:path");
const { browserType, resolveBrowserName } = require("./lib/browser");
const shared = require("./lib/parser-oracle-corpus.js");
const { loadGoldens } = require("./lib/parse-goldens.js");

function parseArgs(argv) {
  const options = { base: "http://127.0.0.1:4173" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) {
      options.base = argv[i + 1];
      i += 1;
    }
  }
  options.base = options.base.replace(/\/+$/, "");
  return options;
}

async function main() {
  const options = parseArgs(process.argv);

  // Corpus + adversarial (skip the fuzz tail — keep the browser run quick; the
  // node-wasm oracle already fuzzes the same engine heavily). The goldens are
  // index-aligned with [corpus, adversarial, fuzz], so the leading slice is
  // exactly these inputs and trees[i] is their frozen JS reference.
  const golden = loadGoldens();
  const corpus = golden.corpus;
  const adversarial = golden.adversarial;
  const inputs = corpus.concat(adversarial);
  const goldenTrees = golden.trees.slice(0, inputs.length);
  const inputsJson = JSON.stringify(inputs); // survives CDP transport incl. lone surrogates

  const browser = await browserType().launch({ headless: true });
  let failures = 0;
  const MAX = 20;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(options.base + "/scriptorium/wasm-parity.html", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForFunction(
      () => window.__parityReady === true || typeof window.__parityError === "string",
      { timeout: 30000 }
    );
    const err = await page.evaluate(() => window.__parityError || null);
    if (err) {
      console.error("scriptorium-wasm-browser-parity: harness did not become ready: " + err);
      process.exitCode = 1;
      return;
    }

    const results = await page.evaluate((json) => {
      const list = JSON.parse(json);
      return list.map(function (t) {
        return {
          js: JSON.stringify(window.RenaissanceAst.parseDocument(t)),
          wasm: JSON.stringify(window.ScriptoriumWasmParser.parseDocument(t)),
        };
      });
    }, inputsJson);

    for (let i = 0; i < inputs.length; i += 1) {
      const browserJs = JSON.parse(results[i].js);
      const browserWasm = JSON.parse(results[i].wasm);
      const golden = goldenTrees[i];

      const dWasm = shared.diffDeep(browserJs, browserWasm, "$");
      const dGolden = shared.diffDeep(golden, browserWasm, "$");
      if (dWasm || dGolden) {
        failures += 1;
        if (failures <= MAX) {
          const region = i < corpus.length ? "corpus" : "adversarial";
          if (dWasm) console.error("FAIL #" + i + " (" + region + ") browserJS≠wasm at " + dWasm.path + " — " + dWasm.why);
          if (dGolden) console.error("FAIL #" + i + " (" + region + ") wasm≠golden at " + dGolden.path + " — " + dGolden.why);
          console.error("  input: " + shared.snippet(inputs[i]));
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error("\nscriptorium-wasm-browser-parity: " + failures + "/" + inputs.length + " inputs diverged.");
    process.exitCode = 1;
    return;
  }
  console.log(
    "scriptorium-wasm-browser-parity (" + resolveBrowserName() + "): " + inputs.length +
    " inputs — browser-JS ≡ wasm-in-browser ≡ golden snapshot."
  );
}

main().catch((e) => {
  console.error("scriptorium-wasm-browser-parity: " + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
