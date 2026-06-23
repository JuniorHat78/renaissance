// Scriptorium — browser glue for the Rust parser compiled to wasm (R1).
//
// Crate-free (no wasm-bindgen, SCRIPTORIUM-RUST-PARSER.md §7): fetch + instantiate
// the .wasm, then for each parse allocate a buffer, write the source as UTF-16LE,
// call parse_utf16, read the (ptr,len) of UTF-8 canonical JSON it returns, decode,
// JSON.parse, and free both buffers. The result is the identical AST object the JS
// authority produces (proven byte-identical by the equivalence oracle), so the
// editor's preview / mapping / commands consume it unchanged.
//
// Exposes window.ScriptoriumWasmParser = { load(url), parseDocument(text), isLoaded() }.
// load() is async; parseDocument() throws if called before a successful load.
(function initScriptoriumWasmParser(root) {
  "use strict";

  var instance = null;
  var decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

  function load(url) {
    var wasmUrl = url || "scriptorium_parser.wasm";
    return fetch(wasmUrl).then(function (response) {
      if (!response.ok) {
        throw new Error("wasm fetch failed: HTTP " + response.status);
      }
      return response.arrayBuffer();
    }).then(function (bytes) {
      // arrayBuffer (not instantiateStreaming) so we don't depend on the server
      // sending application/wasm.
      return WebAssembly.instantiate(bytes, {});
    }).then(function (result) {
      var ex = result.instance.exports;
      var required = ["alloc", "dealloc", "parse_utf16", "memory"];
      for (var i = 0; i < required.length; i += 1) {
        if (!ex[required[i]]) {
          throw new Error("wasm is missing export '" + required[i] + "'");
        }
      }
      instance = result.instance;
      return true;
    });
  }

  function parseDocument(text) {
    if (!instance) {
      throw new Error("wasm parser not loaded — call ScriptoriumWasmParser.load() first");
    }
    var ex = instance.exports;
    var source = String(text == null ? "" : text);
    var len16 = source.length;
    var byteLen = len16 * 2;

    var inPtr = ex.alloc(byteLen);
    // Re-fetch the view after alloc (memory may have grown).
    var inView = new DataView(ex.memory.buffer);
    for (var i = 0; i < len16; i += 1) {
      inView.setUint16(inPtr + i * 2, source.charCodeAt(i), true);
    }

    var packed = ex.parse_utf16(inPtr, byteLen); // i64 → BigInt
    var outPtr = Number(packed >> 32n);
    var outLen = Number(packed & 0xffffffffn);

    // Copy the JSON bytes out (re-fetch: parse may have grown memory).
    var outBytes = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
    var json = decoder ? decoder.decode(outBytes) : utf8Decode(outBytes);

    ex.dealloc(outPtr, outLen);
    ex.dealloc(inPtr, byteLen);
    return JSON.parse(json);
  }

  // Minimal UTF-8 fallback if TextDecoder is somehow unavailable.
  function utf8Decode(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 1) {
      s += String.fromCharCode(bytes[i]);
    }
    return decodeURIComponent(escape(s));
  }

  var api = {
    load: load,
    parseDocument: parseDocument,
    isLoaded: function () { return !!instance; },
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ScriptoriumWasmParser = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
