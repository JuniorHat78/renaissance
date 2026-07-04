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
- `SCRIPTORIUM-NATIVE-SKELETON.md`: **N0 (built + CI-validated)** — the platform/render
  walking skeleton: window + DirectWrite text + caret + keyboard + in-process reparse.
  De-risked the COM-from-raw-Rust FFI (verdict: tolerable).
- `SCRIPTORIUM-NATIVE-BUFFER.md`: **N1 (built + CI-validated)** — the text buffer: a
  **persistent, augmented, chunked rope** (resolving the rope-vs-piece-tree fork toward
  the rope) with insert/delete at any offset, O(1) structural-sharing undo, a code-point
  caret, Ln/Col from the line summary, and parse-on-edit. Proven by a model-based fuzz
  oracle (50k iters) on every platform.
- `SCRIPTORIUM-NATIVE-INPUT.md`: **N2a (built + CI-validated)** — input correctness: a
  real selection (anchor/caret, shift-extend, select-all), grapheme-cluster + word motion
  (a pragmatic UAX #29 subset, oracle'd on every platform), selection-aware edits, a
  hand-rolled CF_UNICODETEXT clipboard, and selection rendering via `HitTestTextRange`.
  IME (`WM_IME_*`) and our-own UAX #14 line breaking are the named N2b follow-ups.
- `SCRIPTORIUM-NATIVE-LAYOUT.md`: **N3 (built + CI-validated)** — layout/render maturity,
  making the editor **spatial** off the *same* retained `IDWriteTextLayout` the renderer
  paints (geometry authority, cache-keyed on `(content_gen, width)`): sticky-goal-column
  Up/Down/PageUp/Down, wheel + `WS_VSCROLL` scrolling with scroll-follows-caret, and mouse
  click-to-place / drag-select / double-word / triple-line / drag-past-edge autoscroll. 28
  geometry oracles + windowed smoke on real DirectWrite, ASan-clean. N4 (concurrency/latency)
  is next after N2b.

**Search, recovery, UX:**
- `ORACLE-SEARCH-SPEC.md`: target AST-native search/index/ranking system for
  Spotlight and existing search surfaces.
- `SEARCH-RANKING-SPEC.md`: deterministic search modes, scoring, and growth
  thresholds for the current legacy search model.
- `SPOTLIGHT-UX-SPEC.md`: target hidden-index UI/interaction contract.
- `404-MAGIC-SPEC.md`: browser and app-shell recovery behavior.
- `HARDENING-GAUNTLETS-SPEC.md`: post-main hardening passes, artifact review,
  and focused Actions suites.
