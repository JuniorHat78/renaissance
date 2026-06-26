// scriptorium-parser — crate-free Rust port of scripts/ast/parse.js, held
// byte-identical to the JS authority by the equivalence oracle in CI
// (docs/specs/SCRIPTORIUM-RUST-PARSER.md). Targets native (the harness/binary)
// and, later, wasm32 (the browser editor) from this one source.

mod ast;
mod consume;
mod docjson;
mod escape;
pub mod essays;
mod json;
pub mod json_value;
mod parser;
mod render;

/// Parse UTF-16 units and project the passage records (core.passagesFromDocument)
/// as a compact JSON array string.
pub fn passages_json(units: &[u16]) -> String {
    consume::passages_json(&parser::parse_document(units))
}

/// Parse UTF-16 units and render to HTML (UTF-16), byte-identical to render.js
/// serializeBlocks. Returned as UTF-16 so lone surrogates round-trip exactly.
pub fn render_to_html_units(units: &[u16]) -> Vec<u16> {
    render::to_html_units(&parser::parse_document(units))
}

pub use ast::Document;
pub use json_value::Json;

// --- content-AST compiler surface (Pass 1 step 2) ---------------------------
//
// Promotes generate-content-ast.js / generate-search-index.js into the one Rust
// core: parse → withoutLeadingHeadings → the projections the reader hydrates and
// the search index derives from. Held byte-identical by the content-ast oracle.

/// core.js withoutLeadingHeadings: drop leading heading blocks, preserving the
/// original diagnostics and stats (Object.assign keeps them — only `children` is
/// replaced, so stats stay the FULL-document counts).
pub fn without_leading_headings(doc: Document) -> Document {
    let Document { children, diagnostics, stats_blocks, stats_words } = doc;
    let mut first_content = 0;
    while first_content < children.len()
        && matches!(children[first_content], ast::Block::Heading { .. })
    {
        first_content += 1;
    }
    let kept = children.into_iter().skip(first_content).collect();
    Document { children: kept, diagnostics, stats_blocks, stats_words }
}

/// parseDocument(text) then withoutLeadingHeadings — the reader's content AST.
pub fn content_document(units: &[u16]) -> Document {
    without_leading_headings(parser::parse_document(units))
}

/// The content AST serialized as `JSON.stringify(ast, null, 2)` (no trailing
/// newline) — the per-section `ast` field of data/compiled/<slug>.json.
pub fn content_ast_pretty(units: &[u16], source_name: &[u16]) -> String {
    let doc = content_document(units);
    json_value::to_pretty(&docjson::document_to_json(&doc, Some(source_name)), 2)
}

/// Document → Json (re-export for the compiler bin, which composes it into the
/// per-essay artifact wrapper).
pub fn document_to_json(doc: &Document, source_name: Option<&[u16]>) -> Json {
    docjson::document_to_json(doc, source_name)
}

/// wordCount(toSearchableText(doc)) — the section `wordCount` field (computed on
/// the heading-stripped projection, distinct from the full-doc stats.words).
pub fn searchable_word_count(doc: &Document) -> usize {
    parser::word_count(&parser::searchable_text(&doc.children))
}

/// passagesFromDocument(doc).length — the section `passageCount` field.
pub fn passage_count(doc: &Document) -> usize {
    consume::passages(doc).len()
}

/// passagesFromDocument(doc) as Json records (the search-index `passages` array;
/// the same {passageId, passageIndex, blockType, text, source*} shape the
/// consume oracle already proves ≡ core.passagesFromDocument).
pub fn passage_records(doc: &Document) -> Vec<Json> {
    consume::passages(doc)
}

/// wordCount over a UTF-16 string — the search index sums this over passage
/// texts (distinct from content-ast's toSearchableText-based section count).
pub fn word_count_units(units: &[u16]) -> usize {
    parser::word_count(units)
}

/// Reformat a JSON document (parse + re-serialize). `pretty` → 2-space like
/// `JSON.stringify(v, null, 2)`; otherwise compact like `JSON.stringify(v)`.
/// Used to verify the json_value module byte-for-byte against Node (R2).
pub fn json_reformat(units: &[u16], pretty: bool) -> String {
    match json_value::parse(units) {
        Ok(v) => {
            if pretty {
                json_value::to_pretty(&v, 2)
            } else {
                json_value::to_compact(&v)
            }
        }
        Err(e) => format!("__parse_error__: {}", e.0),
    }
}

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

