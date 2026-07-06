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
use crate::heights::HeightIndex;
use crate::styles::{StyleKind, StyleSpan};
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
/// The left indent for a blockquote / list-item paragraph (STYLING §5A.3) — a feel knob. Applied to
/// the paragraph's draw origin AND its layout width (so wrap → measured height stays exact), and read
/// back by the caret/hit-test through the same `lay_out_paragraph` result (the one-authority rule).
const INDENT_DIP: f32 = 24.0;
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

/// The source-highlight brush palette (STYLING §5A.1) — created from the render target, so rebuilt
/// with it on device loss. Each is a feel knob (`HEADING_COLOR`/`MARKER_DIM_COLOR`/`QUOTE_COLOR`).
struct Palette {
    heading: ComPtr<ID2D1SolidColorBrush>,
    marker_dim: ComPtr<ID2D1SolidColorBrush>,
    quote: ComPtr<ID2D1SolidColorBrush>,
    rule: ComPtr<ID2D1SolidColorBrush>,
}

pub struct Renderer {
    // Field order is drop order: brushes/formats/target before the factories.
    target: ComPtr<ID2D1HwndRenderTarget>,
    text_brush: ComPtr<ID2D1SolidColorBrush>,
    caret_brush: ComPtr<ID2D1SolidColorBrush>,
    sel_brush: ComPtr<ID2D1SolidColorBrush>,
    // Opaque background fill — repaints the status strip so scrolled text can't bleed under
    // it (the pinned-chrome band, SCRIPTORIUM-NATIVE-LAYOUT.md §6). Device-dependent.
    bg_brush: ComPtr<ID2D1SolidColorBrush>,
    // The Wave-1.5 source-highlight palette (heading accent, dimmed markers, quote grey), attached to
    // sub-ranges via SetDrawingEffect so DrawTextLayout paints them (STYLING §5A.1). Device-dependent
    // — rebuilt with the target on device loss, and it MUST outlive any layout it's attached to (a
    // dropped brush behind a live drawing effect is a use-after-free), which it does: Renderer-lifetime.
    palette: Palette,
    text_format: ComPtr<IDWriteTextFormat>,
    status_format: ComPtr<IDWriteTextFormat>,
    // --- virtualized layout (N5, SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md) --------
    // The geometry authority is no longer one whole-document `IDWriteTextLayout` (that rebuild was
    // the UI-thread cliff — 15–34× parse, superlinear). Instead the document's content-space y is
    // synthesized from a per-paragraph height index, and only the paragraph a query/paint touches
    // is laid out (paragraphs are newline-isolated, so a standalone paragraph's geometry is
    // identical to its geometry in a whole-doc layout — the property the equivalence oracle pins).
    //
    // The height index: `para_top(i)` and `content_height` as prefix sums over per-paragraph
    // heights (measured on layout, estimated otherwise). `para_starts[i]` is paragraph i's start
    // offset (a paragraph = text between hard newlines = a rope line). Both are rebuilt from the
    // text when `(content_gen, wrap width)` drifts (`heights_gen`/`heights_width`); a measured
    // height is folded in whenever a paragraph is laid out, so the total converges to the truth.
    heights: HeightIndex,
    para_starts: Vec<usize>,
    // The per-paragraph content char-lengths of the last `rebuild_heights`, kept so a
    // paragraph-count-changing edit (Enter/Backspace/paste) can DIFF old vs new and splice the
    // height index at just the changed region — preserving the measured heights of every paragraph
    // above and below the edit (SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md §6, edit locality) rather than
    // resetting them all to estimates (which made content below the caret visibly jump).
    para_char_lens: Vec<usize>,
    heights_gen: u64,
    heights_width: f32,
    // Font metrics for the estimate of a not-yet-laid-out paragraph (`ceil(chars / (width /
    // avg_char_width)) × line_height`), probed once at construction (a single DWrite call, not
    // per-edit).
    avg_char_width: f32,
    line_height_dip: f32,
    // The block-level style spans to source-highlight with (SCRIPTORIUM-NATIVE-STYLING.md), refreshed
    // from `App` at the start of each paint. Applied per paragraph inside `lay_out_paragraph`, so paint
    // AND the point-queries AND the height index all see the styled layout (the one-authority rule).
    // They lag the live text (they reflect the last-landed parse); offsets are used only to pick a
    // paragraph's kind, and the applied range is always the whole current paragraph, so a stale offset
    // never reads out of range (§4).
    styles: Vec<StyleSpan>,
    // Whether `styles` lags the live text (a parse is in flight since the last edit), captured from
    // `App` at the start of each paint and read by `resolve_style`. While true, the paragraph being
    // edited is styled from a cheap lexical guess of its own markers (immediate) instead of the
    // stale AST span; while false the AST is the sole authority (STYLING §4, the pop-in fix). Held as a
    // field (not re-read from `App` per query) so point-queries between paints resolve styles
    // identically to the frame on screen.
    styles_stale: bool,
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

// The Wave-1.5 source-highlight palette (STYLING §5A.1) — every value a feel knob the author tunes.
// Headings take a deliberate deep-indigo accent (already bold+big); markers recede to a low-contrast
// grey so the file still reads as its source but the content pops; quotes grey down as secondary text.
const HEADING_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.14, g: 0.20, b: 0.42, a: 1.0 };
const MARKER_DIM_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.66, g: 0.66, b: 0.70, a: 1.0 };
const QUOTE_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.42, g: 0.44, b: 0.50, a: 1.0 };
// The drawn divider rule (STYLING §5A.4) — a soft hairline; the `---` source stays but dimmed.
const RULE_COLOR: D2D1_COLOR_F = D2D1_COLOR_F { r: 0.80, g: 0.80, b: 0.84, a: 1.0 };

