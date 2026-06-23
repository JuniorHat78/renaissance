// json.rs — hand-rolled canonical JSON serializer (no serde, §7).
//
// Emits valid JSON; the equivalence harness JSON.parses both this output and the
// Node AST and compares them STRUCTURALLY, so key order need not byte-match
// JSON.stringify — but escaping must be correct so strings round-trip exactly,
// including lone surrogates (encoded as \uXXXX, lower-case hex, as JSON.stringify
// does). Key order here follows SCRIPTORIUM-RUST-PARSER.md §4.1 for readability.

use crate::ast::*;

pub fn to_json(doc: &Document) -> String {
    let mut s = String::new();
    s.push_str("{\"type\":\"document\",\"version\":\"0.2.0\",\"sourceName\":null,\"children\":[");
    for (i, b) in doc.children.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write_block(&mut s, b);
    }
    s.push_str("],\"diagnostics\":[");
    for (i, d) in doc.diagnostics.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write_diag(&mut s, d);
    }
    s.push_str("],\"stats\":{\"blocks\":");
    s.push_str(&doc.stats_blocks.to_string());
    s.push_str(",\"words\":");
    s.push_str(&doc.stats_words.to_string());
    s.push_str("}}");
    s
}

fn write_position(s: &mut String, p: &Position) {
    s.push_str("\"position\":{\"line\":");
    s.push_str(&p.line.to_string());
    s.push_str(",\"startOffset\":");
    s.push_str(&p.start.to_string());
    s.push_str(",\"endOffset\":");
    s.push_str(&p.end.to_string());
    s.push('}');
}

fn write_block(s: &mut String, b: &Block) {
    match b {
        Block::Heading { level, children, position } => {
            s.push_str("{\"type\":\"heading\",\"level\":");
            s.push_str(&level.to_string());
            s.push_str(",\"children\":[");
            write_inlines(s, children);
            s.push_str("],");
            write_position(s, position);
            s.push('}');
        }
        Block::Paragraph { children, position } => {
            s.push_str("{\"type\":\"paragraph\",\"children\":[");
            write_inlines(s, children);
            s.push_str("],");
            write_position(s, position);
            s.push('}');
        }
        Block::PullQuote { children, position } => {
            s.push_str("{\"type\":\"pull_quote\",\"children\":[");
            write_inlines(s, children);
            s.push_str("],");
            write_position(s, position);
            s.push('}');
        }
        Block::BlockQuote { children, position } => {
            s.push_str("{\"type\":\"blockquote\",\"children\":[");
            for (i, c) in children.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_block(s, c);
            }
            s.push_str("],");
            write_position(s, position);
            s.push('}');
        }
        Block::List { ordered, children, position } => {
            s.push_str("{\"type\":\"list\",\"ordered\":");
            s.push_str(if *ordered { "true" } else { "false" });
            s.push_str(",\"children\":[");
            for (i, c) in children.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_block(s, c);
            }
            s.push_str("],");
            write_position(s, position);
            s.push('}');
        }
        Block::ListItem { children, position } => {
            s.push_str("{\"type\":\"list_item\",\"children\":[");
            write_inlines(s, children);
            s.push_str("],");
            write_position(s, position);
            s.push('}');
        }
        Block::Divider { position } => {
            s.push_str("{\"type\":\"divider\",");
            write_position(s, position);
            s.push('}');
        }
    }
}

fn write_inlines(s: &mut String, nodes: &[Inline]) {
    for (i, n) in nodes.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write_inline(s, n);
    }
}

fn write_inline(s: &mut String, n: &Inline) {
    match n {
        Inline::Text(v) => {
            s.push_str("{\"type\":\"text\",\"value\":");
            write_json_string(s, v);
            s.push('}');
        }
        Inline::Emphasis(ch) => {
            s.push_str("{\"type\":\"emphasis\",\"children\":[");
            write_inlines(s, ch);
            s.push_str("]}");
        }
        Inline::Strong(ch) => {
            s.push_str("{\"type\":\"strong\",\"children\":[");
            write_inlines(s, ch);
            s.push_str("]}");
        }
        Inline::Code(v) => {
            s.push_str("{\"type\":\"code\",\"value\":");
            write_json_string(s, v);
            s.push('}');
        }
        Inline::Link { href, children } => {
            s.push_str("{\"type\":\"link\",\"href\":");
            write_json_string(s, href);
            s.push_str(",\"children\":[");
            write_inlines(s, children);
            s.push_str("]}");
        }
        Inline::HardBreak => {
            s.push_str("{\"type\":\"hard_break\"}");
        }
    }
}

fn write_diag(s: &mut String, d: &Diagnostic) {
    s.push_str("{\"code\":");
    write_ascii_string(s, d.code);
    s.push_str(",\"severity\":");
    write_ascii_string(s, d.severity);
    s.push_str(",\"message\":");
    write_ascii_string(s, &d.message);
    s.push_str(",\"offset\":");
    s.push_str(&d.offset.to_string());
    s.push_str(",\"details\":{");
    for (i, (k, v)) in d.details.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write_ascii_string(s, k);
        s.push(':');
        match v {
            DetailValue::Num(n) => s.push_str(&n.to_string()),
            DetailValue::Str(units) => write_json_string(s, units),
        }
    }
    s.push_str("},\"position\":{\"line\":");
    s.push_str(&d.line.to_string());
    s.push_str(",\"column\":");
    s.push_str(&d.column.to_string());
    s.push_str("}}");
}

// Write an ASCII string (codes / messages we control). Still escape defensively.
fn write_ascii_string(s: &mut String, value: &str) {
    s.push('"');
    for ch in value.chars() {
        match ch {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
}

// Write a JSON string from UTF-16 code units, matching JSON.stringify escaping:
// named escapes for \b \f \n \r \t, \uXXXX for other controls, valid surrogate
// pairs decoded to UTF-8, lone surrogates emitted as \uXXXX (lower-case).
fn write_json_string(s: &mut String, units: &[u16]) {
    s.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => s.push_str("\\\""),
            0x5C => s.push_str("\\\\"),
            0x08 => s.push_str("\\b"),
            0x0C => s.push_str("\\f"),
            0x0A => s.push_str("\\n"),
            0x0D => s.push_str("\\r"),
            0x09 => s.push_str("\\t"),
            0x00..=0x1F => s.push_str(&format!("\\u{:04x}", u)),
            0xD800..=0xDBFF => {
                // High surrogate: pair with a following low surrogate if present.
                if i + 1 < units.len() && (0xDC00..=0xDFFF).contains(&units[i + 1]) {
                    let hi = u as u32;
                    let lo = units[i + 1] as u32;
                    let c = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                    if let Some(ch) = char::from_u32(c) {
                        s.push(ch);
                    }
                    i += 2;
                    continue;
                }
                s.push_str(&format!("\\u{:04x}", u)); // lone high surrogate
            }
            0xDC00..=0xDFFF => s.push_str(&format!("\\u{:04x}", u)), // lone low surrogate
            _ => {
                if let Some(ch) = char::from_u32(u as u32) {
                    s.push(ch);
                }
            }
        }
        i += 1;
    }
    s.push('"');
}
