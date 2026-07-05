# Scriptorium Native Editor — File I/O (open / save / dirty-state)

**Status: BUILT + locally validated (2026-07-05).** The first node outside the named
N-roadmap: not a rendering or input-mechanics landmark but the plumbing that turns the
editor from a scratchpad into something you can *keep work in*. It is also the enabling
move for the author's feel-loop — **you cannot judge N2b IME / N3 scroll-caret / N4 latency
/ N5 scrolling on a real manuscript until you can load one.** So it lands before N5. Built
to this spec; the modal Open/Save dialogs are the author's manual pass (no automatable feel
surface), everything else is oracle- and smoke-covered. **The two checkpoints IO-a (codec +
document model) and IO-b (win32 wiring) landed as one commit** (`d83b340`): the document
model is dead code in a bin crate until the platform layer calls it — `pub` is not
reachability in a binary — so a warning-free tree per commit outweighed the intermediate
split. The codec's byte round-trip is still oracled on every platform, as designed.

Built against the umbrella (`SCRIPTORIUM-NATIVE-EDITOR.md`) — same dependency line (the OS
API, no crate), same seam (`app` platform-free, only `win32`/`render` touch the OS), same
depth discipline (enumerate the edges, oracle what we own, queue only genuine feel).

---

## 1. Scope — and the honest boundary

**In:** Open a file into the buffer; Save; Save As; New. A real **dirty-state machine** and
a **discard-unsaved-changes prompt** guarding every destructive transition (New / Open /
window close). Faithful **encoding + newline round-trip** — a file opens as what it is and
saves back as what it was, byte-for-byte for well-formed input. A title bar that names the
document and marks it dirty.

**Out (named sirens, §11):** a recent-files list, autosave / crash recovery, drag-and-drop
open, file-type association, atomic save-via-temp-rename, encoding *conversion* UI, watching
for external edits. None are needed to load a manuscript and keep working; each is a clean
later add on this substrate.

**The boundary we cannot cross ourselves:** `GetOpenFileNameW`/`GetSaveFileNameW` are modal
dialogs driven by a human clicking through a file system. An automated test cannot pick a
file. So — exactly as with N2b's IMM round-trip — we split the work at the seam: the *codec*
and the *dirty-state machine* are pure and fully oracled on every platform; the *dialogs* are
exercised for crash-freedom only, and the load→save **byte round-trip** is oracled by calling
the path-taking helpers directly (no dialog) through a live window. The "does the Open dialog
feel right" verdict is the author's, but there is almost no feel surface here — this is
correctness plumbing, and correctness is what we can pin.

---

## 2. Dependency line

No new crate; no `windows-sys`. Two OS surfaces added, both hand-declared in `win32::sys`
and ABI-guarded like every other FFI struct here:

- **comdlg32**: `GetOpenFileNameW`, `GetSaveFileNameW` + the `OPENFILENAMEW` struct (§7).
- **user32**: `MessageBoxW` (the discard prompt) — a `#[link(name = "user32")]` addition.

**Bytes** move through `std::fs::read`/`std::fs::write` — cross-platform std, not FFI. The
only Windows-specific pieces are *choosing* the path (the dialogs) and *asking* the user (the
message box). This keeps the byte I/O itself testable off-Windows and the FFI surface minimal.

---

## 3. The codec — bytes ↔ the LF-internal buffer (`codec.rs`, platform-free)

The buffer is **UTF-16, LF-only** (established at N1; the clipboard already normalizes CRLF→LF
on paste). A file is arbitrary bytes in some encoding with some newline convention. `codec.rs`
is the pure bijection-with-memory between them, in its own **un-gated** module (like
`buffer`/`grapheme`/`parse`) so its round-trip oracles run on Windows **and** Ubuntu **and**
macOS.

```
pub enum Encoding { Utf8, Utf8Bom, Utf16Le, Utf16Be }
pub enum Newline  { Lf, Crlf, Cr }

pub struct Decoded { pub units: Vec<u16>, pub encoding: Encoding, pub newline: Newline }
pub fn decode(bytes: &[u8]) -> Decoded          // file bytes → LF-internal units (+ what it was)
pub fn encode(units: &[u16], enc: Encoding, nl: Newline) -> Vec<u8>   // units → file bytes
```

**Decode** (`bytes → Decoded`):
1. **Encoding by BOM**, else UTF-8:
   | leading bytes | encoding | BOM stripped |
   |---|---|---|
   | `EF BB BF` | `Utf8Bom` | 3 |
   | `FF FE` | `Utf16Le` | 2 |
   | `FE FF` | `Utf16Be` | 2 |
   | *(anything else)* | `Utf8` | 0 |
   BOM-less UTF-8 is the default — the overwhelmingly common case for the project's own
   markdown. (`FF FE 00 00` UTF-32LE is read as UTF-16LE; we don't support UTF-32 and won't
   invent a manuscript that needs it — noted, not handled.)