// --- wasm ABI (R1) — crate-free, no wasm-bindgen (§7) -----------------------
//
// The browser/Node glue: allocate a buffer, write the source as UTF-16LE, call
// parse_utf16, read the returned (ptr,len) of UTF-8 canonical JSON, then free
// both buffers. Buffers are Box<[u8]> so capacity == len exactly, making dealloc
// (reconstruct + drop the boxed slice) sound.
#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    /// Allocate `len` bytes and return a pointer the caller fills / reads.
    #[no_mangle]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let buf = vec![0u8; len].into_boxed_slice();
        std::boxed::Box::into_raw(buf) as *mut u8
    }

    /// Free a buffer previously returned by `alloc` or `parse_utf16`.
    ///
    /// # Safety
    /// `ptr`/`len` must be a buffer this module handed out and not yet freed.
    #[no_mangle]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        if ptr.is_null() {
            return;
        }
        let slice = std::slice::from_raw_parts_mut(ptr, len) as *mut [u8];
        drop(std::boxed::Box::from_raw(slice));
    }

    /// Parse `byte_len` bytes of UTF-16LE at `ptr` into canonical JSON.
    /// Returns the result packed as `(out_ptr << 32) | out_len`. The caller
    /// reads `out_len` UTF-8 bytes at `out_ptr`, then `dealloc(out_ptr, out_len)`
    /// (and frees its own input buffer).
    ///
    /// # Safety
    /// `ptr`/`byte_len` must describe a readable UTF-16LE buffer.
    #[no_mangle]
    pub unsafe extern "C" fn parse_utf16(ptr: *const u8, byte_len: usize) -> u64 {
        let units = utf16le_units(ptr, byte_len);
        pack(crate::parse_to_json(&units))
    }

    /// Reformat UTF-16LE JSON as 2-space-pretty (for verifying json_value).
    /// # Safety: see `parse_utf16`.
    #[no_mangle]
    pub unsafe extern "C" fn json_pretty2(ptr: *const u8, byte_len: usize) -> u64 {
        let units = utf16le_units(ptr, byte_len);
        pack(crate::json_reformat(&units, true))
    }

    /// Reformat UTF-16LE JSON as compact (for verifying json_value).
    /// # Safety: see `parse_utf16`.
    #[no_mangle]
    pub unsafe extern "C" fn json_compact(ptr: *const u8, byte_len: usize) -> u64 {
        let units = utf16le_units(ptr, byte_len);
        pack(crate::json_reformat(&units, false))
    }

    /// Parse + project passage records as compact JSON (UTF-8).
    /// # Safety: see `parse_utf16`.
    #[no_mangle]
    pub unsafe extern "C" fn passages_utf16(ptr: *const u8, byte_len: usize) -> u64 {
        let units = utf16le_units(ptr, byte_len);
        pack(crate::passages_json(&units))
    }

    /// Render UTF-16LE JSON-free: parse + render to HTML, returned as UTF-16LE
    /// bytes (the editor / oracle decodes with TextDecoder('utf-16le')).
    /// # Safety: see `parse_utf16`.
    #[no_mangle]
    pub unsafe extern "C" fn render_utf16(ptr: *const u8, byte_len: usize) -> u64 {
        let units = utf16le_units(ptr, byte_len);
        pack_units(crate::render_to_html_units(&units))
    }

    /// Content AST as 2-space-pretty JSON (the per-section `ast` field of the
    /// compiled artifact): withoutLeadingHeadings(parse) with `sourceName` set
    /// from the second buffer. Drives the content-ast oracle.
    /// # Safety: both (ptr,len) pairs must describe readable UTF-16LE buffers.
    #[no_mangle]
    pub unsafe extern "C" fn content_ast_utf16(
        ptr: *const u8,
        byte_len: usize,
        name_ptr: *const u8,
        name_byte_len: usize,
    ) -> u64 {
        let units = utf16le_units(ptr, byte_len);
        let name = utf16le_units(name_ptr, name_byte_len);
        pack(crate::content_ast_pretty(&units, &name))
    }

    unsafe fn utf16le_units(ptr: *const u8, byte_len: usize) -> Vec<u16> {
        std::slice::from_raw_parts(ptr, byte_len)
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    fn pack(json: String) -> u64 {
        pack_bytes(json.into_bytes())
    }

    fn pack_units(units: Vec<u16>) -> u64 {
        let mut bytes = Vec::with_capacity(units.len() * 2);
        for u in units {
            bytes.push((u & 0xff) as u8);
            bytes.push((u >> 8) as u8);
        }
        pack_bytes(bytes)
    }

    fn pack_bytes(bytes: Vec<u8>) -> u64 {
        let out = bytes.into_boxed_slice();
        let out_len = out.len();
        let out_ptr = std::boxed::Box::into_raw(out) as *mut u8 as usize;
        ((out_ptr as u64) << 32) | (out_len as u64)
    }
}
