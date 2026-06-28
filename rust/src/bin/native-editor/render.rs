//! The renderer — Direct2D + DirectWrite, consume-only COM (we call methods through
//! vtables but implement no interface). This is the lowest-risk path to DWrite glyphs
//! on screen; implementing a COM *callback* (e.g. IDWriteTextRenderer for a CPU
//! framebuffer) is the genuinely hard part of COM-from-Rust and is deliberately
//! deferred (SCRIPTORIUM-NATIVE-SKELETON.md §5, the re-opened surface decision).
//!
//! Object graph, all consumed:
//!   D2D1CreateFactory   -> ID2D1Factory -> ID2D1HwndRenderTarget -> ID2D1SolidColorBrush
//!   DWriteCreateFactory -> IDWriteFactory -> IDWriteTextFormat -> IDWriteTextLayout
//! Every interface pointer is wrapped in `ComPtr`, whose Drop calls Release through
//! the universal IUnknown layout — no hand-balanced AddRef/Release in logic.

use core::ffi::c_void;
use core::mem::zeroed;
use core::ptr::{null, null_mut};

use crate::app::App;
use crate::win32::sys::*;

/// RAII wrapper: owns one ref on a COM interface pointer; releases on drop.
pub struct ComPtr<T> {
    ptr: *mut T,
}

impl<T> ComPtr<T> {
    /// # Safety: `ptr` must be a live interface pointer we own a ref on (or null).
    pub unsafe fn from_raw(ptr: *mut T) -> ComPtr<T> {
        ComPtr { ptr }
    }
    pub fn as_raw(&self) -> *mut T {
        self.ptr
    }
}

impl<T> Drop for ComPtr<T> {
    fn drop(&mut self) {
        unsafe { com_release(self.ptr as *mut c_void) }
    }
}

/// Visual constants — the seed of "feel" (everything here is a future knob).
const FONT_FAMILY: &str = "Consolas";
const FONT_SIZE_DIP: f32 = 18.0;
const STATUS_SIZE_DIP: f32 = 12.0;
const PAD_DIP: f32 = 16.0;
const CARET_WIDTH_DIP: f32 = 1.5;

pub struct Renderer {
    // Field order is drop order: brushes/formats/target before the factories.
    target: ComPtr<ID2D1HwndRenderTarget>,
    text_brush: ComPtr<ID2D1SolidColorBrush>,
    caret_brush: ComPtr<ID2D1SolidColorBrush>,
    text_format: ComPtr<IDWriteTextFormat>,
    status_format: ComPtr<IDWriteTextFormat>,
    // Held only to keep our factory ref alive for the Renderer's lifetime (RAII); the
    // render target keeps its own ref, so we never read this after construction.
    // Kept alive for the Renderer's lifetime AND read on device-loss recovery: the
    // factory survives a lost device and rebuilds the target/brushes from it.
    d2d_factory: ComPtr<ID2D1Factory>,
    dwrite_factory: ComPtr<IDWriteFactory>,
    // The window we render into — needed to re-create the hwnd render target after
    // device loss (it sizes itself to the current client rect).
    hwnd: HWND,
    dpi: u32,
}

/// Text and caret colors — device-dependent brushes are rebuilt from these on
/// device-loss recovery, so they live as constants rather than inline literals.
const TEXT_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.10, g: 0.10, b: 0.13, a: 1.0 };
const CARET_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.16, g: 0.40, b: 0.85, a: 1.0 };

