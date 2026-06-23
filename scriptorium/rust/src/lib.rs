// scriptorium-parser — crate-free Rust port of scripts/ast/parse.js, held
// byte-identical to the JS authority by the equivalence oracle in CI
// (docs/specs/SCRIPTORIUM-RUST-PARSER.md). Targets native (the harness/binary)
// and, later, wasm32 (the browser editor) from this one source.

mod ast;
mod json;
mod parser;

pub use ast::Document;

/// Parse a buffer of UTF-16 code units into the content AST.
pub fn parse_document(units: &[u16]) -> Document {
    parser::parse_document(units)
}

/// Serialize a parsed document to canonical JSON (UTF-8).
pub fn to_json(doc: &Document) -> String {
    json::to_json(doc)
}

/// Convenience: parse UTF-16 units and serialize in one step.
pub fn parse_to_json(units: &[u16]) -> String {
    json::to_json(&parser::parse_document(units))
}
