// render.rs — AST → HTML, a faithful UTF-16 port of render.js serializeBlocks.
//
// Consume-only: turns the parsed AST into the exact HTML string render.js emits
// (the shipped/preview markup), held byte-identical by the equivalence oracle.
// Builds Vec<u16> (not String) so lone surrogates in text round-trip exactly,
// matching JS string semantics; the oracle compares as UTF-16.
//
// Replicates core.js exactly: escapeHtml (& < > " '), escapeAttribute (=escapeHtml),
// formatDisplayText (\s*—\s* → thin-space em-dash thin-space), clampHeadingLevel.

use crate::ast::*;

const THIN: u16 = 0x2009;
const EMDASH: u16 = 0x2014;

pub fn to_html_units(doc: &Document) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for b in &doc.children {
        serialize_block(&mut out, b);
    }
    out
}

fn push_ascii(out: &mut Vec<u16>, s: &str) {
    for b in s.bytes() {
        out.push(b as u16);
    }
}

fn open_tag(out: &mut Vec<u16>, tag: &str) {
    push_ascii(out, "<");
    push_ascii(out, tag);
    push_ascii(out, ">");
}
fn close_tag(out: &mut Vec<u16>, tag: &str) {
    push_ascii(out, "</");
    push_ascii(out, tag);
    push_ascii(out, ">");
}

fn serialize_block(out: &mut Vec<u16>, block: &Block) {
    match block {
        Block::Heading { level, children, .. } => {
            let lvl = (*level).max(1).min(3);
            let tag = match lvl { 1 => "h1", 2 => "h2", _ => "h3" };
            open_tag(out, tag);
            serialize_inline(out, children);
            close_tag(out, tag);
        }
        Block::PullQuote { children, .. } => {
            push_ascii(out, "<p class=\"pull-quote\">");
            serialize_inline(out, children);
            push_ascii(out, "</p>");
        }
        Block::Paragraph { children, .. } => {
            open_tag(out, "p");
            serialize_inline(out, children);
            close_tag(out, "p");
        }
        Block::BlockQuote { children, .. } => {
            open_tag(out, "blockquote");
            for c in children {
                serialize_block(out, c);
            }
            close_tag(out, "blockquote");
        }
        Block::List { ordered, children, .. } => {
            let tag = if *ordered { "ol" } else { "ul" };
            open_tag(out, tag);
            for c in children {
                serialize_block(out, c);
            }
            close_tag(out, tag);
        }
        Block::ListItem { children, .. } => {
            open_tag(out, "li");
            serialize_inline(out, children);
            close_tag(out, "li");
        }
        Block::Divider { .. } => {
            push_ascii(out, "<hr>");
        }
    }
}

fn serialize_inline(out: &mut Vec<u16>, nodes: &[Inline]) {
    for node in nodes {
        match node {
            Inline::Text(v) => {
                let formatted = format_display_text(v);
                escape_html_into(out, &formatted);
            }
            Inline::Emphasis(ch) => {
                open_tag(out, "em");
                serialize_inline(out, ch);
                close_tag(out, "em");
            }
            Inline::Strong(ch) => {
                open_tag(out, "strong");
                serialize_inline(out, ch);
                close_tag(out, "strong");
            }
            Inline::Code(v) => {
                open_tag(out, "code");
                escape_html_into(out, v);
                close_tag(out, "code");
            }
            Inline::Link { href, children } => {
                push_ascii(out, "<a href=\"");
                escape_html_into(out, href);
                push_ascii(out, "\">");
                serialize_inline(out, children);
                push_ascii(out, "</a>");
            }
            Inline::HardBreak => {
                push_ascii(out, "<br>");
            }
        }
    }
}

// escapeHtml: & < > " ' — single pass (& already mapped, so no double-escape).
fn escape_html_into(out: &mut Vec<u16>, units: &[u16]) {
    for &u in units {
        match u {
            0x26 => push_ascii(out, "&amp;"),
            0x3C => push_ascii(out, "&lt;"),
            0x3E => push_ascii(out, "&gt;"),
            0x22 => push_ascii(out, "&quot;"),
            0x27 => push_ascii(out, "&#39;"),
            _ => out.push(u),
        }
    }
}

// formatDisplayText: /\s*—\s*/g →  — . Simulated as a global
// non-overlapping regex replace (leftmost match wins; advance past each match).
fn format_display_text(units: &[u16]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let len = units.len();
    let mut i = 0;
    while i < len {
        // Try to match \s*—\s* starting at i.
        let mut j = i;
        while j < len && is_ws(units[j]) {
            j += 1;
        }
        if j < len && units[j] == EMDASH {
            // matched: leading ws units[i..j], emdash at j, trailing ws after.
            let mut k = j + 1;
            while k < len && is_ws(units[k]) {
                k += 1;
            }
            out.push(THIN);
            out.push(EMDASH);
            out.push(THIN);
            i = k;
        } else {
            out.push(units[i]);
            i += 1;
        }
    }
    out
}

// JS /\s/ (same set the parser uses). Kept local to avoid cross-module coupling.
fn is_ws(u: u16) -> bool {
    matches!(u,
        0x0009 | 0x000A | 0x000B | 0x000C | 0x000D | 0x0020 | 0x00A0 | 0x1680
        | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}
