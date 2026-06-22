// Renaissance AST — Node entry (build-time full surface).
//
// The unchanged require() surface for the compiler, the generators, ast-tools,
// and the whole test suite. It merges the three split modules — core (shared +
// consume), render (DOM + serialize), parse (text -> AST, Node-only) — and
// re-exports exactly the public API the monolith exposed. Requiring parse.js also
// registers the parser hooks into core, so normalizeAstInput accepts raw input
// here. The browser never loads this file; it loads core + render only.
// See docs/specs/AST-COMPILER.md.
"use strict";

const core = require("./core.js");
const render = require("./render.js");
const parse = require("./parse.js"); // side effect: registers parser hooks into core

const merged = Object.assign({}, core, render, parse);

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
  legacyBlocksToAst: merged.legacyBlocksToAst,
  normalizeSource: merged.normalizeSource,
  parseDocument: merged.parseDocument,
  parseInline: merged.parseInline,
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
