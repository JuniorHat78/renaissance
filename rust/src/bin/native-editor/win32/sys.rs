//! Hand-declared Win32 + COM FFI — exactly what N0 calls, no more (umbrella §3:
//! no `windows-sys`, graph-zero). This is the surface the skeleton de-risks.
//!
//! COM recipe (SCRIPTORIUM-NATIVE-SKELETON.md §5): each interface is a
//! `#[repr(C)]` object whose first (and only) field is a pointer to its vtable; the
//! vtable is a `#[repr(C)]` struct of `extern "system"` fn pointers in EXACT COM
//! order — the three IUnknown slots (QueryInterface/AddRef/Release) first, then the
//! interface's own methods in declaration order. We type only the slots we call;
//! every other slot is a `usize` placeholder that holds the layout (named after the
//! real method so the table is auditable). Getting the order/signatures right is the
//! correctness risk we accept. Refcounts are released through the universal IUnknown
//! layout (`com_release`), so brushes/formats we only Release need no full vtable.

#![allow(non_snake_case, non_camel_case_types, dead_code, clippy::upper_case_acronyms)]

use core::ffi::c_void;

// --- scalar/handle aliases --------------------------------------------------

pub type HRESULT = i32;
pub type BOOL = i32;
pub type HWND = *mut c_void;
pub type HINSTANCE = *mut c_void;
pub type HICON = *mut c_void;
pub type HCURSOR = *mut c_void;
pub type HBRUSH = *mut c_void;
pub type HMENU = *mut c_void;
pub type HDC = *mut c_void;
pub type HGLOBAL = *mut c_void;
pub type HIMC = *mut c_void; // an Input Method Context handle (imm32)
pub type DPI_AWARENESS_CONTEXT = *mut c_void;
pub type WPARAM = usize;
pub type LPARAM = isize;
pub type LRESULT = isize;
pub type WNDPROC = Option<unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>;

// --- constants --------------------------------------------------------------

pub const CS_VREDRAW: u32 = 0x0001;
pub const CS_HREDRAW: u32 = 0x0002;
pub const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
pub const WS_VSCROLL: u32 = 0x0020_0000;
pub const CW_USEDEFAULT: i32 = 0x8000_0000u32 as i32;
pub const SW_SHOW: i32 = 5;
pub const IDC_ARROW: u16 = 32512;
pub const GWLP_USERDATA: i32 = -21;

pub const WM_CREATE: u32 = 0x0001;
pub const WM_DESTROY: u32 = 0x0002;
pub const WM_CLOSE: u32 = 0x0010;
pub const WM_SIZE: u32 = 0x0005;
pub const WM_PAINT: u32 = 0x000F;
pub const WM_KEYDOWN: u32 = 0x0100;
pub const WM_CHAR: u32 = 0x0102;
// Alt-modified keys arrive on the *system* message path (Windows reserves Alt for menus), not
// WM_KEYDOWN/WM_CHAR. We handle these in find-mode so Alt+Enter / Alt+C / Alt+W reach the bar, and
// swallow them so DefWindowProc doesn't ring the menu bell.
pub const WM_SYSKEYDOWN: u32 = 0x0104;
pub const WM_SYSKEYUP: u32 = 0x0105;
pub const WM_SYSCHAR: u32 = 0x0106;
pub const WM_TIMER: u32 = 0x0113;
pub const WM_VSCROLL: u32 = 0x0115;
pub const WM_MOUSEWHEEL: u32 = 0x020A;
pub const WM_MOUSEMOVE: u32 = 0x0200;
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const WM_CAPTURECHANGED: u32 = 0x0215;
pub const WM_KILLFOCUS: u32 = 0x0008;
pub const WM_IME_STARTCOMPOSITION: u32 = 0x010D;
pub const WM_IME_ENDCOMPOSITION: u32 = 0x010E;
pub const WM_IME_COMPOSITION: u32 = 0x010F;
pub const WM_IME_CHAR: u32 = 0x0286;
pub const WM_NCCREATE: u32 = 0x0081;
pub const WM_NCDESTROY: u32 = 0x0082;
pub const WM_DPICHANGED: u32 = 0x02E0;
/// App-private message: the off-thread parse worker posts this (contentless) to nudge the UI
/// thread to drain a finished parse (N4). `WM_APP` (0x8000) is the base of the application-private
/// range, so it can never collide with a system message.
pub const WM_APP_PARSE_DONE: u32 = 0x8000; // WM_APP + 0

// IME composition (imm32). GCS_* select which slice of the composition ImmGetCompositionStringW
// returns; CFS_* style the candidate window placement; ATTR_TARGET_* mark the converting clause;
// NI_COMPOSITIONSTR + CPS_COMPLETE force a commit on focus loss (SCRIPTORIUM-NATIVE-IME.md §3/§4).
pub const GCS_COMPSTR: u32 = 0x0008;
pub const GCS_COMPATTR: u32 = 0x0010;
pub const GCS_CURSORPOS: u32 = 0x0080;
pub const GCS_RESULTSTR: u32 = 0x0800;
pub const CFS_POINT: u32 = 0x0002;
pub const CFS_FORCE_POSITION: u32 = 0x0020;
pub const ATTR_TARGET_CONVERTED: u8 = 0x01;
pub const ATTR_TARGET_NOTCONVERTED: u8 = 0x03;
pub const NI_COMPOSITIONSTR: u32 = 0x0015;
pub const CPS_COMPLETE: u32 = 0x01;

// Mouse: MK_LBUTTON marks a drag in WM_MOUSEMOVE's wParam; SM_C?DOUBLECLK is the click-count
// hit-box (we track click count ourselves — the class has no CS_DBLCLKS — to also catch triple).
pub const MK_LBUTTON: usize = 0x0001;
pub const SM_CXDOUBLECLK: i32 = 36;
pub const SM_CYDOUBLECLK: i32 = 37;

