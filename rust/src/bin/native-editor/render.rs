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
/// The bottom chrome strip (the status line) — text scrolls *above* this band; the band
/// is painted over with the background so scrolled glyphs never bleed under the status.
const STATUS_STRIP_DIP: f32 = 28.0;
/// The retained layout is laid out to the wrap width but an effectively unbounded height,
/// so vertical clipping never depends on the window — only width wraps, and `GetMetrics`
/// reports the true content height for the scroll extent.
const LAYOUT_MAX_HEIGHT: f32 = 1.0e6;
/// The window background / clear color (also painted behind the status strip).
const BG_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.99, g: 0.985, b: 0.97, a: 1.0 };

pub struct Renderer {
    // Field order is drop order: brushes/formats/target before the factories.
    target: ComPtr<ID2D1HwndRenderTarget>,
    text_brush: ComPtr<ID2D1SolidColorBrush>,
    caret_brush: ComPtr<ID2D1SolidColorBrush>,
    sel_brush: ComPtr<ID2D1SolidColorBrush>,
    // Opaque background fill — repaints the status strip so scrolled text can't bleed under
    // it (the pinned-chrome band, SCRIPTORIUM-NATIVE-LAYOUT.md §6). Device-dependent.
    bg_brush: ComPtr<ID2D1SolidColorBrush>,
    text_format: ComPtr<IDWriteTextFormat>,
    status_format: ComPtr<IDWriteTextFormat>,
    // The retained main-text layout: the geometry authority shared by the paint path and
    // the input path (SCRIPTORIUM-NATIVE-LAYOUT.md §2.1). Rebuilt only when its key —
    // (content_gen, wrap width) — drifts, so caret motion / scroll / selection never
    // re-shape text. A DWrite layout is device-independent, so it survives device loss
    // (unlike the target + brushes). `None` until the first `ensure_layout`.
    cached_layout: Option<ComPtr<IDWriteTextLayout>>,
    cached_gen: u64,
    cached_width: f32,
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
// Translucent so the glyphs read through the highlight it sits behind.
const SEL_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.16, g: 0.40, b: 0.85, a: 0.25 };

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
            let (target, text_brush, caret_brush, sel_brush, bg_brush) =
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
                sel_brush,
                bg_brush,
                text_format,
                status_format,
                cached_layout: None,
                cached_gen: 0,
                cached_width: -1.0, // sentinel: forces the first ensure_layout to build
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
            Ok((target, text_brush, caret_brush, sel_brush, bg_brush)) => {
                self.target = target;
                self.text_brush = text_brush;
                self.caret_brush = caret_brush;
                self.sel_brush = sel_brush;
                self.bg_brush = bg_brush;
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

    /// Paint one frame: clear, draw the buffer text (translated by `scroll_y`), the
    /// selection + caret, then the pinned status strip on top. `px_w`/`px_h` are the
    /// physical client size; `scroll_y` is the content-space DIP offset of the viewport top
    /// (SCRIPTORIUM-NATIVE-LAYOUT.md §3 — content→pixel is `+PAD`, `−scroll_y` on y).
    pub fn draw(&mut self, app: &App, caret_visible: bool, scroll_y: f32, px_w: u32, px_h: u32) {
        unsafe {
            let rt = self.target.as_raw();
            let v = &*(*rt).vtbl;
            (v.begin_draw)(rt);
            (v.clear)(rt, &BG_COLOR);

            // Physical pixels -> DIPs (the target's coordinate space at this DPI).
            let scale = 96.0 / self.dpi as f32;
            let dip_w = px_w as f32 * scale;
            let dip_h = px_h as f32 * scale;
            let text_w = (dip_w - PAD_DIP * 2.0).max(0.0);

            // The retained main-text layout (also the geometry authority for input). The
            // text origin scrolls: x = PAD, y = PAD − scroll_y.
            let layout = self.ensure_layout(&app.text, app.content_gen(), text_w);
            let oy = PAD_DIP - scroll_y;
            if !layout.is_null() {
                // Selection highlight sits behind the glyphs.
                if app.has_selection() {
                    let (s, e) = app.selection();
                    fill_selection_range(
                        rt,
                        v,
                        layout,
                        self.sel_brush.as_raw() as *mut c_void,
                        PAD_DIP,
                        oy,
                        s as u32,
                        (e - s) as u32,
                    );
                }
                (v.draw_text_layout)(
                    rt,
                    D2D_POINT_2F { x: PAD_DIP, y: oy },
                    layout,
                    self.text_brush.as_raw() as *mut c_void,
                    0,
                );
                if caret_visible {
                    if let Some((cx, cy, ch)) = caret_geometry(layout, app.caret, app.text.len()) {
                        let rect = D2D1_RECT_F {
                            left: PAD_DIP + cx,
                            top: oy + cy,
                            right: PAD_DIP + cx + CARET_WIDTH_DIP,
                            bottom: oy + cy + ch,
                        };
                        (v.fill_rectangle)(rt, &rect, self.caret_brush.as_raw() as *mut c_void);
                    }
                }
            }

            // Pin the status strip: repaint the bottom band with the background so any text
            // scrolled under it is hidden, then draw the status line on top (no scroll).
            let strip_top = (dip_h - STATUS_STRIP_DIP).max(0.0);
            let strip = D2D1_RECT_F { left: 0.0, top: strip_top, right: dip_w, bottom: dip_h };
            (v.fill_rectangle)(rt, &strip, self.bg_brush.as_raw() as *mut c_void);
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
            // repaints cleanly. The cached DWrite layout is device-independent and is NOT
            // dropped here. Other errors are non-fatal for a frame and ignored.
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

    // --- geometry service (SCRIPTORIUM-NATIVE-LAYOUT.md §2) -------------------
    // The retained-layout choke point and the four queries the input path needs. All go
    // through `ensure_layout`, so the paint path and the hit-test path can never disagree
    // about geometry. The layout coords are content-space (origin at the top of the text,
    // before scroll); callers apply the scroll/padding transform (§3).

    /// The cached main-text layout for `(gen, width)`, rebuilt only on key drift. The single
    /// place text is (re)shaped. Returns null only if we have no layout at all and the build
    /// failed (a transient build failure keeps the prior, stale-but-valid layout).
    unsafe fn ensure_layout(&mut self, text: &[u16], gen: u64, width: f32) -> *mut IDWriteTextLayout {
        let stale = self.cached_layout.is_none()
            || self.cached_gen != gen
            || (self.cached_width - width).abs() > 0.5;
        if stale {
            let raw = self.make_layout(text, self.text_format.as_raw(), width, LAYOUT_MAX_HEIGHT);
            if !raw.is_null() {
                // Assigning drops the previous ComPtr → releases the old layout.
                self.cached_layout = Some(ComPtr::from_raw(raw));
                self.cached_gen = gen;
                self.cached_width = width;
            }
        }
        self.cached_layout.as_ref().map(|c| c.as_raw()).unwrap_or(null_mut())
    }

    /// The wrap width in DIPs for the current client rect (client width − 2·padding).
    unsafe fn layout_width(&self) -> f32 {
        let mut rc: RECT = zeroed();
        GetClientRect(self.hwnd, &mut rc);
        let scale = 96.0 / self.dpi as f32;
        let dip_w = (rc.right - rc.left).max(0) as f32 * scale;
        (dip_w - PAD_DIP * 2.0).max(0.0)
    }

    /// The scrollable viewport height in DIPs: the text band between the top padding and the
    /// pinned status strip (SCRIPTORIUM-NATIVE-LAYOUT.md §6).
    pub fn viewport_height(&self) -> f32 {
        unsafe {
            let mut rc: RECT = zeroed();
            GetClientRect(self.hwnd, &mut rc);
            let scale = 96.0 / self.dpi as f32;
            let dip_h = (rc.bottom - rc.top).max(0) as f32 * scale;
            (dip_h - PAD_DIP - STATUS_STRIP_DIP).max(0.0)
        }
    }

    /// Map a clicked **physical pixel** (client-relative) to a UTF-16 caret offset, honoring
    /// the trailing-edge rule (§4). Out-of-bounds pixels clamp to the nearest position.
    pub fn hit_test_point(&mut self, text: &[u16], gen: u64, px: i32, py: i32, scroll_y: f32) -> usize {
        let scale = 96.0 / self.dpi as f32;
        let cx = px as f32 * scale - PAD_DIP;
        let cy = py as f32 * scale - PAD_DIP + scroll_y;
        self.hit_test_content(text, gen, cx, cy)
    }

    /// Like `hit_test_point`, but clamps the point to the currently *visible* content band
    /// first, so a drag past the top/bottom edge selects to the visible edge while autoscroll
    /// advances the view (SCRIPTORIUM-NATIVE-LAYOUT.md §4). `scroll_y` is the current view offset.
    pub fn hit_test_point_clamped(
        &mut self,
        text: &[u16],
        gen: u64,
        px: i32,
        py: i32,
        scroll_y: f32,
    ) -> usize {
        let scale = 96.0 / self.dpi as f32;
        let cx = px as f32 * scale - PAD_DIP;
        let cy = py as f32 * scale - PAD_DIP + scroll_y;
        // Keep the y inside [scroll_y, scroll_y + viewport): the hit lands on the last visible
        // line, and the caller's autoscroll brings more into view for the next tick.
        let cy = cy.clamp(scroll_y, (scroll_y + self.viewport_height() - 1.0).max(scroll_y));
        self.hit_test_content(text, gen, cx, cy)
    }

    /// Where a physical-pixel `py` falls relative to the visible text band: `-1` above the top,
    /// `+1` below the bottom, `0` inside. Drives drag-autoscroll direction (§4).
    pub fn edge_of_py(&self, py: i32, scroll_y: f32) -> i32 {
        let scale = 96.0 / self.dpi as f32;
        let cy = py as f32 * scale - PAD_DIP + scroll_y;
        if cy < scroll_y {
            -1
        } else if cy > scroll_y + self.viewport_height() {
            1
        } else {
            0
        }
    }

    /// Map a **content-space** point (DIPs, pre-scroll) to a UTF-16 caret offset. Used both
    /// by `hit_test_point` and directly by Up/Down (which already work in content space).
    pub fn hit_test_content(&mut self, text: &[u16], gen: u64, cx: f32, cy: f32) -> usize {
        unsafe {
            let layout = self.ensure_layout(text, gen, self.layout_width());
            if layout.is_null() {
                return 0;
            }
            let mut trailing: BOOL = 0;
            let mut inside: BOOL = 0;
            let mut m: DWRITE_HIT_TEST_METRICS = zeroed();
            let hr = ((*(*layout).vtbl).hit_test_point)(layout, cx, cy, &mut trailing, &mut inside, &mut m);
            if hr < 0 {
                return 0;
            }
            // offset = textPosition + (isTrailingHit ? cluster length : 0): clicking the
            // right half of a glyph lands the caret after the whole cluster. `isInside` is
            // ignored on purpose — honoring `trailing` regardless is what makes clicks past
            // EOL / below the last line / in the margin all land where a user expects (§4).
            let mut off = m.text_position as usize;
            if trailing != 0 {
                off += m.length as usize;
            }
            off.min(text.len())
        }
    }

    /// Caret geometry (x, top, height) in **content space** for a UTF-16 offset, or None.
    pub fn caret_xywh(&mut self, text: &[u16], gen: u64, offset: usize) -> Option<(f32, f32, f32)> {
        unsafe {
            let layout = self.ensure_layout(text, gen, self.layout_width());
            if layout.is_null() {
                return None;
            }
            caret_geometry(layout, offset, text.len())
        }
    }

    /// The total laid-out text height in DIPs (the scroll extent), via `GetMetrics`.
    pub fn content_height(&mut self, text: &[u16], gen: u64) -> f32 {
        unsafe {
            let layout = self.ensure_layout(text, gen, self.layout_width());
            if layout.is_null() {
                return 0.0;
            }
            let mut tm: DWRITE_TEXT_METRICS = zeroed();
            let hr = ((*(*layout).vtbl).get_metrics)(layout, &mut tm);
            if hr < 0 {
                0.0
            } else {
                tm.height
            }
        }
    }

    /// The line height in DIPs (the caret height at the document start), for wheel + Up/Down
    /// stepping. Falls back to a font-derived estimate if the layout/hit-test is unavailable.
    pub fn line_height(&mut self, text: &[u16], gen: u64) -> f32 {
        self.caret_xywh(text, gen, 0).map(|(_, _, h)| h).unwrap_or(FONT_SIZE_DIP * 1.3)
    }
}

/// The device-dependent resources rebuilt together on device loss: the hwnd render target
/// and the text / caret / selection / background brushes drawn from it (all GPU-device-backed).
type DeviceResources = (
    ComPtr<ID2D1HwndRenderTarget>,
    ComPtr<ID2D1SolidColorBrush>,
    ComPtr<ID2D1SolidColorBrush>,
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
    let sel_brush = ComPtr::from_raw(make_brush(target.as_raw(), SEL_COLOR)?);
    let bg_brush = ComPtr::from_raw(make_brush(target.as_raw(), BG_COLOR)?);
    Ok((target, text_brush, caret_brush, sel_brush, bg_brush))
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

/// Fill the highlight rectangles for the text range `[start, start+length)` of `layout`,
/// offset by (`origin_x`, `origin_y`) into the render target. DirectWrite returns one
/// metric per on-screen run (a wrapped/bidi selection is several boxes); we start with a
/// stack buffer and grow once if the range spans more runs than it holds.
unsafe fn fill_selection_range(
    rt: *mut ID2D1HwndRenderTarget,
    v: &ID2D1HwndRenderTargetVtbl,
    layout: *mut IDWriteTextLayout,
    brush: *mut c_void,
    origin_x: f32,
    origin_y: f32,
    start: u32,
    length: u32,
) {
    let lv = &*(*layout).vtbl;
    let mut metrics: [DWRITE_HIT_TEST_METRICS; 32] = zeroed();
    let mut actual: u32 = 0;
    let hr = (lv.hit_test_text_range)(
        layout,
        start,
        length,
        0.0,
        0.0,
        metrics.as_mut_ptr(),
        metrics.len() as u32,
        &mut actual,
    );
    if hr >= 0 {
        for m in &metrics[..actual as usize] {
            fill_metric(rt, v, brush, origin_x, origin_y, m);
        }
        return;
    }
    // Insufficient buffer: `actual` now holds the count we need. Grow once and retry.
    if actual > 0 {
        let mut buf: Vec<DWRITE_HIT_TEST_METRICS> = Vec::new();
        buf.resize_with(actual as usize, || zeroed());
        let cap = buf.len() as u32;
        let mut got: u32 = 0;
        let hr2 =
            (lv.hit_test_text_range)(layout, start, length, 0.0, 0.0, buf.as_mut_ptr(), cap, &mut got);
        if hr2 >= 0 {
            for m in &buf[..got as usize] {
                fill_metric(rt, v, brush, origin_x, origin_y, m);
            }
        }
    }
}

/// Fill one selection-run rectangle (a hit-test metric) with `brush`.
unsafe fn fill_metric(
    rt: *mut ID2D1HwndRenderTarget,
    v: &ID2D1HwndRenderTargetVtbl,
    brush: *mut c_void,
    origin_x: f32,
    origin_y: f32,
    m: &DWRITE_HIT_TEST_METRICS,
) {
    let rect = D2D1_RECT_F {
        left: origin_x + m.left,
        top: origin_y + m.top,
        right: origin_x + m.left + m.width,
        bottom: origin_y + m.top + m.height,
    };
    (v.fill_rectangle)(rt, &rect, brush);
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

    /// Build a real DWrite factory + format + layout for `text` at `width`, returning them
    /// (the factory + format must outlive the layout, so the caller holds all three) plus the
    /// UTF-16 units. No window needed — this is the layout-oracle substrate.
    unsafe fn build_layout(
        text: &str,
        width: f32,
    ) -> (
        ComPtr<IDWriteFactory>,
        ComPtr<IDWriteTextFormat>,
        *mut IDWriteTextLayout,
        Vec<u16>,
    ) {
        let mut dw: *mut c_void = null_mut();
        let hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, &IID_IDWRITE_FACTORY, &mut dw);
        assert!(hr >= 0, "DWriteCreateFactory failed: 0x{hr:08x}");
        let factory = ComPtr::from_raw(dw as *mut IDWriteFactory);
        let format =
            ComPtr::from_raw(make_text_format(factory.as_raw(), FONT_SIZE_DIP).expect("text format"));
        let units: Vec<u16> = text.encode_utf16().collect();
        let f = factory.as_raw();
        let mut layout: *mut IDWriteTextLayout = null_mut();
        let hr = ((*(*f).vtbl).create_text_layout)(
            f,
            units.as_ptr(),
            units.len() as u32,
            format.as_raw(),
            width,
            LAYOUT_MAX_HEIGHT,
            &mut layout,
        );
        assert!(hr >= 0 && !layout.is_null(), "CreateTextLayout failed: 0x{hr:08x}");
        (factory, format, layout, units)
    }

    /// Resolve a content-space point to a caret offset via the raw HitTestPoint slot (the
    /// same logic as `Renderer::hit_test_content`, but against a bare layout).
    unsafe fn hit(layout: *mut IDWriteTextLayout, x: f32, y: f32, len: usize) -> usize {
        let mut trailing: BOOL = 0;
        let mut inside: BOOL = 0;
        let mut m: DWRITE_HIT_TEST_METRICS = zeroed();
        let hr = ((*(*layout).vtbl).hit_test_point)(layout, x, y, &mut trailing, &mut inside, &mut m);
        assert!(hr >= 0, "HitTestPoint failed: 0x{hr:08x}");
        let mut off = m.text_position as usize;
        if trailing != 0 {
            off += m.length as usize;
        }
        off.min(len)
    }

    #[test]
    fn caret_x_is_monotonic() {
        unsafe {
            let (_factory, _format, layout, text) = build_layout("The quick brown fox", 1000.0);
            let mut last_x = f32::NEG_INFINITY;
            for i in 0..=text.len() {
                let (x, _y, h) =
                    caret_geometry(layout, i, text.len()).expect("hit-test position");
                assert!(x + 0.01 >= last_x, "caret x regressed at index {i}: {x} < {last_x}");
                assert!(h > 0.0, "caret height should be positive at index {i}");
                last_x = x;
            }
            com_release(layout as *mut c_void);
        }
    }

    /// The inverse guard to caret geometry: probing the leading quarter of each glyph round-
    /// trips back to that glyph's offset; the trailing quarter rounds up to the next. This
    /// exercises the newly-typed HitTestPoint slot (64) on real DirectWrite and pins the
    /// trailing-edge rule (SCRIPTORIUM-NATIVE-LAYOUT.md §4) that all spatial input depends on.
    #[test]
    fn point_position_round_trips() {
        unsafe {
            // Single ASCII line in a monospace font: a clean, non-wrapping geometry.
            let (_factory, _format, layout, text) = build_layout("The quick brown fox", 4000.0);
            let len = text.len();
            for i in 0..len {
                let (x0, y, h) = caret_geometry(layout, i, len).unwrap();
                let (x1, _, _) = caret_geometry(layout, i + 1, len).unwrap();
                let mid_y = y + h * 0.5;
                // Leading quarter of glyph i -> offset i (trailing hit false).
                let lead = hit(layout, x0 + (x1 - x0) * 0.25, mid_y, len);
                assert_eq!(lead, i, "leading-quarter probe of glyph {i} should map to {i}");
                // Trailing quarter of glyph i -> offset i+1 (trailing hit true).
                let trail = hit(layout, x0 + (x1 - x0) * 0.75, mid_y, len);
                assert_eq!(trail, i + 1, "trailing-quarter probe of glyph {i} should map to {}", i + 1);
            }
            com_release(layout as *mut c_void);
        }
    }

    /// The out-of-bounds edges (§4): DWrite clamps an out-of-range point to the nearest line
    /// and resolves x *within* that line, so honoring isTrailingHit (regardless of isInside)
    /// lands every edge where a user expects — no per-edge special-casing.
    #[test]
    fn out_of_bounds_clicks_clamp() {
        unsafe {
            let (_factory, _format, layout, text) = build_layout("hello", 4000.0);
            let len = text.len();
            let (_, y, h) = caret_geometry(layout, 0, len).unwrap();
            let mid_y = y + h * 0.5;
            // On the line: past the last glyph -> end; left of the margin -> start.
            assert_eq!(hit(layout, 100_000.0, mid_y, len), len, "click past EOL -> line end");
            assert_eq!(hit(layout, -100_000.0, mid_y, len), 0, "click left of margin -> line start");
            // Below the last line: y clamps to the last line, x then picks the position in
            // it — far right -> its end, far left -> its start (here, the single line = doc).
            assert_eq!(hit(layout, 100_000.0, 100_000.0, len), len, "below + right -> last line end");
            assert_eq!(hit(layout, -100_000.0, 100_000.0, len), 0, "below + left -> last line start");
            // Above the first line clamps the same way (reachable only mid-drag/over-scroll).
            assert_eq!(hit(layout, -100_000.0, -100_000.0, len), 0, "above + left -> doc start");
            com_release(layout as *mut c_void);
        }
    }

    /// Replicate `win32::vertical_motion`'s one-line geometry against a bare layout (no window
    /// needed): step the caret one visual line at the fixed goal column `gx`, returning the new
    /// offset. Mirrors the conductor's core (SCRIPTORIUM-NATIVE-LAYOUT.md §5) minus the view
    /// plumbing — including the Down doc-end snap.
    unsafe fn vstep(
        layout: *mut IDWriteTextLayout,
        caret: usize,
        gx: f32,
        down: bool,
        len: usize,
    ) -> usize {
        let (_, y, h) = caret_geometry(layout, caret, len).unwrap();
        let ty = if down { y + h } else { y - 1.0 };
        let off = hit(layout, gx, ty, len);
        // Snap to the doc edge when we couldn't cross to a new line (already on the first/last
        // visual line): Down → end, Up → start. HitTestPoint clamps y but keeps the goal column
        // on the same line, so the over-shoot must be detected explicitly (§5).
        let crossed = caret_geometry(layout, off, len).map_or(false, |(_, ny, _)| {
            if down { ny > y + 0.5 } else { ny < y - 0.5 }
        });
        if !crossed {
            return if down { len } else { 0 };
        }
        off
    }

    /// The sticky-goal-column oracle (§5): the most-fumbled vertical mechanic. Walking Down
    /// through a *short* line and back Up must return to the original column — the column is
    /// held in `goal_x`, not re-derived per line (which would drift). Plus the two edges: Up on
    /// the first line clamps to doc start, Down on the last snaps to doc end.
    #[test]
    fn vertical_motion_keeps_goal_column() {
        unsafe {
            // Long / short / long: the middle line is too short to hold the goal column.
            let (_factory, _format, layout, text) =
                build_layout("aaaaaaaaaaaa\nbb\ncccccccccccc", 4000.0);
            let len = text.len();
            let start = 8; // column 8 of the long first line
            let gx = caret_geometry(layout, start, len).unwrap().0;

            // Down onto the short line clamps to its end; Down again lands back at column 8 on
            // the third line *because gx was preserved* (the whole point).
            let a = vstep(layout, start, gx, true, len);
            let b = vstep(layout, a, gx, true, len);
            assert!(a < b, "the clamped short-line offset must precede the full-column offset");

            // Walking back Up returns through the short line to the exact starting column.
            let c = vstep(layout, b, gx, false, len);
            let d = vstep(layout, c, gx, false, len);
            assert_eq!(d, start, "Down·Down·Up·Up at a fixed goal column returns to the start column");

            // Edges: Down on the last line → doc end; Up on the first line → doc start.
            assert_eq!(vstep(layout, b, gx, true, len), len, "Down on the last line snaps to doc end");
            assert_eq!(vstep(layout, start, gx, false, len), 0, "Up on the first line clamps to doc start");

            com_release(layout as *mut c_void);
        }
    }

    /// Exercise the newly-typed GetMetrics slot (60) on real DirectWrite: a single
    /// non-wrapping ASCII line reports one line and a positive content height (the scroll
    /// extent source).
    #[test]
    fn get_metrics_reports_content_height() {
        unsafe {
            let (_factory, _format, layout, _text) = build_layout("one line of text", 4000.0);
            let mut tm: DWRITE_TEXT_METRICS = zeroed();
            let hr = ((*(*layout).vtbl).get_metrics)(layout, &mut tm);
            assert!(hr >= 0, "GetMetrics failed: 0x{hr:08x}");
            assert_eq!(tm.line_count, 1, "single line expected");
            assert!(tm.height > 0.0, "content height should be positive");
            com_release(layout as *mut c_void);
        }
    }
}
