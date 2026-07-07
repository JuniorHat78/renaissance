//! Pure geometry for the self-drawn find bar (SCRIPTORIUM-NATIVE-FIND.md §4/§5).
//!
//! One source of truth for *where the bar's parts are*. The renderer draws from these rects and
//! the win32 mouse handler hit-tests clicks against the same rects, so a click always lands on
//! exactly what was painted — there is no second, drifting copy of the layout math. All values are
//! DIPs (the render target's coordinate space); the caller converts physical pixels first.
//!
//! Platform-free (no Win32/COM), so the geometry is oracled on every platform.

#![cfg_attr(not(test), allow(dead_code))]

/// A DIP-space rectangle, half-open on the right/bottom so adjacent rects don't both claim a
/// boundary pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Rect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
    pub fn width(&self) -> f32 {
        self.right - self.left
    }
}

// --- shared constants (the renderer references these too, so the two never diverge) ----------
pub const FB_MARGIN: f32 = 12.0; // gap from the client edges to the panel
pub const FB_PAD: f32 = 8.0; // panel inner padding
pub const FB_FIELD_H: f32 = 24.0; // one text field's height
pub const FB_ROW_GAP: f32 = 6.0; // vertical gap between the query and replace rows
pub const FB_COUNTER_W: f32 = 52.0; // the "N/M" counter column
pub const FB_TOGGLE_W: f32 = 26.0; // one toggle box ("Aa" / "W")
pub const FB_GAP: f32 = 6.0; // horizontal gap between field / counter / toggles
pub const FB_BAR_W_MAX: f32 = 400.0;
pub const FB_BAR_W_MIN: f32 = 220.0;
/// Left inset of the text inside a field well (matches `draw_field`'s `tx = x + 5.0`).
pub const FB_FIELD_TEXT_PAD: f32 = 5.0;

/// The resolved rects for one find-bar state. Every clickable part is a `Rect`; the renderer also
/// uses these to position its decoration (counter text, key hints) relative to them.
#[derive(Clone, Copy, Debug)]
pub struct FindBarGeom {
    pub panel: Rect,
    pub query: Rect,
    pub replace: Option<Rect>, // Some only when the replace row is visible
    pub counter: Rect,         // "N/M" — not clickable, but drawn from here
    pub aa: Rect,              // case-sensitivity toggle
    pub word: Rect,            // whole-word toggle
}

impl FindBarGeom {
    /// The text origin (left, top) inside a field rect — where a field's glyphs and caret start.
    pub fn field_text_origin(field: &Rect) -> (f32, f32) {
        (field.left + FB_FIELD_TEXT_PAD, field.top + 3.0)
    }
    /// The usable text width inside a field rect.
    pub fn field_inner_w(field: &Rect) -> f32 {
        (field.width() - FB_FIELD_TEXT_PAD * 2.0).max(1.0)
    }
}

/// Compute the bar's rects for a client width `dip_w` and whether the replace row shows.
pub fn compute(dip_w: f32, replace_visible: bool) -> FindBarGeom {
    let bar_w = FB_BAR_W_MAX.min(dip_w - FB_MARGIN * 2.0).max(FB_BAR_W_MIN);
    let rows = if replace_visible { 2 } else { 1 };
    let bar_h = FB_PAD * 2.0 + FB_FIELD_H * rows as f32 + FB_ROW_GAP * (rows - 1) as f32;
    let bar_x = (dip_w - FB_MARGIN - bar_w).max(FB_MARGIN);
    let bar_y = FB_MARGIN;

    let panel = Rect { left: bar_x, top: bar_y, right: bar_x + bar_w, bottom: bar_y + bar_h };

    let field_x = bar_x + FB_PAD;
    let field_w = bar_w - FB_PAD * 2.0 - FB_COUNTER_W - FB_TOGGLE_W * 2.0 - FB_GAP * 3.0;
    let r1 = bar_y + FB_PAD;

    let query = Rect { left: field_x, top: r1, right: field_x + field_w, bottom: r1 + FB_FIELD_H };

    let counter_x = field_x + field_w + FB_GAP;
    let counter = Rect { left: counter_x, top: r1, right: counter_x + FB_COUNTER_W, bottom: r1 + FB_FIELD_H };

    // The toggles are drawn as bare text at `r1 + 4`, but their click targets span the full field
    // height so they're comfortable to hit.
    let aa_x = counter_x + FB_COUNTER_W + FB_GAP;
    let aa = Rect { left: aa_x, top: r1, right: aa_x + FB_TOGGLE_W, bottom: r1 + FB_FIELD_H };
    let w_x = aa_x + FB_TOGGLE_W + FB_GAP;
    let word = Rect { left: w_x, top: r1, right: w_x + FB_TOGGLE_W, bottom: r1 + FB_FIELD_H };

    let replace = if replace_visible {
        let r2 = r1 + FB_FIELD_H + FB_ROW_GAP;
        Some(Rect { left: field_x, top: r2, right: field_x + field_w, bottom: r2 + FB_FIELD_H })
    } else {
        None
    };

    FindBarGeom { panel, query, replace, counter, aa, word }
}