// Mouse wheel: a notch is WHEEL_DELTA; high-res wheels/trackpads send sub-notch deltas that we
// accumulate. Lines-per-notch comes from SPI_GETWHEELSCROLLLINES (the special value
// WHEEL_PAGESCROLL means "a screen at a time"). SCROLLINFO/WM_VSCROLL drive the real scrollbar.
pub const WHEEL_DELTA: i32 = 120;
pub const SPI_GETWHEELSCROLLLINES: u32 = 0x0068;
pub const WHEEL_PAGESCROLL: u32 = 0xFFFF_FFFF;

// Scrollbar (WS_VSCROLL): SetScrollInfo mirrors scroll_y as an integer-DIP thumb; WM_VSCROLL
// carries an SB_ request in its low word (the 16-bit thumb pos in the high word is too narrow
// for a tall doc, so a thumb drag reads the 32-bit nTrackPos via GetScrollInfo/SIF_TRACKPOS).
pub const SB_VERT: i32 = 1;
pub const SIF_RANGE: u32 = 0x0001;
pub const SIF_PAGE: u32 = 0x0002;
pub const SIF_POS: u32 = 0x0004;
pub const SIF_TRACKPOS: u32 = 0x0010;
pub const SB_LINEUP: u32 = 0;
pub const SB_LINEDOWN: u32 = 1;
pub const SB_PAGEUP: u32 = 2;
pub const SB_PAGEDOWN: u32 = 3;
pub const SB_THUMBPOSITION: u32 = 4;
pub const SB_THUMBTRACK: u32 = 5;
pub const SB_TOP: u32 = 6;
pub const SB_BOTTOM: u32 = 7;

// Virtual-key codes (delivered by WM_KEYDOWN). N2 handles horizontal + word + line edges,
// plus Delete and the Ctrl shortcuts; N3b adds the vertical family (Up/Down/PageUp/PageDown),
// which is layout-aware — the offset one visual line away comes from the renderer's geometry
// service, not from `app` (SCRIPTORIUM-NATIVE-LAYOUT.md §5).
pub const VK_SHIFT: i32 = 0x10;
pub const VK_CONTROL: i32 = 0x11;
pub const VK_MENU: i32 = 0x12; // Alt (find-mode option toggles)
// Find/Replace (SCRIPTORIUM-NATIVE-FIND.md §4) — the find-mode command keys + letter chords.
pub const VK_BACK: u32 = 0x08;
pub const VK_TAB: u32 = 0x09;
pub const VK_RETURN: u32 = 0x0D;
pub const VK_ESCAPE: u32 = 0x1B;
pub const VK_F3: u32 = 0x72;
pub const VK_F: u32 = 0x46;
pub const VK_H: u32 = 0x48;
pub const VK_W: u32 = 0x57;
pub const VK_PRIOR: u32 = 0x21; // Page Up
pub const VK_NEXT: u32 = 0x22; // Page Down
pub const VK_END: u32 = 0x23;
pub const VK_HOME: u32 = 0x24;
pub const VK_LEFT: u32 = 0x25;
pub const VK_UP: u32 = 0x26;
pub const VK_RIGHT: u32 = 0x27;
pub const VK_DOWN: u32 = 0x28;
pub const VK_DELETE: u32 = 0x2E;
pub const VK_A: u32 = 0x41;
pub const VK_C: u32 = 0x43;
pub const VK_N: u32 = 0x4E;
pub const VK_O: u32 = 0x4F;
pub const VK_S: u32 = 0x53;
pub const VK_V: u32 = 0x56;
pub const VK_X: u32 = 0x58;

// File I/O (SCRIPTORIUM-NATIVE-IO.md §7). MessageBoxW drives the discard-unsaved-changes prompt
// (a three-way Yes/No/Cancel) and the read/write error boxes; the ID* are its return values. The
// OFN_* flags configure the comdlg32 Open/Save dialogs.
pub const MB_OK: u32 = 0x0000_0000;
pub const MB_YESNOCANCEL: u32 = 0x0000_0003;
pub const MB_ICONERROR: u32 = 0x0000_0010;
pub const MB_ICONWARNING: u32 = 0x0000_0030;
pub const IDOK: i32 = 1;
pub const IDCANCEL: i32 = 2;
pub const IDYES: i32 = 6;
pub const IDNO: i32 = 7;
pub const OFN_HIDEREADONLY: u32 = 0x0000_0004;
pub const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
pub const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
pub const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
pub const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
pub const OFN_EXPLORER: u32 = 0x0008_0000;

pub const SWP_NOZORDER: u32 = 0x0004;
pub const SWP_NOACTIVATE: u32 = 0x0010;

// Clipboard: CF_UNICODETEXT is UTF-16; the clipboard owns a moveable HGLOBAL.
pub const CF_UNICODETEXT: u32 = 13;
pub const GMEM_MOVEABLE: u32 = 0x0002;

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is the sentinel pointer value (HANDLE)-4.
// Int->ptr casts are illegal in const, so build it at the call site via this helper.
pub fn dpi_per_monitor_aware_v2() -> DPI_AWARENESS_CONTEXT {
    (-4isize) as DPI_AWARENESS_CONTEXT
}

// EndDraw / Present return this when the device is lost (driver update, RDP, sleep);
// the render target + its resources must be recreated. HRESULT is signed, so cast.
pub const D2DERR_RECREATE_TARGET: HRESULT = 0x8899_000Cu32 as i32;