impl Renderer {
    /// Build the whole object graph for `hwnd`. Returns the HRESULT of the first
    /// failing call (N0 surfaces it; N1+ tightens error handling).
    pub fn new(hwnd: HWND, dpi: u32) -> Result<Renderer, HRESULT> {
        unsafe {
            // D2D factory.
            let mut d2d: *mut c_void = null_mut();
            let hr = D2D1CreateFactory(
                D2D1_FACTORY_TYPE_SINGLE_THREADED,
                &IID_ID2D1FACTORY,
                null(),
                &mut d2d,
            );
            if hr < 0 {
                return Err(hr);
            }
            let d2d_factory = ComPtr::from_raw(d2d as *mut ID2D1Factory);

            // DWrite factory.
            let mut dw: *mut c_void = null_mut();
            let hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, &IID_IDWRITE_FACTORY, &mut dw);
            if hr < 0 {
                return Err(hr);
            }
            let dwrite_factory = ComPtr::from_raw(dw as *mut IDWriteFactory);

            // Device-dependent resources (target + brushes), rebuildable on device loss.
            let (target, text_brush, caret_brush) =
                create_device_resources(d2d_factory.as_raw(), hwnd, dpi)?;

            // Text formats.
            let text_format =
                ComPtr::from_raw(make_text_format(dwrite_factory.as_raw(), FONT_SIZE_DIP)?);
            let status_format =
                ComPtr::from_raw(make_text_format(dwrite_factory.as_raw(), STATUS_SIZE_DIP)?);

            Ok(Renderer {
                target,
                text_brush,
                caret_brush,
                text_format,
                status_format,
                d2d_factory,
                dwrite_factory,
                hwnd,
                dpi,
            })
        }
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        // Minimizing sends a 0x0 WM_SIZE; resizing the target to zero is pointless and
        // some drivers error on it. Skip — the next non-zero size repaints.
        if w == 0 || h == 0 {
            return;
        }
        unsafe {
            let rt = self.target.as_raw();
            let size = D2D1_SIZE_U { width: w, height: h };
            let _ = ((*(*rt).vtbl).resize)(rt, &size);
        }
    }

    /// Rebuild the device-dependent resources (target + brushes) after the GPU device
    /// was lost (EndDraw returned D2DERR_RECREATE_TARGET). The factories and text
    /// formats survive, so only these three are recreated. On failure we leave the old
    /// (dead) resources in place; the next frame loops back here and retries.
    unsafe fn recreate_device_resources(&mut self) {
        match create_device_resources(self.d2d_factory.as_raw(), self.hwnd, self.dpi) {
            Ok((target, text_brush, caret_brush)) => {
                self.target = target;
                self.text_brush = text_brush;
                self.caret_brush = caret_brush;
            }
            Err(hr) => eprintln!("device-resource recreate failed: 0x{hr:08x}"),
        }
    }

    pub fn set_dpi(&mut self, dpi: u32) {
        self.dpi = dpi;
        unsafe {
            let rt = self.target.as_raw();
            ((*(*rt).vtbl).set_dpi)(rt, dpi as f32, dpi as f32);
        }
    }

    /// Paint one frame: clear, draw the buffer text, draw the caret (if visible),
    /// draw the status line. `px_w`/`px_h` are the physical client size.
    pub fn draw(&mut self, app: &App, caret_visible: bool, px_w: u32, px_h: u32) {
        unsafe {
            let rt = self.target.as_raw();
            let v = &*(*rt).vtbl;
            (v.begin_draw)(rt);
            (v.clear)(rt, &D2D1_COLOR_F { r: 0.99, g: 0.985, b: 0.97, a: 1.0 });

            // Physical pixels -> DIPs (the target's coordinate space at this DPI).
            let scale = 96.0 / self.dpi as f32;
            let dip_w = px_w as f32 * scale;
            let dip_h = px_h as f32 * scale;
            let text_w = (dip_w - PAD_DIP * 2.0).max(0.0);

            // Main text layout (also the source of caret geometry).
            let layout = self.make_layout(&app.text, self.text_format.as_raw(), text_w, dip_h);
            if !layout.is_null() {
                (v.draw_text_layout)(
                    rt,
                    D2D_POINT_2F { x: PAD_DIP, y: PAD_DIP },
                    layout,
                    self.text_brush.as_raw() as *mut c_void,
                    0,
                );
                if caret_visible {
                    if let Some((cx, cy, ch)) = caret_geometry(layout, app.caret, app.text.len()) {
                        let rect = D2D1_RECT_F {
                            left: PAD_DIP + cx,
                            top: PAD_DIP + cy,
                            right: PAD_DIP + cx + CARET_WIDTH_DIP,
                            bottom: PAD_DIP + cy + ch,
                        };
                        (v.fill_rectangle)(rt, &rect, self.caret_brush.as_raw() as *mut c_void);
                    }
                }
                com_release(layout as *mut c_void);
            }

            // Status line near the bottom.
            let status: Vec<u16> = app.status_text().encode_utf16().collect();
            let slayout = self.make_layout(&status, self.status_format.as_raw(), text_w, 40.0);
            if !slayout.is_null() {
                (v.draw_text_layout)(
                    rt,
                    D2D_POINT_2F { x: PAD_DIP, y: (dip_h - 28.0).max(PAD_DIP) },
                    slayout,
                    self.text_brush.as_raw() as *mut c_void,
                    0,
                );
                com_release(slayout as *mut c_void);
            }

            // EndDraw reports device loss here rather than failing each draw call. On
            // D2DERR_RECREATE_TARGET the GPU device is gone (driver reset, GPU removed,
            // sleep/resume): drop and rebuild the target + brushes; the next WM_PAINT
            // repaints cleanly. Other errors are non-fatal for a frame and ignored.
            let hr = (v.end_draw)(rt, null_mut(), null_mut());
            if hr == D2DERR_RECREATE_TARGET {
                self.recreate_device_resources();
            }
        }
    }

    /// Create an IDWriteTextLayout for `buf`. Caller owns it and must Release.
    /// Returns null on failure (e.g. HRESULT < 0).
    unsafe fn make_layout(
        &self,
        buf: &[u16],
        format: *mut IDWriteTextFormat,
        max_w: f32,
        max_h: f32,
    ) -> *mut IDWriteTextLayout {
        let f = self.dwrite_factory.as_raw();
        // CreateTextLayout wants a non-null string pointer even when length is 0.
        let dummy = [0u16; 1];
        let ptr = if buf.is_empty() { dummy.as_ptr() } else { buf.as_ptr() };
        let mut out: *mut IDWriteTextLayout = null_mut();
        let hr = ((*(*f).vtbl).create_text_layout)(f, ptr, buf.len() as u32, format, max_w, max_h, &mut out);
        if hr < 0 {
            null_mut()
        } else {
            out
        }
    }
}

