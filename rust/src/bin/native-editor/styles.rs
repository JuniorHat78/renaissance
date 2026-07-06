//! AST → style-span derivation (SCRIPTORIUM-NATIVE-STYLING.md §3). Platform-free: a pure walk over a
//! parsed `Document`'s block tree into a flat, sorted list of **style spans** (a block's UTF-16 offset
//! range + its kind), so the renderer can source-highlight without ever holding the AST. Runs on the
//! parse worker (the compact span list, not the `Document`, crosses the thread boundary) and is
//! oracled on every CI platform — the parser lib is not windows-gated, so this exercises the real
//! `parse_document` → spans end to end.

use scriptorium_parser::{Block, Document};

/// The block kind a source paragraph is styled as. `Paragraph` is the default (no span emitted).
/// `Heading` carries its level (1–6). Offsets/attributes are the renderer's; this is the *what*.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StyleKind {
    Heading(u8),
    BlockQuote,
    PullQuote,
    ListItem,
    Divider,
}

/// A styled range of the source: `[start, end)` UTF-16 offsets carrying a `StyleKind`. The renderer
/// maps each source paragraph to the span whose range contains its start offset.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct StyleSpan {
    pub start: usize,
    pub end: usize,
    pub kind: StyleKind,
}

/// Derive the block-level style spans from a parsed document — **sorted by start, non-overlapping**
/// (top-level blocks partition the source; a container block pushes its kind onto the child blocks it
/// holds rather than emitting its own span, so ranges never nest). A bare top-level `Paragraph` and a
/// `Divider`'s surrounding blank lines yield no span (the default format).
pub fn styles_of(doc: &Document) -> Vec<StyleSpan> {
    let mut out = Vec::new();
    walk(&doc.children, &mut out, None);
    out.sort_by_key(|s| s.start);
    out
}

/// Walk a block list, emitting a span per styled leaf. `container` is the kind inherited from an
/// enclosing block (a blockquote tags its child paragraphs `BlockQuote`); it only overrides the
/// otherwise-default `Paragraph`.
fn walk(blocks: &[Block], out: &mut Vec<StyleSpan>, container: Option<StyleKind>) {
    for b in blocks {
        match b {
            Block::Heading { level, position, .. } => {
                out.push(StyleSpan { start: position.start, end: position.end, kind: StyleKind::Heading(*level) });
            }
            Block::Paragraph { position, .. } => {
                if let Some(kind) = container {
                    out.push(StyleSpan { start: position.start, end: position.end, kind });
                }
            }
            Block::PullQuote { position, .. } => {
                out.push(StyleSpan { start: position.start, end: position.end, kind: StyleKind::PullQuote });
            }
            Block::BlockQuote { children, .. } => walk(children, out, Some(StyleKind::BlockQuote)),
            Block::List { children, .. } => walk(children, out, Some(StyleKind::ListItem)),
            Block::ListItem { position, .. } => {
                out.push(StyleSpan { start: position.start, end: position.end, kind: StyleKind::ListItem });
            }
            Block::Divider { position } => {
                out.push(StyleSpan { start: position.start, end: position.end, kind: StyleKind::Divider });
            }
        }
    }
}

// --- style-derivation oracle (SCRIPTORIUM-NATIVE-STYLING.md §9) ---------------
// End-to-end over the real parser (platform-free — the parser lib isn't windows-gated): a document of
// every block kind derives the right kinds at the right spans, sorted + non-overlapping, and plain
// paragraphs produce nothing.
#[cfg(test)]
mod tests {
    use super::*;
    use scriptorium_parser::parse_document;

    fn styles(src: &str) -> Vec<StyleSpan> {
        let units: Vec<u16> = src.encode_utf16().collect();
        styles_of(&parse_document(&units))
    }

    /// The kind at the source offset `at` (the span whose range contains it), or None for default.
    fn kind_at(spans: &[StyleSpan], at: usize) -> Option<StyleKind> {
        spans.iter().find(|s| s.start <= at && at < s.end).map(|s| s.kind)
    }

    #[test]
    fn headings_carry_their_level_at_their_span() {
        // The dialect clamps heading levels to 3 (parser.rs `parse_heading_line`), so `######` is a
        // level-3 heading — the style table's Heading(_) arm handles 4..=6 defensively but they never
        // occur in practice.
        let src = "# One\n\n## Two\n\n###### Six\n";
        let spans = styles(src);
        assert_eq!(kind_at(&spans, 0), Some(StyleKind::Heading(1)));
        assert_eq!(kind_at(&spans, src.find("## Two").unwrap()), Some(StyleKind::Heading(2)));
        assert_eq!(kind_at(&spans, src.find("###### Six").unwrap()), Some(StyleKind::Heading(3)));
    }

    #[test]
    fn plain_paragraphs_produce_no_span() {
        let spans = styles("Just some ordinary prose.\n\nA second paragraph.\n");
        assert!(spans.is_empty(), "a bare paragraph is the default format: {spans:?}");
    }

    #[test]
    fn spans_are_sorted_and_non_overlapping() {
        let src = "# Title\n\nProse here.\n\n## Section\n\nMore prose.\n";
        let spans = styles(src);
        for w in spans.windows(2) {
            assert!(w[0].start <= w[1].start, "sorted by start");
            assert!(w[0].end <= w[1].start, "non-overlapping: {:?} vs {:?}", w[0], w[1]);
        }
        // Two headings, no paragraph spans.
        assert_eq!(spans.len(), 2);
        assert!(spans.iter().all(|s| matches!(s.kind, StyleKind::Heading(_))));
    }

    #[test]
    fn a_divider_is_tagged() {
        // A thematic break on its own line, between paragraphs.
        let src = "before\n\n---\n\nafter\n";
        let spans = styles(src);
        assert!(
            spans.iter().any(|s| s.kind == StyleKind::Divider),
            "the divider block should yield a Divider span: {spans:?}"
        );
    }
}