// D2D / DWrite factory enum values + brush/draw options we pass.
pub const D2D1_FACTORY_TYPE_SINGLE_THREADED: u32 = 0;
pub const DWRITE_FACTORY_TYPE_SHARED: u32 = 0;
pub const DWRITE_FONT_WEIGHT_NORMAL: u32 = 400;
pub const DWRITE_FONT_STYLE_NORMAL: u32 = 0;
pub const DWRITE_FONT_STRETCH_NORMAL: u32 = 5;
// Heavier weights + italic for AST-styled rendering (SCRIPTORIUM-NATIVE-STYLING.md §5).
pub const DWRITE_FONT_WEIGHT_SEMIBOLD: u32 = 600;
pub const DWRITE_FONT_WEIGHT_BOLD: u32 = 700;
pub const DWRITE_FONT_STYLE_ITALIC: u32 = 2;

// --- plain structs ----------------------------------------------------------

#[repr(C)]
pub struct GUID {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

#[repr(C)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
pub struct RECT {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: u32,
    pub wParam: WPARAM,
    pub lParam: LPARAM,
    pub time: u32,
    pub pt: POINT,
}

#[repr(C)]
pub struct WNDCLASSEXW {
    pub cbSize: u32,
    pub style: u32,
    pub lpfnWndProc: WNDPROC,
    pub cbClsExtra: i32,
    pub cbWndExtra: i32,
    pub hInstance: HINSTANCE,
    pub hIcon: HICON,
    pub hCursor: HCURSOR,
    pub hbrBackground: HBRUSH,
    pub lpszMenuName: *const u16,
    pub lpszClassName: *const u16,
    pub hIconSm: HICON,
}

#[repr(C)]
pub struct PAINTSTRUCT {
    pub hdc: HDC,
    pub fErase: BOOL,
    pub rcPaint: RECT,
    pub fRestore: BOOL,
    pub fIncUpdate: BOOL,
    pub rgbReserved: [u8; 32],
}

#[repr(C)]
pub struct SCROLLINFO {
    pub cbSize: u32,
    pub fMask: u32,
    pub nMin: i32,
    pub nMax: i32,
    pub nPage: u32,
    pub nPos: i32,
    pub nTrackPos: i32,
}

/// Placement of the IME candidate window (`ImmSetCompositionWindow`): with `CFS_POINT` the
/// candidate list is pinned at `ptCurrentPos` (client pixels) — the caret (§6).
#[repr(C)]
pub struct COMPOSITIONFORM {
    pub dwStyle: u32,
    pub ptCurrentPos: POINT,
    pub rcArea: RECT,
}

/// The comdlg32 Open/Save common-dialog parameter block (`GetOpenFileNameW`/`GetSaveFileNameW`,
/// SCRIPTORIUM-NATIVE-IO.md §7). x64 layout is the correctness risk (the `WORD` pair at 100/102
/// then 4 bytes of padding before `lpstrDefExt` @104), so `size_of` (152) + key offsets are
/// ABI-asserted below alongside the COM vtables. We set `lStructSize`, `hwndOwner`, `lpstrFilter`,
/// `lpstrFile` (a caller-owned buffer, filled with the chosen path on return), `nMaxFile`,
/// `lpstrTitle`, `lpstrDefExt`, and `Flags`; the rest stay zeroed.
#[repr(C)]
pub struct OPENFILENAMEW {
    pub lStructSize: u32,
    pub hwndOwner: HWND,
    pub hInstance: HINSTANCE,
    pub lpstrFilter: *const u16,
    pub lpstrCustomFilter: *mut u16,
    pub nMaxCustFilter: u32,
    pub nFilterIndex: u32,
    pub lpstrFile: *mut u16,
    pub nMaxFile: u32,
    pub lpstrFileTitle: *mut u16,
    pub nMaxFileTitle: u32,
    pub lpstrInitialDir: *const u16,
    pub lpstrTitle: *const u16,
    pub Flags: u32,
    pub nFileOffset: u16,
    pub nFileExtension: u16,
    pub lpstrDefExt: *const u16,
    pub lCustData: LPARAM,
    pub lpfnHook: *mut c_void,
    pub lpTemplateName: *const u16,
    pub pvReserved: *mut c_void,
    pub dwReserved: u32,
    pub FlagsEx: u32,
}

#[repr(C)]
pub struct CREATESTRUCTW {
    pub lpCreateParams: *mut c_void,
    pub hInstance: HINSTANCE,
    pub hMenu: HMENU,
    pub hwndParent: HWND,
    pub cy: i32,
    pub cx: i32,
    pub y: i32,
    pub x: i32,
    pub style: i32,
    pub lpszName: *const u16,
    pub lpszClass: *const u16,
    pub dwExStyle: u32,
}

// --- Direct2D / DirectWrite value structs -----------------------------------

#[repr(C)]
pub struct D2D1_COLOR_F {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[repr(C)]
pub struct D2D_POINT_2F {
    pub x: f32,
    pub y: f32,
}

#[repr(C)]
pub struct D2D1_RECT_F {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

#[repr(C)]
pub struct D2D1_SIZE_U {
    pub width: u32,
    pub height: u32,
}

#[repr(C)]
pub struct D2D1_PIXEL_FORMAT {
    pub format: u32,
    pub alpha_mode: u32,
}

#[repr(C)]
pub struct D2D1_RENDER_TARGET_PROPERTIES {
    pub r#type: u32,
    pub pixel_format: D2D1_PIXEL_FORMAT,
    pub dpi_x: f32,
    pub dpi_y: f32,
    pub usage: u32,
    pub min_level: u32,
}

#[repr(C)]
pub struct D2D1_HWND_RENDER_TARGET_PROPERTIES {
    pub hwnd: HWND,
    pub pixel_size: D2D1_SIZE_U,
    pub present_options: u32,
}

#[repr(C)]
pub struct DWRITE_HIT_TEST_METRICS {
    pub text_position: u32,
    pub length: u32,
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
    pub bidi_level: u32,
    pub is_text: BOOL,
    pub is_trimmed: BOOL,
}

// A sub-range of a text layout `[startPosition, startPosition+length)`, passed by value to the
// range-formatting methods (SetFontWeight/Style/Size). Two u32 = 8 bytes. `Copy` so one range can
// drive several attribute calls.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DWRITE_TEXT_RANGE {
    pub startPosition: u32,
    pub length: u32,
}

// IDWriteTextLayout::GetMetrics out-param: the whole laid-out text's box. We read
// `height` (the real content height, for the scroll extent) and `line_count`.
#[repr(C)]
pub struct DWRITE_TEXT_METRICS {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub width_including_trailing_whitespace: f32,
    pub height: f32,
    pub layout_width: f32,
    pub layout_height: f32,
    pub max_bidi_reordering_depth: u32,
    pub line_count: u32,
}

// --- interface GUIDs --------------------------------------------------------

// ID2D1Factory  {06152247-6f50-465a-9245-118bfd3b6007}
pub const IID_ID2D1FACTORY: GUID = GUID {
    data1: 0x0615_2247,
    data2: 0x6f50,
    data3: 0x465a,
    data4: [0x92, 0x45, 0x11, 0x8b, 0xfd, 0x3b, 0x60, 0x07],
};

// IDWriteFactory {b859ee5a-d838-4b5b-a2e8-1adc7d93db48}
pub const IID_IDWRITE_FACTORY: GUID = GUID {
    data1: 0xb859_ee5a,
    data2: 0xd838,
    data3: 0x4b5b,
    data4: [0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48],
};

// --- universal IUnknown (for Release of any COM object) ---------------------

#[repr(C)]
pub struct IUnknownVtbl {
    pub query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    pub add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    pub release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[repr(C)]
pub struct IUnknownObj {
    pub vtbl: *const IUnknownVtbl,
}

/// Release any COM object through the universal IUnknown layout (slot 2). Works for
/// every interface because the first vtable pointer is always QI/AddRef/Release.
///
/// # Safety
/// `p` must be null or a live COM interface pointer this process owns a ref on.
pub unsafe fn com_release(p: *mut c_void) {
    if p.is_null() {
        return;
    }
    let obj = p as *mut IUnknownObj;
    ((*(*obj).vtbl).release)(p);
}

// --- ID2D1Factory (we call CreateHwndRenderTarget, slot 14) -----------------

#[repr(C)]
pub struct ID2D1FactoryVtbl {
    pub query_interface: usize,
    pub add_ref: usize,
    pub release: usize,
    pub reload_system_metrics: usize,          // 3
    pub get_desktop_dpi: usize,                // 4
    pub create_rectangle_geometry: usize,      // 5
    pub create_rounded_rectangle_geometry: usize, // 6
    pub create_ellipse_geometry: usize,        // 7
    pub create_geometry_group: usize,          // 8
    pub create_transformed_geometry: usize,    // 9
    pub create_path_geometry: usize,           // 10
    pub create_stroke_style: usize,            // 11
    pub create_drawing_state_block: usize,     // 12
    pub create_wic_bitmap_render_target: usize, // 13
    pub create_hwnd_render_target: unsafe extern "system" fn(
        *mut ID2D1Factory,
        *const D2D1_RENDER_TARGET_PROPERTIES,
        *const D2D1_HWND_RENDER_TARGET_PROPERTIES,
        *mut *mut ID2D1HwndRenderTarget,
    ) -> HRESULT, // 14
}

#[repr(C)]
pub struct ID2D1Factory {
    pub vtbl: *const ID2D1FactoryVtbl,
}

// --- ID2D1HwndRenderTarget --------------------------------------------------
// : ID2D1RenderTarget : ID2D1Resource : IUnknown. We call CreateSolidColorBrush(8),
// FillRectangle(17), DrawTextLayout(29), Clear(48), BeginDraw(49), EndDraw(50),
// SetDpi(52), Resize(59). All other slots are layout placeholders.

#[repr(C)]
pub struct ID2D1HwndRenderTargetVtbl {
    pub query_interface: usize, // 0
    pub add_ref: usize,         // 1
    pub release: usize,         // 2
    pub get_factory: usize,     // 3  (ID2D1Resource)
    pub create_bitmap: usize,   // 4
    pub create_bitmap_from_wic_bitmap: usize, // 5
    pub create_shared_bitmap: usize, // 6
    pub create_bitmap_brush: usize, // 7
    pub create_solid_color_brush: unsafe extern "system" fn(
        *mut ID2D1HwndRenderTarget,
        *const D2D1_COLOR_F,
        *const c_void, // D2D1_BRUSH_PROPERTIES*, we pass null
        *mut *mut ID2D1SolidColorBrush,
    ) -> HRESULT, // 8
    pub create_gradient_stop_collection: usize, // 9
    pub create_linear_gradient_brush: usize,    // 10
    pub create_radial_gradient_brush: usize,    // 11
    pub create_compatible_render_target: usize, // 12
    pub create_layer: usize,                    // 13
    pub create_mesh: usize,                     // 14
    pub draw_line: usize,                       // 15
    pub draw_rectangle: usize,                  // 16
    pub fill_rectangle: unsafe extern "system" fn(
        *mut ID2D1HwndRenderTarget,
        *const D2D1_RECT_F,
        *mut c_void, // ID2D1Brush*
    ), // 17
    pub draw_rounded_rectangle: usize, // 18
    pub fill_rounded_rectangle: usize, // 19
    pub draw_ellipse: usize,           // 20
    pub fill_ellipse: usize,           // 21
    pub draw_geometry: usize,          // 22
    pub fill_geometry: usize,          // 23
    // NB: ID2D1RenderTarget has exactly ONE mesh method — FillMesh. There is no
    // DrawMesh; an earlier phantom `draw_mesh` slot here shifted every method below it
    // down by one (so draw_text_layout pointed at DrawGlyphRun, begin_draw at EndDraw …)
    // → an access violation on the first real draw. Caught by the windowed smoke test.
    pub fill_mesh: usize,              // 24
    pub fill_opacity_mask: usize,      // 25
    pub draw_bitmap: usize,            // 26
    pub draw_text: usize,              // 27
    pub draw_text_layout: unsafe extern "system" fn(
        *mut ID2D1HwndRenderTarget,
        D2D_POINT_2F, // origin, by value (8-byte aggregate)
        *mut IDWriteTextLayout,
        *mut c_void, // ID2D1Brush* default fill
        u32,         // D2D1_DRAW_TEXT_OPTIONS
    ), // 28
    pub draw_glyph_run: usize,          // 29
    pub set_transform: usize,           // 30
    pub get_transform: usize,           // 31
    pub set_antialias_mode: usize,      // 32
    pub get_antialias_mode: usize,      // 33
    pub set_text_antialias_mode: usize, // 34
    pub get_text_antialias_mode: usize, // 35
    pub set_text_rendering_params: usize, // 36
    pub get_text_rendering_params: usize, // 37
    pub set_tags: usize,                // 38
    pub get_tags: usize,                // 39
    pub push_layer: usize,              // 40
    pub pop_layer: usize,               // 41
    pub flush: usize,                   // 42
    pub save_drawing_state: usize,      // 43
    pub restore_drawing_state: usize,   // 44
    pub push_axis_aligned_clip: usize,  // 45
    pub pop_axis_aligned_clip: usize,   // 46
    pub clear: unsafe extern "system" fn(*mut ID2D1HwndRenderTarget, *const D2D1_COLOR_F), // 47
    pub begin_draw: unsafe extern "system" fn(*mut ID2D1HwndRenderTarget),                 // 48
    pub end_draw: unsafe extern "system" fn(
        *mut ID2D1HwndRenderTarget,
        *mut u64, // tag1
        *mut u64, // tag2
    ) -> HRESULT, // 49
    pub get_pixel_format: usize, // 50
    pub set_dpi: unsafe extern "system" fn(*mut ID2D1HwndRenderTarget, f32, f32), // 51
    pub get_dpi: usize,                 // 52
    pub get_size: usize,                // 53
    pub get_pixel_size: usize,          // 54
    pub get_maximum_bitmap_size: usize, // 55
    pub is_supported: usize,            // 56
    pub check_window_state: usize,      // 57  (ID2D1HwndRenderTarget)
    pub resize: unsafe extern "system" fn(*mut ID2D1HwndRenderTarget, *const D2D1_SIZE_U) -> HRESULT, // 58
}

#[repr(C)]
pub struct ID2D1HwndRenderTarget {
    pub vtbl: *const ID2D1HwndRenderTargetVtbl,
}

// Brushes: we only ever Release them (via com_release) and pass them as ID2D1Brush*.
#[repr(C)]
pub struct ID2D1SolidColorBrush {
    pub vtbl: *const c_void,
}

// --- IDWriteFactory (we call CreateTextFormat(15), CreateTextLayout(18)) -----

#[repr(C)]
pub struct IDWriteFactoryVtbl {
    pub query_interface: usize, // 0
    pub add_ref: usize,         // 1
    pub release: usize,         // 2
    pub get_system_font_collection: usize,        // 3
    pub create_custom_font_collection: usize,     // 4
    pub register_font_collection_loader: usize,   // 5
    pub unregister_font_collection_loader: usize, // 6
    pub create_font_file_reference: usize,        // 7
    pub create_custom_font_file_reference: usize, // 8
    pub create_font_face: usize,                  // 9
    pub create_rendering_params: usize,           // 10
    pub create_monitor_rendering_params: usize,   // 11
    pub create_custom_rendering_params: usize,    // 12
    pub register_font_file_loader: usize,         // 13
    pub unregister_font_file_loader: usize,       // 14
    pub create_text_format: unsafe extern "system" fn(
        *mut IDWriteFactory,
        *const u16,  // fontFamilyName
        *mut c_void, // IDWriteFontCollection*, null
        u32,         // weight
        u32,         // style
        u32,         // stretch
        f32,         // size
        *const u16,  // localeName
        *mut *mut IDWriteTextFormat,
    ) -> HRESULT, // 15
    pub create_typography: usize,  // 16
    pub get_gdi_interop: usize,    // 17
    pub create_text_layout: unsafe extern "system" fn(
        *mut IDWriteFactory,
        *const u16, // string
        u32,        // stringLength
        *mut IDWriteTextFormat,
        f32, // maxWidth
        f32, // maxHeight
        *mut *mut IDWriteTextLayout,
    ) -> HRESULT, // 18
}

#[repr(C)]
pub struct IDWriteFactory {
    pub vtbl: *const IDWriteFactoryVtbl,
}

// Text format: only Released and passed to CreateTextLayout.
#[repr(C)]
pub struct IDWriteTextFormat {
    pub vtbl: *const c_void,
}

// --- IDWriteTextLayout (we call GetMetrics 60, HitTestPoint 64, ---------------
//     HitTestTextPosition 65, HitTestTextRange 66) --------------------------------
// : IDWriteTextFormat : IUnknown. IDWriteTextFormat contributes slots 3..=27,
// IDWriteTextLayout's own methods begin at 28. GetMetrics (60) gives the content
// height for the scroll extent; HitTestPoint (64) maps a clicked pixel to a text
// position (N3 spatial input); HitTestTextPosition (65) and HitTestTextRange (66)
// give caret + selection geometry.

#[repr(C)]
pub struct IDWriteTextLayoutVtbl {
    pub query_interface: usize, // 0
    pub add_ref: usize,         // 1
    pub release: usize,         // 2
    // IDWriteTextFormat (3..=27)
    pub set_text_alignment: usize,         // 3
    pub set_paragraph_alignment: usize,    // 4
    pub set_word_wrapping: usize,          // 5
    pub set_reading_direction: usize,      // 6
    pub set_flow_direction: usize,         // 7
    pub set_incremental_tab_stop: usize,   // 8
    pub set_trimming: usize,               // 9
    pub set_line_spacing: usize,           // 10
    pub get_text_alignment: usize,         // 11
    pub get_paragraph_alignment: usize,    // 12
    pub get_word_wrapping: usize,          // 13
    pub get_reading_direction: usize,      // 14
    pub get_flow_direction: usize,         // 15
    pub get_incremental_tab_stop: usize,   // 16
    pub get_trimming: usize,               // 17
    pub get_line_spacing: usize,           // 18
    pub get_font_collection_fmt: usize,    // 19
    pub get_font_family_name_length_fmt: usize, // 20
    pub get_font_family_name_fmt: usize,   // 21
    pub get_font_weight_fmt: usize,        // 22
    pub get_font_style_fmt: usize,         // 23
    pub get_font_stretch_fmt: usize,       // 24
    pub get_font_size_fmt: usize,          // 25
    pub get_locale_name_length_fmt: usize, // 26
    pub get_locale_name_fmt: usize,        // 27
    // IDWriteTextLayout (28..)
    pub set_max_width: usize,        // 28
    pub set_max_height: usize,       // 29
    pub set_font_collection: usize,  // 30
    pub set_font_family_name: usize, // 31
    // Range formatting for AST-styled rendering (SCRIPTORIUM-NATIVE-STYLING.md §6): apply a font
    // attribute to a sub-range of the layout. Each takes the attribute then a by-value
    // DWRITE_TEXT_RANGE (an 8-byte aggregate, passed in a register on x64).
    pub set_font_weight: unsafe extern "system" fn(*mut IDWriteTextLayout, u32, DWRITE_TEXT_RANGE) -> HRESULT, // 32
    pub set_font_style: unsafe extern "system" fn(*mut IDWriteTextLayout, u32, DWRITE_TEXT_RANGE) -> HRESULT, // 33
    pub set_font_stretch: usize,     // 34
    pub set_font_size: unsafe extern "system" fn(*mut IDWriteTextLayout, f32, DWRITE_TEXT_RANGE) -> HRESULT, // 35
    // Underline a sub-range — the link visual (STYLING §5B.2). `has_underline` is a BOOL (i32).
    pub set_underline: unsafe extern "system" fn(*mut IDWriteTextLayout, BOOL, DWRITE_TEXT_RANGE) -> HRESULT, // 36
    pub set_strikethrough: usize,    // 37
    // Attach a drawing effect (an ID2D1Brush*, as IUnknown*) to a sub-range; DrawTextLayout paints
    // that range with the brush automatically — the consume-only color path (STYLING §5A.1). The
    // brush pointer is passed as *mut c_void, matching how draw_text_layout/fill_rectangle take a
    // brush. A stale effect (dropped brush) would be a use-after-free, so brushes outlive the paint.
    pub set_drawing_effect: unsafe extern "system" fn(*mut IDWriteTextLayout, *mut c_void, DWRITE_TEXT_RANGE) -> HRESULT, // 38
    pub set_inline_object: usize,    // 39
    pub set_typography: usize,       // 40
    pub set_locale_name: usize,      // 41
    pub get_max_width: usize,        // 42
    pub get_max_height: usize,       // 43
    pub get_font_collection: usize,  // 44
    pub get_font_family_name_length: usize, // 45
    pub get_font_family_name: usize, // 46
    pub get_font_weight: usize,      // 47
    pub get_font_style: usize,       // 48
    pub get_font_stretch: usize,     // 49
    pub get_font_size: usize,        // 50
    pub get_underline: usize,        // 51
    pub get_strikethrough: usize,    // 52
    pub get_drawing_effect: usize,   // 53
    pub get_inline_object: usize,    // 54
    pub get_typography: usize,       // 55
    pub get_locale_name_length: usize, // 56
    pub get_locale_name: usize,      // 57
    pub draw: usize,                 // 58
    pub get_line_metrics: usize,     // 59
    pub get_metrics: unsafe extern "system" fn(
        *mut IDWriteTextLayout,
        *mut DWRITE_TEXT_METRICS, // out
    ) -> HRESULT, // 60
    pub get_overhang_metrics: usize, // 61
    pub get_cluster_metrics: usize,  // 62
    pub determine_min_width: usize,  // 63
    pub hit_test_point: unsafe extern "system" fn(
        *mut IDWriteTextLayout,
        f32,  // pointX (content space)
        f32,  // pointY (content space)
        *mut BOOL, // isTrailingHit (out)
        *mut BOOL, // isInside (out)
        *mut DWRITE_HIT_TEST_METRICS, // out
    ) -> HRESULT, // 64
    pub hit_test_text_position: unsafe extern "system" fn(
        *mut IDWriteTextLayout,
        u32,  // textPosition
        BOOL, // isTrailingHit
        *mut f32, // pointX (out)
        *mut f32, // pointY (out)
        *mut DWRITE_HIT_TEST_METRICS, // out
    ) -> HRESULT, // 65
    pub hit_test_text_range: unsafe extern "system" fn(
        *mut IDWriteTextLayout,
        u32, // textPosition
        u32, // textLength
        f32, // originX
        f32, // originY
        *mut DWRITE_HIT_TEST_METRICS, // out array (caller-allocated)
        u32, // maxHitTestMetricsCount
        *mut u32, // actualHitTestMetricsCount (out)
    ) -> HRESULT, // 66
}

#[repr(C)]
pub struct IDWriteTextLayout {
    pub vtbl: *const IDWriteTextLayoutVtbl,
}

// --- extern entry points (resolved only on the Windows target) --------------

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    pub fn RegisterClassExW(wc: *const WNDCLASSEXW) -> u16;
    pub fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: HWND,
        menu: HMENU,
        instance: HINSTANCE,
        param: *mut c_void,
    ) -> HWND;
    pub fn DefWindowProcW(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    pub fn ShowWindow(hwnd: HWND, cmd: i32) -> BOOL;
    pub fn UpdateWindow(hwnd: HWND) -> BOOL;
    pub fn GetMessageW(msg: *mut MSG, hwnd: HWND, min: u32, max: u32) -> BOOL;
    pub fn TranslateMessage(msg: *const MSG) -> BOOL;
    pub fn DispatchMessageW(msg: *const MSG) -> LRESULT;
    pub fn PostQuitMessage(code: i32);
    pub fn LoadCursorW(instance: HINSTANCE, name: *const u16) -> HCURSOR;
    pub fn InvalidateRect(hwnd: HWND, rect: *const RECT, erase: BOOL) -> BOOL;
    pub fn BeginPaint(hwnd: HWND, ps: *mut PAINTSTRUCT) -> HDC;
    pub fn EndPaint(hwnd: HWND, ps: *const PAINTSTRUCT) -> BOOL;
    pub fn GetClientRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    pub fn SetWindowLongPtrW(hwnd: HWND, index: i32, value: isize) -> isize;
    pub fn GetWindowLongPtrW(hwnd: HWND, index: i32) -> isize;
    pub fn SetTimer(hwnd: HWND, id: usize, elapse: u32, proc: *mut c_void) -> usize;
    pub fn KillTimer(hwnd: HWND, id: usize) -> BOOL;
    pub fn GetDpiForWindow(hwnd: HWND) -> u32;
    pub fn SetProcessDpiAwarenessContext(ctx: DPI_AWARENESS_CONTEXT) -> BOOL;
    // Wheel tuning: reads the user's lines-per-notch into a UINT via pvParam.
    pub fn SystemParametersInfoW(action: u32, ui_param: u32, pv_param: *mut c_void, win_ini: u32) -> BOOL;
    // Vertical scrollbar: mirror scroll_y out (Set) and read the 32-bit thumb track pos in (Get).
    pub fn SetScrollInfo(hwnd: HWND, bar: i32, info: *const SCROLLINFO, redraw: BOOL) -> i32;
    pub fn GetScrollInfo(hwnd: HWND, bar: i32, info: *mut SCROLLINFO) -> BOOL;
    pub fn SetWindowPos(
        hwnd: HWND,
        insert_after: HWND,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> BOOL;
    pub fn SendMessageW(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    // The off-thread parse worker posts a contentless WM_APP_PARSE_DONE from its own thread to
    // wake the UI pump (N4). PostMessageW is the documented thread-safe cross-thread call; posting
    // to an already-destroyed window fails harmlessly (§6). Async — returns before it's handled.
    pub fn PostMessageW(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> BOOL;
    pub fn DestroyWindow(hwnd: HWND) -> BOOL;
    pub fn GetKeyState(vk: i32) -> i16;
    // File I/O UI (SCRIPTORIUM-NATIVE-IO.md §5/§7): MessageBoxW is the discard-changes prompt and
    // the read/write error boxes; SetWindowTextW retitles the window with the document name + a
    // dirty marker.
    pub fn MessageBoxW(hwnd: HWND, text: *const u16, caption: *const u16, u_type: u32) -> i32;
    pub fn SetWindowTextW(hwnd: HWND, text: *const u16) -> BOOL;
    // Mouse capture + click-count inputs: a drag tracks past the window edge via SetCapture;
    // GetMessageTime + GetDoubleClickTime + GetSystemMetrics classify single/double/triple.
    pub fn SetCapture(hwnd: HWND) -> HWND;
    pub fn ReleaseCapture() -> BOOL;
    pub fn GetMessageTime() -> i32;
    pub fn GetDoubleClickTime() -> u32;
    pub fn GetSystemMetrics(index: i32) -> i32;
    // Clipboard (the system clipboard is a user32 resource).
    pub fn OpenClipboard(hwnd: HWND) -> BOOL;
    pub fn CloseClipboard() -> BOOL;
    pub fn EmptyClipboard() -> BOOL;
    pub fn SetClipboardData(format: u32, mem: HGLOBAL) -> HGLOBAL;
    pub fn GetClipboardData(format: u32) -> HGLOBAL;
    pub fn IsClipboardFormatAvailable(format: u32) -> BOOL;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    pub fn GetModuleHandleW(module_name: *const u16) -> HINSTANCE;
    // Global memory — the clipboard takes ownership of an HGLOBAL of CF_UNICODETEXT.
    pub fn GlobalAlloc(flags: u32, bytes: usize) -> HGLOBAL;
    pub fn GlobalLock(mem: HGLOBAL) -> *mut c_void;
    pub fn GlobalUnlock(mem: HGLOBAL) -> BOOL;
    pub fn GlobalSize(mem: HGLOBAL) -> usize;
}

#[cfg(windows)]
#[link(name = "comdlg32")]
extern "system" {
    // The Open/Save common dialogs (SCRIPTORIUM-NATIVE-IO.md §7). Each takes a caller-filled
    // OPENFILENAMEW; returns nonzero and writes the chosen path into `lpstrFile` on OK, zero on
    // Cancel (or error — CommDlgExtendedError, which we treat as "no file picked").
    pub fn GetOpenFileNameW(ofn: *mut OPENFILENAMEW) -> BOOL;
    pub fn GetSaveFileNameW(ofn: *mut OPENFILENAMEW) -> BOOL;
}

#[cfg(windows)]
#[link(name = "d2d1")]
extern "system" {
    pub fn D2D1CreateFactory(
        factory_type: u32,
        riid: *const GUID,
        options: *const c_void,
        factory: *mut *mut c_void,
    ) -> HRESULT;
}

#[cfg(windows)]
#[link(name = "dwrite")]
extern "system" {
    pub fn DWriteCreateFactory(
        factory_type: u32,
        iid: *const GUID,
        factory: *mut *mut c_void,
    ) -> HRESULT;
}

#[cfg(windows)]
#[link(name = "imm32")]
extern "system" {
    // The IME composition surface (SCRIPTORIUM-NATIVE-IME.md §3). ImmGetCompositionStringW
    // returns a byte count: called with a null buffer it reports the size to allocate, then
    // fills WCHARs (GCS_COMPSTR/RESULTSTR) or attribute bytes (GCS_COMPATTR), or returns the
    // caret unit-index directly (GCS_CURSORPOS).
    pub fn ImmGetContext(hwnd: HWND) -> HIMC;
    pub fn ImmReleaseContext(hwnd: HWND, himc: HIMC) -> BOOL;
    pub fn ImmGetCompositionStringW(himc: HIMC, index: u32, buf: *mut c_void, len: u32) -> i32;
    pub fn ImmSetCompositionWindow(himc: HIMC, form: *const COMPOSITIONFORM) -> BOOL;
    pub fn ImmNotifyIME(himc: HIMC, action: u32, index: u32, value: u32) -> BOOL;
}

// --- ABI layout guards (the deterministic FFI hardening) --------------------
// The scariest class of COM-from-raw-Rust bug is a *silently* miscounted vtable: a
// typed method landing at the wrong slot calls the wrong function pointer (UB). These
// tests assert, against our own `#[repr(C)]` types (no DWrite needed), that every method
// we call sits at exactly `slot * pointer_size`, and that each by-value struct has its
// real ABI size. If a placeholder count ever drifts, this fails loudly and locally
// instead of corrupting at runtime. The slot numbers mirror the `// N` comments above.
#[cfg(test)]
mod layout_tests {
    use super::*;
    use core::mem::{offset_of, size_of};

    // Vtable slots are pointer-sized; on the 64-bit CI targets this is 8.
    const P: usize = size_of::<usize>();

    #[test]
    fn vtable_slots_match_com_order() {
        assert_eq!(offset_of!(ID2D1FactoryVtbl, create_hwnd_render_target), 14 * P);

        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, create_solid_color_brush), 8 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, fill_rectangle), 17 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, draw_text_layout), 28 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, clear), 47 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, begin_draw), 48 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, end_draw), 49 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, set_dpi), 51 * P);
        assert_eq!(offset_of!(ID2D1HwndRenderTargetVtbl, resize), 58 * P);

        assert_eq!(offset_of!(IDWriteFactoryVtbl, create_text_format), 15 * P);
        assert_eq!(offset_of!(IDWriteFactoryVtbl, create_text_layout), 18 * P);

        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, set_font_weight), 32 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, set_font_style), 33 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, set_font_size), 35 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, set_underline), 36 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, set_drawing_effect), 38 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, get_metrics), 60 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, hit_test_point), 64 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, hit_test_text_position), 65 * P);
        assert_eq!(offset_of!(IDWriteTextLayoutVtbl, hit_test_text_range), 66 * P);
    }

    #[test]
    fn value_struct_sizes_match_abi() {
        assert_eq!(size_of::<GUID>(), 16);
        assert_eq!(size_of::<D2D1_COLOR_F>(), 16);
        assert_eq!(size_of::<D2D_POINT_2F>(), 8);
        assert_eq!(size_of::<D2D1_RECT_F>(), 16);
        assert_eq!(size_of::<D2D1_SIZE_U>(), 8);
        assert_eq!(size_of::<D2D1_PIXEL_FORMAT>(), 8);
        // 9 four-byte fields, no padding.
        assert_eq!(size_of::<DWRITE_HIT_TEST_METRICS>(), 36);
        // 7 f32 + 2 u32, no padding.
        assert_eq!(size_of::<DWRITE_TEXT_METRICS>(), 36);
        // 7 four-byte fields (cbSize is read by Set/GetScrollInfo to version the struct).
        assert_eq!(size_of::<SCROLLINFO>(), 28);
        // DWORD(4) + POINT(8) + RECT(16), no padding — passed by pointer to ImmSetCompositionWindow.
        assert_eq!(size_of::<COMPOSITIONFORM>(), 28);
        // Two u32, passed BY VALUE to the range-formatting methods — the 8-byte size is the ABI risk.
        assert_eq!(size_of::<DWRITE_TEXT_RANGE>(), 8);
        // OPENFILENAMEW (comdlg32): the x64 risk is the WORD pair (nFileOffset/nFileExtension at
        // 100/102) then 4 bytes of padding before the next pointer (lpstrDefExt @104). Pin Flags,
        // lpstrDefExt, and the total size — a miscount would hand comdlg32 a malformed block.
        assert_eq!(offset_of!(OPENFILENAMEW, Flags), 96);
        assert_eq!(offset_of!(OPENFILENAMEW, lpstrDefExt), 104);
        assert_eq!(size_of::<OPENFILENAMEW>(), 152);
    }
}