/// The device-dependent trio rebuilt together on device loss: the hwnd render target
/// and the text + caret brushes drawn from it (all GPU-device-backed).
type DeviceResources = (
    ComPtr<ID2D1HwndRenderTarget>,
    ComPtr<ID2D1SolidColorBrush>,
    ComPtr<ID2D1SolidColorBrush>,
);

/// Build the device-dependent resources: an hwnd render target sized to `hwnd`'s
/// current client rect (DPI from the window, so we work in DIPs and Direct2D scales to
/// physical pixels) plus the two brushes drawn from it. Used both at construction and
/// on device-loss recovery, since the GPU device backs all three.
unsafe fn create_device_resources(
    d2d_factory: *mut ID2D1Factory,
    hwnd: HWND,
    dpi: u32,
) -> Result<DeviceResources, HRESULT> {
    let mut rc: RECT = zeroed();
    GetClientRect(hwnd, &mut rc);
    let size = D2D1_SIZE_U {
        width: (rc.right - rc.left).max(0) as u32,
        height: (rc.bottom - rc.top).max(0) as u32,
    };
    let rt_props = D2D1_RENDER_TARGET_PROPERTIES {
        r#type: 0,                                                   // DEFAULT
        pixel_format: D2D1_PIXEL_FORMAT { format: 0, alpha_mode: 0 }, // UNKNOWN/UNKNOWN
        dpi_x: dpi as f32,
        dpi_y: dpi as f32,
        usage: 0,
        min_level: 0,
    };
    let hwnd_props = D2D1_HWND_RENDER_TARGET_PROPERTIES {
        hwnd,
        pixel_size: size,
        present_options: 0,
    };
    let mut target: *mut ID2D1HwndRenderTarget = null_mut();
    let hr = ((*(*d2d_factory).vtbl).create_hwnd_render_target)(
        d2d_factory,
        &rt_props,
        &hwnd_props,
        &mut target,
    );
    if hr < 0 {
        return Err(hr);
    }
    let target = ComPtr::from_raw(target);

    let text_brush = ComPtr::from_raw(make_brush(target.as_raw(), TEXT_COLOR)?);
    let caret_brush = ComPtr::from_raw(make_brush(target.as_raw(), CARET_COLOR)?);
    Ok((target, text_brush, caret_brush))
}