/// The left indent (DIPs) for a paragraph's block kind (STYLING §5A.3): blockquotes and list items
/// shift right; everything else is flush left. Pure — the ONE place kind → indent, shared by the
/// layout width, the draw origin, and the caret/hit-test x-offset, so they can never disagree.
fn indent_for(kind: Option<StyleKind>) -> f32 {
    match kind {
        Some(StyleKind::BlockQuote) | Some(StyleKind::ListItem) => INDENT_DIP,
        _ => 0.0,
    }
}

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
            let palette = create_palette(target.as_raw())?;

            // Text formats.
            let text_format =
                ComPtr::from_raw(make_text_format(dwrite_factory.as_raw(), FONT_SIZE_DIP)?);
            let status_format =
                ComPtr::from_raw(make_text_format(dwrite_factory.as_raw(), STATUS_SIZE_DIP)?);

            // Probe the font's average advance width + line height once, for paragraph-height
            // estimates (N5). A one-time DWrite layout of a sample line — not a per-edit cost.
            let (avg_char_width, line_height_dip) =
                probe_font_metrics(dwrite_factory.as_raw(), text_format.as_raw());

            Ok(Renderer {
                target,
                text_brush,
                caret_brush,
                sel_brush,
                bg_brush,
                palette,
                text_format,
                status_format,
                heights: HeightIndex::new(),
                para_starts: Vec::new(),
                para_char_lens: Vec::new(),
                styles_stale: false,
                heights_gen: u64::MAX, // sentinel: forces the first rebuild_heights
                heights_width: -1.0,
                avg_char_width,
                line_height_dip,
                styles: Vec::new(),
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
                // The palette brushes come from the target, so rebuild them from the NEW one before
                // swapping it in — on failure keep the old resources and retry next frame (as below).
                match create_palette(target.as_raw()) {
                    Ok(palette) => {
                        self.target = target;
                        self.text_brush = text_brush;
                        self.caret_brush = caret_brush;
                        self.sel_brush = sel_brush;
                        self.bg_brush = bg_brush;
                        self.palette = palette;
                    }
                    Err(hr) => eprintln!("palette recreate failed: 0x{hr:08x}"),
                }
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

    /// Paint one frame: clear, draw the buffer text (translated by `scroll_y`), the selection +
    /// caret, then the pinned status strip on top. `px_w`/`px_h` are the physical client size;
    /// `scroll_y` is the content-space DIP offset of the viewport top (SCRIPTORIUM-NATIVE-LAYOUT.md
    /// §3 — content→pixel is `+PAD`, `−scroll_y` on y). It is `&mut` because virtualized paint may
    /// **scroll-anchor** it: measuring a paragraph that was estimated corrects the content above the
    /// viewport, and `scroll_y` is nudged so the reader's content doesn't jump (§5). The caller
    /// persists the returned value.
    pub fn draw(&mut self, app: &App, caret_visible: bool, scroll_y: &mut f32, px_w: u32, px_h: u32) {
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
            let viewport = (dip_h - PAD_DIP - STATUS_STRIP_DIP).max(0.0);

            // Virtualized paint (N5): lay out and draw only the paragraphs that intersect the
            // viewport band (± a small margin), each at its content-space top `para_top(i)`
            // (translated by `−scroll_y`). Paragraph layouts are transient; folding each one's
            // measured height in keeps `para_top` converging so the block is internally exact.
            self.rebuild_heights(&app.text, app.content_gen(), text_w);
            // Refresh the source-highlight spans from the last-landed parse (N-STYLING); applied per
            // paragraph in `lay_out_paragraph`, so the geometry path between paints uses these too.
            // `styles_stale` gates whether the edited paragraph is styled from the lagging AST or a
            // cheap immediate lexical guess (STYLING §4, the pop-in fix) — captured so every paragraph in
            // this frame (and any point-query before the next paint) resolves consistently.
            self.styles = app.styles().to_vec();
            self.styles_stale = !app.styles_current();
            if !self.para_starts.is_empty() {
                let n = self.para_starts.len();
                let margin = self.line_height_dip * 2.0;

                // Scroll-anchoring (§5): pin the topmost visible paragraph across estimate
                // corrections. The paragraphs entering the margin just above the viewport top (on a
                // scroll-up into un-measured text) get measured here; if their true height differs
                // from the estimate, `para_top(anchor)` shifts by Δ — so nudge `scroll_y` by Δ to
                // keep the anchor paragraph at the same screen position. Content the reader is
                // looking at does not move; only off-screen content above grew/shrank.
                let anchor = self.heights.locate(*scroll_y).0;
                let before = self.heights.para_top(anchor);
                let above = self.heights.locate((*scroll_y - margin).max(0.0)).0;
                for i in above..anchor {
                    self.lay_out_paragraph(&app.text, i, text_w);
                }
                let after = self.heights.para_top(anchor);
                *scroll_y += after - before;
                // Re-clamp to the (possibly corrected) extent.
                let content = self.heights.total();
                *scroll_y = scroll_y.clamp(0.0, (content - viewport).max(0.0));
                let scroll = *scroll_y;

                let p0 = self.heights.locate((scroll - margin).max(0.0)).0;
                let p1 = self.heights.locate(scroll + viewport + margin).0.min(n - 1);

                let comp = app.composition();
                let (lo, hi) = app.selection();
                let comp_para = comp.map(|_| self.para_of_offset(lo));
                // The one paragraph that paints the caret: the composition's while composing, else
                // the caret's — so exactly one paragraph draws it (and none if blinked off).
                let caret_owner = if !caret_visible {
                    None
                } else if comp.is_some() {
                    comp_para
                } else {
                    Some(self.para_of_offset(app.caret))
                };

                let text_brush = self.text_brush.as_raw() as *mut c_void;
                let sel = self.sel_brush.as_raw() as *mut c_void;
                let caret_b = self.caret_brush.as_raw() as *mut c_void;

                for i in p0..=p1 {
                    let oy = PAD_DIP - scroll + self.heights.para_top(i);
                    let ps = self.para_starts[i];
                    let pe = self.para_content_end(i, app.text.len());

                    if comp.is_some() && comp_para == Some(i) {
                        // The composition paragraph: draw the spliced provisional string (no normal
                        // selection highlight — the composition replaces it), the target-clause
                        // emphasis, the underline, and the caret within the composition (§8.7).
                        let c = comp.unwrap();
                        let units = self.spliced_paragraph(&app.text, i, lo, hi, &c.text);
                        // A heading (etc.) composed via an IME stays heading-styled (§8.3); a blockquote
                        // stays indented. Resolve the kind → indent so the composition paragraph shares
                        // the committed paragraph's layout width and draw origin (§5A.3).
                        let kind = self.resolve_style(&app.text, i);
                        let indent = indent_for(kind);
                        let ox = PAD_DIP + indent;
                        let raw = self.make_layout(&units, self.text_format.as_raw(), (text_w - indent).max(1.0), LAYOUT_MAX_HEIGHT);
                        if raw.is_null() {
                            continue;
                        }
                        // Color too, so it doesn't flip to body-colored mid-composition; the marker
                        // range comes from the spliced provisional text (what's actually on screen).
                        if let Some(k) = kind {
                            apply_paragraph_style(raw, k, units.len());
                            let marker_len = crate::styles::marker_len_of_line(&units);
                            self.apply_paragraph_color(raw, k, marker_len, units.len());
                        }
                        let layout = ComPtr::from_raw(raw);
                        let lptr = layout.as_raw();
                        let base = lo.clamp(ps, pe) - ps; // local start of the composition
                        if c.target_end > c.target_start {
                            fill_selection_range(rt, v, lptr, sel, ox, oy, (base + c.target_start) as u32, (c.target_end - c.target_start) as u32);
                        }
                        (v.draw_text_layout)(rt, D2D_POINT_2F { x: ox, y: oy }, lptr, text_brush, 0);
                        underline_range(rt, v, lptr, caret_b, ox, oy, base as u32, c.text.len() as u32);
                        if caret_owner == Some(i) {
                            let local_caret = base + c.caret_units.min(c.text.len());
                            draw_caret(rt, v, lptr, local_caret, units.len(), ox, oy, caret_b);
                        }
                    } else {
                        // A committed paragraph: lay it out (folding its measured height), draw the
                        // selection portion that falls in it, the text, and the caret if it lives here.
                        let (layout, clen, indent) = match self.lay_out_paragraph(&app.text, i, text_w) {
                            Some(l) => l,
                            None => continue,
                        };
                        let lptr = layout.as_raw();
                        let ox = PAD_DIP + indent; // blockquote/list shift right (§5A.3)
                        if app.has_selection() {
                            let s = lo.max(ps);
                            let e = hi.min(pe);
                            if e > s {
                                fill_selection_range(rt, v, lptr, sel, ox, oy, (s - ps) as u32, (e - s) as u32);
                            }
                        }
                        (v.draw_text_layout)(rt, D2D_POINT_2F { x: ox, y: oy }, lptr, text_brush, 0);
                        if caret_owner == Some(i) {
                            let local = (app.caret - ps).min(clen);
                            draw_caret(rt, v, lptr, local, clen, ox, oy, caret_b);
                        }
                        // A divider draws a hairline rule across the content width at the line's
                        // vertical centre (§5A.4); the dimmed `---` text (above) stays editable behind
                        // it. Only in the paint path — geometry/point-queries never draw the rule.
                        if matches!(self.resolve_style(&app.text, i), Some(StyleKind::Divider)) {
                            let mid = oy + self.line_height_dip * 0.5;
                            let right = (dip_w - PAD_DIP).max(ox);
                            let rule = D2D1_RECT_F { left: ox, top: mid - 0.5, right, bottom: mid + 0.5 };
                            (v.fill_rectangle)(rt, &rule, self.palette.rule.as_raw() as *mut c_void);
                        }
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

    // --- geometry service (SCRIPTORIUM-NATIVE-LAYOUT.md §2, virtualized at N5) -
    // The queries the input + paint paths share, now synthesized from the per-paragraph height
    // index instead of one whole-doc layout — but still one authority (paint + hit-test can't
    // disagree, because both lay a paragraph out the same way and read the same index). The layout
    // coords are content-space (origin at the top of the text, before scroll); callers apply the
    // scroll/padding transform (§3).

    // --- the height model (SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md §4/§6) --------

    /// Refresh the paragraph structure + height index when the content or wrap width changed
    /// (`(gen, width)` drift). A paragraph is text between hard newlines (a rope line);
    /// `para_starts[i]` is its start offset, its content excludes the trailing `\n`. A cheap O(n)
    /// byte scan (~1000× under the whole-doc DWrite shape it replaces) rebuilds `para_starts`.
    ///
    /// **Measured heights are preserved across a same-width edit that didn't change the paragraph
    /// count** — typing within a paragraph: the edited paragraph is visible and re-measures on the
    /// next paint (fold overwrites), off-screen paragraphs keep their measured heights, so the
    /// scroll extent stays stable (no per-keystroke wobble). A width change (rewrap invalidates
    /// every measurement, §8.4) or a count change (Enter/Backspace shifts paragraph *indices*)
    /// forces a full re-estimate. The precise rope-driven diff (invalidate exactly the touched
    /// paragraphs, §6) is the deferred refinement; this count-preserving heuristic captures its main
    /// benefit — a settled scrollbar while typing — without needing the edit range.
    fn rebuild_heights(&mut self, text: &[u16], gen: u64, width: f32) {
        if self.heights_gen == gen && (self.heights_width - width).abs() <= 0.5 {
            return;
        }
        let mut starts = vec![0usize];
        let mut char_lens: Vec<usize> = Vec::new();
        let mut last = 0usize;
        for (i, &u) in text.iter().enumerate() {
            if u == 0x000A {
                char_lens.push(i - last); // paragraph content, excluding this '\n'
                starts.push(i + 1);
                last = i + 1;
            }
        }
        char_lens.push(text.len() - last); // the final paragraph (no trailing '\n')

        let first_build = self.heights_gen == u64::MAX;
        let width_changed = (self.heights_width - width).abs() > 0.5;
        let count_changed = char_lens.len() != self.heights.len();
        self.para_starts = starts;
        let cpl = (width / self.avg_char_width).max(1.0);
        if first_build || width_changed {
            // A new wrap width (resize/DPI) invalidates every measured height — wrapping changed for
            // all paragraphs — so rebuild the whole index from estimates (§8.4). Same on first build.
            self.heights.reset_estimated(&char_lens, cpl, self.line_height_dip);
        } else if count_changed {
            // A paragraph-count-changing edit (Enter/Backspace-at-a-boundary/paste) at the SAME wrap
            // width: diff the old vs new per-paragraph char-lengths and splice the height index at
            // only the changed region, KEEPING the measured heights of every paragraph above and
            // below (§6). The old whole-index reset here is what made content below the caret jump to
            // estimates and snap back — the visible "judder". The changed paragraphs drop to fresh
            // estimates and re-measure on this same paint (they contain the caret, so they're on
            // screen); nothing outside the edit moves.
            self.heights.splice_to(&self.para_char_lens, &char_lens, cpl, self.line_height_dip);
        }
        // else: same width, same paragraph count → keep the index (measured heights survive); the
        // edited (visible) paragraph re-measures on the next paint.
        self.para_char_lens = char_lens;
        self.heights_gen = gen;
        self.heights_width = width;
    }

    /// The end offset of paragraph `i`'s content (the `\n` before the next paragraph is excluded;
    /// the last paragraph runs to the text end).
    fn para_content_end(&self, i: usize, text_len: usize) -> usize {
        if i + 1 < self.para_starts.len() {
            self.para_starts[i + 1] - 1
        } else {
            text_len
        }
    }

    /// The paragraph containing offset `off` — the largest `i` with `para_starts[i] <= off`. An
    /// offset at a paragraph's start belongs to that paragraph (the `\n` before it ends the prior).
    fn para_of_offset(&self, off: usize) -> usize {
        let n = self.para_starts.len();
        if n == 0 {
            return 0;
        }
        self.para_starts.partition_point(|&s| s <= off).saturating_sub(1).min(n - 1)
    }

    /// Lay out paragraph `i`'s content (transient — the caller owns and drops it) and fold its
    /// measured height into the index so `para_top`/`content_height` converge to the truth. No
    /// persistent cache yet: a paragraph is small (a viewport's worth is sub-millisecond to shape),
    /// and build-per-query keeps the coordinate model bug-free; a bounded cache is the measure-gated
    /// refinement (§3). Returns the layout + its content length, or `None` on failure.
    unsafe fn lay_out_paragraph(
        &mut self,
        text: &[u16],
        i: usize,
        width: f32,
    ) -> Option<(ComPtr<IDWriteTextLayout>, usize, f32)> {
        let start = self.para_starts[i];
        let end = self.para_content_end(i, text.len());
        // Resolve the block kind FIRST: it sets the indent (§5A.3), which reduces the layout width so
        // wrapping — and therefore the measured height folded below — matches the indented paint.
        let kind = self.resolve_style(text, i);
        let indent = indent_for(kind);
        let layout_width = (width - indent).max(1.0);
        let raw = self.make_layout(&text[start..end], self.text_format.as_raw(), layout_width, LAYOUT_MAX_HEIGHT);
        if raw.is_null() {
            return None;
        }
        let layout = ComPtr::from_raw(raw);
        // Source-highlight (N-STYLING): apply this paragraph's block style BEFORE measuring, so the
        // folded height reflects the styled (e.g. taller heading) layout and paint + point-queries
        // agree. Font attributes (size/weight/style) change geometry; color (SetDrawingEffect, §5A.1)
        // does not, but goes through the same one authority so paint and queries share ONE styled
        // layout. The range is always the whole current paragraph — a stale span offset can only pick
        // the wrong *kind*, never read out of range (§4). The indent is returned so paint (draw origin),
        // caret, and hit-test all shift by the same amount off this one layout.
        if let Some(k) = kind {
            apply_paragraph_style(layout.as_raw(), k, end - start);
            let marker_len = crate::styles::marker_len_of_line(&text[start..end]);
            self.apply_paragraph_color(layout.as_raw(), k, marker_len, end - start);
        }
        self.fold_paragraph_height(i, layout.as_raw());
        Some((layout, end - start, indent))
    }

    /// Attach the source-highlight color for a paragraph's block `kind` to its transient `layout` via
    /// SetDrawingEffect (STYLING §5A.1): the content in the kind's brush (heading accent / quote grey)
    /// and the leading `[0, marker_len)` markdown marker dimmed. Drawing effects don't affect
    /// metrics/hit-testing — this is paint-only styling riding the one shared layout, so a caret query
    /// through this same layout is unaffected. Body/list/divider (no content brush) fall through to
    /// DrawTextLayout's default text brush; Wave-1.5b/c give list + divider their own visuals.
    unsafe fn apply_paragraph_color(
        &self,
        layout: *mut IDWriteTextLayout,
        kind: StyleKind,
        marker_len: usize,
        content_len: usize,
    ) {
        if content_len == 0 {
            return;
        }
        let lv = &*(*layout).vtbl;
        let full = content_len as u32;
        let content_brush = match kind {
            StyleKind::Heading(_) => Some(self.palette.heading.as_raw()),
            StyleKind::BlockQuote | StyleKind::PullQuote => Some(self.palette.quote.as_raw()),
            // The `---` source stays (editable) but dims to grey — the drawn rule is the visual (§5A.4).
            StyleKind::Divider => Some(self.palette.marker_dim.as_raw()),
            StyleKind::ListItem => None,
        };
        // Content color: the range AFTER the marker, so the dimmed marker isn't overpainted.
        if let Some(b) = content_brush {
            let start = marker_len.min(content_len) as u32;
            if full > start {
                (lv.set_drawing_effect)(layout, b as *mut c_void, DWRITE_TEXT_RANGE { startPosition: start, length: full - start });
            }
        }
        // Dim the leading markdown marker (`#`s / `>` + ws).
        if marker_len > 0 {
            let m = marker_len.min(content_len) as u32;
            (lv.set_drawing_effect)(layout, self.palette.marker_dim.as_raw() as *mut c_void, DWRITE_TEXT_RANGE { startPosition: 0, length: m });
        }
    }

    /// The block style to actually apply to paragraph `i` (STYLING §4). When the AST styles are current the
    /// AST is the sole authority (context-aware — it alone knows, e.g., container nesting). While a
    /// parse is in flight (`styles_stale`) the AST lags the paragraph the user is editing, so for the
    /// kinds a line's own markers fully determine (heading, blockquote) we trust a cheap immediate
    /// lexical guess of the live text — the style tracks the keystroke with no frame-late pop-in —
    /// while keeping the last-good AST style for kinds the guess does not own (pull quote, list), so
    /// an edit elsewhere never flickers them off. The authoritative AST reasserts on settle.
    fn resolve_style(&self, text: &[u16], i: usize) -> Option<StyleKind> {
        if !self.styles_stale {
            return self.style_of_para(i);
        }
        match self.style_of_para(i) {
            // A kind the lexical scan does not own: keep the last-good AST style (no flicker).
            Some(k) if !matches!(k, StyleKind::Heading(_) | StyleKind::BlockQuote) => Some(k),
            // Heading / blockquote / plain: the paragraph's own live markers are the truth right now.
            _ => self.provisional_style_of_para(text, i),
        }
    }

    /// The lexical (parser-free) block style for paragraph `i` from its own text — the immediacy guess
    /// `resolve_style` uses while a parse is in flight (STYLING §4). Delegates to the platform-free scan.
    fn provisional_style_of_para(&self, text: &[u16], i: usize) -> Option<StyleKind> {
        let start = *self.para_starts.get(i)?;
        let end = self.para_content_end(i, text.len());
        crate::styles::provisional_style_from_line(&text[start..end])
    }

    /// The block style kind for paragraph `i` from the last-landed AST spans, or `None` for the
    /// default format (§7). Resolved by the paragraph's source range `[para_starts[i],
    /// para_starts[i+1])` — the span whose start falls inside it — so a blockquote (whose span begins
    /// after its `> ` marker, past the paragraph's own start) is matched, not silently dropped.
    fn style_of_para(&self, i: usize) -> Option<StyleKind> {
        let lo = *self.para_starts.get(i)?;
        let hi = self.para_starts.get(i + 1).copied().unwrap_or(usize::MAX);
        crate::styles::kind_for_paragraph(&self.styles, lo, hi)
    }

    /// Read a laid-out paragraph's real height (`GetMetrics`) and fold it into the index (measured
    /// truth replacing the estimate, §5).
    unsafe fn fold_paragraph_height(&mut self, i: usize, layout: *mut IDWriteTextLayout) {
        let mut tm: DWRITE_TEXT_METRICS = zeroed();
        if ((*(*layout).vtbl).get_metrics)(layout, &mut tm) >= 0 && tm.height > 0.0 {
            self.heights.measure(i, tm.height);
        }
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
    /// Virtualized (N5): locate the paragraph whose vertical span holds `cy`, lay out just that
    /// paragraph, hit-test locally (`cy − para_top`), and add the paragraph's start offset.
    pub fn hit_test_content(&mut self, text: &[u16], gen: u64, cx: f32, cy: f32) -> usize {
        unsafe {
            let width = self.layout_width();
            self.rebuild_heights(text, gen, width);
            if self.para_starts.is_empty() {
                return 0;
            }
            let (i, top) = self.heights.locate(cy);
            let (layout, clen, indent) = match self.lay_out_paragraph(text, i, width) {
                Some(l) => l,
                None => return 0,
            };
            let mut trailing: BOOL = 0;
            let mut inside: BOOL = 0;
            let mut m: DWRITE_HIT_TEST_METRICS = zeroed();
            let hr = ((*(*layout.as_raw()).vtbl).hit_test_point)(
                layout.as_raw(),
                cx - indent, // undo the paragraph's indent to get layout-local x (§5A.3); DWrite clamps <0 to line start
                (cy - top).max(0.0), // local y within the paragraph
                &mut trailing,
                &mut inside,
                &mut m,
            );
            if hr < 0 {
                return self.para_starts[i];
            }
            // offset = textPosition + (isTrailingHit ? cluster length : 0): clicking the right half
            // of a glyph lands the caret after the whole cluster. `isInside` is ignored on purpose —
            // honoring `trailing` regardless lands past-EOL / margin clicks where a user expects (§4).
            let mut local = m.text_position as usize;
            if trailing != 0 {
                local += m.length as usize;
            }
            // Clamp within the paragraph's content and lift to a document offset.
            self.para_starts[i] + local.min(clen)
        }
    }

    /// Caret geometry (x, top, height) in **content space** for a UTF-16 offset, or None.
    /// Virtualized (N5): lay out just the paragraph containing `offset`, resolve the caret locally,
    /// and lift the y by `para_top(paragraph)`.
    pub fn caret_xywh(&mut self, text: &[u16], gen: u64, offset: usize) -> Option<(f32, f32, f32)> {
        unsafe {
            let width = self.layout_width();
            self.rebuild_heights(text, gen, width);
            if self.para_starts.is_empty() {
                return None;
            }
            let i = self.para_of_offset(offset);
            let (layout, clen, indent) = self.lay_out_paragraph(text, i, width)?;
            let local = offset - self.para_starts[i];
            let (x, ly, h) = caret_geometry(layout.as_raw(), local.min(clen), clen)?;
            let top = self.heights.para_top(i);
            Some((indent + x, top + ly, h)) // shift content-x by the paragraph indent (§5A.3)
        }
    }

    /// The **display** caret geometry (x, top, height) in content space — composition-aware: the
    /// caret *within* the provisional string while composing (resolved on the spliced layout),
    /// else the committed caret. The one place the on-screen caret is resolved for the candidate
    /// window and scroll-follows, so both track the composition caret (SCRIPTORIUM-NATIVE-IME.md §5).
    pub fn display_caret_xywh(&mut self, app: &App) -> Option<(f32, f32, f32)> {
        match app.composition() {
            None => self.caret_xywh(&app.text, app.content_gen(), app.caret),
            Some(c) => unsafe {
                let width = self.layout_width();
                self.rebuild_heights(&app.text, app.content_gen(), width);
                if self.para_starts.is_empty() {
                    return None;
                }
                // The composition replaces the selection, which lives in one paragraph — splice it
                // into that paragraph's content and resolve the caret locally (N5 §8.7).
                let (lo, hi) = app.selection();
                let i = self.para_of_offset(lo);
                let units = self.spliced_paragraph(&app.text, i, lo, hi, &c.text);
                // Match the composition paint's indented layout width + x-origin (§5A.3), so the
                // candidate window / scroll-follows caret sit at the composed glyph in a quote.
                let indent = indent_for(self.resolve_style(&app.text, i));
                let raw = self.make_layout(&units, self.text_format.as_raw(), (width - indent).max(1.0), LAYOUT_MAX_HEIGHT);
                if raw.is_null() {
                    return None;
                }
                let layout = ComPtr::from_raw(raw);
                let local_caret = (lo - self.para_starts[i]) + c.caret_units.min(c.text.len());
                let (x, ly, h) = caret_geometry(layout.as_raw(), local_caret, units.len())?;
                let top = self.heights.para_top(i);
                Some((indent + x, top + ly, h))
            },
        }
    }

    /// Paragraph `i`'s content with the provisional composition `comp` spliced in place of the
    /// selection `[lo, hi)` (both clamped into the paragraph). The display units for the one
    /// paragraph an IME composition touches (N5 §8.7) — the buffer is never mutated.
    fn spliced_paragraph(&self, text: &[u16], i: usize, lo: usize, hi: usize, comp: &[u16]) -> Vec<u16> {
        let ps = self.para_starts[i];
        let pe = self.para_content_end(i, text.len());
        let lo = lo.clamp(ps, pe);
        let hi = hi.clamp(lo, pe);
        let mut units = Vec::with_capacity((pe - ps) + comp.len());
        units.extend_from_slice(&text[ps..lo]);
        units.extend_from_slice(comp);
        units.extend_from_slice(&text[hi..pe]);
        units
    }

    /// The display caret in **client pixels** — the point the IME candidate window pins to
    /// (§6). Content→viewport (`+PAD`, `−scroll_y`) then DIP→px; the caret's *bottom*-left so
    /// the candidate list sits just below the caret. None if the geometry is unavailable.
    pub fn display_caret_client_px(&mut self, app: &App, scroll_y: f32) -> Option<(i32, i32)> {
        let (cx, cy, ch) = self.display_caret_xywh(app)?;
        let scale = self.dpi as f32 / 96.0;
        let vx = (PAD_DIP + cx) * scale;
        let vy = (PAD_DIP + cy - scroll_y + ch) * scale;
        Some((vx as i32, vy as i32))
    }

    /// The scroll extent in DIPs — the height index total (measured paragraphs + estimates for the
    /// rest, N5 §4), not a whole-doc `GetMetrics`. Converges to the true height as the reader
    /// scrolls and more paragraphs are measured.
    pub fn content_height(&mut self, text: &[u16], gen: u64) -> f32 {
        let width = unsafe { self.layout_width() };
        self.rebuild_heights(text, gen, width);
        self.heights.total()
    }

    /// The line height in DIPs, for wheel + Up/Down stepping. Font-derived (probed once at
    /// construction) — constant for the single-format editor, so no layout is needed.
    pub fn line_height(&mut self, _text: &[u16], _gen: u64) -> f32 {
        self.line_height_dip
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

/// Build the source-highlight brush palette from a render target (STYLING §5A.1) — kept separate
/// from `create_device_resources` (which the recovery path also uses via a tuple) so the palette is
/// purely additive: it is created right after the target on construction and rebuilt with it on
/// device loss. On any failure the caller keeps the old (dead) palette and retries next frame.
unsafe fn create_palette(rt: *mut ID2D1HwndRenderTarget) -> Result<Palette, HRESULT> {
    Ok(Palette {
        heading: ComPtr::from_raw(make_brush(rt, HEADING_COLOR)?),
        marker_dim: ComPtr::from_raw(make_brush(rt, MARKER_DIM_COLOR)?),
        quote: ComPtr::from_raw(make_brush(rt, QUOTE_COLOR)?),
        rule: ComPtr::from_raw(make_brush(rt, RULE_COLOR)?),
    })
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

/// Draw the caret bar for local `offset` within `layout` (content length `len`), at paragraph
/// origin (`ox`, `oy`). Shared by the committed and composition paint paths (N5).
unsafe fn draw_caret(
    rt: *mut ID2D1HwndRenderTarget,
    v: &ID2D1HwndRenderTargetVtbl,
    layout: *mut IDWriteTextLayout,
    offset: usize,
    len: usize,
    ox: f32,
    oy: f32,
    brush: *mut c_void,
) {
    if let Some((cx, cy, ch)) = caret_geometry(layout, offset, len) {
        let rect = D2D1_RECT_F {
            left: ox + cx,
            top: oy + cy,
            right: ox + cx + CARET_WIDTH_DIP,
            bottom: oy + cy + ch,
        };
        (v.fill_rectangle)(rt, &rect, brush);
    }
}

/// Probe the font's average advance width + line height once, for paragraph-height estimates (N5
/// §4). Lay out a non-wrapping sample line: `avg_char_width = width / chars`, `line_height =
/// metrics.height / line_count`. Falls back to font-size-derived constants if the probe fails.
unsafe fn probe_font_metrics(factory: *mut IDWriteFactory, format: *mut IDWriteTextFormat) -> (f32, f32) {
    let fallback = (FONT_SIZE_DIP * 0.55, FONT_SIZE_DIP * 1.3);
    let sample: Vec<u16> = "MMMMMMMMMMMMMMMMMMMM".encode_utf16().collect(); // 20 glyphs, no wrap
    let mut layout: *mut IDWriteTextLayout = null_mut();
    let hr = ((*(*factory).vtbl).create_text_layout)(
        factory,
        sample.as_ptr(),
        sample.len() as u32,
        format,
        LAYOUT_MAX_HEIGHT,
        LAYOUT_MAX_HEIGHT,
        &mut layout,
    );
    if hr < 0 || layout.is_null() {
        return fallback;
    }
    let mut tm: DWRITE_TEXT_METRICS = zeroed();
    let ok = ((*(*layout).vtbl).get_metrics)(layout, &mut tm) >= 0 && tm.line_count >= 1;
    let result = if ok {
        let avg = if tm.width > 0.0 { tm.width / sample.len() as f32 } else { fallback.0 };
        (avg, tm.height / tm.line_count as f32)
    } else {
        fallback
    };
    com_release(layout as *mut c_void);
    result
}

/// Apply a block `StyleKind`'s font attributes to the whole paragraph range `[0, len)` of `layout`
/// (SCRIPTORIUM-NATIVE-STYLING.md §5). Wave 1 is size/weight/style only (no per-run brush, so no color
/// yet); `ListItem`/`Divider` carry no visual in Wave 1 (indent/rules are Wave-1.5).
unsafe fn apply_paragraph_style(layout: *mut IDWriteTextLayout, kind: StyleKind, len: usize) {
    if len == 0 {
        return;
    }
    let range = DWRITE_TEXT_RANGE { startPosition: 0, length: len as u32 };
    let lv = &*(*layout).vtbl;
    let (size_mul, weight, italic) = match kind {
        StyleKind::Heading(1) => (1.7f32, DWRITE_FONT_WEIGHT_BOLD, false),
        StyleKind::Heading(2) => (1.45, DWRITE_FONT_WEIGHT_BOLD, false),
        StyleKind::Heading(3) => (1.25, DWRITE_FONT_WEIGHT_SEMIBOLD, false),
        StyleKind::Heading(_) => (1.1, DWRITE_FONT_WEIGHT_SEMIBOLD, false),
        StyleKind::PullQuote => (1.15, DWRITE_FONT_WEIGHT_NORMAL, true),
        StyleKind::BlockQuote => (1.0, DWRITE_FONT_WEIGHT_NORMAL, true),
        StyleKind::ListItem | StyleKind::Divider => return, // Wave 1: no visual
    };
    if (size_mul - 1.0).abs() > 0.001 {
        (lv.set_font_size)(layout, FONT_SIZE_DIP * size_mul, range);
    }
    if weight != DWRITE_FONT_WEIGHT_NORMAL {
        (lv.set_font_weight)(layout, weight, range);
    }
    if italic {
        (lv.set_font_style)(layout, DWRITE_FONT_STYLE_ITALIC, range);
    }
}

/// Call `f` for each on-screen run rectangle of the text range `[start, start+length)`.
/// DirectWrite returns one metric per run (a wrapped/bidi range is several boxes); we start
/// with a stack buffer and grow once if the range spans more runs than it holds. The single
/// `HitTestTextRange` choke point shared by selection fill and composition underline.
unsafe fn each_range_metric(
    layout: *mut IDWriteTextLayout,
    start: u32,
    length: u32,
    mut f: impl FnMut(&DWRITE_HIT_TEST_METRICS),
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
            f(m);
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
                f(m);
            }
        }
    }
}

/// Fill the highlight rectangles for the range `[start, start+length)` of `layout`, offset by
/// (`origin_x`, `origin_y`) — the selection highlight, and the composition target-clause emphasis.
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
    each_range_metric(layout, start, length, |m| {
        let rect = D2D1_RECT_F {
            left: origin_x + m.left,
            top: origin_y + m.top,
            right: origin_x + m.left + m.width,
            bottom: origin_y + m.top + m.height,
        };
        (v.fill_rectangle)(rt, &rect, brush);
    });
}

/// The composition-underline thickness (a thin strip at each run's baseline-ish bottom).
const COMP_UNDERLINE_DIP: f32 = 1.5;

/// Underline the range `[start, start+length)` — a thin strip at the bottom of each run — the
/// "this text is provisional" affordance for an in-progress IME composition (§5).
unsafe fn underline_range(
    rt: *mut ID2D1HwndRenderTarget,
    v: &ID2D1HwndRenderTargetVtbl,
    layout: *mut IDWriteTextLayout,
    brush: *mut c_void,
    origin_x: f32,
    origin_y: f32,
    start: u32,
    length: u32,
) {
    each_range_metric(layout, start, length, |m| {
        let rect = D2D1_RECT_F {
            left: origin_x + m.left,
            top: origin_y + m.top + m.height - COMP_UNDERLINE_DIP,
            right: origin_x + m.left + m.width,
            bottom: origin_y + m.top + m.height,
        };
        (v.fill_rectangle)(rt, &rect, brush);
    });
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

    /// Exercise the newly-typed range-formatting slots (SetFontSize 35 / SetFontWeight 32 /
    /// SetFontStyle 33) on real DirectWrite — the phantom-slot guard (a never-*called* slot is an AV
    /// on first use). A heading-styled paragraph must come out taller (styling reached the glyphs),
    /// and the caret must stay monotonic on the styled layout (the slots didn't corrupt geometry).
    #[test]
    fn styled_range_changes_metrics_and_keeps_caret_monotonic() {
        unsafe {
            let (_f, _fmt, plain, text) = build_layout("Heading text goes here", 4000.0);
            let (_f2, _fmt2, styled, _t2) = build_layout("Heading text goes here", 4000.0);
            let range = DWRITE_TEXT_RANGE { startPosition: 0, length: text.len() as u32 };
            let sv = &*(*styled).vtbl;
            assert!((sv.set_font_size)(styled, FONT_SIZE_DIP * 1.7, range) >= 0, "SetFontSize (slot 35)");
            assert!((sv.set_font_weight)(styled, DWRITE_FONT_WEIGHT_BOLD, range) >= 0, "SetFontWeight (slot 32)");
            assert!((sv.set_font_style)(styled, DWRITE_FONT_STYLE_ITALIC, range) >= 0, "SetFontStyle (slot 33)");
            // Exercise SetDrawingEffect (slot 38, the Wave-1.5 color path) on real DWrite in the GATED
            // suite — a NULL effect is legal (clears any effect), so this pins the slot's offset +
            // calling convention without needing a render target to make a brush (the phantom-slot
            // lesson: a never-*called* slot AVs on first use; the windowed smoke calls it with a real
            // brush during paint, this calls it in the normal test run). Must not AV and returns S_OK.
            assert!((sv.set_drawing_effect)(styled, null_mut(), range) >= 0, "SetDrawingEffect (slot 38)");

            let mut pm: DWRITE_TEXT_METRICS = zeroed();
            let mut sm: DWRITE_TEXT_METRICS = zeroed();
            assert!(((*(*plain).vtbl).get_metrics)(plain, &mut pm) >= 0);
            assert!((sv.get_metrics)(styled, &mut sm) >= 0);
            assert!(sm.height > pm.height + 0.5, "1.7× paragraph is taller: {} vs {}", sm.height, pm.height);

            let mut last = f32::NEG_INFINITY;
            for i in 0..=text.len() {
                let (x, _y, h) = caret_geometry(styled, i, text.len()).expect("styled caret");
                assert!(x + 0.01 >= last, "caret x regressed on the styled layout at {i}");
                assert!(h > 0.0, "caret height positive on the styled layout at {i}");
                last = x;
            }
            com_release(plain as *mut c_void);
            com_release(styled as *mut c_void);
        }
    }

    #[test]
    fn indent_maps_blockquote_and_list_only() {
        // The one place kind → indent (§5A.3): only blockquotes and list items shift right.
        assert_eq!(indent_for(Some(StyleKind::BlockQuote)), INDENT_DIP);
        assert_eq!(indent_for(Some(StyleKind::ListItem)), INDENT_DIP);
        assert_eq!(indent_for(Some(StyleKind::Heading(1))), 0.0);
        assert_eq!(indent_for(Some(StyleKind::PullQuote)), 0.0);
        assert_eq!(indent_for(Some(StyleKind::Divider)), 0.0);
        assert_eq!(indent_for(None), 0.0);
    }

    #[test]
    fn indent_narrows_the_layout_so_height_only_grows() {
        // The load-bearing §5A.3 claim: an indented paragraph is laid out at width − indent, so the
        // height folded into the N5 index reflects the narrower *paint*. A narrower width can only
        // keep or grow a paragraph's height (more wrapping) — never shrink it — so the height index
        // stays exact for indented paragraphs. Same text, full vs indented width.
        unsafe {
            let long = "a moderately long blockquote line that will wrap once it is narrowed by the indent";
            let (_f, _fmt, wide, _t) = build_layout(long, 300.0);
            let (_f2, _fmt2, narrow, _t2) = build_layout(long, 300.0 - INDENT_DIP);
            let h = |l: *mut IDWriteTextLayout| -> f32 {
                let mut m: DWRITE_TEXT_METRICS = zeroed();
                assert!(((*(*l).vtbl).get_metrics)(l, &mut m) >= 0);
                m.height
            };
            let (hw, hn) = (h(wide), h(narrow));
            assert!(hn >= hw - 0.01, "narrower indent width can only grow height: {hn} vs {hw}");
            com_release(wide as *mut c_void);
            com_release(narrow as *mut c_void);
        }
    }

    /// THE headline N5 oracle (SCRIPTORIUM-NATIVE-VIRTUAL-LAYOUT.md §9): **virtualized geometry ≡
    /// whole-doc geometry** for a document that fits. Laying the whole document out as one layout
    /// (the old authority) and synthesizing geometry from per-paragraph layouts + `para_top` (the
    /// new authority) must agree — proving virtualization changed *cost*, not *geometry*, exactly
    /// as N4's snapshot/parse equivalence proved async changed timing, not result. Uses a **narrow**
    /// width so paragraphs wrap across several lines (the real test of the coordinate synthesis),
    /// and an empty paragraph (the degenerate line). All layouts come from one factory+format so
    /// their metrics are identical.
    #[test]
    fn virtualized_geometry_matches_whole_doc() {
        unsafe {
            let mut dw: *mut c_void = null_mut();
            let hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, &IID_IDWRITE_FACTORY, &mut dw);
            assert!(hr >= 0, "DWriteCreateFactory failed: 0x{hr:08x}");
            let factory = ComPtr::from_raw(dw as *mut IDWriteFactory);
            let format =
                ComPtr::from_raw(make_text_format(factory.as_raw(), FONT_SIZE_DIP).expect("format"));
            let f = factory.as_raw();
            let width = 220.0; // narrow: paragraphs wrap across lines

            let make = |units: &[u16]| -> *mut IDWriteTextLayout {
                let dummy = [0u16; 1];
                let ptr = if units.is_empty() { dummy.as_ptr() } else { units.as_ptr() };
                let mut out: *mut IDWriteTextLayout = null_mut();
                let hr = ((*(*f).vtbl).create_text_layout)(
                    f, ptr, units.len() as u32, format.as_raw(), width, LAYOUT_MAX_HEIGHT, &mut out,
                );
                assert!(hr >= 0 && !out.is_null(), "CreateTextLayout failed");
                out
            };
            let height_of = |l: *mut IDWriteTextLayout| -> f32 {
                let mut tm: DWRITE_TEXT_METRICS = zeroed();
                assert!(((*(*l).vtbl).get_metrics)(l, &mut tm) >= 0);
                tm.height
            };

            let text = "The quick brown fox jumps over the lazy dog again and again\n\
                        a second paragraph long enough to wrap a couple of times as well\n\
                        \n\
                        last";
            let units: Vec<u16> = text.encode_utf16().collect();
            let whole = make(&units);

            // Paragraph starts (line starts) + content ends (excluding the '\n').
            let mut starts = vec![0usize];
            for (i, &u) in units.iter().enumerate() {
                if u == 0x000A {
                    starts.push(i + 1);
                }
            }
            let para_end = |i: usize| -> usize {
                if i + 1 < starts.len() { starts[i + 1] - 1 } else { units.len() }
            };

            // Per-paragraph layouts + heights, and the prefix-sum para_top.
            let mut layouts = Vec::new();
            let mut heights = Vec::new();
            for i in 0..starts.len() {
                let l = make(&units[starts[i]..para_end(i)]);
                heights.push(height_of(l));
                layouts.push(l);
            }
            let para_top = |i: usize| -> f32 { heights[..i].iter().sum::<f32>() };

            // (1) content height: Σ per-paragraph heights ≈ the whole-doc height.
            let sum: f32 = heights.iter().sum();
            let whole_h = height_of(whole);
            assert!(
                (sum - whole_h).abs() <= 1.0,
                "content height diverged: virtualized {sum} vs whole-doc {whole_h}"
            );

            // (2) caret geometry across every offset: virtualized (para_top + local) ≈ whole-doc.
            for off in 0..=units.len() {
                let (wx, wy, wh) = caret_geometry(whole, off, units.len()).expect("whole caret");
                let p = starts.partition_point(|&s| s <= off).saturating_sub(1).min(starts.len() - 1);
                let clen = para_end(p) - starts[p];
                let local = (off - starts[p]).min(clen);
                let (vx, vyl, vh) = caret_geometry(layouts[p], local, clen).expect("para caret");
                let vy = para_top(p) + vyl;
                assert!((wx - vx).abs() <= 1.0, "caret x @ {off}: whole {wx} vs virt {vx}");
                assert!((wy - vy).abs() <= 1.0, "caret y @ {off}: whole {wy} vs virt {vy}");
                assert!((wh - vh).abs() <= 1.0, "caret height @ {off}: whole {wh} vs virt {vh}");
            }

            for l in layouts {
                com_release(l as *mut c_void);
            }
            com_release(whole as *mut c_void);
        }
    }
}
