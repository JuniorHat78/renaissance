// parser.rs — a faithful UTF-16 port of scripts/ast/parse.js parseDocument.
//
// Everything indexes over &[u16] (UTF-16 code units) so offsets and string
// scanning match JS exactly (SCRIPTORIUM-RUST-PARSER.md §4.2/§5). Where parse.js
// has a latent imprecision (e.g. heading textOffset assumes one space after the
// marker; blockquote marker length counts only a literal space), this port
// reproduces it deliberately — byte-identity over local "correctness".

use crate::ast::*;

const MAX_INLINE_DEPTH: i32 = 12;

// --- character predicates (port the JS regex sets LITERALLY, §5.6) ----------

// JS /\s/ — do NOT use Rust's char::is_whitespace (differs on  / ﻿).
fn is_ws(u: u16) -> bool {
    matches!(u,
        0x0009 | 0x000A | 0x000B | 0x000C | 0x000D | 0x0020 | 0x00A0 | 0x1680
        | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

// /[\s([{"'<>:;,-]/
fn is_opening_boundary(u: u16) -> bool {
    is_ws(u)
        || matches!(u,
            0x0028 | 0x005B | 0x007B | 0x0022 | 0x0027 | 0x003C | 0x003E | 0x003A
            | 0x003B | 0x002C | 0x002D)
}

// /[\s)\]}.!?",'<>:;\-]/
fn is_closing_boundary(u: u16) -> bool {
    is_ws(u)
        || matches!(u,
            0x0029 | 0x005D | 0x007D | 0x002E | 0x0021 | 0x003F | 0x0022 | 0x002C
            | 0x0027 | 0x003C | 0x003E | 0x003A | 0x003B | 0x002D)
}

fn is_ascii_alpha(u: u16) -> bool {
    (0x41..=0x5A).contains(&u) || (0x61..=0x7A).contains(&u)
}

fn is_digit(u: u16) -> bool {
    (0x30..=0x39).contains(&u)
}

// --- small slice utilities --------------------------------------------------

fn index_of(units: &[u16], from: usize, target: u16) -> Option<usize> {
    let mut i = from;
    while i < units.len() {
        if units[i] == target {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn index_of_2(units: &[u16], from: usize, a: u16, b: u16) -> Option<usize> {
    if units.is_empty() {
        return None;
    }
    let mut i = from;
    while i + 1 < units.len() {
        if units[i] == a && units[i + 1] == b {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn count_leading_ws(units: &[u16]) -> usize {
    let mut i = 0;
    while i < units.len() && is_ws(units[i]) {
        i += 1;
    }
    i
}

// JS String.prototype.trim range (WhiteSpace+LineTerminator ≈ our \s set).
fn trim_range(units: &[u16]) -> (usize, usize) {
    let mut start = 0;
    let mut end = units.len();
    while start < end && is_ws(units[start]) {
        start += 1;
    }
    while end > start && is_ws(units[end - 1]) {
        end -= 1;
    }
    (start, end)
}

fn trim_to_vec(units: &[u16]) -> Vec<u16> {
    let (s, e) = trim_range(units);
    units[s..e].to_vec()
}

// --- diagnostics ------------------------------------------------------------

fn diag(
    code: &'static str,
    message: String,
    offset: usize,
    details: Vec<(&'static str, DetailValue)>,
) -> Diagnostic {
    Diagnostic { code, severity: "info", message, offset, details, line: 0, column: 0 }
}

fn position_at_offset(offset: usize, line_offsets: &[usize]) -> (u32, usize) {
    let safe = offset;
    let mut line_index = 0usize;
    for i in 0..line_offsets.len() {
        if line_offsets[i] > safe {
            break;
        }
        line_index = i;
    }
    ((line_index + 1) as u32, safe - line_offsets[line_index] + 1)
}

// --- inline node assembly (appendText / appendInlineNode) -------------------

fn append_text(nodes: &mut Vec<Inline>, units: &[u16]) {
    if units.is_empty() {
        return;
    }
    if let Some(Inline::Text(last)) = nodes.last_mut() {
        last.extend_from_slice(units);
        return;
    }
    nodes.push(Inline::Text(units.to_vec()));
}

fn push_node(nodes: &mut Vec<Inline>, node: Inline) {
    match node {
        Inline::Text(v) => append_text(nodes, &v),
        other => nodes.push(other),
    }
}

// --- paragraph-line model ---------------------------------------------------

struct ParagraphLine {
    text: Vec<u16>,
    line_number: u32,
    offset: usize,
    source_length: usize,
    hard_break_after: bool,
}

struct ListLine {
    ordered: bool,
    text: Vec<u16>,
    line_number: u32,
    offset: usize,
    source_offset: usize,
    source_length: usize,
}

// createParagraphLine
fn create_paragraph_line(line: &[u16], line_number: u32, offset: usize) -> ParagraphLine {
    // / {2,}$/ — two or more trailing literal SPACES (0x20).
    let mut trailing_spaces = 0usize;
    {
        let mut j = line.len();
        while j > 0 && line[j - 1] == 0x20 {
            j -= 1;
            trailing_spaces += 1;
        }
    }
    let hard_break_after = trailing_spaces >= 2;

    let text: Vec<u16>;
    if hard_break_after {
        // line.replace(/ {2,}$/, "") — strip the trailing run of spaces.
        text = line[..line.len() - trailing_spaces].to_vec();
    } else {
        let (s, e) = trim_range(line);
        text = line[s..e].to_vec();
    }
    // leadingWhitespace: countLeadingWhitespace (hardBreak) vs length-trimStart
    // (else) — identical over our \s set.
    let leading = count_leading_ws(line);

    ParagraphLine {
        text,
        line_number,
        offset: offset + leading,
        source_length: line.len(),
        hard_break_after,
    }
}

// --- normalize source (BOM + CRLF) ------------------------------------------

fn normalize_source(source: &[u16]) -> (Vec<u16>, Vec<Diagnostic>) {
    let mut value = source.to_vec();
    let mut diagnostics = Vec::new();

    if !value.is_empty() && value[0] == 0xFEFF {
        value.remove(0);
        diagnostics.push(diag("bom-removed", "Removed UTF-8 byte-order mark.".to_string(), 0, vec![]));
    }

    if value.iter().any(|&u| u == 0x0D) {
        let mut out = Vec::with_capacity(value.len());
        let mut i = 0;
        while i < value.len() {
            if value[i] == 0x0D {
                out.push(0x0A);
                if i + 1 < value.len() && value[i + 1] == 0x0A {
                    i += 2;
                } else {
                    i += 1;
                }
            } else {
                out.push(value[i]);
                i += 1;
            }
        }
        value = out;
        diagnostics.push(diag(
            "crlf-normalized",
            "Normalized carriage returns to line feeds.".to_string(),
            0,
            vec![],
        ));
    }

    (value, diagnostics)
}

fn compute_line_offsets(text: &[u16]) -> Vec<usize> {
    let mut offsets = vec![0usize];
    for i in 0..text.len() {
        if text[i] == 0x0A {
            offsets.push(i + 1);
        }
    }
    offsets
}

// --- the document parser ----------------------------------------------------

pub fn parse_document(source: &[u16]) -> Document {
    let (text, mut diagnostics) = normalize_source(source);
    let line_offsets = compute_line_offsets(&text);

    // lines: (offset, content-slice) — content excludes the trailing \n.
    let mut lines: Vec<(usize, &[u16])> = Vec::with_capacity(line_offsets.len());
    for i in 0..line_offsets.len() {
        let start = line_offsets[i];
        let end = if i + 1 < line_offsets.len() {
            line_offsets[i + 1] - 1
        } else {
            text.len()
        };
        lines.push((start, &text[start..end]));
    }

    let mut blocks: Vec<Block> = Vec::new();
    let mut pending: Vec<ParagraphLine> = Vec::new();

    let mut index = 0usize;
    while index < lines.len() {
        let (offset, line) = lines[index];
        let line_number = (index + 1) as u32;

        if is_blank(line) {
            flush_paragraph(&mut blocks, &mut pending, &mut diagnostics);
            index += 1;
            continue;
        }

        // heading — parse_heading_line pushes the clamp diagnostic BEFORE flush,
        // exactly as parse.js (order matters for diagnostic sequence).
        if let Some(heading) = parse_heading_line(line, line_number, offset, &mut diagnostics) {
            flush_paragraph(&mut blocks, &mut pending, &mut diagnostics);
            blocks.push(heading);
            index += 1;
            continue;
        }

        if is_divider_line(line) {
            flush_paragraph(&mut blocks, &mut pending, &mut diagnostics);
            blocks.push(Block::Divider {
                position: Position { line: line_number, start: offset, end: offset + line.len() },
            });
            index += 1;
            continue;
        }

        if parse_block_quote_line(line, line_number, offset).is_some() {
            flush_paragraph(&mut blocks, &mut pending, &mut diagnostics);
            let mut quote_lines: Vec<ParagraphLine> = Vec::new();
            while index < lines.len() {
                let (o, l) = lines[index];
                match parse_block_quote_line(l, (index + 1) as u32, o) {
                    Some(pl) => {
                        quote_lines.push(pl);
                        index += 1;
                    }
                    None => break,
                }
            }
            let bq = create_block_quote(quote_lines, &mut diagnostics);
            blocks.push(bq);
            continue;
        }

        if let Some(first_ll) = parse_list_line(line, line_number, offset) {
            flush_paragraph(&mut blocks, &mut pending, &mut diagnostics);
            let ordered = first_ll.ordered;
            let mut list_lines: Vec<ListLine> = Vec::new();
            while index < lines.len() {
                let (o, l) = lines[index];
                match parse_list_line(l, (index + 1) as u32, o) {
                    Some(ll) if ll.ordered == ordered => {
                        list_lines.push(ll);
                        index += 1;
                    }
                    _ => break,
                }
            }
            let list = create_list(list_lines, ordered, &mut diagnostics);
            blocks.push(list);
            continue;
        }

        pending.push(create_paragraph_line(line, line_number, offset));
        index += 1;
    }

    flush_paragraph(&mut blocks, &mut pending, &mut diagnostics);

    // attachDiagnosticPosition — derive {line, column} from each offset.
    for d in diagnostics.iter_mut() {
        let (l, c) = position_at_offset(d.offset, &line_offsets);
        d.line = l;
        d.column = c;
    }

    // stats — blocks.length and wordCount(toSearchableText(ast)) (core.js).
    let stats_blocks = blocks.len();
    let searchable = searchable_text(&blocks);
    let stats_words = word_count(&searchable);

    Document { children: blocks, diagnostics, stats_blocks, stats_words }
}

// --- stats: toSearchableText + wordCount (faithful port of core.js) ---------

fn join_with_space(parts: &[Vec<u16>]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.push(0x20);
        }
        out.extend_from_slice(p);
    }
    out
}

// normalizeWhitespace: replace /\s+/g with a single space, then trim.
fn normalize_whitespace(units: &[u16]) -> Vec<u16> {
    let mut collapsed = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        if is_ws(units[i]) {
            collapsed.push(0x20);
            while i < units.len() && is_ws(units[i]) {
                i += 1;
            }
        } else {
            collapsed.push(units[i]);
            i += 1;
        }
    }
    let (s, e) = trim_range(&collapsed);
    collapsed[s..e].to_vec()
}

// inlineToText(nodes, hardBreakValue).join(""), hardBreakValue is a single u16.
fn inline_to_text(nodes: &[Inline], hard_break: u16, out: &mut Vec<u16>) {
    for n in nodes {
        match n {
            Inline::Text(v) => out.extend_from_slice(v),
            Inline::Emphasis(ch) => inline_to_text(ch, hard_break, out),
            Inline::Strong(ch) => inline_to_text(ch, hard_break, out),
            Inline::Link { children, .. } => inline_to_text(children, hard_break, out),
            Inline::Code(v) => out.extend_from_slice(v),
            Inline::HardBreak => out.push(hard_break),
        }
    }
}

pub(crate) fn block_to_searchable_text(block: &Block) -> Vec<u16> {
    match block {
        Block::Divider { .. } => Vec::new(),
        Block::BlockQuote { children, .. } | Block::List { children, .. } => {
            let parts: Vec<Vec<u16>> = children
                .iter()
                .map(block_to_searchable_text)
                .filter(|p| !p.is_empty())
                .collect();
            normalize_whitespace(&join_with_space(&parts))
        }
        Block::Heading { children, .. }
        | Block::Paragraph { children, .. }
        | Block::PullQuote { children, .. }
        | Block::ListItem { children, .. } => {
            let mut t = Vec::new();
            inline_to_text(children, 0x20, &mut t); // hardBreakValue = " "
            normalize_whitespace(&t)
        }
    }
}

// toSearchableText over a block list (core.js): join non-empty searchable text
// with " ". pub(crate) so the content-ast compiler can compute a section's
// heading-stripped wordCount the same way the reader does.
pub(crate) fn searchable_text(blocks: &[Block]) -> Vec<u16> {
    let parts: Vec<Vec<u16>> = blocks
        .iter()
        .map(block_to_searchable_text)
        .filter(|p| !p.is_empty())
        .collect();
    join_with_space(&parts)
}

// wordCount: count of /\S+/ runs (normalize-invariant, so we count runs directly).
pub(crate) fn word_count(units: &[u16]) -> usize {
    let mut count = 0;
    let mut in_word = false;
    for &u in units {
        if is_ws(u) {
            in_word = false;
        } else if !in_word {
            count += 1;
            in_word = true;
        }
    }
    count
}

fn flush_paragraph(
    blocks: &mut Vec<Block>,
    pending: &mut Vec<ParagraphLine>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if pending.is_empty() {
        return;
    }
    let lines = std::mem::take(pending);
    blocks.push(create_paragraph(lines, diagnostics));
}

fn is_blank(line: &[u16]) -> bool {
    line.iter().all(|&u| is_ws(u))
}

fn is_divider_line(line: &[u16]) -> bool {
    let (s, e) = trim_range(line);
    let core = &line[s..e];
    core.len() == 3 && core.iter().all(|&u| u == 0x2D)
}

fn parse_heading_line(
    line: &[u16],
    line_number: u32,
    offset: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Block> {
    let len = line.len();
    let mut i = 0;
    while i < len && line[i] == 0x23 {
        i += 1;
    }
    let marker_len = i;
    if marker_len < 1 || marker_len > 6 {
        return None;
    }
    // /^(#{1,6})\s+(.+?)\s*$/ : the char after the marker must be whitespace
    // (\s+ ≥1) and the line must extend ≥2 past the marker (\s+ plus content ≥1).
    // (.+?) is lazy, so when the tail is ALL whitespace it collapses (via regex
    // backtracking) to the LAST whitespace char — not "no match".
    if marker_len >= len || !is_ws(line[marker_len]) || len - marker_len < 2 {
        return None;
    }
    let mut cstart = marker_len;
    while cstart < len && is_ws(line[cstart]) {
        cstart += 1;
    }
    let mut cend = len;
    while cend > marker_len && is_ws(line[cend - 1]) {
        cend -= 1;
    }
    let text: Vec<u16> = if cstart < cend {
        line[cstart..cend].to_vec()
    } else {
        vec![line[len - 1]]
    };
    let text = &text[..];

    let mut level = marker_len as i64;
    if level > 3 {
        diagnostics.push(diag(
            "heading-level-clamped",
            format!("Clamped heading level {} to level 3.", level),
            offset,
            vec![
                ("line", DetailValue::Num(line_number as i64)),
                ("level", DetailValue::Num(level)),
            ],
        ));
        level = 3;
    }

    // parse.js: textOffset = offset + marker.length + 1 (assumes ONE space).
    let text_offset = offset + marker_len + 1;
    let children = parse_inline(text, text_offset, diagnostics, 0, false);

    Some(Block::Heading {
        level: level as u8,
        children,
        position: Position { line: line_number, start: offset, end: offset + len },
    })
}

fn parse_block_quote_line(line: &[u16], line_number: u32, offset: usize) -> Option<ParagraphLine> {
    let len = line.len();
    let g1 = count_leading_ws(line);
    if g1 >= len || line[g1] != 0x3E {
        return None;
    }
    let after = g1 + 1;
    // \s? : optional single whitespace after '>'.
    let g2_start = if after < len && is_ws(line[after]) { after + 1 } else { after };
    let group2 = &line[g2_start..];
    // parse.js counts the marker's optional ws ONLY when it is a literal space.
    let marker_length = g1 + 1 + if after < len && line[after] == 0x20 { 1 } else { 0 };
    Some(create_paragraph_line(group2, line_number, offset + marker_length))
}

fn parse_list_line(line: &[u16], line_number: u32, offset: usize) -> Option<ListLine> {
    let len = line.len();
    let mut i = count_leading_ws(line);
    let marker_start = i;

    let ordered;
    if i < len && (line[i] == 0x2D || line[i] == 0x2B) {
        ordered = false;
        i += 1;
    } else if i < len && is_digit(line[i]) {
        ordered = true;
        while i < len && is_digit(line[i]) {
            i += 1;
        }
        if i >= len || !(line[i] == 0x2E || line[i] == 0x29) {
            return None;
        }
        i += 1;
    } else {
        return None;
    }

    // \s+(.+?)\s*$ : the char after the glyph must be whitespace and the line
    // must extend ≥2 past it. As with headings, an all-whitespace tail collapses
    // (regex backtracking) to the LAST whitespace char rather than failing.
    let gstart = i;
    if gstart >= len || !is_ws(line[gstart]) || len - gstart < 2 {
        return None;
    }
    let mut cstart = gstart;
    while cstart < len && is_ws(line[cstart]) {
        cstart += 1;
    }
    let mut cend = len;
    while cend > gstart && is_ws(line[cend - 1]) {
        cend -= 1;
    }
    let (text, text_offset) = if cstart < cend {
        (line[cstart..cend].to_vec(), offset + cstart) // = offset + markerStart + marker.length
    } else {
        (vec![line[len - 1]], offset + (len - 1))
    };

    let _ = marker_start;
    Some(ListLine {
        ordered,
        text,
        line_number,
        offset: text_offset,
        source_offset: offset,
        source_length: len,
    })
}

fn create_paragraph(lines: Vec<ParagraphLine>, diagnostics: &mut Vec<Diagnostic>) -> Block {
    let first_line = lines[0].line_number;
    let first_offset = lines[0].offset;
    let last = &lines[lines.len() - 1];
    let position = Position {
        line: first_line,
        start: first_offset,
        end: last.offset + last.source_length,
    };
    let pull = lines.len() == 1 && is_pull_quote_text(&lines[0].text);
    let children = parse_inline_lines(&lines, diagnostics);
    if pull {
        Block::PullQuote { children, position }
    } else {
        Block::Paragraph { children, position }
    }
}

fn create_block_quote(lines: Vec<ParagraphLine>, diagnostics: &mut Vec<Diagnostic>) -> Block {
    let first_line = lines[0].line_number;
    let first_offset = lines[0].offset;
    let last = &lines[lines.len() - 1];
    let position = Position {
        line: first_line,
        start: first_offset,
        end: last.offset + last.source_length,
    };
    let para = create_paragraph(lines, diagnostics);
    Block::BlockQuote { children: vec![para], position }
}

fn create_list(lines: Vec<ListLine>, ordered: bool, diagnostics: &mut Vec<Diagnostic>) -> Block {
    let first_line = lines[0].line_number;
    let first_source_offset = lines[0].source_offset;
    let last = &lines[lines.len() - 1];
    let position = Position {
        line: first_line,
        start: first_source_offset,
        end: last.source_offset + last.source_length,
    };
    let mut children: Vec<Block> = Vec::with_capacity(lines.len());
    for l in &lines {
        let item_children = parse_inline(&l.text, l.offset, diagnostics, 0, false);
        children.push(Block::ListItem {
            children: item_children,
            position: Position {
                line: l.line_number,
                start: l.offset,
                end: l.source_offset + l.source_length,
            },
        });
    }
    Block::List { ordered, children, position }
}

fn is_pull_quote_text(text: &[u16]) -> bool {
    let (s, e) = trim_range(text);
    let t = &text[s..e];
    if t.len() < 2 {
        return false;
    }
    let pairs: [(u16, u16); 4] = [
        (0x22, 0x22),
        (0x27, 0x27),
        (0x201C, 0x201D),
        (0x2018, 0x2019),
    ];
    for (open, close) in pairs {
        if t[0] == open && t[t.len() - 1] == close {
            return true;
        }
    }
    false
}

// --- inline-line joining + separator normalization --------------------------

fn parse_inline_lines(lines: &[ParagraphLine], diagnostics: &mut Vec<Diagnostic>) -> Vec<Inline> {
    let (joined, offset) = join_inline_lines(lines);
    let nodes = parse_inline(&joined, offset, diagnostics, 0, false);
    normalize_inline_separators(nodes)
}

fn join_inline_lines(lines: &[ParagraphLine]) -> (Vec<u16>, usize) {
    if lines.is_empty() {
        return (Vec::new(), 0);
    }
    let mut text = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        text.extend_from_slice(&line.text);
        if i < lines.len() - 1 {
            if line.hard_break_after {
                text.push(0x01); // HARD_BREAK_SENTINEL
                text.push(0x0A);
            } else {
                text.push(0x0A);
            }
        }
    }
    (text, lines[0].offset)
}

fn normalize_inline_separators(nodes: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    for node in nodes {
        match node {
            Inline::Text(v) => append_separator_text(&mut out, &v),
            Inline::Emphasis(ch) => push_node(&mut out, Inline::Emphasis(normalize_inline_separators(ch))),
            Inline::Strong(ch) => push_node(&mut out, Inline::Strong(normalize_inline_separators(ch))),
            Inline::Link { href, children } => {
                push_node(&mut out, Inline::Link { href, children: normalize_inline_separators(children) })
            }
            Inline::Code(v) => push_node(&mut out, Inline::Code(normalize_inline_code_text(&v))),
            other => push_node(&mut out, other),
        }
    }
    out
}

fn append_separator_text(target: &mut Vec<Inline>, value: &[u16]) {
    let mut cursor = 0;
    while cursor < value.len() {
        let hb = index_of_2(value, cursor, 0x01, 0x0A);
        let nl = index_of(value, cursor, 0x0A);
        let next = first_non_negative(hb, nl);
        match next {
            None => {
                append_text(target, &value[cursor..]);
                return;
            }
            Some(ni) => {
                append_text(target, &value[cursor..ni]);
                if hb == Some(ni) {
                    push_node(target, Inline::HardBreak);
                    cursor = ni + 2;
                } else {
                    append_text(target, &[0x20]);
                    cursor = ni + 1;
                }
            }
        }
    }
}

fn first_non_negative(left: Option<usize>, right: Option<usize>) -> Option<usize> {
    match (left, right) {
        (None, r) => r,
        (l, None) => l,
        (Some(a), Some(b)) => Some(a.min(b)),
    }
}

fn normalize_inline_code_text(value: &[u16]) -> Vec<u16> {
    // replace HARD_BREAK_SENTINEL+"\n" with "\n"
    let mut tmp = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        if value[i] == 0x01 && i + 1 < value.len() && value[i + 1] == 0x0A {
            tmp.push(0x0A);
            i += 2;
        } else {
            tmp.push(value[i]);
            i += 1;
        }
    }
    // replace /\s+/g with a single space
    let mut out = Vec::with_capacity(tmp.len());
    let mut j = 0;
    while j < tmp.len() {
        if is_ws(tmp[j]) {
            out.push(0x20);
            while j < tmp.len() && is_ws(tmp[j]) {
                j += 1;
            }
        } else {
            out.push(tmp[j]);
            j += 1;
        }
    }
    out
}

// --- the inline tokenizer ---------------------------------------------------

fn parse_inline(
    units: &[u16],
    base: usize,
    diagnostics: &mut Vec<Diagnostic>,
    depth: i32,
    suppress: bool,
) -> Vec<Inline> {
    let mut nodes: Vec<Inline> = Vec::new();
    let len = units.len();
    let mut cursor = 0;

    while cursor < len {
        let ch = units[cursor];

        // `code`
        if ch == 0x60 {
            match index_of(units, cursor + 1, 0x60) {
                None => {
                    append_text(&mut nodes, &[ch]);
                    if !suppress {
                        diagnostics.push(diag(
                            "unmatched-code-marker",
                            "Treating unmatched code marker as literal text.".to_string(),
                            base + cursor,
                            vec![],
                        ));
                    }
                    cursor += 1;
                }
                Some(close) => {
                    push_node(&mut nodes, Inline::Code(units[cursor + 1..close].to_vec()));
                    cursor = close + 1;
                }
            }
            continue;
        }

        // [link](href)
        if ch == 0x5B {
            if let Some(link) = parse_link_token(units, cursor) {
                if !is_safe_link_url(&link.href) {
                    append_text(&mut nodes, &units[cursor..link.end_index]);
                    diagnostics.push(diag(
                        "unsafe-link-url",
                        "Treating unsafe link URL as literal text.".to_string(),
                        base + link.href_offset,
                        vec![("href", DetailValue::Str(link.href.clone()))],
                    ));
                    cursor = link.end_index;
                } else {
                    let children = parse_inline_children(&link.label, base + cursor + 1, diagnostics, depth);
                    nodes.push(Inline::Link { href: link.href, children });
                    cursor = link.end_index;
                }
            } else {
                append_text(&mut nodes, &[ch]);
                cursor += 1;
            }
            continue;
        }

        // **strong**
        if ch == 0x2A && cursor + 1 < len && units[cursor + 1] == 0x2A {
            if !can_open_strong(units, cursor) {
                append_text(&mut nodes, &[0x2A]);
                cursor += 1;
                continue;
            }
            match find_closing_strong(units, cursor + 2) {
                None => {
                    append_text(&mut nodes, &[0x2A, 0x2A]);
                    if !suppress {
                        diagnostics.push(diag(
                            "unmatched-strong-marker",
                            "Treating unmatched strong marker as literal text.".to_string(),
                            base + cursor,
                            vec![],
                        ));
                    }
                    cursor += 2;
                }
                Some(close) => {
                    let children =
                        parse_inline_children(&units[cursor + 2..close], base + cursor + 2, diagnostics, depth);
                    nodes.push(Inline::Strong(children));
                    cursor = close + 2;
                }
            }
            continue;
        }

        // *emphasis*
        if ch == 0x2A {
            if !can_open_emphasis(units, cursor) {
                append_text(&mut nodes, &[0x2A]);
                cursor += 1;
                continue;
            }
            match find_closing_emphasis(units, cursor + 1) {
                None => {
                    append_text(&mut nodes, &[0x2A]);
                    if !suppress {
                        diagnostics.push(diag(
                            "unmatched-emphasis-marker",
                            "Treating unmatched emphasis marker as literal text.".to_string(),
                            base + cursor,
                            vec![],
                        ));
                    }
                    cursor += 1;
                }
                Some(close) => {
                    let children =
                        parse_inline_children(&units[cursor + 1..close], base + cursor + 1, diagnostics, depth);
                    nodes.push(Inline::Emphasis(children));
                    cursor = close + 1;
                }
            }
            continue;
        }

        append_text(&mut nodes, &[ch]);
        cursor += 1;
    }

    nodes
}

fn parse_inline_children(
    units: &[u16],
    base: usize,
    diagnostics: &mut Vec<Diagnostic>,
    depth: i32,
) -> Vec<Inline> {
    if depth >= MAX_INLINE_DEPTH {
        return if units.is_empty() {
            Vec::new()
        } else {
            vec![Inline::Text(units.to_vec())]
        };
    }
    parse_inline(units, base, diagnostics, depth + 1, true)
}

struct LinkToken {
    label: Vec<u16>,
    href: Vec<u16>,
    href_offset: usize,
    end_index: usize,
}

fn parse_link_token(units: &[u16], open: usize) -> Option<LinkToken> {
    let label_end = index_of_2(units, open + 1, 0x5D, 0x28)?; // "]("
    if label_end == open + 1 {
        return None;
    }
    let href_start = label_end + 2;
    let href_end = index_of(units, href_start, 0x29)?; // ")"
    if href_end == href_start {
        return None;
    }
    Some(LinkToken {
        label: units[open + 1..label_end].to_vec(),
        href: trim_to_vec(&units[href_start..href_end]),
        href_offset: href_start,
        end_index: href_end + 1,
    })
}

fn is_safe_link_url(href: &[u16]) -> bool {
    let t = trim_to_vec(href);
    if t.is_empty() {
        return false;
    }
    for &u in &t {
        if u <= 0x1F || u == 0x3C || u == 0x3E {
            return false;
        }
    }
    // scheme: /^([a-z][a-z0-9+.-]*):/i
    if !is_ascii_alpha(t[0]) {
        return true; // schemeless → safe
    }
    let mut i = 1;
    while i < t.len() {
        let c = t[i];
        if is_ascii_alpha(c) || is_digit(c) || c == 0x2B || c == 0x2E || c == 0x2D {
            i += 1;
        } else {
            break;
        }
    }
    if i < t.len() && t[i] == 0x3A {
        let scheme = lower_ascii(&t[0..i]);
        return scheme == "http" || scheme == "https" || scheme == "mailto" || scheme == "tel";
    }
    true // leading letter but no terminating colon → no scheme → safe
}

fn lower_ascii(units: &[u16]) -> String {
    let mut s = String::with_capacity(units.len());
    for &u in units {
        let c = if (0x41..=0x5A).contains(&u) { u + 0x20 } else { u };
        if let Some(ch) = char::from_u32(c as u32) {
            s.push(ch);
        }
    }
    s
}

fn find_closing_strong(units: &[u16], start: usize) -> Option<usize> {
    let len = units.len();
    let mut index = start;
    while index + 1 < len {
        if units[index] == 0x2A && units[index + 1] == 0x2A && can_close_strong(units, index) {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn find_closing_emphasis(units: &[u16], start: usize) -> Option<usize> {
    let len = units.len();
    let mut index = start;
    while index < len {
        if units[index] == 0x2A && can_close_emphasis(units, index) {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn prev_unit(units: &[u16], index: usize) -> Option<u16> {
    if index > 0 {
        Some(units[index - 1])
    } else {
        None
    }
}

fn can_open_strong(units: &[u16], index: usize) -> bool {
    let prev = prev_unit(units, index);
    let next = if index + 2 < units.len() { Some(units[index + 2]) } else { None };
    let next_bad = match next {
        None => true,
        Some(n) => is_ws(n) || n == 0x2A,
    };
    if next_bad {
        return false;
    }
    match prev {
        None => true,
        Some(p) => is_ws(p) || is_opening_boundary(p),
    }
}

fn can_close_strong(units: &[u16], index: usize) -> bool {
    let prev = prev_unit(units, index);
    let next = if index + 2 < units.len() { Some(units[index + 2]) } else { None };
    let prev_bad = match prev {
        None => true,
        Some(p) => is_ws(p) || p == 0x2A,
    };
    if prev_bad {
        return false;
    }
    match next {
        None => true,
        Some(n) => is_ws(n) || is_closing_boundary(n),
    }
}

fn can_open_emphasis(units: &[u16], index: usize) -> bool {
    let prev = prev_unit(units, index);
    let next = if index + 1 < units.len() { Some(units[index + 1]) } else { None };
    let next_bad = match next {
        None => true,
        Some(n) => is_ws(n) || n == 0x2A,
    };
    if next_bad {
        return false;
    }
    match prev {
        None => true,
        Some(p) => is_ws(p) || is_opening_boundary(p),
    }
}

fn can_close_emphasis(units: &[u16], index: usize) -> bool {
    let prev = prev_unit(units, index);
    let next = if index + 1 < units.len() { Some(units[index + 1]) } else { None };
    let prev_bad = match prev {
        None => true,
        Some(p) => is_ws(p) || p == 0x2A,
    };
    if prev_bad {
        return false;
    }
    match next {
        None => true,
        Some(n) => is_ws(n) || is_closing_boundary(n),
    }
}
