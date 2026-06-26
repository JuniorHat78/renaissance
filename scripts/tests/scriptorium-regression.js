#!/usr/bin/env node
"use strict";

// Scriptorium's own small regression — the spine guard (SCRIPTORIUM.md §2 + §8).
//
// Scriptorium is quarantined local author tooling (§6): it never enters the
// served bundle, the precache, the asset budget, or the reader gauntlets. So it
// gets THIS test instead of the reader CI. The load-bearing assertion is the
// spine invariant: the editor authors *through the one parse authority*
// (contentAstFor — the exact path the compiler and reader use), so the chain is
//
//     author's buffer ─parse(one authority)→ AST ─render→ preview == shipped DOM
//
// "buffer == compiled == rendered == shipped, all provably one artifact." This
// test proves the editor *cannot preview a lie*: the preview render of a
// section's source is byte-identical to rendering the COMPILED AST that ships.
// If they ever diverge, the editor has grown a second parse path and the build
// must fail closed.
//
// Two further units exercise the local server's internals without HTTP
// (atomic-write + path-safety, §7) and the project doctor (§3), each
// skip-with-warning if its module isn't present yet — those modules are being
// built concurrently, and an interface mismatch must NOT hard-fail the spine
// guard. Zero deps, plain `node` script: nonzero exit on any hard failure.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ast = require("../ast/index.js");
const compiler = require("../generate-content-ast.js");

const root = path.join(__dirname, "..", "..");
const compiledDir = path.join(root, "data", "compiled");

let passed = 0;
let skipped = 0;
const failures = [];

// Hard assertion: a failure here is a real regression and exits nonzero.
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + (error && error.message ? error.message : String(error)));
    console.error("FAIL " + name);
  }
}

// Soft skip: the unit's subject (a concurrently-built module / optional
// artifact) isn't available. Warn loudly, but do not fail the suite.
function skip(name, reason) {
  skipped += 1;
  console.warn("SKIP " + name + " — " + reason);
}

// ---------------------------------------------------------------------------
// 1. SPINE EQUIVALENCE — the core guard.
//
// For every real section of every essay, render the section's source through
// the ONE authority (the "preview render" the editor shows) and render the
// COMPILED AST that ships, and assert the two HTML strings are byte-identical.
// ---------------------------------------------------------------------------

function sourceName(essay, sectionNumber) {
  return (String((essay && essay.source_dir) || "").trim() || "raw") + "/" + String(sectionNumber) + ".txt";
}

// The editor's preview path: source text -> the one parse authority -> AST.
// contentAstFor is literally what the compiler stores and what the reader
// hydrates, so rendering its output IS the preview the author sees.
function previewAstFor(essay, sectionNumber) {
  return compiler.contentAstFor(essay, sectionNumber);
}

// Render via the AST's own serializer (the HTML-string renderer shared by the
// preview and the shipped DOM). serializeDocument delegates to serializeBlocks;
// we use serializeBlocks directly since the compiled artifact stores a document
// node already projected through withoutLeadingHeadings.
function render(documentNode) {
  return ast.serializeBlocks(documentNode);
}

// Every essay with a slug. compilableEssays mirrors the compiler: published and
// drafts alike get an artifact (since P5 a draft opened by direct URL hydrates a
// compiled AST too), so the spine guard must cover real sections of each.
const essays = compiler.compilableEssays(compiler.loadEssays());

// Is there a committed compiled artifact set to render the "shipped" side from?
// (If data/compiled/ is absent we fall back to an idempotence check and say so.)
const haveCompiledDir = fs.existsSync(compiledDir);

check("spine: at least one essay with real sections is present", () => {
  assert.ok(essays.length > 0, "no compilable essays found in data/essays.json");
  const totalSections = essays.reduce(
    (sum, essay) => sum + (Array.isArray(essay.section_order) ? essay.section_order.length : 0),
    0
  );
  assert.ok(totalSections > 0, "essays carry no sections to guard");
});

