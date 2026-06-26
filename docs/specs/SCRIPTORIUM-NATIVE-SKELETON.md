# Scriptorium Native — N0: the platform/render walking skeleton

> The first build target of the native editor (`SCRIPTORIUM-NATIVE-EDITOR.md` §7,
> N0). A **deliberately thin vertical slice** through every layer: a real Win32
> window → DirectWrite-rendered text → a blinking caret → keyboard input → the text
> reparsed through the `rust/` core **in-process**. Its purpose is to **de-risk the
> COM-from-raw-Rust FFI** and to **unlock the feel-loop** by putting a runnable
> native thing in front of the author as fast as possible.
>
> It is a spike, but **not a throwaway**: it lays the platform seam (§3) that N1+
> build on. The discipline: hand-roll exactly the Win32/COM bindings this slice
> needs — no more — declared, vendored, and auditable in our own tree (no
> `windows-sys`; `SCRIPTORIUM-NATIVE-EDITOR.md` §3).
>
> Status: **spec / not started.** Last refreshed: 2026-06-27.

---

## 1. Goal & exit criteria

N0 is **done** when, on Windows:

1. A native window opens (DPI-correct, per-monitor aware), and closes cleanly
   (`WM_DESTROY` → `PostQuitMessage`, no leaked COM refs).
2. Typing **appends** UTF-16 units to an in-memory buffer; **Backspace** deletes
   the last; **Enter** inserts a newline. (Caret movement / selection are N2.)
3. The buffer renders crisply via **DirectWrite**, correctly scaled for the
   window's DPI.
4. A **blinking caret** draws at the insertion point (end of buffer for N0).
5. **Every edit reparses the buffer through `scriptorium_parser::parse_document`
   in-process** (no wasm, no marshalling), and an AST-derived signal — block count
   + word count + parse time — is shown in a status line. *This is the proof the
   loop is closed.*
6. The bin **builds and links on `windows-latest`** (the real test of the
   hand-rolled externs), and the **workspace still builds on Linux CI** (the bin is
   a stub off-Windows; §6).

And the *real* exit criterion behind those: **we now know whether COM-from-raw-Rust
is tolerable**, and there is a thing the author can type into and react to.

## 2. Scope fence

**In:** one window, message loop, DPI awareness, `WM_CHAR` append/backspace/enter,
DirectWrite text, a blinking caret at end-of-text, in-process reparse + a status
signal, the platform-seam module split, one layout-geometry oracle seed.

