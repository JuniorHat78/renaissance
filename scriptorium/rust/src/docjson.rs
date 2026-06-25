// docjson.rs — Document → json_value::Json, for the content-AST compiler (R3 /
// Pass 1 step 2). json.rs serializes the AST straight to a *compact* canonical
// string for the parse oracle (compared structurally). The build-time content
// artifact (data/compiled/<slug>.json) is instead compared BYTE-for-byte against
// `JSON.stringify(withoutLeadingHeadings(parseDocument(text)), null, 2)`, so here
// we build a `Json` value tree and hand it to json_value::to_pretty — which is
// already proven byte-identical to JSON.stringify (R2). Key order mirrors
// parse.js's object insertion order exactly (the same order json.rs uses); the
// content-ast oracle guards any drift over the full corpus + adversarial + fuzz.

use crate::ast::*;
use crate::json_value::Json;

fn s(text: &str) -> Json {
    Json::Str(text.encode_utf16().collect())
}

fn k(key: &str) -> Vec<u16> {
    key.encode_utf16().collect()
}

fn units(value: &[u16]) -> Json {
    Json::Str(value.to_vec())
}

/// withoutLeadingHeadings(parseDocument(...)) serialized shape. `source_name`
/// becomes the `sourceName` field (None → null, as the bare parser emits).
pub fn document_to_json(doc: &Document, source_name: Option<&[u16]>) -> Json {
    Json::Object(vec![
        (k("type"), s("document")),
        (k("version"), s("0.2.0")),
        (
            k("sourceName"),
            match source_name {
                Some(name) => units(name),
                None => Json::Null,
            },
        ),
        (
            k("children"),
            Json::Array(doc.children.iter().map(block_to_json).collect()),
        ),
        (
            k("diagnostics"),
            Json::Array(doc.diagnostics.iter().map(diag_to_json).collect()),
        ),
        (
            k("stats"),
            Json::Object(vec![
                (k("blocks"), Json::Int(doc.stats_blocks as i64)),
                (k("words"), Json::Int(doc.stats_words as i64)),
            ]),
        ),
    ])
}

fn position_to_json(p: &Position) -> Json {
    Json::Object(vec![
        (k("line"), Json::Int(p.line as i64)),
        (k("startOffset"), Json::Int(p.start as i64)),
        (k("endOffset"), Json::Int(p.end as i64)),
    ])
}

fn inlines(nodes: &[Inline]) -> Json {
    Json::Array(nodes.iter().map(inline_to_json).collect())
}

fn blocks(nodes: &[Block]) -> Json {
    Json::Array(nodes.iter().map(block_to_json).collect())
}

fn block_to_json(b: &Block) -> Json {
    match b {
        Block::Heading { level, children, position } => Json::Object(vec![
            (k("type"), s("heading")),
            (k("level"), Json::Int(*level as i64)),
            (k("children"), inlines(children)),
            (k("position"), position_to_json(position)),
        ]),
        Block::Paragraph { children, position } => Json::Object(vec![
            (k("type"), s("paragraph")),
            (k("children"), inlines(children)),
            (k("position"), position_to_json(position)),
        ]),
        Block::PullQuote { children, position } => Json::Object(vec![
            (k("type"), s("pull_quote")),
            (k("children"), inlines(children)),
            (k("position"), position_to_json(position)),
        ]),
        Block::BlockQuote { children, position } => Json::Object(vec![
            (k("type"), s("blockquote")),
            (k("children"), blocks(children)),
            (k("position"), position_to_json(position)),
        ]),
        Block::List { ordered, children, position } => Json::Object(vec![
            (k("type"), s("list")),
            (k("ordered"), Json::Bool(*ordered)),
            (k("children"), blocks(children)),
            (k("position"), position_to_json(position)),
        ]),
        Block::ListItem { children, position } => Json::Object(vec![
            (k("type"), s("list_item")),
            (k("children"), inlines(children)),
            (k("position"), position_to_json(position)),
        ]),
        Block::Divider { position } => Json::Object(vec![
            (k("type"), s("divider")),
            (k("position"), position_to_json(position)),
        ]),
    }
}

fn inline_to_json(n: &Inline) -> Json {
    match n {
        Inline::Text(v) => Json::Object(vec![
            (k("type"), s("text")),
            (k("value"), units(v)),
        ]),
        Inline::Emphasis(ch) => Json::Object(vec![
            (k("type"), s("emphasis")),
            (k("children"), inlines(ch)),
        ]),
        Inline::Strong(ch) => Json::Object(vec![
            (k("type"), s("strong")),
            (k("children"), inlines(ch)),
        ]),
        Inline::Code(v) => Json::Object(vec![
            (k("type"), s("code")),
            (k("value"), units(v)),
        ]),
        Inline::Link { href, children } => Json::Object(vec![
            (k("type"), s("link")),
            (k("href"), units(href)),
            (k("children"), inlines(children)),
        ]),
        Inline::HardBreak => Json::Object(vec![(k("type"), s("hard_break"))]),
    }
}

fn diag_to_json(d: &Diagnostic) -> Json {
    Json::Object(vec![
        (k("code"), s(d.code)),
        (k("severity"), s(d.severity)),
        (k("message"), s(&d.message)),
        (k("offset"), Json::Int(d.offset as i64)),
        (
            k("details"),
            Json::Object(
                d.details
                    .iter()
                    .map(|(key, val)| {
                        let v = match val {
                            DetailValue::Num(n) => Json::Int(*n),
                            DetailValue::Str(u) => units(u),
                        };
                        (k(key), v)
                    })
                    .collect(),
            ),
        ),
        (
            k("position"),
            Json::Object(vec![
                (k("line"), Json::Int(d.line as i64)),
                (k("column"), Json::Int(d.column as i64)),
            ]),
        ),
    ])
}