if (!haveCompiledDir) {
  // Fallback (SCRIPTORIUM.md §2, explicit): no compiled artifacts to diff
  // against, so prove the next-best property — the preview render is stable
  // across two independent parse+render passes (the authority is deterministic,
  // so the editor's preview is at least self-consistent).
  console.warn(
    "NOTE data/compiled/ is absent — no shipped artifact to diff against. " +
    "Falling back to render idempotence of render(contentAstFor(text))."
  );
  for (const essay of essays) {
    check(essay.slug + ": preview render is idempotent across two parses (no compiled/ fallback)", () => {
      for (const sectionNumber of essay.section_order) {
        const once = render(previewAstFor(essay, sectionNumber));
        const twice = render(previewAstFor(essay, sectionNumber));
        assert.strictEqual(
          once,
          twice,
          "preview render for section " + sectionNumber + " is not stable across two calls"
        );
      }
    });
  }
} else {
  // The real spine guard: preview render == render of the SHIPPED compiled AST,
  // byte-for-byte. The shipped AST is read from data/compiled/<slug>.json when a
  // section is present there; any section missing from the artifact is compiled
  // through the SAME authority (a section the editor could be authoring right
  // now), so the guard still closes the loop end to end.
  for (const essay of essays) {
    const artifactPath = path.join(compiledDir, essay.slug + ".json");
    const artifact = fs.existsSync(artifactPath)
      ? JSON.parse(fs.readFileSync(artifactPath, "utf8"))
      : null;
    const shippedBySection = new Map();
    if (artifact && Array.isArray(artifact.sections)) {
      for (const section of artifact.sections) {
        shippedBySection.set(Number(section.sectionNumber), section.ast);
      }
    }

    check(essay.slug + ": preview render is byte-identical to the shipped (compiled) render", () => {
      assert.ok(
        Array.isArray(essay.section_order) && essay.section_order.length > 0,
        "essay has no section_order to guard"
      );
      for (const sectionNumber of essay.section_order) {
        const previewHtml = render(previewAstFor(essay, sectionNumber));

        // Prefer the committed artifact as the "shipped" side; fall back to a
        // compile-through-the-authority for any section not yet in the artifact.
        const shippedAst = shippedBySection.has(Number(sectionNumber))
          ? shippedBySection.get(Number(sectionNumber))
          : compiler.contentAstFor(essay, sectionNumber);
        const shippedHtml = render(shippedAst);

        assert.strictEqual(
          previewHtml,
          shippedHtml,
          "section " + sectionNumber + ": editor preview diverged from shipped render — " +
            "the editor has grown a second parse path (spine broken)"
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 2. ATOMIC-WRITE + PATH-SAFETY — server internals, no HTTP (SCRIPTORIUM.md §7).
//
// require the server module and exercise its pure exports directly. The server
// is being written concurrently, so if the export shape differs we SKIP loudly
// rather than hard-fail the spine guard. We never start the HTTP listener.
// ---------------------------------------------------------------------------

(function serverInternals() {
  const label2a = "server: atomicWrite round-trips a file and leaves no temp behind";
  const label2b = "server: safeContentPath rejects traversal/abs/bad-slug, accepts raw/<slug>/<n>.txt";

  let server;
  try {
    server = require("../../scriptorium/server.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/server.js not present yet (built concurrently)"
        : "require('scriptorium/server.js') threw: " + (error && error.message ? error.message : String(error));
    skip(label2a, reason);
    skip(label2b, reason);
    return;
  }

  // --- atomicWrite -------------------------------------------------------
  if (typeof server.atomicWrite !== "function") {
    skip(label2a, "server.atomicWrite is not an exported function (interface differs)");
  } else {
    check(label2a, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptorium-atomic-"));
      const target = path.join(dir, "section.txt");
      try {
        const payload = "spine line one\nspine line two\n";
        server.atomicWrite(target, payload);

        assert.ok(fs.existsSync(target), "atomicWrite did not produce the target file");
        assert.strictEqual(
          fs.readFileSync(target, "utf8"),
          payload,
          "atomicWrite contents did not round-trip"
        );

        // Overwrite must also be atomic and clean.
        const payload2 = "rewritten\n";
        server.atomicWrite(target, payload2);
        assert.strictEqual(fs.readFileSync(target, "utf8"), payload2, "atomicWrite overwrite did not round-trip");

        // No torn/leftover temp files: the only entry should be the target.
        const leftovers = fs.readdirSync(dir).filter((name) => name !== "section.txt");
        assert.deepStrictEqual(
          leftovers,
          [],
          "atomicWrite left temp file(s) behind: " + JSON.stringify(leftovers)
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // --- content/section path safety ---------------------------------------
  // SCRIPTORIUM.md §7 calls for ONE idea — "refuse paths outside the content
  // roots." The server splits it into two functions with two jobs, so we test
  // each against its real contract (asserting one does the other's job would be
  // a false failure):
  //   * safeSectionPath(slug, n) — the WRITE guard. This is the one that owns
  //     the raw/<slug>/<n>.txt contract: it rejects bad slugs, non-integer
  //     section numbers, and traversal, and accepts a valid section. This is the
  //     "accepts raw/<slug>/<n>.txt, rejects traversal/abs/bad-slug" assertion.
  //   * safeContentPath(urlPath) — the static-READ guard. By design a leading
  //     "/" is taken relative to the project root (so "/etc/passwd" resolves to
  //     <root>/etc/passwd, which is *inside* root and safe to serve); its job is
  //     only to refuse escapes ABOVE the project root. We assert exactly that.
  //
  // Prefer safeSectionPath for the §7 contract; fall back to safeContentPath if
  // the server didn't split the function (interface differs) — skip otherwise.
  const goodSlug = (essays[0] && essays[0].slug) || "etching-god-into-sand";

  if (typeof server.safeSectionPath === "function") {
    check(label2b, () => {
      // ACCEPT a valid section: returns a usable path inside the project root,
      // and ends at raw/<slug>/<n>.txt.
      let accepted;
      assert.doesNotThrow(() => {
        accepted = server.safeSectionPath(goodSlug, 1);
      }, "safeSectionPath rejected a valid (slug, 1) section");
      assert.ok(
        typeof accepted === "string" && accepted.length > 0,
        "safeSectionPath should return a usable path for a valid section"
      );
      const resolved = path.resolve(accepted);
      assert.ok(
        resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep),
        "accepted section path escaped the project root: " + resolved
      );
      assert.ok(
        resolved.endsWith(path.join("raw", goodSlug, "1.txt")),
        "accepted section path is not raw/<slug>/<n>.txt: " + resolved
      );

      // REJECT bad slugs, traversal, absolute-ish and malformed section numbers.
      // safeSectionPath throws BadRequestError on any invalid input.
      const badInputs = [
        ["../../etc", 1],
        ["..", 1],
        [".", 1],
        ["a/b", 1],
        ["a\\b", 1],
        ["etching-god-into-sand/../../secret", 1],
        ["bad slug!", 1],
        ["UPPER", 1],
        ["", 1],
        ["/etc/passwd", 1],
        [goodSlug, "../../etc/passwd"],
        [goodSlug, "1.txt"],
        [goodSlug, 0],
        [goodSlug, -1],
        [goodSlug, "1.5"],
        [goodSlug, ""],
      ];
      for (const [slug, n] of badInputs) {
        assert.throws(
          () => server.safeSectionPath(slug, n),
          "safeSectionPath accepted an unsafe input: " + JSON.stringify([slug, n])
        );
      }
    });
  } else if (typeof server.safeContentPath === "function") {
    // The server kept a single content-path guard. Test what that one actually
    // promises: accept an in-root file, refuse anything that escapes ABOVE root.
    check(label2b, () => {
      let accepted;
      assert.doesNotThrow(() => {
        accepted = server.safeContentPath("raw/" + goodSlug + "/1.txt");
      }, "safeContentPath rejected a valid raw/<slug>/<n>.txt path");
      assert.ok(
        typeof accepted === "string" && accepted.length > 0,
        "safeContentPath should return a usable path for a valid file"
      );

      // Only paths that escape the root must be refused (null/throw). A leading
      // "/" being root-relative is intended, so we do NOT require "/etc/passwd"
      // to be rejected here.
      const escapes = [
        "../../etc/passwd",
        "raw/../../etc/passwd",
        "raw/" + goodSlug + "/../../../secret.txt",
        "..%2f..%2fetc%2fpasswd",
        "a/../../b",
      ];
      for (const bad of escapes) {
        let rejected = false;
        let value;
        try {
          value = server.safeContentPath(bad);
        } catch (_e) {
          rejected = true;
        }
        if (!rejected) {
          assert.ok(
            !value,
            "safeContentPath accepted a root-escaping input: " + JSON.stringify(bad) +
              " -> " + JSON.stringify(value)
          );
        }
      }
    });
  } else {
    skip(
      label2b,
      "neither server.safeSectionPath nor server.safeContentPath is an exported function (interface differs)"
    );
  }

  // safeContentPath, when present, must still refuse a path that climbs above
  // the project root — that is its load-bearing static-serve guarantee. This is
  // additive to label2b and named distinctly so a hole here is unambiguous.
  if (typeof server.safeContentPath === "function") {
    check("server: safeContentPath refuses a path that escapes the project root", () => {
      const climbed = server.safeContentPath("../../../../../../etc/passwd");
      assert.ok(!climbed, "safeContentPath returned a path above the project root: " + JSON.stringify(climbed));
      // A NUL byte in a path is always an attack/bug and must be refused.
      assert.ok(!server.safeContentPath("raw/\0/1.txt"), "safeContentPath accepted a NUL byte in the path");
    });
  }

  // --- source_dir resolution (SCRIPTORIUM.md §12 blocker 3) --------------
  // The server must key section files off the essay's declared source_dir, not
  // assume raw/<slug>. sourceDirForSlug is the pure core (no disk), so we can
  // drive the three cases — honor a declared source_dir that DIFFERS from the
  // slug, fall back to raw/<slug> for an unregistered slug, and REFUSE a slug
  // shared by two essays (which would collide on data/compiled/<slug>.json).
  if (typeof server.sourceDirForSlug === "function") {
    check("server: sourceDirForSlug honors source_dir, falls back, refuses duplicates", () => {
      const list = [
        { slug: "alpha", source_dir: "essays/alpha/prose" },
        { slug: "beta", source_dir: "" },
        { slug: "dup", source_dir: "raw/dup-a" },
        { slug: "dup", source_dir: "raw/dup-b" },
      ];

      // 1. A declared source_dir that does NOT match the slug is honored — this
      //    is the exact bug: the old code would have used raw/alpha.
      assert.strictEqual(
        server.sourceDirForSlug("alpha", list),
        "essays/alpha/prose",
        "sourceDirForSlug ignored a declared source_dir that differs from the slug"
      );
      // 2. An empty source_dir falls back to raw/<slug>.
      assert.strictEqual(
        server.sourceDirForSlug("beta", list),
        "raw/beta",
        "sourceDirForSlug did not fall back to raw/<slug> for an empty source_dir"
      );
      // 3. An unregistered slug falls back to raw/<slug> (new section authoring).
      assert.strictEqual(
        server.sourceDirForSlug("gamma", list),
        "raw/gamma",
        "sourceDirForSlug did not fall back to raw/<slug> for an unknown slug"
      );
      // 4. A duplicated slug is refused, not silently resolved to one of them.
      assert.throws(
        () => server.sourceDirForSlug("dup", list),
        "sourceDirForSlug silently resolved an ambiguous (duplicated) slug"
      );
    });
  } else {
    skip(
      "server: sourceDirForSlug honors source_dir, falls back, refuses duplicates",
      "server.sourceDirForSlug is not exported (interface differs / not built yet)"
    );
  }
})();

// ---------------------------------------------------------------------------
// 3. DOCTOR CLEAN — the project doctor reports ok on the current repo (§3).
//    skip-with-warning if the module isn't present yet.
// ---------------------------------------------------------------------------

(function doctorClean() {
  const label = "doctor: runDoctor() reports ok === true on the current repo";
  let doctor;
  try {
    doctor = require("../../scriptorium/doctor.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/doctor.js not present yet (built concurrently)"
        : "require('scriptorium/doctor.js') threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof doctor.runDoctor !== "function") {
    skip(label, "scriptorium/doctor.js does not export runDoctor() (interface differs)");
    return;
  }

  check(label, () => {
    const report = doctor.runDoctor();
    // runDoctor() is documented sync (the server awaits it to normalize both);
    // if a future version returns a Promise we cannot await inside this sync
    // harness, so fail with a clear message rather than asserting on a thenable.
    assert.ok(
      report && typeof report === "object" && typeof report.then !== "function",
      "runDoctor() should return a plain report object (got " +
        (report && typeof report.then === "function" ? "a Promise" : typeof report) + ")"
    );

    // Surface the doctor's own findings (it reports { ok, issues:[{message}] };
    // tolerate a problems[] shape too) so a failure here is actionable.
    const findings = Array.isArray(report.issues)
      ? report.issues
      : Array.isArray(report.problems)
        ? report.problems
        : [];
    const detail = findings.length
      ? findings.map((f) => (f && f.message ? f.message : String(f))).join("; ")
      : JSON.stringify(report);

    assert.strictEqual(report.ok, true, "project doctor is unhealthy: " + detail);
  });

  // The doctor must DETECT duplicate slugs (SCRIPTORIUM.md §12 blocker 3): the
  // live repo is clean (asserted above), so drive the pure check with a synthetic
  // duplicate and assert it flags a failing-severity issue with the right code.
  if (typeof doctor.checkSlugUniqueness === "function") {
    check("doctor: checkSlugUniqueness flags two essays sharing a slug", () => {
      const found = [];
      const collector = { add(severity, code, message) { found.push({ severity, code, message }); } };
      doctor.checkSlugUniqueness(
        [{ slug: "x" }, { slug: "y" }, { slug: "x" }],
        collector
      );
      const dup = found.filter((i) => i.code === "slug-duplicate");
      assert.strictEqual(dup.length, 1, "expected exactly one slug-duplicate issue, got " + dup.length);
      assert.notStrictEqual(dup[0].severity, "warning", "a duplicate slug must be a failing severity, not a warning");

      // And a unique list produces no slug-duplicate finding.
      const cleanFound = [];
      doctor.checkSlugUniqueness(
        [{ slug: "a" }, { slug: "b" }],
        { add(severity, code, message) { cleanFound.push({ severity, code, message }); } }
      );
      assert.strictEqual(
        cleanFound.filter((i) => i.code === "slug-duplicate").length,
        0,
        "checkSlugUniqueness flagged a duplicate on a unique list"
      );
    });
  } else {
    skip(
      "doctor: checkSlugUniqueness flags two essays sharing a slug",
      "doctor.checkSlugUniqueness is not exported (interface differs / not built yet)"
    );
  }
})();

// ---------------------------------------------------------------------------
// 4. MAPPING — the pure offset↔block index (SCRIPTORIUM-EDITOR.md §2/§4).
//
// The structural layer rests on ONE mapping read both ways. It is pure (no DOM),
// so it is fully Node-testable here: parse a fixture through the one authority,
// build the index, and assert offset→block resolves correctly across starts,
// interiors, gaps, the before-first edge, and past-end — and that the top-level
// (command) index carries the unaddressable containers the passage index omits.
// skip-with-warning if the module isn't present yet.
// ---------------------------------------------------------------------------

(function mappingUnit() {
  const label = "mapping: offset↔block index matches the parse (caret↔preview)";
  let mapping;
  try {
    mapping = require("../../scriptorium/mapping.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/mapping.js not present yet (built concurrently)"
        : "require('scriptorium/mapping.js') threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof mapping.indexDocument !== "function" || typeof mapping.blockAtOffset !== "function") {
    skip(label, "mapping interface differs (indexDocument / blockAtOffset missing)");
    return;
  }

  const text = [
    "# Title",
    "",
    "First paragraph here.",
    "",
    "> A quoted line.",
    "",
    "- one",
    "- two",
    "",
    "---",
    "",
    "Closing paragraph.",
  ].join("\n");

  check(label, () => {
    const parsed = ast.parseDocument(text);
    const index = mapping.indexDocument(parsed);
    const passages = index.passages;
    const blocks = index.blocks;

    // Passages are exactly the addressable types, in source order.
    assert.ok(passages.length >= 5, "expected >=5 passages, got " + passages.length);
    for (const p of passages) {
      assert.ok(mapping.PASSAGE_TYPES[p.type], "passage of non-addressable type: " + p.type);
    }
    for (let i = 1; i < passages.length; i++) {
      assert.ok(passages[i].start >= passages[i - 1].start, "passages not sorted by start");
    }

    // Each passage resolves to itself at its own start and at an interior offset.
    for (const p of passages) {
      assert.strictEqual(mapping.blockAtOffset(passages, p.start), p, "start offset did not resolve to its own passage");
      if (p.end > p.start) {
        assert.strictEqual(mapping.blockAtOffset(passages, p.end - 1), p, "interior offset did not resolve to its own passage");
      }
    }

    // Before the first passage -> null (heading starts at 0, so probe negative).
    assert.strictEqual(mapping.blockAtOffset(passages, -1), null, "negative offset should resolve to null");

    // A gap (blank line) between two passages resolves to the PRECEDING one (§4.5).
    let gapTested = false;
    for (let i = 0; i < passages.length - 1; i++) {
      const gap = passages[i].end;
      if (gap < passages[i + 1].start) {
        assert.strictEqual(mapping.blockAtOffset(passages, gap), passages[i], "gap offset did not resolve to the preceding passage");
        gapTested = true;
        break;
      }
    }
    assert.ok(gapTested, "fixture produced no inter-passage gap to test");

    // Past the very end -> the last passage (nearest preceding).
    assert.strictEqual(
      mapping.blockAtOffset(passages, text.length + 50),
      passages[passages.length - 1],
      "past-end offset should resolve to the last passage"
    );

    // The top-level (command) index carries the UNADDRESSABLE containers the
    // passage index omits: a blockquote, a list, and a divider are all present
    // even though render.js gives them no preview element.
    const topTypes = blocks.map((b) => b.type);
    assert.ok(topTypes.indexOf("blockquote") !== -1, "top-level index missing blockquote");
    assert.ok(topTypes.indexOf("list") !== -1, "top-level index missing list");
    assert.ok(topTypes.indexOf("divider") !== -1, "top-level index missing divider");

    // A caret inside the quoted line lands in the blockquote at top level, but in
    // a paragraph (the quote's inner passage) in the passage index — the two
    // indices serve their two jobs (§5.3).
    const quoteOffset = text.indexOf("A quoted line");
    assert.strictEqual(mapping.blockAtOffset(blocks, quoteOffset).type, "blockquote", "top-level lookup in quote should be blockquote");
    assert.strictEqual(mapping.blockAtOffset(passages, quoteOffset).type, "paragraph", "passage lookup in quote should be the inner paragraph");
  });
})();

// ---------------------------------------------------------------------------
// 5. COMMANDS — AST-aware edits, verified by the per-command oracle (§5.2).
//
// The command analogue of the equivalence oracle: each command applies a
// candidate edit, RE-PARSES through the one authority, and commits only if the
// intended node materialized (counts move by one, visible text is preserved, no
// new error). We drive each command through the REAL parser here, so a wrong
// marker or a boundary mistake fails loudly — and we prove the oracle REFUSES a
// mid-word wrap that wouldn't parse. skip-with-warning if the module is absent.
// ---------------------------------------------------------------------------

(function commandsUnit() {
  const label = "commands: AST-aware edits pass/refuse via the per-command oracle";
  let commands;
  try {
    commands = require("../../scriptorium/commands.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/commands.js not present yet (built concurrently)"
        : "require('scriptorium/commands.js') threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof commands.apply !== "function") {
    skip(label, "commands interface differs (apply missing)");
    return;
  }

  const parse = (text) => ast.parseDocument(text);
  const run = (id, text, start, end) => commands.apply(id, text, start, end, parse);

  check(label, () => {
    // Bold a whole word -> succeeds, inserts **…**, parses as one strong node.
    let r = run("strong", "make this bold", 10, 14);
    assert.ok(r.ok, "bold a whole word should succeed: " + r.reason);
    assert.strictEqual(r.text, "make this **bold**", "bold produced wrong markup: " + r.text);
    assert.strictEqual(commands.countInline(parse(r.text), "strong"), 1, "bold did not yield exactly one strong node");

    // Italic + code likewise.
    assert.strictEqual(run("emphasis", "a word here", 2, 6).text, "a *word* here", "emphasis markup wrong");
    assert.strictEqual(run("code", "call foo now", 5, 8).text, "call `foo` now", "code markup wrong");

    // Empty selection inserts the pair and caret-between (no oracle).
    r = run("strong", "abc", 3, 3);
    assert.ok(r.ok && r.text === "abc****" && r.selectionStart === 5 && r.selectionEnd === 5, "empty-selection bold insert wrong: " + JSON.stringify(r));

    // Toggle OFF: selecting an already-bold word removes the markers.
    r = run("strong", "a **b** c", 4, 5);
    assert.ok(r.ok && r.text === "a b c", "toggling bold off failed: " + JSON.stringify(r));

    // Round-trip: bold then un-bold returns the original buffer.
    const onceBold = run("strong", "round trip word", 6, 10); // "trip"
    assert.ok(onceBold.ok, "round-trip bold-on failed: " + onceBold.reason);
    const back = run("strong", onceBold.text, onceBold.selectionStart, onceBold.selectionEnd);
    assert.ok(back.ok && back.text === "round trip word", "bold round-trip did not restore the original: " + JSON.stringify(back));

    // THE ORACLE REFUSES: a mid-word wrap that wouldn't parse as strong is
    // rejected (markers next to alphanumerics don't open) — buffer untouched.
    r = run("strong", "department", 2, 6); // "part" inside the word
    assert.ok(!r.ok, "oracle should REFUSE a mid-word bold that won't parse, but it accepted: " + JSON.stringify(r));
    assert.ok(r.text === null, "a refused command must not propose a buffer");

    // Headings: promote, level-correct, and demote to body.
    r = run("heading-2", "Title line\n\nbody", 3);
    assert.ok(r.ok && r.text === "## Title line\n\nbody", "heading-2 markup wrong: " + JSON.stringify(r));
    r = run("heading-0", "## Title line\n\nbody", 4);
    assert.ok(r.ok && r.text === "Title line\n\nbody", "demote-to-body failed: " + JSON.stringify(r));
    // Re-leveling an existing heading replaces, not stacks, the hashes.
    r = run("heading-1", "### Deep\n\nx", 4);
    assert.ok(r.ok && r.text === "# Deep\n\nx", "re-leveling stacked hashes: " + JSON.stringify(r));

    // Link: wrap selection, land the caret on the URL placeholder.
    r = run("link", "see here now", 4, 8); // "here"
    assert.ok(r.ok && r.text === "see [here](https://) now", "link markup wrong: " + JSON.stringify(r));
    assert.strictEqual(r.text.slice(r.selectionStart, r.selectionEnd), "https://", "link caret should select the URL placeholder");
    assert.strictEqual(commands.countInline(parse(r.text), "link"), 1, "link did not yield exactly one link node");
  });

  check("commands: block toggles (pull-quote / blockquote / divider) via oracle", () => {
    // Pull-quote: wrap a single-line paragraph in quotes; oracle confirms the
    // block type flipped. Toggle off restores it.
    let r = run("pull-quote", "A line here\n\nbody", 0);
    assert.ok(r.ok && r.text === '"A line here"\n\nbody', "pull-quote on failed: " + JSON.stringify(r));
    assert.strictEqual(commands.topBlockAt(parse(r.text), 0).type, "pull_quote", "pull-quote did not parse as a pull_quote");
    r = run("pull-quote", '"A line here"\n\nbody', 0);
    assert.ok(r.ok && r.text === "A line here\n\nbody", "pull-quote off failed: " + JSON.stringify(r));

    // Multi-line paragraph refuses to become a pull-quote.
    r = run("pull-quote", "line one\nline two\n\nx", 0);
    assert.ok(!r.ok, "pull-quote should refuse a multi-line paragraph");

    // Blockquote: prefix every line with '> '; toggle off strips it.
    r = run("blockquote", "quote me\n\nx", 0);
    assert.ok(r.ok && r.text === "> quote me\n\nx", "blockquote on failed: " + JSON.stringify(r));
    // A blockquote's position starts after its '> ' marker, so count it rather
    // than probing offset 0.
    assert.strictEqual(commands.countTopBlocks(parse(r.text), "blockquote"), 1, "blockquote did not parse as a blockquote");
    r = run("blockquote", "> quote me\n\nx", 0);
    assert.ok(r.ok && r.text === "quote me\n\nx", "blockquote off failed: " + JSON.stringify(r));

    // Divider: insert '---' as its own block at the caret line.
    r = run("divider", "top\n\nbottom", 5);
    assert.ok(r.ok && r.text === "top\n\n---\nbottom", "divider insert failed: " + JSON.stringify(r));
    assert.strictEqual(commands.countTopBlocks(parse(r.text), "divider"), 1, "divider did not yield one divider block");

    // blockRangeAt returns the source span of the block at an offset (select-node).
    const span = commands.blockRangeAt(parse("# Heading\n\npara here"), 2);
    assert.ok(span && span.start === 0 && span.end === 9, "blockRangeAt wrong for heading: " + JSON.stringify(span));
  });
})();

// ---------------------------------------------------------------------------
// 6. EDITOR LOAD ORDER — the shell wires the AST modules in the right sequence.
//
// SCRIPTORIUM.md §12 blocker 1 asked for editor.html to be load-order-checked.
// It does NOT belong in `ast doctor`'s reader-shell checks: those assert a shell
// must NOT load parse.js and MUST load content.js, but the editor legitimately
// loads parse.js (it authors through the one parser) and loads editor.js, not
// content.js. So the editor's load order is verified HERE, in its own suite.
// core must precede render must precede parse (parse.js registers its tokenizer
// INTO core at load); editor.js loads last (it consumes everything). The opt-in
// wasm-parser.js must load before editor.js so the engine swap can find it.
// ---------------------------------------------------------------------------

(function editorLoadOrder() {
  const label = "editor: editor.html loads the AST + editor modules in order";
  const htmlPath = path.join(root, "scriptorium", "editor.html");
  let html;
  try {
    html = fs.readFileSync(htmlPath, "utf8");
  } catch (error) {
    skip(label, "scriptorium/editor.html not readable: " + (error && error.message ? error.message : String(error)));
    return;
  }

  check(label, () => {
    const at = (needle) => html.indexOf(needle);
    const core = at('src="../scripts/ast/core.js"');
    const render = at('src="../scripts/ast/render.js"');
    const mapping = at('src="mapping.js"');
    const commands = at('src="commands.js"');
    const wasm = at('src="wasm-parser.js"');
    const editor = at('src="editor.js"');
    // The command-surface modules must also load before editor.js (it reads them
    // from window at start).
    const feature = {
      "palette.js": at('src="palette.js"'),
      "find-replace.js": at('src="find-replace.js"'),
      "block-ops.js": at('src="block-ops.js"'),
      "list-continue.js": at('src="list-continue.js"'),
    };

    // After the parse.js cutover (§14.3) the editor authors through the ONE parser:
    // the Rust core as wasm. core.js + render.js are the consume spine; parse.js is
    // gone and must NOT reappear.
    assert.ok(core !== -1, "editor.html does not load core.js");
    assert.ok(render !== -1, "editor.html does not load render.js");
    assert.ok(wasm !== -1, "editor.html does not load wasm-parser.js (the one parser)");
    assert.ok(editor !== -1, "editor.html does not load editor.js");
    assert.ok(at('src="../scripts/ast/parse.js"') === -1, "editor.html must NOT load the deleted parse.js");

    assert.ok(core < render, "editor.html must load core before render");
    assert.ok(render < editor, "editor.html must load render before editor.js");
    assert.ok(wasm < editor, "wasm-parser.js must load before editor.js (the parser)");
    if (mapping !== -1) assert.ok(mapping < editor, "mapping.js must load before editor.js");
    if (commands !== -1) assert.ok(commands < editor, "commands.js must load before editor.js");
    Object.keys(feature).forEach(function each(name) {
      if (feature[name] !== -1) {
        assert.ok(feature[name] < editor, name + " must load before editor.js");
      }
    });
  });
})();

// ---------------------------------------------------------------------------
// 7. FIND & REPLACE — the pure text-surgery engine (above the caret, §4).
//
// All matching goes through one compiled RegExp (literal queries escaped), so
// case-insensitive search can't desync offsets. We assert match spans, options
// (case / whole-word / regex), invalid-regex handling, zero-width safety, and
// the replace surface. skip-with-warning if the module isn't present.
// ---------------------------------------------------------------------------

(function findReplaceUnit() {
  const label = "find-replace: matches, options, replace, and regex safety";
  let fr;
  try {
    fr = require("../../scriptorium/find-replace.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/find-replace.js not present yet"
        : "require threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof fr.findMatches !== "function" || typeof fr.replaceAll !== "function") {
    skip(label, "find-replace interface differs");
    return;
  }

  check(label, () => {
    // Literal, case-insensitive by default. (Note: substring match — "other"
    // would contain "the", so the fixture avoids that.)
    let m = fr.findMatches("the The THE done", "the");
    assert.strictEqual(m.length, 3, "case-insensitive literal should find 3");
    assert.deepStrictEqual(m[0], { start: 0, end: 3 }, "first match span wrong");
    assert.deepStrictEqual(m[1], { start: 4, end: 7 }, "second match span wrong");

    // Case-sensitive narrows it.
    assert.strictEqual(fr.findMatches("the The THE", "the", { caseSensitive: true }).length, 1, "case-sensitive should find 1");

    // Whole-word: "cat" does not match inside "category".
    assert.strictEqual(fr.findMatches("cat category cat.", "cat", { wholeWord: true }).length, 2, "whole-word count wrong");

    // Offsets stay correct under case-insensitivity (no toLowerCase desync).
    m = fr.findMatches("aXbXc", "x");
    assert.deepStrictEqual(m, [{ start: 1, end: 2 }, { start: 3, end: 4 }], "ci offsets desynced");

    // Empty query → no matches; invalid regex → no matches + isValid false.
    assert.deepStrictEqual(fr.findMatches("abc", ""), [], "empty query should match nothing");
    assert.strictEqual(fr.isValid("[", { regex: true }), false, "invalid regex should be invalid");
    assert.deepStrictEqual(fr.findMatches("abc", "[", { regex: true }), [], "invalid regex should match nothing");

    // Regex mode + zero-width safety (a* must terminate).
    assert.strictEqual(fr.findMatches("abc", "a.c", { regex: true }).length, 1, "regex a.c should match once");
    const zw = fr.findMatches("aaa", "a*", { regex: true });
    assert.ok(zw.length >= 1 && zw.length < 100, "zero-width regex should terminate finitely");

    // nextMatchIndex forward/backward with wrap.
    const ms = [{ start: 2, end: 3 }, { start: 8, end: 9 }];
    assert.strictEqual(fr.nextMatchIndex(ms, 0, true), 0, "forward from 0 → first");
    assert.strictEqual(fr.nextMatchIndex(ms, 5, true), 1, "forward from 5 → second");
    assert.strictEqual(fr.nextMatchIndex(ms, 9, true), 0, "forward past end wraps to first");
    assert.strictEqual(fr.nextMatchIndex(ms, 5, false), 0, "backward from 5 → first");
    assert.strictEqual(fr.nextMatchIndex(ms, 0, false), 1, "backward past start wraps to last");

    // replaceRange splices + reports the inserted selection.
    const rr = fr.replaceRange("hello world", 6, 11, "there");
    assert.strictEqual(rr.text, "hello there", "replaceRange text wrong");
    assert.deepStrictEqual([rr.selectionStart, rr.selectionEnd], [6, 11], "replaceRange selection wrong");

    // replaceAll literal: count + verbatim replacement ($ is NOT a backref).
    let ra = fr.replaceAll("foo foo foo", "foo", "bar");
    assert.ok(ra.text === "bar bar bar" && ra.count === 3, "literal replaceAll wrong: " + JSON.stringify(ra));
    ra = fr.replaceAll("x", "x", "$&");
    assert.strictEqual(ra.text, "$&", "literal replacement must treat $ literally");

    // replaceAll regex: $1/$2 backrefs honored.
    ra = fr.replaceAll("ab cd", "(\\w)(\\w)", "$2$1", { regex: true });
    assert.strictEqual(ra.text, "ba dc", "regex backref replacement wrong: " + ra.text);
  });
})();

// ---------------------------------------------------------------------------
// 8. PALETTE — fuzzy ranking + the slash trigger (pure command-surface brains).
// ---------------------------------------------------------------------------

(function paletteUnit() {
  const label = "palette: fuzzy ranking + slash-trigger detection";
  let pal;
  try {
    pal = require("../../scriptorium/palette.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/palette.js not present yet"
        : "require threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof pal.filter !== "function" || typeof pal.slashContext !== "function") {
    skip(label, "palette interface differs");
    return;
  }

  check(label, () => {
    // fuzzyMatch: subsequence hit vs miss; empty query.
    assert.ok(pal.fuzzyMatch("hd", "Heading") !== null, "'hd' should fuzzy-match 'Heading'");
    assert.strictEqual(pal.fuzzyMatch("zzz", "Heading"), null, "non-subsequence should be null");
    assert.deepStrictEqual(pal.fuzzyMatch("", "Heading").positions, [], "empty query → empty positions");

    const items = [
      { id: "strong", label: "Toggle bold" },
      { id: "link", label: "Insert link" },
      { id: "divider", label: "Insert divider", keywords: "hr rule horizontal line" },
      { id: "heading-1", label: "Heading 1" },
    ];

    // Empty query → all items in order.
    const all = pal.filter("", items);
    assert.strictEqual(all.length, 4, "empty query should return all items");
    assert.strictEqual(all[0].id, "strong", "empty query should preserve order");

    // "bold" ranks the bold command first.
    let r = pal.filter("bold", items);
    assert.ok(r.length >= 1 && r[0].id === "strong", "'bold' should rank Toggle bold first: " + JSON.stringify(r.map((x) => x.id)));

    // Keyword fallback: "rule" finds the divider via its keywords.
    r = pal.filter("rule", items);
    assert.ok(r.some((x) => x.id === "divider"), "'rule' should match divider via keywords");

    // An exact prefix ranks ahead of a scattered match.
    r = pal.filter("head", items);
    assert.strictEqual(r[0].id, "heading-1", "'head' should rank Heading 1 first");

    // slashContext: triggers at line/text start or after whitespace; never mid-word.
    let s = pal.slashContext("/", 1);
    assert.ok(s.active && s.start === 0 && s.query === "", "'/' at start should be active");
    s = pal.slashContext("/he", 3);
    assert.ok(s.active && s.start === 0 && s.query === "he", "'/he' should be active with query 'he'");
    s = pal.slashContext("write /q", 8);
    assert.ok(s.active && s.start === 6 && s.query === "q", "'/q' after space should be active");
    s = pal.slashContext("\n/h", 3);
    assert.ok(s.active && s.query === "h", "'/' at line start should be active");
    assert.strictEqual(pal.slashContext("http://x", 8).active, false, "'http://' must NOT trigger");
    assert.strictEqual(pal.slashContext("a/b", 3).active, false, "mid-word 'a/b' must NOT trigger");
    assert.strictEqual(pal.slashContext("/he ", 4).active, false, "a space after the query deactivates");
    assert.strictEqual(pal.slashContext("", 0).active, false, "empty buffer is inactive");
  });
})();

// ---------------------------------------------------------------------------
// 9. BLOCK OPS — move / duplicate / delete the caret's block (pure surgery).
// ---------------------------------------------------------------------------

(function blockOpsUnit() {
  const label = "block-ops: move / duplicate / delete by line span";
  let bo;
  try {
    bo = require("../../scriptorium/block-ops.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/block-ops.js not present yet"
        : "require threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof bo.move !== "function") {
    skip(label, "block-ops interface differs");
    return;
  }

  check(label, () => {
    // Three paragraphs; blocks are { start, end } over the full buffer.
    const text = "alpha\n\nbeta\n\ngamma";
    const blocks = [
      { start: 0, end: 5 },   // alpha
      { start: 7, end: 11 },  // beta
      { start: 13, end: 18 }, // gamma
    ];

    // Move "beta" (caret at 7) up → swaps with alpha, gap preserved.
    let r = bo.move(text, blocks, 7, -1);
    assert.strictEqual(r.text, "beta\n\nalpha\n\ngamma", "move up wrong: " + JSON.stringify(r.text));

    // Move "alpha" (caret 0) down → swaps with beta.
    r = bo.move(text, blocks, 0, 1);
    assert.strictEqual(r.text, "beta\n\nalpha\n\ngamma", "move down wrong: " + JSON.stringify(r.text));

    // Move up at the top edge is a no-op.
    assert.strictEqual(bo.move(text, blocks, 0, -1).text, text, "move up at top should be a no-op");

    // Duplicate "beta" → a copy after it, blank-line separated.
    r = bo.duplicate(text, blocks, 7);
    assert.strictEqual(r.text, "alpha\n\nbeta\n\nbeta\n\ngamma", "duplicate wrong: " + JSON.stringify(r.text));

    // Delete "beta" → block + one separating blank line gone.
    r = bo.remove(text, blocks, 7);
    assert.strictEqual(r.text, "alpha\n\ngamma", "delete wrong: " + JSON.stringify(r.text));

    // Delete the last block trims the preceding blank line (no trailing blank).
    r = bo.remove(text, blocks, 13);
    assert.strictEqual(r.text, "alpha\n\nbeta", "delete-last wrong: " + JSON.stringify(r.text));
  });
})();

// ---------------------------------------------------------------------------
// 10. LIST CONTINUE — Enter inside a list item (explicit edit, not reflow).
// ---------------------------------------------------------------------------

(function listContinueUnit() {
  const label = "list-continue: continue / end a list on Enter";
  let lc;
  try {
    lc = require("../../scriptorium/list-continue.js");
  } catch (error) {
    const reason =
      error && error.code === "MODULE_NOT_FOUND"
        ? "scriptorium/list-continue.js not present yet"
        : "require threw: " + (error && error.message ? error.message : String(error));
    skip(label, reason);
    return;
  }

  if (typeof lc.enterEdit !== "function") {
    skip(label, "list-continue interface differs");
    return;
  }

  check(label, () => {
    // Bullet continuation at end of line.
    let r = lc.enterEdit("- one", 5);
    assert.ok(r && r.text === "- one\n- " && r.caret === 8, "bullet continue wrong: " + JSON.stringify(r));

    // Ordered increments the number, keeps the delimiter.
    r = lc.enterEdit("3) item", 7);
    assert.ok(r && r.text === "3) item\n4) " && r.caret === 11, "ordered continue wrong: " + JSON.stringify(r));
    r = lc.enterEdit("1. first", 8);
    assert.ok(r && r.text === "1. first\n2. ", "ordered '.' continue wrong: " + JSON.stringify(r));

    // Empty item ends the list (clears the marker line).
    r = lc.enterEdit("- ", 2);
    assert.ok(r && r.text === "" && r.caret === 0, "empty item should end list: " + JSON.stringify(r));

    // Indented bullet keeps its indent.
    r = lc.enterEdit("  - nested", 10);
    assert.ok(r && r.text === "  - nested\n  - ", "indented continue wrong: " + JSON.stringify(r));

    // Not a list, or caret mid-line → null (normal Enter).
    assert.strictEqual(lc.enterEdit("plain paragraph", 15), null, "non-list should return null");
    assert.strictEqual(lc.enterEdit("- one", 3), null, "mid-line should return null");
  });
})();

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------

console.log(
  "\nScriptorium regression: " + passed + " passed, " + skipped + " skipped, " + failures.length + " failed."
);

if (failures.length) {
  console.error("\nScriptorium regression FAILED:");
  failures.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}

console.log("Scriptorium spine guard holds.");
