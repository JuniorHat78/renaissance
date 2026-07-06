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
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use sys::*;

use crate::app::{App, Motion};
use crate::grapheme;
use crate::parse::ParseService;
use crate::render::Renderer;

/// Per-window state, owned by the window via GWLP_USERDATA.
struct WindowState {
    app: App,
    renderer: Option<Renderer>,
    /// The off-thread parser (N4; SCRIPTORIUM-NATIVE-CONCURRENCY.md). `Option` because it is
    /// spawned in `WM_CREATE` — the wake closure needs the `HWND`, which doesn't exist until then.
    /// Dropping it (on `WM_NCDESTROY`) stops and joins the worker (leak-free teardown, §6).
    parse: Option<ParseService>,
    /// The last generation handed to the parser, so `reparse_if_dirty` submits at most once per
    /// edit and a no-op key never resubmits (the coalescing is on the worker; this is the guard).
    last_submitted_gen: u64,
    /// When the most recent edit was submitted — the start of the end-to-end async round-trip
    /// timer (N4b). Taken when the settling result lands, to measure submit→landed felt latency.
    edit_at: Option<Instant>,
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
    /// A left-button drag is in progress (capture held, selection tracking the pointer).
    selecting: bool,
    /// The drag-autoscroll timer is running (pointer held past a viewport edge).
    autoscrolling: bool,
    /// Rolling click count (1 = single, 2 = double/word, 3 = triple/line), advanced when a
    /// press falls within `GetDoubleClickTime` and the `SM_C?DOUBLECLK` box of the last (§4).
    click_count: u32,
    /// `GetMessageTime` of the last button-down, and its physical-pixel position — the
    /// reference the next press is measured against for the click-count classification.
    last_click_ms: i32,
    last_click_x: i32,
    last_click_y: i32,
    /// The most recent pointer position (physical px), kept so autoscroll ticks can re-hit-test
    /// at the held pointer even while it isn't moving.
    last_mouse_x: i32,
    last_mouse_y: i32,
    /// The granularity a drag extends by — set by the initiating click (single → char,
    /// double → word, triple → line) so dragging grows the selection in whole units (§4).
    drag_mode: DragMode,
    /// The anchored range fixed for the duration of the drag: the initial caret for a single
    /// click, or the whole word/line for a double/triple. Drag extension pivots around it.
    sel_origin: (usize, usize),
    /// The window title last handed to `SetWindowTextW` (SCRIPTORIUM-NATIVE-IO.md §6). Kept so
    /// `update_title` only calls the OS when the displayed string actually changes — the dirty
    /// marker rides the paint path, and we don't want to retitle on every keystroke.
    title: String,
}