2. **Bytes → UTF-16 units**: UTF-8 via `String::from_utf8_lossy` (malformed bytes → U+FFFD, so
   decode *never fails* — a truncated file opens, it doesn't error); UTF-16 by pairing bytes in
   the detected endianness (a trailing odd byte is dropped).
3. **Newline detect + normalize**: scan for the first line ending — `\r\n`→`Crlf`, lone
   `\r`→`Cr`, lone `\n`→`Lf`, none→`Lf`. Then normalize **all** CRLF and lone CR to LF for the
   internal buffer. Detection records the file's *dominant* convention (first wins); a
   mixed-ending file is normalized to one convention and will save consistently (§ below).

**Encode** (`units → bytes`, units are LF-internal):
1. **LF → target newline**: `Lf` verbatim, `Crlf` maps each `\n`→`\r\n`, `Cr` maps each
   `\n`→`\r`.
2. **Units → bytes**: UTF-8 via `String::from_utf16_lossy` then `.into_bytes()` (an unpaired
   surrogate → U+FFFD, so encode never fails); UTF-16 by emitting each unit in the target
   endianness. Prepend the BOM for `Utf8Bom`/`Utf16Le`/`Utf16Be`.

**The round-trip contract** (the headline oracle, §9):
- **`encode(decode(bytes)) == bytes`** for well-formed, consistently-terminated input in any of
  the four encodings — the byte-faithful property (a CRLF UTF-8-BOM file stays exactly that).
- **`decode(encode(u, e, n)).units == u`** for any LF-internal `u` — units survive the trip.
- **Mixed endings normalize**: a file with both `\r\n` and `\n` decodes to LF-only and
  re-encodes to a single convention. This is a deliberate, ledgered behavior change on save
  (the same thing every mainstream editor does), *not* a violation of round-trip — the property
  is scoped to consistent input.

**Why preserve rather than force a house convention:** the editor sits upstream of the
project's LF-based markdown/AST pipeline, so LF is the *default for new documents* (§4). But a
file the author opens belongs to them — silently rewriting every line ending of an existing
CRLF file on the first save is a surprise and a noisy diff. Preserve what was there; default
only what we create.

---

## 4. Document identity + the dirty-state machine (`app.rs`)

`App` gains a small identity block — platform-free (a `PathBuf` is std), the dialogs fill it:

```
path: Option<PathBuf>   // None = untitled
encoding: Encoding      // default Utf8 (new docs are BOM-less UTF-8)
newline: Newline        // default Lf   (coherent with the LF buffer + the md pipeline)
saved_gen: u64          // content_gen at the last load/save; == "the on-disk generation"
```

**Dirty is a generation comparison, not a flag:** `is_dirty() = content_gen != saved_gen`.
`content_gen` already monotonically bumps on every edit (N3). A fresh `App` sets
`saved_gen = content_gen` after its initial `refresh()`, so the empty untitled document is
**clean** (closing it prompts for nothing). Save and load both set `saved_gen = content_gen`.

Transitions (all clamp caret/anchor, all go through existing primitives):
- **`load_document(decoded, path)`** — rebuild the buffer from the decoded units
  (`TextBuffer::from_units`), **clear undo/redo** (a loaded file is a fresh history, not an
  undoable edit of the previous one), reset caret/anchor to 0, record path/encoding/newline,
  `refresh()`, then `saved_gen = content_gen`. The parser re-submits off-thread as for any
  content change (N4) — the status line's block/word counts refresh for the loaded doc.
- **`new_document()`** — `load_document` of empty units with `path=None`, default encoding/
  newline. Clean.
- **`mark_saved()`** — `saved_gen = content_gen`. Called after a successful write.
- **`bytes_to_save() -> Vec<u8>`** — `encode(&self.text, self.encoding, self.newline)`. Pure;
  `win32` writes it.
- **`set_path_encoding_newline(...)`** — Save As records the chosen path (and keeps the
  encoding/newline, since Save As is "same document, new location", not a conversion).

**One honest limitation, ledgered:** because dirtiness is generation-based, *undoing back to the
last-saved state still reads as dirty* (undo bumps `content_gen`). Editors that clear dirty on
undo-to-save track a content hash; we don't, yet. It only ever over-reports (you may be prompted
to save something byte-identical to disk) — it never loses work. A content-hash upgrade is a
named siren (§11).

---

## 5. The commands + the guarded transitions (`win32`)

Keyboard, mapped in `WM_KEYDOWN` alongside the existing Ctrl shortcuts:
- **Ctrl+O** — Open. If dirty, run the discard guard first.
- **Ctrl+S** — Save. Untitled ⇒ escalates to Save As (needs a path).
- **Ctrl+Shift+S** — Save As (always shows the dialog).
- **Ctrl+N** — New. If dirty, run the discard guard first.
- **WM_CLOSE** (the ✕ / Alt+F4) — if dirty, run the discard guard; it decides whether we
  `DestroyWindow`.

