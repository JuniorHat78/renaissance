//! The Win32 platform layer: register a class, create a DPI-aware window, pump
//! messages, and route input/paint into `app` + `render`. Only this module and
//! `render` touch the OS; `app` stays platform-free (the seam, umbrella §4).
//!
//! The `WndProc` is an `extern "system" fn` and cannot capture, so the per-window
//! state is boxed and threaded through `GWLP_USERDATA` — set from the CREATESTRUCT
//! `lpCreateParams` on WM_NCCREATE, reclaimed and dropped on WM_NCDESTROY.

pub mod sys;

use core::ffi::c_void;
use core::mem::{size_of, zeroed};
use core::ptr::{null, null_mut};

use sys::*;

use crate::app::{App, Motion};
use crate::render::Renderer;

/// Per-window state, owned by the window via GWLP_USERDATA.
struct WindowState {
    app: App,
    renderer: Option<Renderer>,
    caret_visible: bool,
    dpi: u32,
    /// View-space scroll offset (content-space DIPs of the viewport top). Wheel + scrollbar
    /// move it (N3c); the renderer translates the text by it. Kept here, not in `app`,
    /// because it is a view quantity, not document state (SCRIPTORIUM-NATIVE-LAYOUT.md §2).
    scroll_y: f32,
    /// The sticky goal column for vertical caret motion: the content-space x (DIP) the caret
    /// aims for on Up/Down/PageUp/PageDown. `None` means "not currently in a vertical run" —
    /// the first vertical move seeds it from the caret's current x and later ones reuse it, so
    /// walking through a short line and back keeps the column. Any horizontal/word/Home/End
    /// motion or edit clears it (SCRIPTORIUM-NATIVE-LAYOUT.md §5). A view quantity (pixels),
    /// so it lives here, not in `app`.
    goal_x: Option<f32>,
    /// Accumulated wheel delta not yet spent as whole notches. High-resolution wheels and
    /// trackpads send deltas smaller than `WHEEL_DELTA`; we bank the remainder across messages
    /// so a slow scroll isn't truncated to nothing (SCRIPTORIUM-NATIVE-LAYOUT.md §6).
    wheel_accum: i32,
}

/// One vertical caret step. Up/Down move by a visual line; the Page variants by a viewport
/// height. All four share the sticky-goal-column mechanic (SCRIPTORIUM-NATIVE-LAYOUT.md §5).
#[derive(Clone, Copy, PartialEq)]
enum VStep {
    Up,
    Down,
    PageUp,
    PageDown,
}

const CARET_TIMER_ID: usize = 1;
const CARET_BLINK_MS: u32 = 530;

/// Open the editor window and pump messages until it closes.
pub fn run() {
    unsafe {
        // DPI awareness day-one (umbrella ledger): physical pixels everywhere, and we
        // scale ourselves. Must precede window creation.
        SetProcessDpiAwarenessContext(dpi_per_monitor_aware_v2());

        let hinstance = GetModuleHandleW(null());
        let class_name = wide("ScriptoriumNativeEditorN0");

        let wc = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW as usize as *const u16),
            hbrBackground: null_mut(), // Direct2D clears; no GDI background erase.
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: null_mut(),
        };
        if RegisterClassExW(&wc) == 0 {
            panic!("RegisterClassExW failed");
        }

        // Box the state and hand its pointer to CreateWindowExW as lpParam; the
        // WndProc adopts it on WM_NCCREATE.
        let state = Box::new(WindowState {
            app: App::new(),
            renderer: None,
            caret_visible: true,
            dpi: 96,
            scroll_y: 0.0,
            goal_x: None,
            wheel_accum: 0,
        });
        let state_ptr = Box::into_raw(state);

        let title = wide("Scriptorium \u{2014} N0");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VSCROLL,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1000,
            700,
            null_mut(),
            null_mut(),
            hinstance,
            state_ptr as *mut c_void,
        );
        if hwnd.is_null() {
            drop(Box::from_raw(state_ptr)); // CreateWindow failed before NCCREATE adopted it.
            panic!("CreateWindowExW failed");
        }

        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);

        let mut msg: MSG = zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        // The boxed state is freed on WM_NCDESTROY.
    }
}

