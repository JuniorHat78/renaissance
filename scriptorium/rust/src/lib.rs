// scriptorium-parser — crate-free Rust port of scripts/ast/parse.js, held
// byte-identical to the JS authority by the equivalence oracle in CI
// (docs/specs/SCRIPTORIUM-RUST-PARSER.md). Targets native (the harness/binary)
// and, later, wasm32 (the browser editor) from this one source.

mod ast;
mod json;
pub mod json_value;
mod parser;

pub use ast::Document;

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

    unsafe fn utf16le_units(ptr: *const u8, byte_len: usize) -> Vec<u16> {
        std::slice::from_raw_parts(ptr, byte_len)
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    fn pack(json: String) -> u64 {
        let out = json.into_bytes().into_boxed_slice();
        let out_len = out.len();
        let out_ptr = std::boxed::Box::into_raw(out) as *mut u8 as usize;
        ((out_ptr as u64) << 32) | (out_len as u64)
    }
}
