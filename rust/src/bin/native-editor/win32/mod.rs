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
        });
        let state_ptr = Box::into_raw(state);

        let title = wide("Scriptorium \u{2014} N0");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
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
            // An edit makes the caret solid again so it's visible right after typing.
            state.caret_visible = true;
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_KEYDOWN => {
            let motion = match wparam as u32 {
                VK_LEFT => Some(Motion::Left),
                VK_RIGHT => Some(Motion::Right),
                VK_HOME => Some(Motion::Home),
                VK_END => Some(Motion::End),
                _ => None,
            };
            if let Some(m) = motion {
                state.app.move_caret(m);
                state.caret_visible = true;
                InvalidateRect(hwnd, null(), 0);
            }
            // Let DefWindowProc run too (so system keys still behave).
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_TIMER => {
            if wparam == CARET_TIMER_ID {
                state.caret_visible = !state.caret_visible;
                InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_SIZE => {
            if let Some(r) = state.renderer.as_mut() {
                let w = (lparam & 0xffff) as u32;
                let h = ((lparam >> 16) & 0xffff) as u32;
                r.resize(w, h);
            }
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
                    (rc.right - rc.left).max(0) as u32,
                    (rc.bottom - rc.top).max(0) as u32,
                );
            }
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
            });
            let state_ptr = Box::into_raw(state);

            let title = wide("smoke");
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
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
            // Move the caret left once.
            SendMessageW(hwnd, WM_KEYDOWN, VK_LEFT as usize, 0);

            // Exercise resize (incl. the 0x0 minimize guard) and a caret-blink tick.
            SendMessageW(hwnd, WM_SIZE, 0, (600isize << 16) | 800);
            SendMessageW(hwnd, WM_SIZE, 0, 0); // minimize: must be a no-op, not a panic.
            SendMessageW(hwnd, WM_TIMER, CARET_TIMER_ID, 0);

            // Force a paint through the real WM_PAINT path.
            InvalidateRect(hwnd, null(), 0);
            UpdateWindow(hwnd);
            SendMessageW(hwnd, WM_PAINT, 0, 0);

            // Read the buffer state back out of the live window before we destroy it.
            let st = &*(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState);
            assert_eq!(st.app.text.len(), 2, "expected two typed units");
            assert_eq!(st.app.caret, 1, "caret should have moved left of 'i'");

            // Tear down — WM_DESTROY + WM_NCDESTROY run synchronously and drop the box.
            assert!(DestroyWindow(hwnd) != 0, "DestroyWindow failed");
            // state_ptr is freed now; do not touch it.
        }
    }
}