**The discard guard** (`confirm_discard`) — the heart of "don't lose the author's work". When
the document is dirty and it is about to be replaced or closed:

```
MessageBoxW(MB_YESNOCANCEL | MB_ICONWARNING, "Save changes to <name>?")
  IDYES    → save (Save As if untitled); proceed only if the save SUCCEEDED
  IDNO     → discard; proceed
  IDCANCEL → abort the whole action (stay exactly where we are)
```

The three-way answer is load-bearing: **Yes-that-fails must not proceed** (a failed or
cancelled save can't silently drop the buffer), and **Cancel is a first-class outcome** (closing
the window is aborted, not deferred). `confirm_discard` returns a `Proceed`/`Abort` the caller
obeys — for `WM_CLOSE` that gates `DestroyWindow`; for Open/New it gates the load.

**Save escalation:** `save()` with `path=Some` writes `bytes_to_save()` to that path and
`mark_saved()`. With `path=None` it calls `save_as()`, which pops `GetSaveFileNameW`
(OFN_OVERWRITEPROMPT so the OS handles "replace existing?"), and on a confirmed path records it,
writes, and marks saved. A dialog **Cancel** is a clean no-op (and, inside the discard guard,
means the save didn't happen → Yes-that-was-cancelled becomes an Abort, buffer intact).

**Failure surfacing:** a read error (`std::fs::read` Err — permissions, vanished file) or a
write error (disk full, read-only) shows a `MessageBoxW(MB_OK | MB_ICONERROR)` with the OS error
and changes nothing — a failed Open keeps the current document, a failed Save leaves the buffer
dirty. Never a panic, never a silent loss.

---

## 6. Title bar

`Scriptorium — <name>[*]`, where `<name>` is the file name (`path` basename) or `Untitled`,
and `*` appears iff `is_dirty()`. Updated via `SetWindowTextW` whenever the identity or dirty
state can change (load / save / and — so the `*` tracks live — folded into the same repaint
path the status line already rides, throttled to only re-set the title when the displayed string
actually changes so we don't call `SetWindowTextW` every keystroke). Adds `SetWindowTextW` to the
user32 FFI.

---

## 7. FFI surface + ABI guards

**`OPENFILENAMEW`** (comdlg32) — the one large struct; its x64 layout is the correctness risk, so
it is `size_of`/`offset_of`-asserted like every COM vtable here. Expected x64 layout: the
`WORD nFileOffset`/`WORD nFileExtension` pair sits at offset 100/102 followed by 4 bytes of
padding before the next pointer (`lpstrDefExt` @104); `Flags` @96; **total size 152**. The ABI
test pins `Flags`, `lpstrDefExt`, and the total size.

Fields we set: `lStructSize` (=152), `hwndOwner`, `lpstrFilter` (`"Text\0*.txt;*.md\0All\0*.*\0\0"`),
`lpstrFile` (a caller-owned `[u16; 260+]` buffer, pre-seeded with the current name for Save),
`nMaxFile`, `lpstrTitle`, `lpstrDefExt` (`"txt"`), `Flags`. Flags:
`OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR` for both, plus
`OFN_FILEMUSTEXIST` (Open) / `OFN_OVERWRITEPROMPT` (Save). On return the path is read from
`lpstrFile` up to its NUL.

**`MessageBoxW`** (user32): `(HWND, *const u16 text, *const u16 caption, u32 uType) -> i32`, with
`MB_YESNOCANCEL`/`MB_OK`/`MB_ICONWARNING`/`MB_ICONERROR` and `IDYES`/`IDNO`/`IDCANCEL`/`IDOK`.

**`SetWindowTextW`** (user32): `(HWND, *const u16) -> BOOL`.

Bytes: `std::fs::read`/`std::fs::write` (no FFI).

---

## 8. The edges we handle as first-class

- **Untitled Save** → Save As (never write to a nonexistent path).
- **Save dialog Cancel inside the discard guard** → the save didn't happen → do not proceed
  (buffer intact).
- **Read/write failure** → error box, state unchanged, no panic.
- **Malformed encoding** → lossy decode/encode (U+FFFD), never an error path that strands the
  user.
- **Mixed line endings** → normalized to the detected dominant convention on save (ledgered).
- **Empty file** → decodes to empty units, `Lf`, default encoding — a clean untitled-like doc
  that nonetheless has a path.
- **A file with no newline at all** → `Newline::Lf` default; adding lines later saves LF (until
  we've seen evidence otherwise, LF is the coherent default).
- **BOM present but body empty** → encoding remembered, so re-saving preserves the BOM.
- **Loading clears undo history** → you can't Ctrl+Z across an Open into the previous document.
- **The parser + scroll re-home on load** → `content_gen` bumps, so N4 reparses and the caret
  resets to the top (a freshly opened doc shows its start, not a stale scroll offset).

---

## 9. Testing

**Codec oracles (platform-free, every CI job)** — the valuable net, in `codec.rs`:
- `encode(decode(bytes)) == bytes` for each encoding × {LF, CRLF} with representative Unicode
  (ASCII, accents, CJK, an emoji with a surrogate pair, a BOM).
- `decode(encode(u,e,n)).units == u` for sample LF-internal `u` across all encodings/newlines.
- BOM detection table (each signature → the right `Encoding`, right bytes stripped).
- Mixed-ending input → LF-only units + single-convention re-encode.
- Malformed UTF-8 / odd-length UTF-16 → lossy, no panic.
- Empty and no-newline inputs.

**Dirty-state oracles (app, Windows CI)** — fresh doc clean; edit → dirty; `mark_saved` → clean;
`load_document` → clean + undo history cleared + caret home; the generation math.

**Smoke extension (Windows, `--features smoke`, ASan)** — the breadth check without a human at
the dialog: through the live window, write a known byte buffer to a temp file with
`std::fs::write`, call the **path-taking** `load_path(&temp)` (the dialog-free core of Open),
assert the buffer/encoding/newline/title/clean-state; type an edit (→ dirty, title `*`); call the
path-taking `save_path(&temp2)` (the core of Save), read `temp2` back and assert the **byte
round-trip** and clean state; run `confirm_discard`'s decision logic on a synthetic answer. The
modal dialogs themselves are *not* invoked (they'd block); `GetOpenFileNameW`/`GetSaveFileNameW`
are compiled + ABI-asserted, and their thin wrapper is covered by the manual feel pass. Teardown
stays ASan-clean (the temp files are cleaned up).

---

## 10. Checkpoints (both landed in one commit — see Status)

- **IO-a — the codec + the document model (platform-free core).** `codec.rs` (Encoding/Newline,
  decode/encode, all round-trip oracles) + `app.rs` identity block, `is_dirty`, `load_document`/
  `new_document`/`mark_saved`/`bytes_to_save`/`path` + dirty-state oracles. **No FFI, no `win32`.**
  The codec's byte round-trip lands green on all three platforms. This is the correctness heart.
- **IO-b — the win32 wiring.** comdlg32 + `MessageBoxW` + `SetWindowTextW` FFI (ABI-asserted),
  the Ctrl+O/S/Shift+S/N handlers, the `confirm_discard` guard + `WM_CLOSE`, `load_from`/
  `save_to` (the dialog-free cores) behind `do_open`/`do_save`/`do_new` (dialog + `std::fs` +
  error boxes), the title bar, and the smoke extension (the live-window load→edit→save→byte
  round-trip, dialogs excepted).

**Landed together** (`d83b340`): IO-a's document model is unreachable — hence dead-code-warned in
a bin crate — until IO-b's platform layer calls it, and a warning-free tree per commit is the
governing rule. Validated locally before the push: 56 oracles debug+release, windowed smoke green,
**ASan-clean** across the new FFI + teardown, clippy adds zero new findings, warning-free release.

---

## 11. Deferred (named sirens)

Recent-files (MRU); autosave + crash recovery (the rope's O(1) snapshots make periodic
journaling cheap — a real future win); drag-and-drop open (`WM_DROPFILES`); `.md`/`.txt` file
association + "Open with"; **atomic save** (write temp in the same dir, `fsync`, rename over —
crash-during-save safety); external-change watch (`ReadDirectoryChangesW`); **content-hash dirty
tracking** (clear dirty on undo-to-saved, §4); an encoding/newline picker in the UI (we detect +
preserve; we don't yet let you *convert* deliberately). Each is additive on this substrate.

---

## 12. Ledger deltas (fold into the umbrella §8 on reconcile)

- File I/O added as the first post-N-roadmap node; lands **before N5** because loading a real
  manuscript is the prerequisite for every queued feel verdict.
- **Preserve-on-save, default-on-create**: opened files round-trip their encoding + newline
  byte-faithfully; new documents default to BOM-less UTF-8 + LF (coherent with the buffer and the
  markdown pipeline). Mixed endings normalize on save (standard, ledgered).
- **Dirty = `content_gen != saved_gen`** (generation compare, not a flag); over-reports across
  undo-to-saved (content-hash upgrade is a siren), never under-reports.
- Codec is platform-free (`codec.rs`, un-gated) so the byte round-trip is oracled on every CI
  platform; only the dialogs + message box are Windows FFI.
- `OPENFILENAMEW` x64 layout (size 152) ABI-asserted alongside the COM vtables.