/// The unit a drag extends the selection by, fixed by the click that began it (§4).
#[derive(Clone, Copy, PartialEq)]
enum DragMode {
    Char,
    Word,
    Line,
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
/// Second timer: while a drag holds past a viewport edge, this ticks to roll the view (and
/// re-extend the selection) toward the pointer. One line per tick at ~25 Hz — a steady,
/// tunable crawl (SCRIPTORIUM-NATIVE-LAYOUT.md §4).
const AUTOSCROLL_TIMER_ID: usize = 2;
const AUTOSCROLL_MS: u32 = 40;

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
            parse: None,
            last_submitted_gen: 0,
            edit_at: None,
            caret_visible: true,
            dpi: 96,
            scroll_y: 0.0,
            goal_x: None,
            wheel_accum: 0,
            selecting: false,
            autoscrolling: false,
            click_count: 0,
            last_click_ms: 0,
            last_click_x: 0,
            last_click_y: 0,
            last_mouse_x: 0,
            last_mouse_y: 0,
            drag_mode: DragMode::Char,
            sel_origin: (0, 0),
            title: String::new(),
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
            // Spawn the off-thread parser now that we have an HWND to post the wake to (N4). The
            // wake captures the HWND as a `usize` (a raw HWND isn't `Send`) and posts a contentless
            // WM_APP_PARSE_DONE from the worker thread to nudge this pump. Then seed the first parse.
            let hwnd_usize = hwnd as usize;
            let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || unsafe {
                PostMessageW(hwnd_usize as HWND, WM_APP_PARSE_DONE, 0, 0);
            });
            state.parse = Some(ParseService::new(wake));
            reparse_if_dirty(state);
            0
        }
        WM_CHAR => {
            state.app.input_char(wparam as u16);
            // An edit is a horizontal move: it ends any vertical run, so the next Up/Down
            // re-seeds the goal column from the caret's new x (§5).
            state.goal_x = None;
            // Hand the new content to the off-thread parser (N4). No-op if nothing changed.
            reparse_if_dirty(state);
            // Typing at the bottom must keep the caret on screen (scroll-follows-caret, §6).
            ensure_caret_visible(state);
            // An edit makes the caret solid again so it's visible right after typing.
            state.caret_visible = true;
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_APP_PARSE_DONE => {
            // The off-thread worker finished a parse and nudged us (N4). Drain to the newest result
            // and fold it in under the monotonic gate; repaint the status line only if it applied.
            let res = state.parse.as_ref().and_then(|p| p.drain_latest());
            if let Some(r) = res {
                let gen = r.gen;
                if state.app.apply_parse(gen, r.signal, r.styles) {
                    // If this result brought the display level with the live content (no newer edit
                    // is pending), the async round-trip for the settled edit is complete — record
                    // the submit→landed latency (N4b). A newer edit in flight defers the measure.
                    if gen == state.app.content_gen() {
                        if let Some(t) = state.edit_at.take() {
                            state.app.set_roundtrip(t.elapsed().as_micros());
                        }
                    }
                    InvalidateRect(hwnd, null(), 0);
                }
            }
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
                // File I/O (SCRIPTORIUM-NATIVE-IO.md §5). These aren't caret motions (a load homes
                // the caret + view itself), so `moves_caret = false` keeps the shared tail from
                // yanking the view; the tail's `reparse_if_dirty` still submits a load's new content.
                VK_O if ctrl => {
                    do_open(state, hwnd);
                    moves_caret = false;
                }
                VK_N if ctrl => {
                    do_new(state, hwnd);
                    moves_caret = false;
                }
                VK_S if ctrl && shift => {
                    do_save(state, hwnd, true);
                    moves_caret = false;
                }
                VK_S if ctrl => {
                    do_save(state, hwnd, false);
                    moves_caret = false;
                }
                _ => handled = false,
            }

            if handled {
                // End the vertical run on any non-vertical motion so the next Up/Down
                // re-seeds the goal column from the caret's current x (§5).
                if !is_vertical {
                    state.goal_x = None;
                }
                // Editing keys (Delete/Cut/Paste) changed content — submit a reparse (N4). A
                // pure motion leaves content_gen untouched, so this no-ops for those.
                reparse_if_dirty(state);
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
            } else if wparam == AUTOSCROLL_TIMER_ID {
                autoscroll_tick(state, hwnd);
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
        WM_LBUTTONDOWN => {
            mouse_down(state, hwnd, get_x_lparam(lparam), get_y_lparam(lparam), key_down(VK_SHIFT));
            0
        }
        WM_MOUSEMOVE => {
            // Only while we own the drag and the button is still down (the wParam flag guards
            // against a stray move after a lost/synthetic release).
            if state.selecting && (wparam & MK_LBUTTON) != 0 {
                mouse_drag(state, hwnd, get_x_lparam(lparam), get_y_lparam(lparam));
            }
            0
        }
        WM_LBUTTONUP => {
            mouse_up(state, hwnd);
            0
        }
        WM_CAPTURECHANGED => {
            // Capture yanked away (another window, Alt+Tab, a menu): end the drag cleanly so we
            // don't keep extending a selection we can no longer see the pointer for.
            end_drag(state, hwnd);
            0
        }
        WM_IME_STARTCOMPOSITION => {
            // A composition session begins. We draw the composition inline ourselves, so pin the
            // candidate window at the caret and return 0 WITHOUT DefWindowProc — that suppresses
            // the OS's default gray composition box (SCRIPTORIUM-NATIVE-IME.md §3).
            let himc = ImmGetContext(hwnd);
            if !himc.is_null() {
                set_ime_candidate_pos(state, hwnd, himc);
                ImmReleaseContext(hwnd, himc);
            }
            0
        }
        WM_IME_COMPOSITION => {
            ime_composition(state, hwnd, lparam as u32);
            // Handled — do NOT DefWindowProc: forwarding a GCS_RESULTSTR would synthesize a
            // WM_IME_CHAR and insert the result a second time (§4, the double-insert edge).
            0
        }
        WM_IME_ENDCOMPOSITION => {
            // A commit already fired via GCS_RESULTSTR if there was one; a bare end is a cancel.
            state.app.clear_composition();
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_IME_CHAR => {
            // The result already committed via GCS_RESULTSTR; swallow so it can't insert twice.
            0
        }
        WM_KILLFOCUS => {
            // Finalize a composition-in-progress so focus loss never strands provisional text:
            // ask the IME to complete (it commits via a synchronous GCS_RESULTSTR), then clear.
            if state.app.composition().is_some() {
                let himc = ImmGetContext(hwnd);
                if !himc.is_null() {
                    ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_COMPLETE, 0);
                    ImmReleaseContext(hwnd, himc);
                }
                state.app.clear_composition();
                InvalidateRect(hwnd, null(), 0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
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
                // `scroll_y` is `&mut`: virtualized paint may scroll-anchor it (N5 §5) when
                // measuring a paragraph corrects the content above the viewport — the nudged value
                // is persisted so the anchor holds across frames.
                r.draw(
                    &state.app,
                    state.caret_visible,
                    &mut state.scroll_y,
                    (rc.right - rc.left).max(0) as u32,
                    (rc.bottom - rc.top).max(0) as u32,
                );
            }
            // Re-sync the scrollbar thumb from the current geometry + scroll_y every frame. We
            // invalidate after every state change, so paint is the one place guaranteed to see
            // the latest extent (an edit changed content_height, a wheel changed scroll_y).
            update_scrollbar(hwnd, state);
            // The title (document name + dirty marker) also rides the paint path — cheap because
            // `update_title` only calls SetWindowTextW when the string actually changed (§6).
            update_title(state, hwnd);
            EndPaint(hwnd, &ps);
            0
        }
        WM_CLOSE => {
            // The ✕ / Alt+F4: guard unsaved work before we tear the window down (§5). The guard
            // returns whether to proceed — Cancel (or a failed save) aborts the close entirely.
            if confirm_discard(state, hwnd) {
                DestroyWindow(hwnd);
            }
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

/// Submit a fresh parse to the off-thread worker iff the content changed since the last submit
/// (N4; SCRIPTORIUM-NATIVE-CONCURRENCY.md §6). Hands the worker an O(1) immutable `snapshot()` —
/// the UI thread never blocks, and the worker never touches `App`. Called from every content-
/// mutating handler; the `content_gen` guard makes calling it from a no-op key harmless.
fn reparse_if_dirty(state: &mut WindowState) {
    let gen = state.app.content_gen();
    if gen != state.last_submitted_gen {
        if let Some(p) = state.parse.as_ref() {
            p.submit(gen, state.app.snapshot());
            state.last_submitted_gen = gen;
            // Start the end-to-end round-trip timer for this edit (N4b). Overwriting on each edit
            // means it tracks the *latest* edit — the one whose settling is the felt latency.
            state.edit_at = Some(Instant::now());
        }
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
    // The DISPLAY caret (composition-aware): while composing, follow the caret inside the
    // provisional string, so typing a long composition past the fold pulls the view along.
    if let Some((_, cy, ch)) = r.display_caret_xywh(&state.app) {
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

/// Move + clamp `scroll_y` by `dy` DIPs (autoscroll steps; positive scrolls down). No-op
/// without a renderer.
unsafe fn scroll_by(state: &mut WindowState, dy: f32) {
    let r = match state.renderer.as_mut() {
        Some(r) => r,
        None => return,
    };
    let gen = state.app.content_gen();
    let viewport = r.viewport_height();
    let content = r.content_height(&state.app.text, gen);
    state.scroll_y = clamp_scroll(state.scroll_y + dy, content, viewport);
}

// --- mouse: click-to-place, drag-select, double/triple, autoscroll (§4) -------

/// The low / high signed 16-bit halves of an lParam — a mouse point's client-pixel x / y.
fn get_x_lparam(lp: LPARAM) -> i32 {
    (lp & 0xffff) as u16 as i16 as i32
}
fn get_y_lparam(lp: LPARAM) -> i32 {
    ((lp >> 16) & 0xffff) as u16 as i16 as i32
}

/// The half-open `[start, end)` of the line containing `offset`, newline excluded — the Home/End
/// span a triple-click selects.
fn line_bounds(text: &[u16], offset: usize) -> (usize, usize) {
    let len = text.len();
    let o = offset.min(len);
    let mut s = o;
    while s > 0 && text[s - 1] != 0x000A {
        s -= 1;
    }
    let mut e = o;
    while e < len && text[e] != 0x000A {
        e += 1;
    }
    (s, e)
}

/// Given the drag granularity, the fixed origin range, and the offset now under the pointer,
/// return the `(anchor, caret)` the selection should take. Char drags pivot on the origin
/// caret; Word/Line drags grow in whole units, flipping the anchor to the origin's far edge
/// when the pointer crosses to the other side (§4). Pure — oracle-tested without a window.
fn extend_selection(mode: DragMode, origin: (usize, usize), offset: usize, text: &[u16]) -> (usize, usize) {
    let (lo, hi) = origin;
    match mode {
        DragMode::Char => (lo, offset),
        DragMode::Word => {
            if offset > hi {
                (lo, grapheme::word_at(text, offset).1)
            } else if offset < lo {
                (hi, grapheme::word_at(text, offset).0)
            } else {
                (lo, hi)
            }
        }
        DragMode::Line => {
            if offset > hi {
                (lo, line_bounds(text, offset).1)
            } else if offset < lo {
                (hi, line_bounds(text, offset).0)
            } else {
                (lo, hi)
            }
        }
    }
}

/// Resolve a client-pixel point to a caret offset via the geometry service (unclamped: an
/// initial click is inside the window, and a click below the last line should land at the
/// nearest cluster, which DWrite already gives us). None without a renderer.
unsafe fn hit_offset(state: &mut WindowState, px: i32, py: i32) -> Option<usize> {
    let r = state.renderer.as_mut()?;
    let gen = state.app.content_gen();
    Some(r.hit_test_point(&state.app.text, gen, px, py, state.scroll_y))
}

/// Left button pressed: classify the click count, place/extend/word/line-select accordingly,
/// and begin a captured drag (§4).
unsafe fn mouse_down(state: &mut WindowState, hwnd: HWND, px: i32, py: i32, shift: bool) {
    let offset = match hit_offset(state, px, py) {
        Some(o) => o,
        None => return,
    };
    // A press close in time AND space to the previous advances the count (1→2→3→1); otherwise
    // it restarts at a single click. SM_C?DOUBLECLK is the full box, so the tolerance is half.
    let now = GetMessageTime();
    let within_time = now.wrapping_sub(state.last_click_ms) as u32 <= GetDoubleClickTime();
    let within_box = (px - state.last_click_x).abs() <= GetSystemMetrics(SM_CXDOUBLECLK) / 2
        && (py - state.last_click_y).abs() <= GetSystemMetrics(SM_CYDOUBLECLK) / 2;
    state.click_count = if within_time && within_box { state.click_count % 3 + 1 } else { 1 };
    state.last_click_ms = now;
    state.last_click_x = px;
    state.last_click_y = py;
    state.last_mouse_x = px;
    state.last_mouse_y = py;
    // A click is a horizontal placement: it ends any vertical goal-column run (§5).
    state.goal_x = None;

    if shift {
        // Shift-click extends the existing selection to the click (character granularity).
        state.app.set_caret(offset, true);
        state.drag_mode = DragMode::Char;
        state.sel_origin = (state.app.anchor, state.app.anchor);
    } else {
        match state.click_count {
            2 => {
                let (s, e) = grapheme::word_at(&state.app.text, offset);
                state.app.set_selection(s, e);
                state.drag_mode = DragMode::Word;
                state.sel_origin = (s, e);
            }
            3 => {
                let (s, e) = line_bounds(&state.app.text, offset);
                state.app.set_selection(s, e);
                state.drag_mode = DragMode::Line;
                state.sel_origin = (s, e);
            }
            _ => {
                state.app.set_caret(offset, false);
                state.drag_mode = DragMode::Char;
                state.sel_origin = (offset, offset);
            }
        }
    }

    SetCapture(hwnd); // track the drag even when the pointer leaves the window
    state.selecting = true;
    state.caret_visible = true;
    // Clicking visible text shouldn't jolt the view, so no ensure_caret_visible on the click.
    InvalidateRect(hwnd, null(), 0);
}

/// Pointer moved during a captured drag: re-hit-test (clamped to the visible band) and extend
/// the selection by the drag's granularity, arming/disarming autoscroll at the edges (§4).
unsafe fn mouse_drag(state: &mut WindowState, hwnd: HWND, px: i32, py: i32) {
    state.last_mouse_x = px;
    state.last_mouse_y = py;
    drag_extend(state);

    let edge = match state.renderer.as_ref() {
        Some(r) => r.edge_of_py(py, state.scroll_y),
        None => 0,
    };
    if edge != 0 && !state.autoscrolling {
        SetTimer(hwnd, AUTOSCROLL_TIMER_ID, AUTOSCROLL_MS, null_mut());
        state.autoscrolling = true;
    } else if edge == 0 && state.autoscrolling {
        KillTimer(hwnd, AUTOSCROLL_TIMER_ID);
        state.autoscrolling = false;
    }
    InvalidateRect(hwnd, null(), 0);
}

/// Re-hit-test the held pointer (clamped to the visible band) and set the selection to the
/// granularity-extended range. Shared by drag moves and autoscroll ticks.
unsafe fn drag_extend(state: &mut WindowState) {
    let offset = match state.renderer.as_mut() {
        Some(r) => r.hit_test_point_clamped(
            &state.app.text,
            state.app.content_gen(),
            state.last_mouse_x,
            state.last_mouse_y,
            state.scroll_y,
        ),
        None => return,
    };
    let (anchor, caret) = extend_selection(state.drag_mode, state.sel_origin, offset, &state.app.text);
    state.app.set_selection(anchor, caret);
}

/// Autoscroll tick: while the drag holds past a viewport edge, roll the view one line toward the
/// pointer and re-extend the selection to the new visible edge (§4).
unsafe fn autoscroll_tick(state: &mut WindowState, hwnd: HWND) {
    if !state.selecting {
        return;
    }
    let (dir, line) = match state.renderer.as_mut() {
        Some(r) => (
            r.edge_of_py(state.last_mouse_y, state.scroll_y),
            r.line_height(&state.app.text, state.app.content_gen()),
        ),
        None => return,
    };
    if dir == 0 {
        return; // pointer wandered back inside between ticks; the next move will disarm us
    }
    scroll_by(state, dir as f32 * line);
    drag_extend(state);
    InvalidateRect(hwnd, null(), 0);
}

/// Left button released: drop capture (which also fires WM_CAPTURECHANGED) and end the drag.
unsafe fn mouse_up(state: &mut WindowState, hwnd: HWND) {
    if state.selecting {
        ReleaseCapture();
    }
    end_drag(state, hwnd);
}

/// End a drag from any cause (button up or capture stolen): stop tracking and stop autoscroll.
/// Idempotent — safe to run twice (release then the WM_CAPTURECHANGED it triggers).
unsafe fn end_drag(state: &mut WindowState, hwnd: HWND) {
    state.selecting = false;
    if state.autoscrolling {
        KillTimer(hwnd, AUTOSCROLL_TIMER_ID);
        state.autoscrolling = false;
    }
}

// --- IME composition (SCRIPTORIUM-NATIVE-IME.md §3) ---------------------------

/// Handle one `WM_IME_COMPOSITION`: commit the finalized string (`GCS_RESULTSTR`) and/or update
/// the provisional one (`GCS_COMPSTR` + caret + target clause), then follow the caret and repaint.
/// `gcs` is the lParam flag mask.
unsafe fn ime_composition(state: &mut WindowState, hwnd: HWND, gcs: u32) {
    let himc = ImmGetContext(hwnd);
    if himc.is_null() {
        return;
    }
    // A single message can carry both (an IME can commit one clause while composing the next):
    // handle the result first, then the in-progress string.
    if gcs & GCS_RESULTSTR != 0 {
        let result = ime_get_string(himc, GCS_RESULTSTR);
        state.app.commit_composition(&result);
        state.goal_x = None; // a commit is a horizontal placement (§5-adjacent, cf. N3b §5)
    }
    if gcs & GCS_COMPSTR != 0 {
        let comp = ime_get_string(himc, GCS_COMPSTR);
        if comp.is_empty() {
            state.app.clear_composition();
        } else {
            let caret = ImmGetCompositionStringW(himc, GCS_CURSORPOS, null_mut(), 0);
            let caret_units = if caret < 0 { 0 } else { caret as usize };
            let attrs = ime_get_attrs(himc);
            state.app.set_composition(&comp, caret_units, target_clause(&attrs));
        }
        set_ime_candidate_pos(state, hwnd, himc);
    }
    ImmReleaseContext(hwnd, himc);
    // A GCS_RESULTSTR commit folded provisional text into the rope — submit a reparse (N4).
    // Provisional-only composition updates don't touch the rope, so this no-ops for those.
    reparse_if_dirty(state);
    state.caret_visible = true;
    ensure_caret_visible(state);
    InvalidateRect(hwnd, null(), 0);
}

/// Read a UTF-16 composition slice (`GCS_COMPSTR` / `GCS_RESULTSTR`). ImmGetCompositionStringW
/// with a null buffer returns the byte size; call again to fill, then halve for the unit count.
unsafe fn ime_get_string(himc: HIMC, index: u32) -> Vec<u16> {
    let bytes = ImmGetCompositionStringW(himc, index, null_mut(), 0);
    if bytes <= 0 {
        return Vec::new();
    }
    let units = bytes as usize / 2;
    let mut buf = vec![0u16; units];
    let got = ImmGetCompositionStringW(himc, index, buf.as_mut_ptr() as *mut c_void, bytes as u32);
    if got < 0 {
        return Vec::new();
    }
    buf.truncate((got as usize / 2).min(units));
    buf
}

/// Read the per-unit attribute bytes (`GCS_COMPATTR`) — one `ATTR_*` per composition unit.
unsafe fn ime_get_attrs(himc: HIMC) -> Vec<u8> {
    let bytes = ImmGetCompositionStringW(himc, GCS_COMPATTR, null_mut(), 0);
    if bytes <= 0 {
        return Vec::new();
    }
    let mut buf = vec![0u8; bytes as usize];
    let got = ImmGetCompositionStringW(himc, GCS_COMPATTR, buf.as_mut_ptr() as *mut c_void, bytes as u32);
    if got < 0 {
        return Vec::new();
    }
    buf.truncate((got as usize).min(buf.len()));
    buf
}

/// The target clause `[start, end)` — the maximal run of target attributes (converting or
/// not-yet-converted), the segment the candidate list acts on. `(0, 0)` when there is none.
fn target_clause(attrs: &[u8]) -> (usize, usize) {
    let mut start = None;
    let mut end = 0;
    for (i, &a) in attrs.iter().enumerate() {
        if a == ATTR_TARGET_CONVERTED || a == ATTR_TARGET_NOTCONVERTED {
            if start.is_none() {
                start = Some(i);
            }
            end = i + 1;
        }
    }
    match start {
        Some(s) => (s, end),
        None => (0, 0),
    }
}

/// Pin the IME candidate window at the caret in client pixels (`CFS_POINT | CFS_FORCE_POSITION`),
/// so the candidate list appears under the caret rather than the window origin (§6).
unsafe fn set_ime_candidate_pos(state: &mut WindowState, hwnd: HWND, himc: HIMC) {
    let pt = match state.renderer.as_mut() {
        Some(r) => r.display_caret_client_px(&state.app, state.scroll_y),
        None => None,
    };
    if let Some((x, y)) = pt {
        let mut rc: RECT = zeroed();
        GetClientRect(hwnd, &mut rc);
        let form = COMPOSITIONFORM {
            dwStyle: CFS_POINT | CFS_FORCE_POSITION,
            ptCurrentPos: POINT { x, y },
            rcArea: rc,
        };
        ImmSetCompositionWindow(himc, &form);
    }
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

// --- file I/O: open / save / discard guard (SCRIPTORIUM-NATIVE-IO.md §5) ------
// The dialogs + message boxes + the byte read/write. The pure codec (bytes<->buffer) and the
// dirty-state machine live in `codec`/`app`; this is the OS-facing shell. `load_from`/`save_to`
// are the dialog-free cores (used by the handlers below AND driven directly by the smoke test,
// since a modal dialog can't run unattended).

/// Read a file, decode it, and load it into the document — the dialog-free core of Open. Homes the
/// view to the top (a freshly opened doc shows its start, not a stale scroll). Returns the read
/// error so the caller can surface it (the buffer is left untouched on failure).
fn load_from(state: &mut WindowState, path: &Path) -> std::io::Result<()> {
    let bytes = std::fs::read(path)?;
    let decoded = crate::codec::decode(&bytes);
    state.app.load_document(decoded, Some(path.to_path_buf()));
    state.scroll_y = 0.0;
    state.goal_x = None;
    Ok(())
}

/// Encode the buffer and write it — the dialog-free core of Save. Records the path (so an untitled
/// buffer that was just Saved-As now has one) and marks the document clean on success; a write
/// failure leaves it dirty and the error is returned for the caller to surface.
fn save_to(state: &mut WindowState, path: &Path) -> std::io::Result<()> {
    std::fs::write(path, state.app.bytes_to_save())?;
    state.app.set_save_target(path.to_path_buf());
    state.app.mark_saved();
    Ok(())
}

/// Show a `MessageBoxW` and return its result (`IDYES`/`IDNO`/`IDCANCEL`/`IDOK`). A tiny wrapper
/// that owns the wide-string lifetimes for the duration of the modal call.
unsafe fn message_box(hwnd: HWND, text: &str, caption: &str, flags: u32) -> i32 {
    let t = wide(text);
    let c = wide(caption);
    MessageBoxW(hwnd, t.as_ptr(), c.as_ptr(), flags)
}

/// Guard a destructive transition (New / Open / close). Clean ⇒ proceed silently. Dirty ⇒ the
/// three-way prompt (§5): Yes saves (proceed only if the save *succeeded* — a cancelled Save As or
/// a write error aborts), No discards, Cancel aborts. Returns whether the caller may proceed.
unsafe fn confirm_discard(state: &mut WindowState, hwnd: HWND) -> bool {
    if !state.app.is_dirty() {
        return true;
    }
    let prompt = format!("Save changes to {}?", state.app.document_name());
    match message_box(hwnd, &prompt, "Scriptorium", MB_YESNOCANCEL | MB_ICONWARNING) {
        IDYES => do_save(state, hwnd, false),
        IDNO => true,
        _ => false, // IDCANCEL, or the box failed to show — the safe answer is "don't discard"
    }
}

/// Open: guard unsaved work, pick a file, load it (surfacing a read error). No-op on dialog Cancel.
unsafe fn do_open(state: &mut WindowState, hwnd: HWND) {
    if !confirm_discard(state, hwnd) {
        return;
    }
    if let Some(path) = run_open_dialog(hwnd) {
        if let Err(e) = load_from(state, &path) {
            message_box(hwnd, &format!("Couldn't open the file:\n{e}"), "Scriptorium", MB_OK | MB_ICONERROR);
        }
    }
}

/// New: guard unsaved work, then reset to a clean untitled buffer.
unsafe fn do_new(state: &mut WindowState, hwnd: HWND) {
    if !confirm_discard(state, hwnd) {
        return;
    }
    state.app.new_document();
    state.scroll_y = 0.0;
    state.goal_x = None;
}

/// Save. `force_dialog` (Save As) always prompts for a path; a plain Save writes to the existing
/// path and only escalates to the dialog when the document is still untitled. Returns whether the
/// save succeeded (the discard guard needs to know: a cancelled/failed save must not proceed).
unsafe fn do_save(state: &mut WindowState, hwnd: HWND, force_dialog: bool) -> bool {
    let path = if force_dialog || !state.app.has_path() {
        match run_save_dialog(hwnd, &state.app.document_name()) {
            Some(p) => p,
            None => return false, // dialog cancelled — nothing written
        }
    } else {
        // has_path() is true here, so this is always Some; clone out before the mutable write.
        state.app.path().map(Path::to_path_buf).unwrap()
    };
    match save_to(state, &path) {
        Ok(()) => true,
        Err(e) => {
            message_box(hwnd, &format!("Couldn't save the file:\n{e}"), "Scriptorium", MB_OK | MB_ICONERROR);
            false
        }
    }
}

/// The comdlg32 file-type filter, a run of NUL-separated pairs ending in a double NUL:
/// `Text files\0*.txt;*.md\0All files\0*.*\0\0`.
fn filter_string() -> Vec<u16> {
    let mut v: Vec<u16> = "Text files\0*.txt;*.md\0All files\0*.*\0".encode_utf16().collect();
    v.push(0); // the second NUL that terminates the whole list
    v
}

/// The path from an `OPENFILENAMEW`'s `lpstrFile` buffer (NUL-terminated wide), as a `PathBuf`
/// via the OS-string round-trip (no lossy UTF-8 detour — paths can hold unpaired surrogates).
fn pathbuf_from_wide(buf: &[u16]) -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    std::ffi::OsString::from_wide(&buf[..len]).into()
}

/// Run the Open dialog; `Some(path)` on OK, `None` on Cancel. The `lpstrFile` buffer is the
/// caller-owned scratch comdlg32 writes the chosen path into.
unsafe fn run_open_dialog(hwnd: HWND) -> Option<PathBuf> {
    let mut file_buf = vec![0u16; 1024];
    let filter = filter_string();
    let title = wide("Open");
    let defext = wide("txt");
    let mut ofn: OPENFILENAMEW = zeroed();
    ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
    ofn.hwndOwner = hwnd;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file_buf.as_mut_ptr();
    ofn.nMaxFile = file_buf.len() as u32;
    ofn.lpstrTitle = title.as_ptr();
    ofn.lpstrDefExt = defext.as_ptr();
    ofn.Flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR;
    if GetOpenFileNameW(&mut ofn) != 0 {
        Some(pathbuf_from_wide(&file_buf))
    } else {
        None
    }
}

/// Run the Save As dialog, pre-seeding the current document name; `Some(path)` on OK (the OS
/// handles the overwrite prompt), `None` on Cancel.
unsafe fn run_save_dialog(hwnd: HWND, suggested_name: &str) -> Option<PathBuf> {
    let mut file_buf = vec![0u16; 1024];
    // Seed the edit field with the current name (skipping the "Untitled" placeholder).
    if suggested_name != "Untitled" {
        for (i, u) in suggested_name.encode_utf16().enumerate() {
            if i + 1 < file_buf.len() {
                file_buf[i] = u;
            }
        }
    }
    let filter = filter_string();
    let title = wide("Save As");
    let defext = wide("txt");
    let mut ofn: OPENFILENAMEW = zeroed();
    ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
    ofn.hwndOwner = hwnd;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file_buf.as_mut_ptr();
    ofn.nMaxFile = file_buf.len() as u32;
    ofn.lpstrTitle = title.as_ptr();
    ofn.lpstrDefExt = defext.as_ptr();
    ofn.Flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_OVERWRITEPROMPT | OFN_HIDEREADONLY | OFN_NOCHANGEDIR;
    if GetSaveFileNameW(&mut ofn) != 0 {
        Some(pathbuf_from_wide(&file_buf))
    } else {
        None
    }
}

/// Retitle the window `Scriptorium — <name>[*]` (name = file base name or `Untitled`, `*` iff
/// dirty), but only when the string actually changed — so it rides the paint path for free (§6).
unsafe fn update_title(state: &mut WindowState, hwnd: HWND) {
    let dirty = if state.app.is_dirty() { "*" } else { "" };
    let next = format!("Scriptorium \u{2014} {}{}", state.app.document_name(), dirty);
    if next != state.title {
        let wide_title = wide(&next);
        SetWindowTextW(hwnd, wide_title.as_ptr());
        state.title = next;
    }
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

// --- mouse-selection oracles (SCRIPTORIUM-NATIVE-LAYOUT.md §7) ----------------
// The geometry-free half of the mouse: line/word span math and the drag-granularity state
// machine, pinned without DWrite (the pixel↔offset half is the render.rs round-trip oracle).
#[cfg(test)]
mod mouse_tests {
    use super::{extend_selection, line_bounds, DragMode};

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn line_bounds_excludes_newlines() {
        let t = u("ab\ncde\nf");
        assert_eq!(line_bounds(&t, 4), (3, 6)); // inside the middle line "cde"
        assert_eq!(line_bounds(&t, 3), (3, 6)); // at its start
        assert_eq!(line_bounds(&t, 6), (3, 6)); // at its end (before the \n)
        assert_eq!(line_bounds(&t, 0), (0, 2)); // first line "ab"
        assert_eq!(line_bounds(&t, 8), (7, 8)); // last line "f"
    }

    #[test]
    fn char_drag_pivots_on_the_origin() {
        let t = u("hello world");
        assert_eq!(extend_selection(DragMode::Char, (5, 5), 9, &t), (5, 9));
        assert_eq!(extend_selection(DragMode::Char, (5, 5), 2, &t), (5, 2));
    }

    #[test]
    fn word_drag_snaps_to_whole_words() {
        let t = u("the quick brown fox");
        let origin = (4, 9); // "quick"
        // Drag right into "brown" grows to brown's end; inside the origin word is unchanged;
        // drag left into "the" flips the anchor to the origin's far edge and snaps to word start.
        assert_eq!(extend_selection(DragMode::Word, origin, 12, &t), (4, 15));
        assert_eq!(extend_selection(DragMode::Word, origin, 6, &t), (4, 9));
        assert_eq!(extend_selection(DragMode::Word, origin, 1, &t), (9, 0));
    }

    #[test]
    fn line_drag_snaps_to_whole_lines() {
        let t = u("aaa\nbbb\nccc");
        let origin = (4, 7); // "bbb"
        assert_eq!(extend_selection(DragMode::Line, origin, 9, &t), (4, 11));
        assert_eq!(extend_selection(DragMode::Line, origin, 1, &t), (7, 0));
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
                parse: None,
                last_submitted_gen: 0,
                edit_at: None,
                caret_visible: true,
                dpi: 96,
                scroll_y: 0.0,
                goal_x: None,
                wheel_accum: 0,
                selecting: false,
                autoscrolling: false,
                click_count: 0,
                last_click_ms: 0,
                last_click_x: 0,
                last_click_y: 0,
                last_mouse_x: 0,
                last_mouse_y: 0,
                drag_mode: DragMode::Char,
                sel_origin: (0, 0),
                title: String::new(),
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
            // Mouse: press, drag, release — SetCapture, hit_test_point + hit_test_point_clamped,
            // set_caret/set_selection, ReleaseCapture, all through the real WndProc on real
            // DWrite. y stays inside the viewport so no autoscroll timer arms.
            let lp = |x: isize, y: isize| ((y << 16) | (x & 0xffff)) as LPARAM;
            SendMessageW(hwnd, WM_LBUTTONDOWN, 0, lp(30, 18));
            SendMessageW(hwnd, WM_MOUSEMOVE, MK_LBUTTON, lp(10, 18));
            SendMessageW(hwnd, WM_LBUTTONUP, 0, lp(10, 18));
            // IME: drive the composition handlers through the real WndProc. Without a real IME
            // installed the IMC carries no composition, so ImmGetCompositionStringW returns empty
            // and these are effectively no-ops — but they exercise the imm32 FFI (ImmGetContext /
            // GetCompositionStringW / SetCompositionWindow / ReleaseContext) crash-free. The IMM
            // round-trip + feel need a human on a real IME (SCRIPTORIUM-NATIVE-IME.md §8).
            SendMessageW(hwnd, WM_IME_STARTCOMPOSITION, 0, 0);
            SendMessageW(hwnd, WM_IME_COMPOSITION, 0, GCS_COMPSTR as isize);
            SendMessageW(hwnd, WM_IME_COMPOSITION, 0, GCS_RESULTSTR as isize);
            SendMessageW(hwnd, WM_IME_ENDCOMPOSITION, 0, 0);
            // Exercise the inline-composition RENDER path on real DirectWrite: set a provisional
            // composition directly (a synthetic message can't populate the IMC, but the render is
            // ours — §8), paint (building the spliced layout, drawing the composition underline via
            // HitTestTextRange, and the caret inside the spliced layout), then clear.
            {
                let cs = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                cs.app.set_composition(&['x' as u16, 'y' as u16], 2, (0, 2));
                assert!(cs.app.composition().is_some(), "composition should be active for the render");
            }
            InvalidateRect(hwnd, null(), 0);
            SendMessageW(hwnd, WM_PAINT, 0, 0);
            {
                let cs = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                cs.app.clear_composition();
            }

            // N4: the off-thread parser was spawned in WM_CREATE and every WM_CHAR above submitted
            // a reparse. Give the real worker a bounded moment, then drive the WM_APP_PARSE_DONE
            // drain path through the WndProc (the worker's own PostMessage nudges sit in the queue,
            // which SendMessage bypasses — so we call the handler directly). Assert the async loop
            // actually closed: a result folded in under the monotonic gate (signal_gen advanced).
            {
                let mut caught_up = false;
                for _ in 0..500 {
                    SendMessageW(hwnd, WM_APP_PARSE_DONE, 0, 0);
                    let cs = &*(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                    // Once the worker's result is folded in, the signal catches up to the content
                    // and the "parsing…" lag marker clears — proof the async loop closed end-to-end.
                    if !cs.app.status_text().contains("parsing") {
                        caught_up = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                assert!(caught_up, "off-thread parse should fold a result in via WM_APP_PARSE_DONE");
            }

            // AST-styled rendering (SCRIPTORIUM-NATIVE-STYLING.md §9): drive the styled draw path on
            // real DWrite. Fold a Heading style span over the typed text directly (a synthetic parse
            // result), then paint — `draw` → `lay_out_paragraph` → `apply_paragraph_style` calls the
            // newly-typed SetFontSize/Weight/Style slots on a live layout inside a real paint (the
            // integration companion to the bare-layout oracle). Must not panic.
            {
                let cs = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                let g = cs.app.content_gen() + 1;
                let span = crate::styles::StyleSpan {
                    start: 0,
                    end: cs.app.text.len(),
                    kind: crate::styles::StyleKind::Heading(1),
                };
                cs.app.apply_parse(g, crate::parse::ParseSignal { blocks: 1, words: 1, parse_micros: 0 }, vec![span]);
            }
            InvalidateRect(hwnd, null(), 0);
            SendMessageW(hwnd, WM_PAINT, 0, 0);

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

            // File I/O (SCRIPTORIUM-NATIVE-IO.md §9): drive the dialog-free cores + the byte
            // round-trip through the live window. The modal GetOpen/SaveFileNameW can't run
            // unattended (they'd block the test), so we exercise `load_from`/`save_to` directly —
            // the dialogs themselves are compiled + ABI-asserted and left to the author's manual
            // pass. Runs LAST (it replaces the document) and ends CLEAN so the DestroyWindow below
            // — which bypasses WM_CLOSE, so no discard prompt — tears down without a modal.
            {
                let dir = std::env::temp_dir();
                let src = dir.join("scriptorium_smoke_in.txt");
                let dst = dir.join("scriptorium_smoke_out.txt");
                // A CRLF, UTF-8-with-BOM file carrying CJK + an emoji (a surrogate pair) — the
                // interesting encoding/newline corners in one round-trip.
                let body: Vec<u16> = "first line\nsecond \u{6587}\u{5B57} line\n\u{1F600}".encode_utf16().collect();
                let original = crate::codec::encode(&body, crate::codec::Encoding::Utf8Bom, crate::codec::Newline::Crlf);
                std::fs::write(&src, &original).expect("write smoke input");

                let cs = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                load_from(cs, &src).expect("load_from reads + decodes the file");
                assert!(!cs.app.is_dirty(), "a freshly loaded file is clean");
                assert_eq!(cs.app.document_name(), "scriptorium_smoke_in.txt");
                assert_eq!(
                    String::from_utf16(&cs.app.text).unwrap(),
                    "first line\nsecond \u{6587}\u{5B57} line\n\u{1F600}",
                    "the CRLF file decoded to the LF-internal buffer"
                );
                // The title (name + no dirty marker) updates on the next paint.
                InvalidateRect(hwnd, null(), 0);
                SendMessageW(hwnd, WM_PAINT, 0, 0);

                // Edit → dirty; save to a new path → the bytes must reproduce the file's own
                // encoding + newline faithfully (preserve-on-save, §3), not the LF buffer form.
                // The caret homed to offset 0 on load, so the typed '!' lands at the FRONT.
                SendMessageW(hwnd, WM_CHAR, '!' as usize, 0);
                let cs = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                assert!(cs.app.is_dirty(), "typing dirties the loaded document");
                save_to(cs, &dst).expect("save_to writes the file");
                assert!(!cs.app.is_dirty(), "a successful save marks the document clean");

                let mut expect_body = vec!['!' as u16];
                expect_body.extend_from_slice(&body);
                let expected = crate::codec::encode(&expect_body, crate::codec::Encoding::Utf8Bom, crate::codec::Newline::Crlf);
                let round = std::fs::read(&dst).expect("read the saved file back");
                assert_eq!(round, expected, "save re-encodes in the file's own encoding + newline");

                let _ = std::fs::remove_file(&src);
                let _ = std::fs::remove_file(&dst);
            }

            // N5c flat-cost guard (SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md §9/§11): the cliff
            // regression guard. Painting a large multi-paragraph document — and scrolling through it
            // — must cost a time *independent of its length*, because virtualized paint shapes only
            // the viewport. The old whole-doc layout was ~700 ms to shape a doc this size (25× parse,
            // superlinear); a regression to O(document) paint could not meet the generous bound
            // below, while the viewport-only path clears it with room to spare. Also exercises
            // scrolling deep into a big doc on real DWrite (windowed layout + anchoring), crash-free.
            //
            // (We deliberately don't type here: an edit would submit the whole 880k-unit snapshot to
            // the N4 parse worker, whose *debug* parse is seconds — off-thread, so it never blocks
            // the UI, but the teardown join would wait on it. Paint cost is the N5 claim; the edit
            // path is covered on the small docs above.)
            {
                let line: Vec<u16> = "the quick brown fox jumps over the lazy dog\n".encode_utf16().collect();
                let mut big: Vec<u16> = Vec::with_capacity(line.len() * 20000);
                for _ in 0..20000 {
                    big.extend_from_slice(&line); // ~20k paragraphs, ~880k units
                }
                let decoded = crate::codec::Decoded {
                    units: big,
                    encoding: crate::codec::Encoding::Utf8,
                    newline: crate::codec::Newline::Lf,
                };
                let cs = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
                cs.app.load_document(decoded, None);
                // Warm one paint (builds the paragraph index), then time several scroll+paint cycles
                // marching down the document — each must stay viewport-bounded, not grow with length.
                InvalidateRect(hwnd, null(), 0);
                SendMessageW(hwnd, WM_PAINT, 0, 0);
                let t = std::time::Instant::now();
                for _ in 0..8 {
                    SendMessageW(hwnd, WM_VSCROLL, SB_PAGEDOWN as usize, 0);
                    SendMessageW(hwnd, WM_PAINT, 0, 0);
                }
                let elapsed = t.elapsed();
                // A deliberately generous bound: the viewport-only path is ~200 ms (plain debug) /
                // ~500 ms (ASan-instrumented) for 8 cycles, while an O(document) regression at this
                // size would be *tens of seconds* (the 880k-unit whole-doc shape is ~700 ms in
                // release alone, far worse instrumented). 3 s clears the slowest instrumented build
                // with headroom yet trips instantly on the cliff — a robust regression guard, not a
                // fickle perf gate (which the CI philosophy keeps out of the hard path anyway).
                assert!(
                    elapsed.as_millis() < 3000,
                    "virtualized paint+scroll on a 20k-paragraph doc must be flat (<3s for 8 cycles), was {elapsed:?}"
                );
            }

            // Tear down — WM_DESTROY + WM_NCDESTROY run synchronously and drop the box.
            assert!(DestroyWindow(hwnd) != 0, "DestroyWindow failed");
            // state_ptr is freed now; do not touch it.
        }
    }
}