/// What a click at (`x`, `y`) DIPs landed on, given the bar geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Hit {
    Query,
    Replace,
    ToggleCase,
    ToggleWord,
    /// Inside the panel but not on any control — swallow so the click doesn't fall to the document.
    Panel,
    /// Outside the panel entirely — the caller lets the document handle it.
    Outside,
}

impl FindBarGeom {
    pub fn hit(&self, x: f32, y: f32) -> Hit {
        if self.query.contains(x, y) {
            Hit::Query
        } else if self.replace.map(|r| r.contains(x, y)).unwrap_or(false) {
            Hit::Replace
        } else if self.aa.contains(x, y) {
            Hit::ToggleCase
        } else if self.word.contains(x, y) {
            Hit::ToggleWord
        } else if self.panel.contains(x, y) {
            Hit::Panel
        } else {
            Hit::Outside
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_sit_inside_the_panel_and_dont_overlap() {
        let g = compute(1200.0, true);
        for r in [g.query, g.replace.unwrap(), g.counter, g.aa, g.word] {
            assert!(r.left >= g.panel.left && r.right <= g.panel.right, "{r:?} escapes panel x");
            assert!(r.top >= g.panel.top && r.bottom <= g.panel.bottom, "{r:?} escapes panel y");
        }
        // The row-1 controls are laid left→right without overlap.
        assert!(g.query.right <= g.counter.left);
        assert!(g.counter.right <= g.aa.left);
        assert!(g.aa.right <= g.word.left);
    }

    #[test]
    fn replace_row_only_when_visible() {
        assert!(compute(1200.0, false).replace.is_none());
        let g = compute(1200.0, true);
        let r = g.replace.unwrap();
        // The replace field sits below the query field, same x/width.
        assert_eq!(r.left, g.query.left);
        assert_eq!(r.width(), g.query.width());
        assert!(r.top > g.query.bottom);
    }

    #[test]
    fn bar_pins_to_the_right_and_clamps_narrow() {
        // Wide window: right-anchored with the max width.
        let g = compute(1600.0, false);
        assert!((g.panel.width() - FB_BAR_W_MAX).abs() < 0.01);
        assert!((g.panel.right - (1600.0 - FB_MARGIN)).abs() < 0.01);
        // Narrow window: never below the min width, never left of the margin.
        let g = compute(150.0, false);
        assert!((g.panel.width() - FB_BAR_W_MIN).abs() < 0.01);
        assert!(g.panel.left >= FB_MARGIN - 0.01);
    }

    #[test]
    fn hit_classifies_each_region() {
        let g = compute(1200.0, true);
        let mid = |r: Rect| ((r.left + r.right) / 2.0, (r.top + r.bottom) / 2.0);
        let (qx, qy) = mid(g.query);
        assert_eq!(g.hit(qx, qy), Hit::Query);
        let (rx, ry) = mid(g.replace.unwrap());
        assert_eq!(g.hit(rx, ry), Hit::Replace);
        let (ax, ay) = mid(g.aa);
        assert_eq!(g.hit(ax, ay), Hit::ToggleCase);
        let (wx, wy) = mid(g.word);
        assert_eq!(g.hit(wx, wy), Hit::ToggleWord);
        // Counter is dead space inside the panel → Panel (swallowed, not a control).
        let (cx, cy) = mid(g.counter);
        assert_eq!(g.hit(cx, cy), Hit::Panel);
        // Far outside → Outside (falls through to the document).
        assert_eq!(g.hit(5.0, 5.0), Hit::Outside);
    }

    #[test]
    fn single_row_has_no_replace_hit() {
        let g = compute(1200.0, false);
        // A click where the replace row *would* be lands outside the (shorter) panel.
        let below = g.query.bottom + FB_ROW_GAP + FB_FIELD_H / 2.0;
        assert_eq!(g.hit((g.query.left + g.query.right) / 2.0, below), Hit::Outside);
    }
}
