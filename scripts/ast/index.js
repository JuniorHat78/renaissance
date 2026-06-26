// Renaissance AST — Node entry (build-time full surface).
//
// The unchanged require() surface for the compiler, the generators, ast-tools,
// and the whole test suite. It merges the surviving modules — core (shared +
// consume), render (DOM + serialize), validate (AST invariant checks) — and
// sources the ONE parser (text -> AST) from the Rust core via wasm (parse-wasm),
// which also registers the string parser into core so normalizeAstInput accepts
// raw input here. Requiring parse-wasm costs nothing until the first parse (the
// wasm loads lazily). The browser never loads this file; it loads core + render
// only. The retired parse.js's parser-only helpers (parseInline, normalizeSource,
// the legacy bridge) had no consumers and left with it. See AST-COMPILER.md and
// SCRIPTORIUM-RUST-PARSER.md §14.3.
"use strict";

const core = require("./core.js");
const render = require("./render.js");
const validate = require("./validate.js");
const parse = require("./parse-wasm.js"); // side effect: registers the wasm string parser into core

const merged = Object.assign({}, core, render, validate, parse);

module.exports = Object.freeze({
  VERSION: merged.VERSION,
  BLOCK_TYPES: merged.BLOCK_TYPES,
  INLINE_TYPES: merged.INLINE_TYPES,
  DIAGNOSTIC_CODES: merged.DIAGNOSTIC_CODES,
  HARD_BREAK_SENTINEL: merged.HARD_BREAK_SENTINEL,
  astToLegacyBlocks: merged.astToLegacyBlocks,
  blockToPlainText: merged.blockToPlainText,
  blockToSearchableText: merged.blockToSearchableText,
  escapeHtml: merged.escapeHtml,
  firstParagraphText: merged.firstParagraphText,
  formatDisplayText: merged.formatDisplayText,
  parseDocument: merged.parseDocument,
  passagesFromDocument: merged.passagesFromDocument,
  renderBlocks: merged.renderBlocks,
  renderDocument: merged.renderDocument,
  serializeBlocks: merged.serializeBlocks,
  serializeDocument: merged.serializeDocument,
  toPlainText: merged.toPlainText,
  toSearchableText: merged.toSearchableText,
  validateDocument: merged.validateDocument,
  withoutLeadingHeadings: merged.withoutLeadingHeadings,
  wordCount: merged.wordCount,
});