**Out (named so they don't creep in):** caret movement / selection / hit-testing by
click (N2/N3), grapheme-correct movement + IME (N2), a real text buffer — rope/
piece-tree (N1), AST-*styled* rendering — headings bigger, emphasis italic (N3),
scrolling + virtualized layout (N3), undo (N1), save/load/file IO (durability,
siren), menus/toolbars/chrome, multi-window. N0 renders *plain* text; the only
thing it does with the AST is display the signal in §5.

## 3. Architecture — the platform seam

Lives in the existing `rust/` package as a new bin with a co-located module tree
(Cargo supports `src/bin/<name>/main.rs` + sibling modules), so it reuses the
parser via a plain `use` and adds no crate:

```
rust/src/bin/native-editor/
  main.rs        entry: DPI-aware, create window, create renderer, run loop
                 (+ a #[cfg(not(windows))] stub main so the workspace builds anywhere)
  win32/
    sys.rs       hand-declared FFI: extern fns, #[repr(C)] structs, constants, GUIDs
                 — declare ONLY what N0 calls (§4, §5)
    mod.rs       thin safe-ish wrappers: Window, the message pump, input→events
  render.rs      the D2D/DWrite renderer: factories, text format, draw text + caret
  app.rs         editor state: the buffer (naive Vec<u16> for N0), caret index,
                 last-parse signal; on edit → mutate + reparse + invalidate
```

- **The seam rule** (`SCRIPTORIUM-NATIVE-EDITOR.md` §4): only `win32/` and `render.rs`
  touch Win32/COM. `app.rs` speaks our own types (an input event, a buffer, a caret).
  N0 implements Win32 only, but the boundary is where a second OS *could* slot in.
- **Reuse:** `app.rs` calls `scriptorium_parser::parse_document(&buffer)` directly
  (`pub fn parse_document(units: &[u16]) -> Document`, lib.rs). The buffer is already
  UTF-16, so it feeds the parser with **zero conversion** — the native ergonomics the
  in-process path was for.
- **No new dependency.** `rust/Cargo.toml` gains one `[[bin]]` entry; nothing else.

## 4. The Win32 surface

Event-driven, classic message-pump. Hand-declare (in `win32/sys.rs`) exactly:

- **Window/loop:** `RegisterClassExW`, `CreateWindowExW`, `DefWindowProcW`,
  `ShowWindow`, `GetMessageW`, `TranslateMessage`, `DispatchMessageW`,
  `PostQuitMessage`, `LoadCursorW`, `InvalidateRect`, `BeginPaint`/`EndPaint`.
  Structs `WNDCLASSEXW`, `MSG`, `POINT`, `RECT`, `PAINTSTRUCT`. Constants
  `WS_OVERLAPPEDWINDOW`, `CW_USEDEFAULT`, `SW_SHOW`, `CS_HREDRAW|CS_VREDRAW`,
  `IDC_ARROW`, and the messages `WM_DESTROY`, `WM_PAINT`, `WM_SIZE`, `WM_CHAR`,
  `WM_TIMER`.
- **DPI (day-one):** `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` at
  startup; `GetDpiForWindow` to scale font size + caret. Decided in the umbrella ledger.
- **Caret blink:** `SetTimer`/`KillTimer`; on `WM_TIMER` toggle a `caret_visible`
  flag and `InvalidateRect`.
- **The `WndProc`** is an `extern "system" fn`. It cannot capture; thread the app
  state through `GWLP_USERDATA` (`SetWindowLongPtrW`/`GetWindowLongPtrW`, set from the
  `lParam`'s `CREATESTRUCT` on `WM_CREATE`). `WM_CHAR` mutates the buffer (printable +
  `0x08` backspace + `0x0D`→newline), reparses, invalidates. `WM_DESTROY` posts quit.

## 5. The renderer — COM / DirectWrite, and the FFI we're really testing

**N0 path: Direct2D + DirectWrite, calling `DrawTextLayout`.** We *consume* COM
interfaces (call methods through vtables) but **implement none** — the lowest-risk
way to get DWrite glyphs on screen, because implementing a COM callback interface
(e.g. a custom `IDWriteTextRenderer`) is the genuinely hard part of COM-from-Rust and
is *not* what N0 should gamble on. The object graph, all consumed:

```
D2D1CreateFactory      -> ID2D1Factory
  CreateHwndRenderTarget -> ID2D1HwndRenderTarget   (BeginDraw/Clear/EndDraw, Resize)
    CreateSolidColorBrush -> ID2D1SolidColorBrush    (text + caret)
DWriteCreateFactory    -> IDWriteFactory
  CreateTextFormat      -> IDWriteTextFormat          (font, size, DPI-scaled)
  CreateTextLayout      -> IDWriteTextLayout          (the buffer text; gives geometry)
```

Render in `WM_PAINT`: `BeginDraw` → `Clear` → `DrawTextLayout` → draw the caret as a
filled rect at the layout's caret x (from `HitTestTextPosition`) → `EndDraw`.

**The COM-from-raw-Rust pattern (the thing we're de-risking), spelled out so it's a
recipe, not a discovery:**
- Each interface = `#[repr(C)] struct IXxx { vtbl: *const IXxxVtbl }` where the vtbl
  is a `#[repr(C)]` struct of `extern "system"` fn pointers **in exact COM order**
  (the three `IUnknown` slots — `QueryInterface`/`AddRef`/`Release` — first, then the
  interface's own methods in declaration order). Getting the order/signatures right
  is the correctness risk we accept (`SCRIPTORIUM-NATIVE-EDITOR.md` §3).
- Call a method: `((*(*p).vtbl).Method)(p, args…)`, `unsafe`.
- **Refcounts:** wrap each interface pointer in a small RAII type whose `Drop` calls
  `Release`. Never hand-balance `AddRef`/`Release` in logic.
- **HRESULT:** every call returns it; `hr < 0` is failure → a checked error/panic with
  the call name (N0 may panic; N1+ tighten).
- **GUIDs:** hand-declare the IIDs/CLSIDs for the factories + interfaces as
  `#[repr(C)] struct GUID` constants (the `factory` create-calls need them).
- Link: `#[link(name = "d2d1")]`, `#[link(name = "dwrite")]`, `#[link(name = "user32")]`
  — all under `#[cfg(windows)]` so they only resolve on the Windows target.

**Surface-architecture note (and a flagged tension with the umbrella).** The umbrella
leaned "CPU/software framebuffer to start." N0 uses an `ID2D1HwndRenderTarget` instead
— the fastest route to validated pixels — because the honest *CPU-framebuffer + DWrite*
path requires implementing an `IDWriteTextRenderer` callback (or an
`IDWriteBitmapRenderTarget` + custom renderer), i.e. exactly the COM-callback risk N0
defers. **So N0 re-opens the surface decision:** what N0 teaches about COM-callback
difficulty feeds the CPU-framebuffer-vs-Direct2D choice, which lands as a ledger item
around N3 — not now. N0's job is pixels + de-risking, not committing the surface.

## 6. The edit/parse loop & build gating

- **Buffer:** a naive `Vec<u16>` (the real buffer is N1). `WM_CHAR` pushes/pops/inserts.
- **On every edit:** `let doc = parse_document(&buffer); signal = (doc.children.len(),
  doc.stats_words, elapsed)`; `InvalidateRect`. (580µs/section is imperceptible —
  `SCRIPTORIUM-WASM-MARSHALLING.md` — so synchronous reparse-on-keystroke on the UI
  thread is fine for N0; off-thread is N4.)
- **Cross-platform build gating:** `main.rs` has `#[cfg(windows)] fn main()` (the real
  app) and `#[cfg(not(windows))] fn main()` (a one-line stub) so `cargo build` on the
  Linux CI runners — which build the wasm + the generator bins — still succeeds. The
  `win32`/`render` modules are `#[cfg(windows)]`. The parser lib is untouched and stays
  clean (the GUI never enters it).

## 7. Testing & the first oracle seed

GUIs resist unit tests, but N0 plants the discipline (`SCRIPTORIUM-NATIVE-EDITOR.md` §6):

- **Layout-geometry oracle seed:** a test that, for a fixed string + text format,
  `HitTestTextPosition` returns **monotonically non-decreasing caret x** for increasing
  index — the first golden geometry. (Runs on Windows where DWrite exists.)
- **Parser-in-the-loop:** already covered — the parser is unchanged and guarded by the
  existing oracles; N0 adds no parse logic, only calls it.
- **CI guard (the automatable one):** a `windows-latest` job that `cargo build`s the
  `scriptorium-native-editor` bin — proving the hand-rolled externs **link** against the
  real system import libs. This is N0's real regression value in CI. (Maximal-CI:
  also a Linux job asserting the stub keeps the workspace green.)

## 8. Risks / what could actually bite

- **COM vtable order or signature wrong** → UB/crash. Mitigation: tiny surface (~6
  consumed interfaces), RAII Release, check every HRESULT, build the recipe (§5) once
  and reuse. This *is* the experiment — if it's miserable, we learn it here, cheap.
- **`WndProc` state threading** (the `extern "system"` no-capture callback) — a known
  Win32 idiom (`GWLP_USERDATA`); low risk, just fiddly.
- **DPI math** — get it right day-one or every later coordinate is wrong.
- **The deferred hard thing:** if owning a CPU framebuffer (umbrella's lean) proves
  important, the `IDWriteTextRenderer` COM *callback* is the next escalation — N0
  deliberately doesn't attempt it.

## 9. Decisions to feed the umbrella ledger (on completion)

- N0 renders via **Direct2D `DrawTextLayout`** (consume-only COM); the CPU-framebuffer
  surface decision is **re-opened**, informed by COM-callback difficulty, for ~N3.
- The native editor lives as a **co-located bin module tree** in `rust/`, stub-gated
  off Windows — no new crate, parser reused in-process.
- Verdict on **COM-from-raw-Rust tolerability** (the headline finding) → records whether
  the hand-rolled-bindings line (`SCRIPTORIUM-NATIVE-EDITOR.md` §3) holds in practice or
  needs revisiting.
