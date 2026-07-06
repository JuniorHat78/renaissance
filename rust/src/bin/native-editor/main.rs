//! scriptorium-native-editor — N0, the platform/render walking skeleton.
//!
//! A deliberately thin vertical slice through every layer of the native editor:
//! a real Win32 window -> DirectWrite-rendered text -> a blinking caret ->
//! keyboard input -> the buffer reparsed through the `rust/` core *in-process*.
//! Its purpose is to de-risk the COM-from-raw-Rust FFI and unlock the feel-loop.
//! See docs/specs/SCRIPTORIUM-NATIVE-SKELETON.md (and the umbrella
//! SCRIPTORIUM-NATIVE-EDITOR.md) for the contract this is built against.
//!
//! Platform seam: only `win32` and `render` touch Win32/COM; `app` speaks our own
//! types (a buffer, a caret, a parse signal). Windows-first, but the seam is where a
//! second OS could slot in. The Win32/COM bindings are hand-declared in `win32::sys`
//! — no `windows-sys`, no crate in the graph (umbrella §3).

#![cfg_attr(not(windows), allow(unused))]

// Platform-independent: the rope buffer + its cross-platform fuzz oracle, the grapheme/word
// boundary logic + its oracle, and the off-thread parse service (N4; its OS wakeup is injected
// by `win32`, so the mailbox/coalescing/service logic itself is platform-free) all compile and
// run everywhere (no Win32/DWrite), so they are NOT gated to Windows.
mod buffer;
mod codec;
mod grapheme;
mod heights;
mod parse;
mod styles;

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod render;
#[cfg(windows)]
mod win32;

/// The real app: open a DPI-aware window and pump messages until it closes.
#[cfg(windows)]
fn main() {
    win32::run();
}

/// Off-Windows stub so `cargo build` stays green on the Linux/macOS CI runners
/// (which build the wasm + generator bins). The GUI never enters the parser, so the
/// parser lib stays clean; this stub never enters the GUI.
#[cfg(not(windows))]
fn main() {
    eprintln!(
        "scriptorium-native-editor is a Windows-only native GUI (N0 walking skeleton).\n\
         This non-Windows build is a stub so the workspace still compiles on Linux/macOS CI.\n\
         See docs/specs/SCRIPTORIUM-NATIVE-SKELETON.md."
    );
}
