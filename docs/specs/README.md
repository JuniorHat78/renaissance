# Feature Specs

These files describe specific feature contracts. They support the active
roadmap, but they are not the roadmap itself. For overall orientation read
`docs/PROJECT-STATE.md` first.

**The AST compiler & the parser:**
- `AST-COMPILER.md`: the AST compiler design of record (equivalence oracle,
  net-off, module layout, phase log).
- `AST-DIALECT.md`: supported prose syntax and AST compatibility boundaries.
- `AST-ANCHORS-SPEC.md`: stable passage anchors for search, copy links, and
  reader arrival.

**Scriptorium (the authoring tool) & the Rust core:**
- `SCRIPTORIUM.md`: the local authoring tool design of record (spine invariant,
  drift doctor, caret boundary, quarantine, server, phase plan).
- `SCRIPTORIUM-EDITOR.md`: the structural editor layer (two-way source↔preview
  sync, offset↔block mapping, AST-aware commands + oracle).
- `SCRIPTORIUM-RUST-PARSER.md`: the crate-free Rust core. **Parser cutover
  complete** — `rust/` is the one parser (native + wasm); the native-app shell
  sections are being superseded by the native-editor umbrella spec.
- `SCRIPTORIUM-WASM-MARSHALLING.md`: **closed** — the JS⇄wasm boundary was
  measured and is not the bottleneck (`npm run bench:marshalling` kept as a guard).
- `SCRIPTORIUM-NATIVE-EDITOR.md`: **the active frontier** — umbrella vision +
  architecture for a true zero-dep native Windows editor (hand-rolled Win32 +
  DirectWrite FFI, own the text engine, reuse `rust/` in-process). North star +
  living roadmap + decisions ledger; per-component specs spawn from it.
- `SCRIPTORIUM-NATIVE-SKELETON.md`: **N0** — the platform/render walking skeleton
  (the first build target): window + DirectWrite text + caret + keyboard + in-process
  reparse. De-risks the COM-from-raw-Rust FFI.

**Search, recovery, UX:**
- `ORACLE-SEARCH-SPEC.md`: target AST-native search/index/ranking system for
  Spotlight and existing search surfaces.
- `SEARCH-RANKING-SPEC.md`: deterministic search modes, scoring, and growth
  thresholds for the current legacy search model.
- `SPOTLIGHT-UX-SPEC.md`: target hidden-index UI/interaction contract.
- `404-MAGIC-SPEC.md`: browser and app-shell recovery behavior.
- `HARDENING-GAUNTLETS-SPEC.md`: post-main hardening passes, artifact review,
  and focused Actions suites.
