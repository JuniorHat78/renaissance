# Scriptorium — the crate-free Rust core

> The design of record for porting Scriptorium's runtime from Node to a single
> **statically-linked, zero-crate Rust binary**, with the parser written once in
> Rust and run *everywhere* — natively in the binary and, compiled to WebAssembly,
> in the browser editor in place of `scripts/ast/parse.js`. The parser is held
> honest by the **equivalence oracle**: it must be **byte-identical** to the JS
> parse authority across a corpus, in CI, fail-closed — the only thing that lets a
> second implementation exist without violating the spine.
>
> This is the answer to "an *actual* zero-dependency desktop app, not just a PWA"
> (`docs/specs/SCRIPTORIUM.md` §8 P3's PWA capstone, taken to the metal). The
> shell is a separate axis from the parser (§8): the PWA is the *interim* shell,
> and the **destination is a true native app — Windows-first, hand-rolled Win32 +
> RichEdit, zero crate** — where the OS text control owns the caret, so going
> native *honors* the §4 boundary rather than breaching it. Read `SCRIPTORIUM.md`
> first; this assumes its spine invariant (§2), caret boundary (§4), and
> quarantine (§6) as settled law.
>
> Status: **spec / not started.** Doc-driven — written first, built against, and
> retired into the parent specs when it ships (the AST-compiler convention).
>
> Last refreshed: 2026-06-24.

---

## 1. What this is — and the one dependency it actually kills

Scriptorium is already "zero-dependency" in the npm sense and ships as an
installable PWA. But it has one real runtime dependency that the PWA did not
remove: **Node**. You must install a JavaScript runtime to run `server.js` — the
process that reads and writes `raw/<slug>/<n>.txt` and `data/essays.json`. That
is the dependency worth killing, and the browser is *not* it: every machine
already has a browser, and the editor already runs entirely inside it.

This spec replaces Node with **one statically-linked Rust binary, built with
zero third-party crates**:

- the binary is the local server (§7 of the parent) — `std::net::TcpListener`,
  a hand-rolled HTTP/1.1 loop for `localhost`, `std::fs` atomic writes;
- the binary also opens the editor in the OS browser (the existing `--open`
  behaviour, via `std::process::Command`);
- the **same Rust parser source** compiles to `wasm32-unknown-unknown` and the
  browser editor loads it in place of `parse.js`.

End state: **one parser, written once, running natively in the binary and as
WASM in the browser; the OS browser is the window, reached as a PWA.** No
Electron, no webview crate, no FFI, no `serde`, no `regex`, no `wasm-bindgen`.

What it is **not**:
- not a rewrite of the editor — `editor.js`, `mapping.js`, `commands.js`,
  `render.js` stay as JS; only the *parser* and the *server* move to Rust;
- not a new grammar or a "better" parser — it is a faithful **port**, and its
  whole job is to be indistinguishable from `parse.js` (§4);
- not shipped to readers — it lives under `scriptorium/` and stays quarantined
  (`SCRIPTORIUM.md` §6) exactly as the Node server did.

## 2. The spine — why a second parser is normally forbidden, and why this one is allowed

`SCRIPTORIUM.md` §2 is law: *the editor authors through the one parse authority,
never a second parser.* A Rust parser is, on its face, the cardinal violation —
a second implementation of the grammar, the exact thing the project refuses.

It is allowed here for one reason, and only while that reason holds:

> **It is not a second grammar — it is the same grammar, mechanically proven
> identical to the first, byte-for-byte, in CI.** The equivalence oracle that
> makes "compiled == parsed" true is turned on a second axis: *Rust-parsed ==
> JS-parsed*, over a corpus, fail-closed. Drift is not guarded against; it is
> made *provable* and *loud* — the project's signature move.

And crucially, **the second parser is temporary by design.** This is the same
maneuver the AST compiler already executed in its P5 "drop-parser" cutover:
use the oracle to validate a challenger against the incumbent, cut over once
trust is earned, then **retire the incumbent**. The phases (§9) keep `parse.js`
only as the *reference oracle* during migration. When the Rust parser has been
byte-identical across the full corpus and every fuzz round for long enough to
trust, `parse.js` is retired from the runtime and Rust becomes **the one
authority**. There is no permanent two-parser maintenance burden — there is a
migration, gated by a proof, ending in a single parser again.

Until that cutover, the honest cost is real and is named in §10: every grammar
change lands twice and the oracle must stay green. That window is the price; the
oracle is what makes it safe to pay.

## 3. Architecture — one core, three faces, and a window made of a URL

```
                     ┌───────────────────────────────┐
                     │   scriptorium/rust/parser/     │   one crate-free
                     │   the grammar, written ONCE    │   Rust source
                     └───────────────┬───────────────┘
                native target        │        wasm32 target
              ┌──────────────────────┴───────────────────────┐
              ▼                                               ▼
   ┌─────────────────────┐                       ┌──────────────────────────┐
   │ scriptorium binary  │   serves localhost    │  parser.wasm + thin glue │
   │ TcpListener + fs +  │ ────────────────────► │  loaded by editor.html   │
   │ process::Command    │   opens the browser   │  in place of parse.js    │
   └─────────────────────┘                       └──────────────────────────┘
              │                                               │
              └───────────────► OS browser (PWA) ◄────────────┘
                         the window — addressed by a URL,
                         not bound by FFI
```

Three faces, one source:

- **The binary** is the runtime. It serves the editor assets and the `/api/*`
  read/write endpoints (a direct port of `server.js`'s contract), does atomic
  writes, and opens the PWA. Pure `std`.
- **The WASM module** is the browser parser. `editor.js` calls it exactly where
  it calls `parse.js` today; everything downstream (`render.js`, `mapping.js`,
  `commands.js`, the per-command oracle) is unchanged because the AST it returns
  is byte-identical.
- **The window is the OS browser, reached as a PWA** — the lightest possible
  coupling to a webview. We do **not** bind WebView2/WKWebView/WebKitGTK via FFI
  (that is writing `wry` by hand, three times, as the ugliest form of the
  dependency we are trying to avoid). A `manifest.webmanifest` and an install
  is the dependency, and a URL never breaks the way an FFI surface does. The
  native chromeless frame is explicitly deferred (§8).

**The honest dependency tally:** zero third-party crates. Build needs `rustc`
plus the `wasm32-unknown-unknown` target (a toolchain *component*, not a
dependency). Runtime needs the OS browser (already present) and the one binary.
That is the floor; there is nothing lighter that is still a real desktop app.

## 4. The byte-identical contract (the gate)

The oracle compares **canonical AST serializations** for equality. "Byte-
identical" is precise, so the contract is precise.

### 4.1 The canonical form

- Serialization is **JSON, UTF-8, no insignificant whitespace** (the
  `JSON.stringify(ast)` default — no indentation, no trailing spaces).
- **Keys appear in a fixed, enumerated order per node type** — the construction
  order in `parse.js`, frozen here so the Rust serializer is not reverse-
  engineering `JSON.stringify`:
  - document: `type, version, sourceName, children, diagnostics, stats`
  - heading: `type, level, children, position`
  - paragraph / pull_quote: `type, children, position`
  - blockquote: `type, children, position`
  - list: `type, ordered, children, position`
  - list_item: `type, children, position`
  - divider: `type, position`
  - position: `line, startOffset, endOffset`
  - text: `type, value` · emphasis/strong: `type, children` · code:
    `type, value` · link: `type, href, children` · hard_break: `type`
  - diagnostic: `code, severity, message, offset, details, position`
  - diagnostic.position: `line, column` · stats: `blocks, words`
- **String escaping matches JSON / RFC 8259 as `JSON.stringify` emits it:** `"`
  → `\"`, `\` → `\\`, the named escapes `\b \f \n \r \t`, and any other control
  character `U+0000–U+001F` as `\uXXXX` (lower-case hex). Everything else,
  including non-ASCII, is emitted literally as UTF-8. (The hard-break sentinel
  `U+0001` never survives to output — §5.4 — but the escaping rule must still be
  exact for code spans that contain control characters.)
- `sourceName` is `null` unless the caller supplies one; `position` is omitted
  on nodes that never carry it (inline nodes — see §5.5).

Both sides emit *this* form. The reference JS is run through the same canonical
serializer (which, by construction, equals `JSON.stringify` on a freshly parsed
AST). Equality is **byte equality of the canonical UTF-8**.

### 4.2 The offset-space reconciliation (the keystone trap)

`SCRIPTORIUM-EDITOR.md` §3.1 pins the coordinate contract: **all offsets are
UTF-16 code-unit indices into the full raw buffer** — the exact unit
`textarea.setSelectionRange` consumes. The Rust parser must produce the **same
integers**, or the editor's caret↔node mapping silently skews on any non-BMP
character.

Therefore:

- The Rust parser operates over the buffer as a **sequence of UTF-16 code
  units** (decode the incoming UTF-8 to `Vec<u16>` and index over that), **not**
  over Rust `char`s (Unicode scalar values) and **not** over bytes. JS string
  indexing, `.length`, `.charCodeAt`, and `text[i]` are all per-UTF-16-code-unit;
  an astral character is two units and `text[i]` can land on a lone surrogate.
  The port must reproduce that exactly, including the lone-surrogate behaviour,
  or offsets diverge on emoji/CJK-extension input.
- All `position` offsets, all `baseOffset` arithmetic, and all `cursor`
  arithmetic are in UTF-16 units.
- String *values* extracted for the AST (text/code `value`, link `href`) are the
  corresponding `u16` slice re-encoded to UTF-8 for JSON. A lone surrogate in a
  slice is re-encoded the way `JSON.stringify` would emit it (`\uXXXX`).

This is the single highest-risk item in the port and it is a *correctness*
requirement of the contract, not an optimization.

### 4.3 Diagnostics and stats parity

Byte-identity covers the **whole** AST, which means the Rust port must also
reproduce, exactly:

- **Diagnostics**: same `code` (the seven `DIAGNOSTIC_CODES` string values),
  same `severity` (`"info"`/`"error"`), same `message` strings, same `offset`,
  same `details`, and the same derived `position: { line, column }` from
  `positionAtOffset`. Diagnostic *order* must match (they are pushed in scan
  order, then mapped). The BOM and CRLF diagnostics are emitted at offset `0`.
- **Stats**: `stats.blocks` (top-level child count) and `stats.words`
  (`wordCount(toSearchableText(ast))`). This pulls `toSearchableText` and
  `wordCount` into the port's surface — they are part of byte-identity. (Open
  question §11: replicate them, or exclude `stats` from the canonical form and
  recompute it in JS post-parse. Lean: replicate — the surface is small and a
  faithful port should own it.)

## 5. The grammar the Rust parser must replicate exactly

This is the normative port target, lifted from `scripts/ast/parse.js` and
`scripts/ast/core.js`. The Rust parser reproduces this and nothing else. Any
ambiguity is resolved by reading `parse.js`, which is authoritative until the
cutover; after cutover this section becomes authoritative and `parse.js`
retires.

### 5.1 Constants (must match `core.js` literally)

- `VERSION = "0.2.0"`, `HARD_BREAK_SENTINEL = U+0001` (a literal `\x01`), `MAX_INLINE_DEPTH = 12`.
- `BLOCK_TYPES`: `document, heading, paragraph, pull_quote, blockquote, list,
  list_item, divider`. **Note `blockquote` is the string — not `block_quote`.**
- `INLINE_TYPES`: `text, emphasis, strong, code, link, hard_break`.
- `DIAGNOSTIC_CODES`: `bom-removed, crlf-normalized, heading-level-clamped,
  unsafe-link-url, unmatched-code-marker, unmatched-emphasis-marker,
  unmatched-strong-marker`.

### 5.2 Normalization (`normalizeSource`)

1. If the first code unit is `U+FEFF`, drop it; emit `bom-removed` at offset 0.
2. If any `\r` is present, replace `\r\n?` → `\n` globally; emit
   `crlf-normalized` at offset 0.

Offsets are computed over the **normalized** text. (The editor also normalizes
once on load — `SCRIPTORIUM-EDITOR.md` §3.1 — so in practice the parser rarely
sees `\r`, but the port must still implement this for parity on raw input.)

### 5.3 Block grammar (line-oriented)

Split the normalized text on `\n`. `lineOffsets[i]` = UTF-16 offset of line `i`'s
first code unit. For each line, in this exact precedence:

1. **Blank** — `^\s*$` → flush the pending paragraph; continue.
2. **Heading** — `^(#{1,6})\s+(.+?)\s*$`. `level = marker.length`; if `> 3`,
   emit `heading-level-clamped` (with `details {line, level}` at the line offset)
   and clamp to `3`. Inline children parsed from capture group 2 at
   `baseOffset = offset + marker.length + 1`. `position = (line, offset,
   offset + line.length)`.
3. **Divider** — `^\s*---\s*$` → a `divider` block, `position = (line, offset,
   offset + line.length)`, no children.
4. **Blockquote** — `^(\s*)>\s?(.*)$`. Consume consecutive matching lines. The
   marker length is `leadingWs + 1 + (1 if the char after '>' is a space)`; each
   line's content is a paragraph-line whose offset starts **after** the marker.
   A blockquote's `children` is exactly `[paragraph]` built from those content
   lines; `position` spans from the first content offset (post-marker) to
   `last.offset + last.sourceLength`. (This post-marker start is why
   `commands.js` needed `blockLineSpan` — noted in `SCRIPTORIUM-EDITOR.md`.)
5. **List** — `^(\s*)((?:[-+]|\d+[.)])\s+)(.+?)\s*$`. `ordered = /^\d/` on the
   marker. Consume consecutive list lines **of the same `ordered` value**. List
   `position` uses line-start offsets (`sourceOffset`); each `list_item`
   `position` runs from its text offset (after the marker) to
   `sourceOffset + sourceLength`. `ordered` is a boolean field on the list.
6. **Otherwise** — accumulate as a paragraph line.

Flush at EOF. A **paragraph** is a `pull_quote` iff it is a single line whose
trimmed text both starts and ends with one matching pair from
`" "`, `' '`, `U+201C U+201D`, `U+2018 U+2019` and has trimmed length ≥ 2;
otherwise `paragraph`. Paragraph `position` = first line offset to
`last.offset + last.sourceLength`.

**Paragraph-line construction** (`createParagraphLine`): a trailing run of two or
more spaces sets `hardBreakAfter` and is stripped (the rest is *not* trimmed);
otherwise the line is trimmed. `offset` advances by the leading-whitespace count
(measured with the matching rule for each branch).

### 5.4 Inline grammar (`parseInline`)

Scan the joined paragraph/heading/item text by UTF-16 code unit. Multi-line
paragraph text is joined with `\n`, or with `HARD_BREAK_SENTINEL + "\n"` where a
line had `hardBreakAfter`. At each cursor:

- **`` ` `` (code)** — find the next backtick. None → literal backtick + emit
  `unmatched-code-marker` (suppressed in nested calls); else a `code` node whose
  `value` is the slice between, then advance past the close.
- **`[` (link)** — `parseLinkToken`: require `](` after a non-empty label, then a
  non-empty `)`-terminated href; `href` is **trimmed**. If the token doesn't
  form, the `[` is literal. If it forms but `isSafeLinkUrl(href)` is false, emit
  `unsafe-link-url` (`details {href}`, offset at the href start) and keep the
  whole `[label](href)` slice as literal text. Else a `link` node `{ href,
  children }` whose children are the label parsed as inline.
- **`**` (strong)** — only if `canOpenStrong`; find the closing `**` via
  `canCloseStrong`. None → literal `**` + `unmatched-strong-marker`. Else a
  `strong` node with inline children of the inner slice.
- **`*` (emphasis)** — only if `canOpenEmphasis`; find closing `*` via
  `canCloseEmphasis`. None → literal `*` + `unmatched-emphasis-marker`. Else an
  `emphasis` node.
- **otherwise** — append the code unit as literal text.

Nested inline parsing uses `depth + 1` with unmatched-diagnostics **suppressed**;
at `depth >= MAX_INLINE_DEPTH` the remaining text is returned as a single `text`
node. Adjacent `text` nodes are always merged (`appendText`).

**Separator normalization** (`normalizeInlineSeparators`, applied to
paragraph/blockquote inline output): within `text`, a `HARD_BREAK_SENTINEL + \n`
becomes a `hard_break` node and a bare `\n` becomes a single space; emphasis/
strong/link children are normalized recursively; `code` values have
`HARD_BREAK_SENTINEL + \n` → `\n` then `\s+` → a single space. (Headings and list
items parse a single line and skip this join/normalize step.)

### 5.5 Node shapes and positions

- Only **blocks** carry `position { line, startOffset, endOffset }`. **Inline
  nodes carry no position** (`baseOffset` exists only to place diagnostics). The
  serializer must therefore not emit a `position` key on inline nodes.
- Inline node fields exactly: `text {value}`, `emphasis {children}`,
  `strong {children}`, `code {value}`, `link {href, children}`, `hard_break {}`.
- Document carries `version`, `sourceName`, `children`, `diagnostics` (each with
  the derived `{line, column}` position appended), and `stats {blocks, words}`.

### 5.6 Boundary predicates and URL safety (the byte-identity minefield)

These are tiny and decide a huge fraction of outputs; port them character-set-
exact, **not** with `char::is_whitespace` or the `regex` crate:

- **`isWhitespace`** = JS `/\s/`. Enumerate it literally: `U+0009 U+000A U+000B
  U+000C U+000D U+0020 U+00A0 U+1680 U+2000–U+200A U+2028 U+2029 U+202F U+205F
  U+3000 U+FEFF`. (Notably this set includes `U+FEFF` and excludes `U+0085`;
  Rust's `char::is_whitespace` differs on both — do not use it.)
- **`isOpeningBoundary`** = `/[\s([{"'<>:;,-]/` (whitespace per above, plus
  `( [ { " ' < > : ; , -`).
- **`isClosingBoundary`** = `/[\s)\]}.!?",'<>:;\-]/` (whitespace, plus
  `) ] } . ! ? " , ' < > : ; -`).
- **`canOpenStrong/Emphasis`**: the char after the marker must exist, be
  non-whitespace, and not be `*`; the char before must be empty, whitespace, or
  an opening boundary. **`canClose*`** mirrors: char before non-empty, non-ws,
  not `*`; char after empty/ws/closing-boundary.
- **`isSafeLinkUrl`**: trim; reject empty or any `U+0000–U+001F` / `<` / `>`;
  match scheme `^([a-z][a-z0-9+.-]*):` case-insensitively — if no scheme, safe;
  if a scheme, safe only for `http, https, mailto, tel` (lower-cased).

## 6. The equivalence harness (CI, fail-closed)

The oracle is the whole permission slip, so it is the centerpiece of the build,
not an afterthought. It extends `scripts/tests/scriptorium-regression.js` and the
`ci:build-verify` discipline.

- **Corpus.** Parse every `raw/<slug>/<n>.txt` in the repo, plus the existing AST
  fixtures, plus a curated adversarial set targeting the §4.2/§5.6 traps:
  non-BMP characters (emoji, CJK extension B), lone surrogates, every Unicode
  whitespace code point, nested inline at depth ≥ 12, unmatched markers, unsafe
  and schemeless URLs, CRLF/BOM inputs, hard-break runs, pull-quote quote pairs,
  blockquote/list runs with odd indentation.
- **Comparison.** For each input, parse with Node (`scripts/ast/index.js`) and
  with the Rust parser (native binary in a `--parse-stdin` mode, *and* the WASM
  build driven in a headless page), serialize both to the §4.1 canonical form,
  and assert **byte equality**. Any single mismatch fails the job and prints a
  minimal diff (first differing offset + both canonical slices).
- **Fuzz.** A generative round (seeded, reproducible) mutates corpus inputs and
  random Unicode and asserts equality, so the contract is exercised beyond the
  hand-written cases. Failures shrink to a minimal reproducer checked into the
  corpus.
- **Both browser and native.** Per `SCRIPTORIUM.md` §12 blocker 1, the real
  divergence vector is *browser modules vs Node*. The WASM build closes that:
  the same `.wasm` runs in the browser, so the harness drives **WASM-in-browser
  vs Node-JS** *and* **native-Rust vs Node-JS**. Green on both is the gate.
- **Gating philosophy.** This is a *deterministic correctness* gate — exactly the
  kind that is allowed to hard-fail a PR (per the project's CI philosophy:
  reserve hard gates for determinism, leave fickle metrics advisory). Byte-
  identity is binary; it gates.

## 7. Dependency discipline (zero crates, and how)

The point is purity, so the rules are strict and each is achievable in `std`:

- **No `serde`/`serde_json`.** Hand-write the canonical serializer (§4.1) — ~150
  lines for a fixed, known AST shape, and it gives total control over key order
  and escaping, which is the whole contract. A general JSON crate would *fight*
  byte-identity, not help it.
- **No `regex`.** Hand-write the anchored line matchers (§5.3) and the boundary
  predicates (§5.6). The grammar's regexes are simple and anchored; a regex
  crate brings its own Unicode semantics that differ from JS `RegExp` — a
  hazard, not a convenience.
- **No `wasm-bindgen`.** Target `wasm32-unknown-unknown` with `std` only. The JS
  glue passes the buffer into WASM linear memory (a length-prefixed UTF-8 / or
  UTF-16 block) and reads back the canonical JSON bytes from a returned
  `(ptr, len)`; `editor.js` `JSON.parse`s that string. Manual marshalling, but
  truly crate-free. (`wasm-bindgen` would be ergonomic but is a build-time dep
  and we are spending effort precisely to avoid that class.)
- **No webview crate, ever.** The interim shell is the PWA/`--app` window (§8.1);
  the destination shell is a hand-rolled native window, *not* an embedded webview
  (§8.2). Binding crates like `windows-rs` are a separate, weaker question
  answered in §8.2 (decision: hand-roll the `extern` blocks).
- **HTTP/atomic-writes/launch** are `std::net`, `std::fs`, `std::process` — the
  Node `server.js` is already small and hand-rolled, so this is a direct port of
  a known-good contract, not new surface.

The one honest concession: a build now needs the Rust toolchain + the `wasm32`
target, where today the editor is *zero-build* (open the HTML, the parser is
view-source JS). That trade is real and is in §10.

## 8. The window — the shell is a separate axis, and a true native app is the destination

**The parser and server (R0–R3) are shell-agnostic.** The same zero-crate Rust
core backs *any* frame — a PWA, a Chromium `--app` window, or a true native
window. So the shell decision is genuinely independent of the parser work and
can be made later without changing it. That independence is the whole reason the
parser is the right first move regardless of where the shell lands.

There are three tiers, and the honest sequencing is **interim PWA now, true
native Windows-first as the destination, cross-platform only if it's ever
actually needed.**

### 8.1 Interim shell — the PWA / Chromium `--app` window (R4)

The way-station, not the summit. Zero dependency, ships today, lets authoring
continue while the parser lands:

- **Installed PWA (`display: standalone`)** — own window, own icon, no browser
  chrome; the Rust binary serves it and opens it (the existing `--open`).
- **`--app=URL` Chromium window** — the binary can launch a *chromeless*
  single-purpose window with no install required, falling back to PWA/tab if no
  Chromium browser is found. Zero crates.
- **`window-controls-overlay`** — draw the toolbar into the title bar for a more
  bespoke, less-browsery frame. A polish lever, still zero dep.

This tier is honest about what it is: a browser engine in a chrome-less window.
It looks like a real app at a glance, but it is not the destination.

### 8.2 Destination — a true native app, Windows-first, zero crate (R5)

The real goal: an *actual* native desktop application, not a browser engine in a
frame. The key unlock that makes this finite instead of scope-exploding:

> **Going native does NOT mean re-solving the editing surface.** `SCRIPTORIUM.md`
> §4 forbids hand-building a caret — and a native app honors that, because the
> **OS hands you a mature multiline text control** (Win32 RichEdit, macOS
> `NSTextView`, GTK `GtkSourceView`) that owns caret, selection, IME, and undo
> natively, often better than a `<textarea>`. The OS owns the caret, not us. A
> native text control *satisfies* the §4 boundary; it does not breach it.

It also does not threaten the spine (`SCRIPTORIUM.md` §2): the spine is "author
through the one parse authority," and the **native Rust parser already is that.**
A native GUI calling the native parser is *more* spine-coherent than
WASM-in-a-browser, not less. Everything above the caret (mapping, commands, the
per-command oracle) is the platform-agnostic Rust core, written once.

**The decision: Windows-only first, with a hand-rolled `extern "system"` Win32 +
RichEdit shell — truly zero crate.** This is the *only* combination consistent
with everything held above: absolute zero-dependency **and** actually-native
**and** a great text surface (the OS control gives caret/IME/undo for free). The
surface is small — `CreateWindowExW`, the message loop, `DefWindowProcW`,
RichEdit via `LoadLibraryW` + `SendMessageW`/`EM_*`, and a handful of structs and
constants — a few hundred lines of declarations, not a framework.

The price of purity here is **single-platform-first**, and it is the right price:
for a personal authoring tool run on a Windows machine, macOS/Linux backends are
YAGNI. Only the *shell* is per-OS; the parser, document model, commands, and
oracle are shared, so a future port re-implements the window layer only.

> **On `windows-rs` (and "morally zero-dep").** A *binding* crate (`windows-rs`,
> `objc2`, `gtk-rs`) adds no third-party *behaviour* — the behaviour is the OS
> you call anyway; it ships only typed signatures/structs/constants. That is a
> real category difference from a *logic* crate (`serde`, `regex`, a GUI
> framework). But it is **still a crate** — in the lockfile, the supply chain,
> `cargo audit`, and large — so by this spec's literal "zero crates" rule it does
> *not* qualify as zero-dep. The genuinely zero-crate path is hand-written
> `extern` blocks; the only thing `windows-rs` buys is eliminating
> transcription/UB risk (a wrong struct layout or constant is undefined
> behaviour, not a compile error). **Decision: hand-roll the `extern` blocks**
> for true zero-crate purity, accepting the transcription-care burden. Reach for
> `windows-rs` only if that burden proves to bite.

### 8.3 Cross-platform — only if *other people* need it

A fat cross-platform path (`gpui` — Zed's editor framework, the one place
"native + great text editing in Rust" exists ready-made — or per-OS bindings) is
the **only** point at which a real dependency earns its place. For a personal
tool it is pure YAGNI and a betrayal of the zero-dep line. **It becomes the job
only if the goal changes to "other people run this on Macs and Linux boxes."**
Named here so the trigger is explicit, not so it's planned.

## 9. Phasing (each phase shippable; per-checkpoint commits)

**R0–R3 are shell-agnostic** — they produce the one zero-crate core that any
shell (§8) consumes, so they are the right first move whether the frame ends up
PWA or native. R4–R5 are the shell, decided in §8.

- **R0 — the parser, behind the oracle. [DONE]** Crate-free Rust port of the full
  §5 grammar + the §4 serializer, including `stats` parity. The §6 harness diffs
  native-Rust vs Node-JS over corpus + adversarial + 500 fuzz; green on an
  ubuntu/windows/macos matrix in CI (565 inputs byte-identical, proving
  cross-platform determinism too).
- **R1 — WASM. [DONE bar the in-browser check]** The same source compiles to
  `wasm32` (crate-free ABI, no `wasm-bindgen`); `scriptorium/wasm-parser.js` is
  the browser glue; `editor.js` runs on it behind `?engine=wasm` with a JS
  fallback (the default path is untouched). The wasm oracle drives the *shipped
  glue* (via a fetch shim in Node) over the full set — 565 byte-identical, in CI.
  Remaining: a Playwright in-browser parity check (closes `SCRIPTORIUM.md` §12
  blocker 1 fully) and the eventual `parse.js` retirement at R3.
- **R2 — the Rust server.** Port `server.js`'s contract (read/write, atomic
  writes, path safety, `--open`) to the binary; the binary embeds/serves the
  editor assets + `parser.wasm`. Node is no longer required to *run* Scriptorium.
  Done = `scriptorium(.exe)` boots the editor end-to-end with no Node installed.
- **R3 — the cutover (retire `parse.js`).** After the oracle has been green long
  enough to trust, make the WASM parser the only browser parser and the Rust
  parser the one authority; `parse.js` is retired from the Scriptorium runtime
  (it may remain in the wider repo for the reader pipeline — scope that
  separately). The second parser ceases to exist; one parser remains. This
  mirrors the AST-compiler P5 drop-parser.
- **R4 — interim shell polish (§8.1).** The zero-dep "looks native" middle rungs
  on the existing PWA: the binary launches a chromeless `--app` window (fallback
  to PWA/tab), and `window-controls-overlay` for a bespoke title bar. Keeps
  authoring pleasant *while* R5 is built; not the destination.
- **R5 — the true native app, Windows-first, zero crate (§8.2).** A hand-rolled
  `extern "system"` Win32 + RichEdit shell hosting the platform-agnostic Rust
  core (parser, document model, commands, oracle). The OS text control owns the
  caret (honors `SCRIPTORIUM.md` §4); the spine is satisfied by the native parser
  it already calls. Single-platform on purpose — only the window layer is per-OS.
  This is the destination, not a deferral.
- **R6 (only if the goal changes) — cross-platform (§8.3).** A second/third OS
  backend, and the one point a real dependency (`gpui` or per-OS bindings) earns
  its place. Triggered solely by "other people run this on macOS/Linux," never by
  default.

## 10. Risks & honest notes

- **Double maintenance during R0–R2.** Two parsers exist until R3; every grammar
  change lands twice and the oracle must stay green. This is the project's exact
  anti-pattern, accepted *temporarily* and *provably*, with R3 as the exit. If R3
  stalls, the cost becomes permanent — treat a stuck cutover as a real problem,
  not a comfortable steady state.
- **The opaque-blob character cost.** In the browser the parser goes from view-
  source JS to an opaque `.wasm`. Scriptorium's whole vibe is hand-built and
  inspectable; this trades transparency for unification. Real, and not a
  dependency issue — a *character* one. Mitigation: the Rust source is in-repo
  and the oracle makes the blob's behaviour fully pinned to the readable JS.
- **The UTF-16 offset trap (§4.2)** is the highest-risk correctness item. Build
  the adversarial non-BMP/lone-surrogate corpus *first*, in R0, before trusting
  anything.
- **The whitespace-class trap (§5.6).** `char::is_whitespace` is *almost* right
  and therefore dangerous. Enumerate the JS `\s` set literally and test every
  code point in it.
- **Determinism is free here.** The grammar has no floating point and no hashing;
  same source compiled to native and WASM is the same logic, so WASM-vs-native
  divergence should be impossible — but the harness checks both anyway, cheaply.
- **Scope.** This is a multi-week build and a third project-within-a-project. It
  pulls focus the same way Scriptorium itself does (`SCRIPTORIUM.md` §9). Worth
  it only if "an actual zero-dep native runtime" is a goal we are choosing on
  purpose — name it, don't drift into it.
- **The native shell (R5) is its own large effort *on top of* the parser.** R0–R3
  is the parser/server; R5 is a hand-rolled Win32 + RichEdit application, which is
  a second substantial undertaking (window, message loop, text-control wiring,
  menus, dialogs, clipboard). Sequenced deliberately *after* the shell-agnostic
  core so it is never on the critical path and the PWA (R4) keeps authoring alive
  meanwhile. Don't conflate "the parser is done" with "the native app is done."
- **Hand-rolled FFI carries UB risk (R5).** A mis-transcribed struct layout,
  constant, or calling convention is undefined behaviour, not a compile error
  (§8.2). Mitigate with a thin, tested FFI layer and small reviewable surface; if
  it bites, `windows-rs` is the typed-but-crate fallback.

## 11. Decisions made here (call out / override me)

1. **The Rust parser exists only because the oracle makes it byte-identical, and
   it is temporary** — R3 retires `parse.js`. No permanent two-parser state. §2.
2. **Zero third-party crates**, including no `serde`, `regex`, or `wasm-bindgen`;
   hand-rolled serializer, matchers, and WASM marshalling. §7.
3. **The parser operates over UTF-16 code units**, not `char`s or bytes, to match
   JS offset semantics exactly. §4.2.
4. **The shell is a separate axis; the parser (R0–R3) is shell-agnostic.** Interim
   shell = PWA/`--app` (R4); **destination = a true native app, Windows-first,
   hand-rolled `extern` Win32 + RichEdit, zero crate (R5)** — not a deferral, the
   goal. The OS text control owns the caret, so native *honors* §4 rather than
   breaching it. Cross-platform (R6) only if other people need macOS/Linux. §8.
5. **No webview, ever; and `windows-rs` is not zero-dep.** A binding crate adds no
   third-party *logic* but is still a crate (lockfile, supply chain, size), so we
   hand-roll the `extern` blocks for true zero-crate purity. §8.2.
6. **`stats` is replicated in Rust** (port `toSearchableText`/`wordCount`) rather
   than excluded from the canonical form. §4.3 — **done in R0**: the full AST
   including `stats { blocks, words }` is in the byte-identity comparison.
7. **Byte-identity is a hard CI gate** (deterministic correctness), unlike the
   project's advisory metrics. §6.

## 12. Open questions

- **`stats` parity vs exclusion.** *Resolved (R0): replicated.* `toSearchableText`
  (block join `" "`, inline join `""`, hard-break → `" "`, normalize `\s+`) and
  `wordCount` (count of `\S+` runs) are ported; `stats { blocks, words }` is in
  the oracle comparison. The fuzz set exercises the word-splitting.
- **WASM marshalling encoding.** Pass the buffer into WASM as UTF-8 (and decode
  to `Vec<u16>` inside) or as UTF-16 directly from JS (`encode into Uint16Array`)?
  UTF-16-in avoids a decode step and a class of surrogate bugs; UTF-8-in is
  simpler glue. (Lean: UTF-16-in, since the parser is UTF-16-native anyway.)
- **Asset embedding.** Does the R2 binary embed the editor assets via
  `include_bytes!` (single-file, truly portable) or serve them from disk
  (hackable, matches today)? (Lean: `include_bytes!` for the shipped binary, a
  `--serve-dir` flag for dev.)
- **Where `parse.js` lives after R3.** Retired from Scriptorium for sure; does the
  reader pipeline also move to the Rust parser, or keep the JS one? That is a
  separate, larger decision for `AST-COMPILER.md`, not this doc.

## 13. Map / related docs

- `docs/specs/SCRIPTORIUM.md` — the parent; §2 spine, §4 caret boundary, §6
  quarantine, §7 server (this is its native port), §8 P3 PWA capstone (this is
  its "to the metal" continuation).
- `docs/specs/SCRIPTORIUM-EDITOR.md` — the editor whose coordinate contract
  (§3.1) this parser must satisfy byte-for-byte (§4.2).
- `docs/specs/AST-COMPILER.md` — the parse/consume authority and the P5 "drop-
  parser" cutover this mirrors (§2, §9 R3).
- `docs/specs/AST-DIALECT.md` — the grammar §5 ports; the normative reference if
  §5 and `parse.js` disagree (until R3 flips authority).
- `scripts/ast/parse.js`, `scripts/ast/core.js` — the authoritative source of the
  §5 grammar until the R3 cutover.
