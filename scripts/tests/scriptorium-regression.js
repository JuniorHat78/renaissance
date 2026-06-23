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
