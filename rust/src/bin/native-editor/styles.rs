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

/// The block style kind for the paragraph occupying source range `[lo, hi)` (`hi` = the next
/// paragraph's start, or `usize::MAX` for the last), from the sorted, non-overlapping `spans`. A span
/// belongs to the paragraph when its **start falls within** the paragraph — NOT "starts at or before
/// the paragraph start": a blockquote's AST span begins after its `> ` marker (the child paragraph's
/// offset) while the paragraph itself begins at the marker, so an at-or-before test silently misses
/// it. Intersection by start is exact here because top-level blocks partition the source one-per-
/// paragraph, so at most one span starts inside any paragraph.
pub fn kind_for_paragraph(spans: &[StyleSpan], lo: usize, hi: usize) -> Option<StyleKind> {
    let idx = spans.partition_point(|s| s.start < lo);
    match spans.get(idx) {
        Some(s) if s.start < hi => Some(s.kind),
        _ => None,
    }
}

/// A **provisional** block style for a single paragraph line, derived lexically from its own leading
/// markers — no parser, no document context (SCRIPTORIUM-NATIVE-STYLING.md §4). The renderer uses it
/// for the paragraph being edited while the authoritative async parse is in flight, so the style
/// tracks the keystroke immediately instead of popping in a frame later. It covers only the kinds a
/// line's own prefix fully determines in this dialect (which has no fenced code blocks, so a `#` line
/// is unambiguously a heading): ATX **headings** (`#{1,6}` + whitespace + ≥1 char, level clamped to 3
/// to match `parser.rs`) and **blockquotes** (optional leading whitespace, then `>`). Everything else
/// — including pull quotes and lists, whose styling the renderer keeps from the last-good AST — is
/// `None` here. Kept byte-rule-faithful to the parser by `provisional_agrees_with_the_parser`.
pub fn provisional_style_from_line(line: &[u16]) -> Option<StyleKind> {
    scan_block_marker(line).map(|(kind, _)| kind)
}

/// The source length of the leading block marker on `line` — the units the parser treats as marker,
/// not content (heading `#`s + one whitespace, or a blockquote `>` + an optional single whitespace),
/// or 0 if the line has no owned marker. The renderer dims `[0, marker_len)` so the markdown markers
/// recede while the content pops (STYLING §5A.2). Shares `scan_block_marker` with the style guess, so
/// the dimmed range and the detected kind are always consistent (dim exactly what made it that kind).
pub fn marker_len_of_line(line: &[u16]) -> usize {
    scan_block_marker(line).map_or(0, |(_, len)| len)
}

/// The single lexical scan behind both `provisional_style_from_line` and `marker_len_of_line`: the
/// block `StyleKind` a line's own leading markers determine, plus that marker's **source length**.
/// Marker lengths mirror the parser's content offset: a heading skips `#`-run + one ws
/// (`parse_heading_line`'s `text_offset = offset + marker_len + 1`); a blockquote skips optional
/// leading ws + `>` + an optional single space (`parse_block_quote_line`'s `marker_length`).
fn scan_block_marker(line: &[u16]) -> Option<(StyleKind, usize)> {
    // Heading: 1..=6 '#' at column 0, then whitespace, then >=1 more unit.
    let mut h = 0;
    while h < line.len() && line[h] == 0x23 {
        h += 1;
    }
    if (1..=6).contains(&h) && h < line.len() && is_ws(line[h]) && line.len() - h >= 2 {
        // The style level clamps to 3, but the dimmed marker covers ALL of the actual '#' run + the
        // one ws — so `###### x` dims 7 units even though its kind is Heading(3).
        return Some((StyleKind::Heading(h.min(3) as u8), h + 1));
    }
    // Blockquote: optional leading whitespace, then '>', then an optional single literal space.
    let mut g = 0;
    while g < line.len() && is_ws(line[g]) {
        g += 1;
    }
    if g < line.len() && line[g] == 0x3E {
        let sp = usize::from(g + 1 < line.len() && line[g + 1] == 0x20);
        return Some((StyleKind::BlockQuote, g + 1 + sp));
    }
    None
}

