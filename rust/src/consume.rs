// consume.rs — consume-side projections, a port of core.js passagesFromDocument.
//
// Walks the AST producing the stable passage records (p1..pN) that drive search,
// anchors, and arrival — descending into blockquote/list containers, numbering
// only the addressable passage blocks with non-empty searchable text. Held
// byte-identical to core.js by the consume oracle. Emits a JSON array (reusing
// json_value so escaping matches JSON.stringify).

use crate::ast::*;
use crate::json_value::{self, Json};
use crate::parser::block_to_searchable_text;

fn is_passage_block(block: &Block) -> bool {
    matches!(
        block,
        Block::Heading { .. } | Block::Paragraph { .. } | Block::PullQuote { .. } | Block::ListItem { .. }
    )
}

fn block_type_str(block: &Block) -> &'static str {
    match block {
        Block::Heading { .. } => "heading",
        Block::Paragraph { .. } => "paragraph",
        Block::PullQuote { .. } => "pull_quote",
        Block::ListItem { .. } => "list_item",
        Block::BlockQuote { .. } => "blockquote",
        Block::List { .. } => "list",
        Block::Divider { .. } => "divider",
    }
}

fn position_of(block: &Block) -> Option<&Position> {
    match block {
        Block::Heading { position, .. }
        | Block::Paragraph { position, .. }
        | Block::PullQuote { position, .. }
        | Block::BlockQuote { position, .. }
        | Block::List { position, .. }
        | Block::ListItem { position, .. }
        | Block::Divider { position } => Some(position),
    }
}

fn str_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn append_passages(block: &Block, index: &mut i64, out: &mut Vec<Json>) {
    match block {
        Block::BlockQuote { children, .. } | Block::List { children, .. } => {
            for child in children {
                append_passages(child, index, out);
            }
        }
        _ => {
            if !is_passage_block(block) {
                return;
            }
            let text = block_to_searchable_text(block);
            if text.is_empty() {
                return;
            }
            *index += 1;
            let pos = position_of(block);
            let (start, end, line) = match pos {
                Some(p) => (
                    Json::Int(p.start as i64),
                    Json::Int(p.end as i64),
                    Json::Int(p.line as i64),
                ),
                None => (Json::Null, Json::Null, Json::Null),
            };
            out.push(Json::Object(vec![
                (str_units("passageId"), Json::Str(str_units(&format!("p{}", index)))),
                (str_units("passageIndex"), Json::Int(*index)),
                (str_units("blockType"), Json::Str(str_units(block_type_str(block)))),
                (str_units("text"), Json::Str(text)),
                (str_units("sourceStart"), start),
                (str_units("sourceEnd"), end),
                (str_units("sourceLine"), line),
            ]));
        }
    }
}

pub fn passages(doc: &Document) -> Vec<Json> {
    let mut out = Vec::new();
    let mut index: i64 = 0;
    for block in &doc.children {
        append_passages(block, &mut index, &mut out);
    }
    out
}

/// Passage records as a compact JSON array (matches core.passagesFromDocument).
pub fn passages_json(doc: &Document) -> String {
    json_value::to_compact(&Json::Array(passages(doc)))
}