/// The real WndProc, registered with the class. Unwinding a Rust panic across an
/// `extern "system"` boundary into the OS is undefined behavior, so we catch it
/// here: every dispatch runs inside `catch_unwind`, and a panic degrades to
/// `DefWindowProcW` (the window keeps living) instead of corrupting the stack.
/// The state pointer is `AssertUnwindSafe` — we own it and a poisoned edit at
/// worst drops a frame, it can't violate memory safety across the catch.
unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wndproc_impl(hwnd, msg, wparam, lparam)
    }));
    match result {
        Ok(lr) => lr,
        Err(_) => {
            // A handler panicked. Don't let it cross into the OS; fall back to the
            // default proc so the window survives. (stderr already carries the panic.)
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }
}

unsafe fn wndproc_impl(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Adopt the boxed state pointer before anything else needs it.
    if msg == WM_NCCREATE {
        let cs = lparam as *const CREATESTRUCTW;
        let state_ptr = (*cs).lpCreateParams as isize;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr);
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
    if state_ptr.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let state = &mut *state_ptr;

    match msg {
        WM_CREATE => {
            state.dpi = GetDpiForWindow(hwnd);
            match Renderer::new(hwnd, state.dpi) {
                Ok(r) => state.renderer = Some(r),
                Err(hr) => eprintln!("Renderer init failed: 0x{hr:08x}"),
            }
            SetTimer(hwnd, CARET_TIMER_ID, CARET_BLINK_MS, null_mut());
            0
        }
        WM_CHAR => {
            state.app.input_char(wparam as u16);
            // An edit is a horizontal move: it ends any vertical run, so the next Up/Down
            // re-seeds the goal column from the caret's new x (§5).
            state.goal_x = None;
            // Typing at the bottom must keep the caret on screen (scroll-follows-caret, §6).
            ensure_caret_visible(state);
            // An edit makes the caret solid again so it's visible right after typing.
            state.caret_visible = true;
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_KEYDOWN => {
            let shift = key_down(VK_SHIFT);
            let ctrl = key_down(VK_CONTROL);
            let vk = wparam as u32;

            // Map VK (+ modifiers) to one editor action. `None` => not ours, fall through
            // to DefWindowProc (so typing still produces WM_CHAR and system keys behave).
            // Vertical moves keep the goal column; every other handled key clears it (§5),
            // done once after the match so each arm doesn't have to remember.
            let mut handled = true;
            let mut is_vertical = false;
            let mut moves_caret = true;
            match vk {
                VK_LEFT => {
                    let m = if ctrl { Motion::WordLeft } else { Motion::Left };
                    state.app.move_caret(m, shift);
                }
                VK_RIGHT => {
                    let m = if ctrl { Motion::WordRight } else { Motion::Right };
                    state.app.move_caret(m, shift);
                }
                VK_UP => {
                    is_vertical = true;
                    vertical_motion(state, VStep::Up, shift);
                }
                VK_DOWN => {
                    is_vertical = true;
                    vertical_motion(state, VStep::Down, shift);
                }
                VK_PRIOR => {
                    is_vertical = true;
                    vertical_motion(state, VStep::PageUp, shift);
                }
                VK_NEXT => {
                    is_vertical = true;
                    vertical_motion(state, VStep::PageDown, shift);
                }
                VK_HOME => state.app.move_caret(Motion::Home, shift),
                VK_END => state.app.move_caret(Motion::End, shift),
                VK_DELETE => state.app.delete_forward(),
                VK_A if ctrl => state.app.select_all(),
                VK_C if ctrl => {
                    // Copy doesn't move the caret, so it must not yank the view back to it: a
                    // wheel-scrolled reader can copy without the page jumping (§6).
                    clipboard_set(hwnd, &state.app.copy());
                    moves_caret = false;
                }
                VK_X if ctrl => {
                    let cut = state.app.cut();
                    clipboard_set(hwnd, &cut);
                }
                VK_V if ctrl => {
                    if let Some(units) = clipboard_get(hwnd) {
                        state.app.paste(&units);
                    }
                }
                _ => handled = false,
            }

            if handled {
                // End the vertical run on any non-vertical motion so the next Up/Down
                // re-seeds the goal column from the caret's current x (§5).
                if !is_vertical {
                    state.goal_x = None;
                }
                // Scroll-follows-caret: keep the caret on screen after it moves (§6).
                if moves_caret {
                    ensure_caret_visible(state);
                }
                state.caret_visible = true;
                InvalidateRect(hwnd, null(), 0);
                0
            } else {
                // Let DefWindowProc run (so WM_CHAR is generated for typing, etc.).
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
        }
        WM_TIMER => {
            if wparam == CARET_TIMER_ID {
                state.caret_visible = !state.caret_visible;
                InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_MOUSEWHEEL => {
            // The wheel moves the view only — the caret keeps its document offset and scrolls
            // with the content (it may leave the viewport). GET_WHEEL_DELTA_WPARAM is the signed
            // high word; positive = wheel up = scroll toward the top (§6).
            let delta = (((wparam >> 16) & 0xffff) as u16 as i16) as i32;
            wheel_scroll(state, delta);
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_VSCROLL => {
            // The scrollbar: LOWORD is the SB_ request (line/page/thumb/top/bottom). Same view-
            // only semantics as the wheel; the bar itself is re-synced from scroll_y on paint.
            let code = (wparam & 0xffff) as u32;
            vscroll(state, hwnd, code);
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_SIZE => {
            if let Some(r) = state.renderer.as_mut() {
                let w = (lparam & 0xffff) as u32;
                let h = ((lparam >> 16) & 0xffff) as u32;
                r.resize(w, h);
            }
            // The viewport (and thus max_scroll) changed: shrinking can push content past the
            // bottom, growing can leave dead space below the text — re-clamp either way (§6).
            reclamp_scroll(state);
            0
        }
        WM_DPICHANGED => {
            state.dpi = (wparam & 0xffff) as u32; // X DPI in the low word.
            if let Some(r) = state.renderer.as_mut() {
                r.set_dpi(state.dpi);
            }
            // lParam is the suggested new window rect for the target monitor.
            let prc = lparam as *const RECT;
            if !prc.is_null() {
                let rc = &*prc;
                SetWindowPos(
                    hwnd,
                    null_mut(),
                    rc.left,
                    rc.top,
                    rc.right - rc.left,
                    rc.bottom - rc.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            0
        }
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = zeroed();
            BeginPaint(hwnd, &mut ps);
            let mut rc: RECT = zeroed();
            GetClientRect(hwnd, &mut rc);
            if let Some(r) = state.renderer.as_mut() {
                r.draw(
                    &state.app,
                    state.caret_visible,
                    state.scroll_y,
                    (rc.right - rc.left).max(0) as u32,
                    (rc.bottom - rc.top).max(0) as u32,
                );
            }
            // Re-sync the scrollbar thumb from the current geometry + scroll_y every frame. We
            // invalidate after every state change, so paint is the one place guaranteed to see
            // the latest extent (an edit changed content_height, a wheel changed scroll_y).
            update_scrollbar(hwnd, state);
            EndPaint(hwnd, &ps);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, CARET_TIMER_ID);
            PostQuitMessage(0);
            0
        }
        WM_NCDESTROY => {
            // Reclaim and drop the boxed state (also releases the renderer's COM refs).
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Box::from_raw(state_ptr));
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// A nul-terminated UTF-16 string for the wide Win32 APIs.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Is the high (pressed) bit of this virtual key set right now?
unsafe fn key_down(vk: i32) -> bool {
    (GetKeyState(vk) as u16 & 0x8000) != 0
}

/// Move the caret one visual line (Up/Down) or one viewport page (PageUp/PageDown) in the
/// step's direction, aiming at the sticky goal column, then place it via `app.set_caret`
/// (extending the selection when `extend`). This is the win32 conductor for vertical motion
/// (SCRIPTORIUM-NATIVE-LAYOUT.md §5): the renderer owns the *geometry* (where a column lands
/// on the neighbouring line), `app` stays logical (it only learns the resulting offset), and
/// `goal_x` (a pixel column) lives in the view. A no-op until the renderer exists.
unsafe fn vertical_motion(state: &mut WindowState, step: VStep, extend: bool) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    let gen = state.app.content_gen();
    // The caret's current geometry seeds the run and gives the line height for a one-line
    // step. This borrows `app.text` immutably; the `set_caret` below re-borrows `app` mutably
    // only after all geometry work is done — disjoint in time (NLL), and on a different field
    // from the `renderer` borrow held by `r`.
    let (x, y, h) = match r.caret_xywh(&state.app.text, gen, state.app.caret) {
        Some(g) => g,
        None => return,
    };
    // The first vertical move seeds the goal column from the caret's x; later moves in the
    // same run reuse it, so walking through a short line and back keeps the column.
    let gx = *state.goal_x.get_or_insert(x);
    // Aim a hair into the neighbouring line: `−1` sits just above this line's top (Up), `+h`
    // just past its bottom (Down); a page steps a full viewport. Using the caret's own line
    // height (`h`) keeps the one-line step robust to mixed line heights.
    let ty = match step {
        VStep::Up => y - 1.0,
        VStep::Down => y + h,
        VStep::PageUp => y - r.viewport_height(),
        VStep::PageDown => y + r.viewport_height(),
    };
    let mut offset = r.hit_test_content(&state.app.text, gen, gx, ty);
    // A vertical move that can't cross to a new line snaps to the document edge (§5): Down on
    // the last line → doc end, Up on the first → doc start — the Notepad convention. HitTestPoint
    // does NOT do this for us: it clamps `ty` to the nearest line and still resolves `gx`
    // horizontally, so an over-shoot lands at the goal column on the *same* line, not the edge.
    // We detect "didn't cross" by the target offset resolving to a line no further in `step`'s
    // direction than the current one. The doc-edge snap keeps `goal_x` (untouched here), so a
    // reversing move returns to the column.
    let down = matches!(step, VStep::Down | VStep::PageDown);
    let crossed = r.caret_xywh(&state.app.text, gen, offset).map_or(false, |(_, ny, _)| {
        if down { ny > y + 0.5 } else { ny < y - 0.5 }
    });
    if !crossed {
        offset = if down { state.app.text.len() } else { 0 };
    }
    state.app.set_caret(offset, extend);
    // Scroll-follows-caret runs at the WM_KEYDOWN call site (shared with the horizontal
    // motions), so vertical motion past the fold pulls the view along too.
}

// --- scrolling (SCRIPTORIUM-NATIVE-LAYOUT.md §6) ------------------------------
// The scroll math is pure arithmetic over DIP floats (content height, viewport height, caret
// extent), split from the view plumbing so it can be oracled without a window. The wrappers
// below fetch the live geometry from the renderer and apply these.

/// Clamp a scroll offset to `[0, max_scroll]`, where `max_scroll = max(0, content − viewport)`.
/// When the text fits (`content ≤ viewport`) the only legal offset is 0.
fn clamp_scroll(scroll_y: f32, content_h: f32, viewport_h: f32) -> f32 {
    scroll_y.clamp(0.0, (content_h - viewport_h).max(0.0))
}

/// The minimal scroll offset that reveals the caret's vertical extent `[cy, cy+ch]`, then
/// clamped. A caret above the viewport pins to the top, below pins to the bottom, and one
/// already inside leaves the view untouched — so it never scrolls away from a caret that fits.
fn scroll_to_reveal(scroll_y: f32, cy: f32, ch: f32, content_h: f32, viewport_h: f32) -> f32 {
    let adjusted = if cy < scroll_y {
        cy
    } else if cy + ch > scroll_y + viewport_h {
        cy + ch - viewport_h
    } else {
        scroll_y
    };
    clamp_scroll(adjusted, content_h, viewport_h)
}

/// Spend a raw wheel `delta` (signed, in `WHEEL_DELTA` units): bank the sub-notch remainder,
/// convert whole notches to a DIP step (lines · line_height, or a page for `WHEEL_PAGESCROLL`),
/// and move + clamp `scroll_y`. Positive delta scrolls toward the top. No-op without a renderer.
unsafe fn wheel_scroll(state: &mut WindowState, delta: i32) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    state.wheel_accum += delta;
    let notches = state.wheel_accum / WHEEL_DELTA; // toward zero; sub-notch remainder banked
    state.wheel_accum -= notches * WHEEL_DELTA;
    if notches == 0 {
        return; // a sub-notch nudge: banked, nothing to spend yet
    }
    // Lines-per-notch is a user setting; the sentinel WHEEL_PAGESCROLL means "a screen a time".
    let mut lines: u32 = 3;
    SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &mut lines as *mut u32 as *mut c_void, 0);
    let gen = state.app.content_gen();
    let viewport = r.viewport_height();
    let step = if lines == WHEEL_PAGESCROLL {
        viewport
    } else {
        lines as f32 * r.line_height(&state.app.text, gen)
    };
    let content = r.content_height(&state.app.text, gen);
    state.scroll_y = clamp_scroll(state.scroll_y - notches as f32 * step, content, viewport);
}

/// Scroll-follows-caret: after a caret-moving op, scroll the minimum needed to keep the caret
/// on screen (§6). No-op until the renderer + a resolvable caret geometry exist.
unsafe fn ensure_caret_visible(state: &mut WindowState) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    let gen = state.app.content_gen();
    if let Some((_, cy, ch)) = r.caret_xywh(&state.app.text, gen, state.app.caret) {
        let viewport = r.viewport_height();
        let content = r.content_height(&state.app.text, gen);
        state.scroll_y = scroll_to_reveal(state.scroll_y, cy, ch, content, viewport);
    }
}

/// Re-clamp `scroll_y` to the current geometry (after a resize changes viewport / extent).
unsafe fn reclamp_scroll(state: &mut WindowState) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    let gen = state.app.content_gen();
    let viewport = r.viewport_height();
    let content = r.content_height(&state.app.text, gen);
    state.scroll_y = clamp_scroll(state.scroll_y, content, viewport);
}

/// Apply one `WM_VSCROLL` request (line / page / thumb / top / bottom) to `scroll_y`, then
/// clamp. Thumb drags read the 32-bit `nTrackPos` via `GetScrollInfo` because the message's own
/// thumb field is only 16 bits — too narrow for a tall document (§6). No-op without a renderer.
unsafe fn vscroll(state: &mut WindowState, hwnd: HWND, code: u32) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    let gen = state.app.content_gen();
    let viewport = r.viewport_height();
    let content = r.content_height(&state.app.text, gen);
    let line = r.line_height(&state.app.text, gen);
    let target = match code {
        SB_LINEUP => state.scroll_y - line,
        SB_LINEDOWN => state.scroll_y + line,
        SB_PAGEUP => state.scroll_y - viewport,
        SB_PAGEDOWN => state.scroll_y + viewport,
        SB_TOP => 0.0,
        SB_BOTTOM => (content - viewport).max(0.0),
        SB_THUMBTRACK | SB_THUMBPOSITION => {
            let mut si: SCROLLINFO = zeroed();
            si.cbSize = size_of::<SCROLLINFO>() as u32;
            si.fMask = SIF_TRACKPOS;
            if GetScrollInfo(hwnd, SB_VERT, &mut si) != 0 {
                si.nTrackPos as f32
            } else {
                state.scroll_y
            }
        }
        _ => return, // SB_ENDSCROLL and friends: nothing to do
    };
    state.scroll_y = clamp_scroll(target, content, viewport);
}

/// Mirror `scroll_y` and the document extent onto the vertical scrollbar so the thumb's size
/// and position track the view. Range is `[0, content]` in integer DIPs, page = viewport (so a
/// short doc shows a full/disabled bar); `nPos = scroll_y`. Called each frame from paint.
unsafe fn update_scrollbar(hwnd: HWND, state: &mut WindowState) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    let gen = state.app.content_gen();
    let viewport = r.viewport_height();
    let content = r.content_height(&state.app.text, gen);
    let si = SCROLLINFO {
        cbSize: size_of::<SCROLLINFO>() as u32,
        fMask: SIF_RANGE | SIF_PAGE | SIF_POS,
        nMin: 0,
        nMax: content.ceil() as i32,
        nPage: viewport.max(0.0) as u32,
        nPos: state.scroll_y as i32,
        nTrackPos: 0,
    };
    SetScrollInfo(hwnd, SB_VERT, &si, 1);
}

/// Put `units` on the system clipboard as CF_UNICODETEXT (nul-terminated). Best-effort:
/// on any failure we just close the clipboard and move on — clipboard ops never panic.
unsafe fn clipboard_set(hwnd: HWND, units: &[u16]) {
    if OpenClipboard(hwnd) == 0 {
        return;
    }
    EmptyClipboard();
    let count = units.len() + 1; // + nul terminator
    let hmem = GlobalAlloc(GMEM_MOVEABLE, count * 2);
    if !hmem.is_null() {
        let p = GlobalLock(hmem) as *mut u16;
        if !p.is_null() {
            core::ptr::copy_nonoverlapping(units.as_ptr(), p, units.len());
            *p.add(units.len()) = 0;
            GlobalUnlock(hmem);
            // On success the clipboard takes ownership of hmem; we must not free it.
            SetClipboardData(CF_UNICODETEXT, hmem);
        }
    }
    CloseClipboard();
}

/// Read CF_UNICODETEXT off the clipboard, normalizing CRLF/CR to our LF-only buffer.
/// Returns None when there's no text or the clipboard can't be opened.
unsafe fn clipboard_get(hwnd: HWND) -> Option<Vec<u16>> {
    if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 || OpenClipboard(hwnd) == 0 {
        return None;
    }
    let mut out = None;
    let hmem = GetClipboardData(CF_UNICODETEXT);
    if !hmem.is_null() {
        let p = GlobalLock(hmem) as *const u16;
        if !p.is_null() {
            let max = GlobalSize(hmem) / 2;
            let mut v: Vec<u16> = Vec::new();
            let mut i = 0;
            while i < max {
                let u = *p.add(i);
                if u == 0 {
                    break;
                }
                // CRLF -> LF, lone CR -> LF (the buffer is LF-only).
                if u == 0x000D {
                    v.push(0x000A);
                    if i + 1 < max && *p.add(i + 1) == 0x000A {
                        i += 1;
                    }
                } else {
                    v.push(u);
                }
                i += 1;
            }
            GlobalUnlock(hmem);
            out = Some(v);
        }
    }
    CloseClipboard();
    out
}

// --- scroll-math oracles (SCRIPTORIUM-NATIVE-LAYOUT.md §7) --------------------
// Pure arithmetic — no DWrite or window needed — so the clamp invariants and the
// scroll-follows-caret contract (minimal, edge-pinning, idempotent) are pinned deterministically.
#[cfg(test)]
mod scroll_tests {
    use super::{clamp_scroll, scroll_to_reveal};

    #[test]
    fn scroll_clamps_to_range() {
        // In-range stays; over/under clamp to [0, max_scroll] where max_scroll = content−viewport.
        assert_eq!(clamp_scroll(50.0, 1000.0, 400.0), 50.0);
        assert_eq!(clamp_scroll(-10.0, 1000.0, 400.0), 0.0);
        assert_eq!(clamp_scroll(9999.0, 1000.0, 400.0), 600.0);
        // Content fits in the viewport ⇒ max_scroll 0 ⇒ only 0 is legal.
        assert_eq!(clamp_scroll(50.0, 300.0, 400.0), 0.0);
    }

    #[test]
    fn reveal_pins_caret_to_the_nearer_edge() {
        let (content, vp) = (2000.0, 400.0);
        // Caret above the view pins it to the viewport top; below pins to the bottom
        // (scroll = cy+ch−viewport); already inside leaves the view untouched.
        assert_eq!(scroll_to_reveal(500.0, 480.0, 20.0, content, vp), 480.0);
        assert_eq!(scroll_to_reveal(0.0, 700.0, 20.0, content, vp), 320.0);
        assert_eq!(scroll_to_reveal(100.0, 200.0, 20.0, content, vp), 100.0);
    }

    #[test]
    fn reveal_is_idempotent_and_keeps_the_caret_visible() {
        let (content, vp, ch) = (2000.0, 400.0, 20.0);
        for &(s, cy) in &[(0.0f32, 700.0f32), (500.0, 480.0), (100.0, 200.0), (1500.0, 50.0)] {
            let once = scroll_to_reveal(s, cy, ch, content, vp);
            let twice = scroll_to_reveal(once, cy, ch, content, vp);
            assert_eq!(once, twice, "reveal must be idempotent (running it twice is a no-op)");
            // A caret that fits in a viewport must actually be inside it afterwards.
            assert!(
                cy >= once - 0.01 && cy + ch <= once + vp + 0.01,
                "caret must be visible after reveal: cy={cy} scroll={once}"
            );
        }
    }
}

// --- windowed lifecycle smoke test (feature = "smoke") -----------------------
// The breadth check the unit oracles can't give: a *real* window, driven through
// its own WndProc with synthetic input, painted, and torn down — proving the whole
// CREATE → input → paint → DESTROY chain (GWLP_USERDATA threading, the box adopt/drop,
// the message routing) holds together on a live OS. It needs a window station, so it's
// Windows-only, #[ignore]'d, and gated behind the `smoke` feature so a regression here
// can't break the main gate. CI runs it informationally (continue-on-error).
#[cfg(all(test, windows, feature = "smoke"))]
mod smoke_tests {
    use super::*;

    #[test]
    #[ignore = "windowed; run with: cargo test --features smoke -- --ignored"]
    fn window_lifecycle_survives_synthetic_input() {
        unsafe {
            SetProcessDpiAwarenessContext(dpi_per_monitor_aware_v2());
            let hinstance = GetModuleHandleW(null());
            let class_name = wide("ScriptoriumSmokeTestN0");

            let wc = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: null_mut(),
                hCursor: LoadCursorW(null_mut(), IDC_ARROW as usize as *const u16),
                hbrBackground: null_mut(),
                lpszMenuName: null(),
                lpszClassName: class_name.as_ptr(),
                hIconSm: null_mut(),
            };
            assert!(RegisterClassExW(&wc) != 0, "RegisterClassExW failed");

            let state = Box::new(WindowState {
                app: App::new(),
                renderer: None,
                caret_visible: true,
                dpi: 96,
                scroll_y: 0.0,
                goal_x: None,
                wheel_accum: 0,
            });
            let state_ptr = Box::into_raw(state);

            let title = wide("smoke");
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VSCROLL, // a real bar for Set/GetScrollInfo to drive
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                800,
                600,
                null_mut(),
                null_mut(),
                hinstance,
                state_ptr as *mut c_void,
            );
            assert!(!hwnd.is_null(), "CreateWindowExW failed");

            // CREATE already ran synchronously; the box pointer is now owned by the
            // window. Read state back through GWLP_USERDATA from here on.
            ShowWindow(hwnd, SW_SHOW);

            // Type "Hi" — two synchronous WM_CHARs straight into the WndProc.
            SendMessageW(hwnd, WM_CHAR, 'H' as usize, 0);
            SendMessageW(hwnd, WM_CHAR, 'i' as usize, 0);
            // Move the caret left once (no Shift held → non-extending).
            SendMessageW(hwnd, WM_KEYDOWN, VK_LEFT as usize, 0);
            // Drive the vertical family through the real WndProc so `vertical_motion` runs its
            // caret_xywh → hit_test_content geometry on real DirectWrite (single-line text, so
            // these clamp rather than move). Exercises the N3b path end-to-end; must not panic.
            SendMessageW(hwnd, WM_KEYDOWN, VK_DOWN as usize, 0);
            SendMessageW(hwnd, WM_KEYDOWN, VK_UP as usize, 0);
            // A wheel notch (delta in the high word) runs `wheel_scroll` on the live renderer:
            // SystemParametersInfoW + content_height/line_height on real DWrite. Short text
            // fits, so max_scroll is 0 and it clamps to 0 — the path runs, must not panic.
            SendMessageW(hwnd, WM_MOUSEWHEEL, (WHEEL_DELTA as usize) << 16, 0);
            // The scrollbar path: a line-down request and a thumb-track (the latter reads the
            // 32-bit nTrackPos via GetScrollInfo). update_scrollbar (SetScrollInfo) runs on the
            // WM_PAINT below. Exercises the new Set/GetScrollInfo FFI on a real WS_VSCROLL bar.
            SendMessageW(hwnd, WM_VSCROLL, SB_LINEDOWN as usize, 0);
            SendMessageW(hwnd, WM_VSCROLL, SB_THUMBTRACK as usize, 0);

            // Exercise resize (incl. the 0x0 minimize guard) and a caret-blink tick.
            SendMessageW(hwnd, WM_SIZE, 0, (600isize << 16) | 800);
            SendMessageW(hwnd, WM_SIZE, 0, 0); // minimize: must be a no-op, not a panic.
            SendMessageW(hwnd, WM_TIMER, CARET_TIMER_ID, 0);

            // Force a paint through the real WM_PAINT path.
            InvalidateRect(hwnd, null(), 0);
            UpdateWindow(hwnd);
            SendMessageW(hwnd, WM_PAINT, 0, 0);

            // Drive a selection directly (synthetic Shift can't move GetKeyState) and
            // paint again, so the selection path exercises IDWriteTextLayout::
            // HitTestTextRange (vtbl slot 66) on real DirectWrite — the same
            // never-been-called-slot risk that the draw_text_layout AV came from.
            let stm = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
            stm.app.select_all();
            assert!(stm.app.has_selection(), "select_all should select the typed text");
            InvalidateRect(hwnd, null(), 0);
            SendMessageW(hwnd, WM_PAINT, 0, 0);

            // Exercise the N3 geometry service on the live renderer + real DirectWrite: this
            // CALLS the newly-typed HitTestPoint (64) and GetMetrics (60) slots through the
            // cached layout — the never-been-called-slot guard (the phantom draw_mesh AV).
            if let Some(r) = stm.renderer.as_mut() {
                let gen = stm.app.content_gen();
                assert!(
                    r.caret_xywh(&stm.app.text, gen, 1).is_some(),
                    "caret_xywh should resolve on real DWrite"
                );
                assert!(
                    r.content_height(&stm.app.text, gen) > 0.0,
                    "content_height (GetMetrics) should be positive"
                );
                // A click near the top-left should land at/just after the first glyph.
                let off = r.hit_test_point(&stm.app.text, gen, 18, 18, 0.0);
                assert!(off <= stm.app.text.len(), "hit-test offset must be in range");
            }

            // Read the buffer state back out of the live window before we destroy it.
            let st = &*(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
            assert_eq!(st.app.text.len(), 2, "expected two typed units");
            assert_eq!(st.app.selection(), (0, 2), "whole document should be selected");

            // Tear down — WM_DESTROY + WM_NCDESTROY run synchronously and drop the box.
            assert!(DestroyWindow(hwnd) != 0, "DestroyWindow failed");
            // state_ptr is freed now; do not touch it.
        }
    }
}