/// CreateSolidColorBrush on a render target.
unsafe fn make_brush(
    rt: *mut ID2D1HwndRenderTarget,
    color: D2D1_COLOR_F,
) -> Result<*mut ID2D1SolidColorBrush, HRESULT> {
    let mut out: *mut ID2D1SolidColorBrush = null_mut();
    let hr = ((*(*rt).vtbl).create_solid_color_brush)(rt, &color, null(), &mut out);
    if hr < 0 {
        Err(hr)
    } else {
        Ok(out)
    }
}

/// CreateTextFormat on the DWrite factory (FONT_FAMILY, normal weight/style/stretch).
unsafe fn make_text_format(
    f: *mut IDWriteFactory,
    size: f32,
) -> Result<*mut IDWriteTextFormat, HRESULT> {
    let family = wide(FONT_FAMILY);
    let locale = wide("en-us");
    let mut out: *mut IDWriteTextFormat = null_mut();
    let hr = ((*(*f).vtbl).create_text_format)(
        f,
        family.as_ptr(),
        null_mut(),
        DWRITE_FONT_WEIGHT_NORMAL,
        DWRITE_FONT_STYLE_NORMAL,
        DWRITE_FONT_STRETCH_NORMAL,
        size,
        locale.as_ptr(),
        &mut out,
    );
    if hr < 0 {
        Err(hr)
    } else {
        Ok(out)
    }
}

/// Caret geometry (x, top, height) in DIPs from a layout, via HitTestTextPosition.
/// For the caret at end-of-text we hit-test the trailing edge of the last unit; at
/// start/empty we hit-test the leading edge of position 0.
unsafe fn caret_geometry(
    layout: *mut IDWriteTextLayout,
    caret: usize,
    len: usize,
) -> Option<(f32, f32, f32)> {
    let (pos, trailing): (u32, BOOL) = if len == 0 || caret == 0 {
        (0, 0)
    } else if caret >= len {
        ((len - 1) as u32, 1)
    } else {
        (caret as u32, 0)
    };
    let mut x = 0f32;
    let mut y = 0f32;
    let mut m: DWRITE_HIT_TEST_METRICS = zeroed();
    let hr = ((*(*layout).vtbl).hit_test_text_position)(layout, pos, trailing, &mut x, &mut y, &mut m);
    if hr < 0 {
        return None;
    }
    let height = if m.height > 0.0 { m.height } else { FONT_SIZE_DIP * 1.3 };
    Some((x, m.top, height))
}

/// A nul-terminated UTF-16 string for the wide Win32/DWrite APIs.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// --- layout-geometry oracle seed (SCRIPTORIUM-NATIVE-SKELETON.md §7) ---------
// The first golden geometry: for a fixed string + format, caret x must be
// monotonically non-decreasing as the index advances. Needs real DWrite, so it runs
// only on Windows (the windows-latest CI job runs `cargo test --bin`).
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn caret_x_is_monotonic() {
        unsafe {
            let mut dw: *mut c_void = null_mut();
            let hr =
                DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, &IID_IDWRITE_FACTORY, &mut dw);
            assert!(hr >= 0, "DWriteCreateFactory failed: 0x{hr:08x}");
            let factory = ComPtr::from_raw(dw as *mut IDWriteFactory);

            let format = ComPtr::from_raw(
                make_text_format(factory.as_raw(), FONT_SIZE_DIP).expect("text format"),
            );

            let text: Vec<u16> = "The quick brown fox".encode_utf16().collect();
            let f = factory.as_raw();
            let mut layout: *mut IDWriteTextLayout = null_mut();
            let hr = ((*(*f).vtbl).create_text_layout)(
                f,
                text.as_ptr(),
                text.len() as u32,
                format.as_raw(),
                1000.0,
                1000.0,
                &mut layout,
            );
            assert!(hr >= 0 && !layout.is_null(), "CreateTextLayout failed");

            let mut last_x = f32::NEG_INFINITY;
            for i in 0..=text.len() {
                let (x, _y, h) =
                    caret_geometry(layout, i, text.len()).expect("hit-test position");
                assert!(
                    x + 0.01 >= last_x,
                    "caret x regressed at index {i}: {x} < {last_x}"
                );
                assert!(h > 0.0, "caret height should be positive at index {i}");
                last_x = x;
            }
            com_release(layout as *mut c_void);
        }
    }
}