/// Space or tab — the whitespace the marker rules test for (a superset isn't needed: a heading with
/// exotic whitespace after its `#` does not occur in practice, and the AST corrects it on settle).
fn is_ws(u: u16) -> bool {
    u == 0x20 || u == 0x09
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
    fn kind_for_paragraph_matches_a_span_starting_inside_the_paragraph() {
        // Two paragraphs: a blockquote `> q` (offsets 0..3) then a heading `# H` (offsets 4..7),
        // with the paragraph boundary at offset 4 (the '\n' is at 3). The blockquote's span begins
        // AFTER its marker (offset 2), past the paragraph's own start (0) — the regression this fixes.
        let spans = [
            StyleSpan { start: 2, end: 3, kind: StyleKind::BlockQuote },
            StyleSpan { start: 4, end: 7, kind: StyleKind::Heading(1) },
        ];
        // Paragraph 0 = [0, 4): picks the blockquote even though its span starts at 2, not 0.
        assert_eq!(kind_for_paragraph(&spans, 0, 4), Some(StyleKind::BlockQuote));
        // Paragraph 1 = [4, MAX): the heading.
        assert_eq!(kind_for_paragraph(&spans, 4, usize::MAX), Some(StyleKind::Heading(1)));
        // A paragraph range with no span starting inside it is the default format.
        assert_eq!(kind_for_paragraph(&spans, 8, 12), None);
        assert_eq!(kind_for_paragraph(&[], 0, usize::MAX), None);
    }

    #[test]
    fn provisional_reads_the_leading_markers() {
        let lex = |s: &str| provisional_style_from_line(&s.encode_utf16().collect::<Vec<u16>>());
        assert_eq!(lex("# Heading"), Some(StyleKind::Heading(1)));
        assert_eq!(lex("## Two"), Some(StyleKind::Heading(2)));
        assert_eq!(lex("### Three"), Some(StyleKind::Heading(3)));
        assert_eq!(lex("###### Six"), Some(StyleKind::Heading(3)), "level clamps to 3 like the dialect");
        assert_eq!(lex("#no-space"), None, "a heading needs whitespace after the marker");
        assert_eq!(lex("#"), None, "just a marker, no content");
        assert_eq!(lex("# "), None, "marker + space but no content (< 2 past the marker)");
        assert_eq!(lex("> quote"), Some(StyleKind::BlockQuote));
        assert_eq!(lex("   > indented quote"), Some(StyleKind::BlockQuote), "leading ws before '>' is allowed");
        assert_eq!(lex("plain prose"), None);
        assert_eq!(lex(""), None);
    }

    #[test]
    fn marker_len_covers_the_leading_marker() {
        let m = |s: &str| marker_len_of_line(&s.encode_utf16().collect::<Vec<u16>>());
        assert_eq!(m("# Heading"), 2, "# + space");
        assert_eq!(m("### Three"), 4, "### + space");
        assert_eq!(m("###### Six"), 7, "all six # + space, even though the level clamps to 3");
        assert_eq!(m("> quote"), 2, "> + space");
        assert_eq!(m(">quote"), 1, "> with no space");
        assert_eq!(m("   > indented"), 5, "3 leading spaces + > + space");
        assert_eq!(m("plain prose"), 0);
        assert_eq!(m("#nospace"), 0, "not a heading → no marker");
        assert_eq!(m(""), 0);
    }

    #[test]
    fn provisional_agrees_with_the_parser() {
        // The immediacy guess must match what the authoritative AST settles to, or typing a marker
        // would visibly resize twice (provisional, then a different AST result). For each single-line
        // document, the lexical guess equals the parser's block kind at offset 0 on the kinds it owns.
        for src in [
            "# One",
            "## Two",
            "### Three",
            "###### clamped",
            "> a quote",
            "  > indented quote",
            "ordinary prose",
            "#not-a-heading",
        ] {
            let units: Vec<u16> = src.encode_utf16().collect();
            // A single-line document has at most one styled block; its kind is the settled truth the
            // provisional guess must match. (Resolved by paragraph range, mirroring the renderer —
            // `> quote`'s span starts after the marker, so an offset-0 lookup would miss it.)
            let ast = kind_for_paragraph(&styles_of(&parse_document(&units)), 0, usize::MAX);
            let lex = provisional_style_from_line(&units);
            // The provisional owns Heading + BlockQuote; where it yields one, the parser must agree.
            // Where it yields None on an owned-kind line, the parser must also not produce one.
            match lex {
                Some(k) => assert_eq!(ast, Some(k), "provisional vs parser disagree on {src:?}"),
                None => assert!(
                    !matches!(ast, Some(StyleKind::Heading(_)) | Some(StyleKind::BlockQuote)),
                    "provisional said plain but the parser found an owned kind on {src:?}: {ast:?}"
                ),
            }
        }
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
