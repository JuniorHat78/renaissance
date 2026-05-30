(function initRenaissanceAst(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.RenaissanceAst = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function buildRenaissanceAst() {
  "use strict";

  const VERSION = "0.1.0";
  const HARD_BREAK_SENTINEL = "\x01";

  const BLOCK_TYPES = Object.freeze({
    DOCUMENT: "document",
    HEADING: "heading",
    PARAGRAPH: "paragraph",
    PULL_QUOTE: "pull_quote",
    DIVIDER: "divider",
  });

  const INLINE_TYPES = Object.freeze({
    TEXT: "text",
    EMPHASIS: "emphasis",
    HARD_BREAK: "hard_break",
  });

  const DIAGNOSTIC_CODES = Object.freeze({
    BOM_REMOVED: "bom-removed",
    CRLF_NORMALIZED: "crlf-normalized",
    HEADING_LEVEL_CLAMPED: "heading-level-clamped",
    UNMATCHED_EMPHASIS_MARKER: "unmatched-emphasis-marker",
  });

  function normalizeSource(source) {
    let value = source == null ? "" : String(source);
    const diagnostics = [];

    if (value.charCodeAt(0) === 0xfeff) {
      value = value.slice(1);
      diagnostics.push(createDiagnostic(DIAGNOSTIC_CODES.BOM_REMOVED, "Removed UTF-8 byte-order mark.", 0));
    }

    if (/\r/.test(value)) {
      value = value.replace(/\r\n?/g, "\n");
      diagnostics.push(createDiagnostic(DIAGNOSTIC_CODES.CRLF_NORMALIZED, "Normalized carriage returns to line feeds.", 0));
    }

    return { value, diagnostics };
  }

  function parseDocument(source, options) {
    const settings = Object.assign({ sourceName: null }, options || {});
    const normalized = normalizeSource(source);
    const diagnostics = normalized.diagnostics.slice();
    const sourceText = normalized.value;
    const lines = sourceText.split("\n");
    const lineOffsets = computeLineOffsets(sourceText);
    const blocks = [];
    let pendingParagraph = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNumber = index + 1;
      const offset = lineOffsets[index];

      if (isBlank(line)) {
        flushParagraph();
        continue;
      }

      const heading = parseHeadingLine(line, lineNumber, offset, diagnostics);
      if (heading) {
        flushParagraph();
        blocks.push(heading);
        continue;
      }

      if (isDividerLine(line)) {
        flushParagraph();
        blocks.push(createDivider(lineNumber, offset, line.length));
        continue;
      }

      pendingParagraph.push(createParagraphLine(line, lineNumber, offset));
    }

    flushParagraph();

    const ast = {
      type: BLOCK_TYPES.DOCUMENT,
      version: VERSION,
      sourceName: settings.sourceName,
      children: blocks,
      diagnostics,
    };

    ast.stats = {
      blocks: blocks.length,
      words: wordCount(toSearchableText(ast)),
    };

    return ast;

    function flushParagraph() {
      if (!pendingParagraph.length) {
        return;
      }

      blocks.push(createParagraph(pendingParagraph, diagnostics));
      pendingParagraph = [];
    }
  }

  function parseHeadingLine(line, lineNumber, offset, diagnostics) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      return null;
    }

    const marker = match[1];
    let level = marker.length;
    if (level > 3) {
      diagnostics.push(createDiagnostic(
        DIAGNOSTIC_CODES.HEADING_LEVEL_CLAMPED,
        "Clamped heading level " + level + " to level 3.",
        offset,
        { line: lineNumber, level }
      ));
      level = 3;
    }

    const text = match[2];
    const textOffset = offset + marker.length + 1;
    return {
      type: BLOCK_TYPES.HEADING,
      level,
      children: parseInline(text, textOffset, diagnostics),
      position: createPosition(lineNumber, offset, offset + line.length),
    };
  }

  function createParagraph(lines, diagnostics) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    const pullQuote = lines.length === 1 && isPullQuoteText(first.text);
    const blockType = pullQuote ? BLOCK_TYPES.PULL_QUOTE : BLOCK_TYPES.PARAGRAPH;

    return {
      type: blockType,
      children: parseInlineLines(lines, diagnostics),
      position: createPosition(first.lineNumber, first.offset, last.offset + last.sourceLength),
    };
  }

  function createParagraphLine(line, lineNumber, offset) {
    const hardBreakAfter = / {2,}$/.test(line);
    const text = hardBreakAfter ? line.replace(/ {2,}$/, "") : line.trim();
    const leadingWhitespace = hardBreakAfter ? countLeadingWhitespace(line) : line.length - line.trimStart().length;

    return {
      text,
      lineNumber,
      offset: offset + leadingWhitespace,
      sourceLength: line.length,
      hardBreakAfter,
    };
  }

  function createDivider(lineNumber, offset, length) {
    return {
      type: BLOCK_TYPES.DIVIDER,
      position: createPosition(lineNumber, offset, offset + length),
    };
  }

  function parseInlineLines(lines, diagnostics) {
    const joined = joinInlineLines(lines);
    return normalizeInlineSeparators(parseInline(joined.text, joined.offset, diagnostics));
  }

  function joinInlineLines(lines) {
    if (!lines.length) {
      return { text: "", offset: 0 };
    }

    let text = "";
    lines.forEach(function appendLine(line, index) {
      text += line.text;
      if (index < lines.length - 1) {
        text += line.hardBreakAfter ? HARD_BREAK_SENTINEL + "\n" : "\n";
      }
    });

    return { text, offset: lines[0].offset };
  }

  function normalizeInlineSeparators(nodes) {
    const normalized = [];

    nodes.forEach(function normalize(node) {
      if (node.type === INLINE_TYPES.TEXT) {
        appendSeparatorText(normalized, node.value);
        return;
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        appendInlineNode(normalized, {
          type: INLINE_TYPES.EMPHASIS,
          children: normalizeInlineSeparators(node.children || []),
        });
        return;
      }

      appendInlineNode(normalized, node);
    });

    return normalized;
  }

  function appendSeparatorText(target, value) {
    const text = String(value);
    let cursor = 0;

    while (cursor < text.length) {
      const hardBreakIndex = text.indexOf(HARD_BREAK_SENTINEL + "\n", cursor);
      const newlineIndex = text.indexOf("\n", cursor);
      const nextIndex = firstNonNegative(hardBreakIndex, newlineIndex);

      if (nextIndex === -1) {
        appendText(target, text.slice(cursor));
        return;
      }

      appendText(target, text.slice(cursor, nextIndex));

      if (hardBreakIndex === nextIndex) {
        appendInlineNode(target, { type: INLINE_TYPES.HARD_BREAK });
        cursor = nextIndex + 2;
      } else {
        appendText(target, " ");
        cursor = nextIndex + 1;
      }
    }
  }

  function firstNonNegative(left, right) {
    if (left === -1) {
      return right;
    }

    if (right === -1) {
      return left;
    }

    return Math.min(left, right);
  }

  function parseInline(input, baseOffset, diagnostics) {
    const text = input == null ? "" : String(input);
    const nodes = [];
    let cursor = 0;

    while (cursor < text.length) {
      const markerIndex = text.indexOf("*", cursor);
      if (markerIndex === -1) {
        appendText(nodes, text.slice(cursor));
        break;
      }

      if (!canOpenEmphasis(text, markerIndex)) {
        appendText(nodes, text.slice(cursor, markerIndex + 1));
        cursor = markerIndex + 1;
        continue;
      }

      const closeIndex = findClosingEmphasis(text, markerIndex + 1);
      if (closeIndex === -1) {
        appendText(nodes, text.slice(cursor, markerIndex + 1));
        diagnostics.push(createDiagnostic(
          DIAGNOSTIC_CODES.UNMATCHED_EMPHASIS_MARKER,
          "Treating unmatched emphasis marker as literal text.",
          baseOffset + markerIndex
        ));
        cursor = markerIndex + 1;
        continue;
      }

      appendText(nodes, text.slice(cursor, markerIndex));
      appendInlineNode(nodes, {
        type: INLINE_TYPES.EMPHASIS,
        children: [{ type: INLINE_TYPES.TEXT, value: text.slice(markerIndex + 1, closeIndex) }],
      });
      cursor = closeIndex + 1;
    }

    return nodes;
  }

  function findClosingEmphasis(text, start) {
    for (let index = start; index < text.length; index += 1) {
      if (text[index] !== "*") {
        continue;
      }

      if (canCloseEmphasis(text, index)) {
        return index;
      }
    }

    return -1;
  }

  function canOpenEmphasis(text, index) {
    const previous = index > 0 ? text[index - 1] : "";
    const next = index < text.length - 1 ? text[index + 1] : "";

    if (!next || isWhitespace(next) || next === "*") {
      return false;
    }

    return !previous || isWhitespace(previous) || isOpeningBoundary(previous);
  }

  function canCloseEmphasis(text, index) {
    const previous = index > 0 ? text[index - 1] : "";
    const next = index < text.length - 1 ? text[index + 1] : "";

    if (!previous || isWhitespace(previous) || previous === "*") {
      return false;
    }

    return !next || isWhitespace(next) || isClosingBoundary(next);
  }

  function appendInlineNodes(target, nodes) {
    nodes.forEach(function append(node) {
      appendInlineNode(target, node);
    });
  }

  function appendInlineNode(target, node) {
    if (node.type === INLINE_TYPES.TEXT) {
      appendText(target, node.value);
      return;
    }

    target.push(node);
  }

  function appendText(target, value) {
    if (!value) {
      return;
    }

    const last = target[target.length - 1];
    if (last && last.type === INLINE_TYPES.TEXT) {
      last.value += value;
      return;
    }

    target.push({ type: INLINE_TYPES.TEXT, value });
  }

  function renderDocument(container, documentNode) {
    return renderBlocks(container, documentNode);
  }

  function renderBlocks(container, input) {
    const ast = normalizeAstInput(input);
    if (!container || typeof container.appendChild !== "function") {
      throw new Error("renderBlocks requires a DOM container.");
    }

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    getBlockChildren(ast).forEach(function renderBlockNode(block) {
      container.appendChild(createBlockElement(container.ownerDocument, block));
    });

    return container;
  }

  function createBlockElement(documentRef, block) {
    if (block.type === BLOCK_TYPES.HEADING) {
      const level = clampHeadingLevel(block.level);
      const element = documentRef.createElement("h" + level);
      appendInlineDom(documentRef, element, block.children || []);
      return element;
    }

    if (block.type === BLOCK_TYPES.PULL_QUOTE) {
      const element = documentRef.createElement("p");
      element.className = "pull-quote";
      appendInlineDom(documentRef, element, block.children || []);
      return element;
    }

    if (block.type === BLOCK_TYPES.PARAGRAPH) {
      const element = documentRef.createElement("p");
      appendInlineDom(documentRef, element, block.children || []);
      return element;
    }

    if (block.type === BLOCK_TYPES.DIVIDER) {
      return documentRef.createElement("hr");
    }

    throw new Error("Unsupported block type: " + block.type);
  }

  function appendInlineDom(documentRef, parent, nodes) {
    nodes.forEach(function append(node) {
      if (node.type === INLINE_TYPES.TEXT) {
        parent.appendChild(documentRef.createTextNode(formatDisplayText(node.value)));
        return;
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        const element = documentRef.createElement("em");
        appendInlineDom(documentRef, element, node.children || []);
        parent.appendChild(element);
        return;
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        parent.appendChild(documentRef.createElement("br"));
        return;
      }

      throw new Error("Unsupported inline type: " + node.type);
    });
  }

  function serializeDocument(documentNode) {
    return serializeBlocks(documentNode);
  }

  function serializeBlocks(input) {
    const ast = normalizeAstInput(input);
    return getBlockChildren(ast).map(serializeBlock).join("");
  }

  function serializeBlock(block) {
    if (block.type === BLOCK_TYPES.HEADING) {
      const tag = "h" + clampHeadingLevel(block.level);
      return "<" + tag + ">" + serializeInline(block.children || []) + "</" + tag + ">";
    }

    if (block.type === BLOCK_TYPES.PULL_QUOTE) {
      return '<p class="pull-quote">' + serializeInline(block.children || []) + "</p>";
    }

    if (block.type === BLOCK_TYPES.PARAGRAPH) {
      return "<p>" + serializeInline(block.children || []) + "</p>";
    }

    if (block.type === BLOCK_TYPES.DIVIDER) {
      return "<hr>";
    }

    throw new Error("Unsupported block type: " + block.type);
  }

  function serializeInline(nodes) {
    return nodes.map(function serialize(node) {
      if (node.type === INLINE_TYPES.TEXT) {
        return escapeHtml(formatDisplayText(node.value));
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        return "<em>" + serializeInline(node.children || []) + "</em>";
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        return "<br>";
      }

      throw new Error("Unsupported inline type: " + node.type);
    }).join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDisplayText(value) {
    return String(value).replace(/\s*\u2014\s*/g, "\u2009\u2014\u2009");
  }

  function validateDocument(input) {
    const ast = normalizeAstInput(input);
    const errors = [];

    if (!ast || ast.type !== BLOCK_TYPES.DOCUMENT) {
      errors.push(createValidationError("document.type", "Root node must be a document."));
      return errors;
    }

    if (!Array.isArray(ast.children)) {
      errors.push(createValidationError("document.children", "Document children must be an array."));
      return errors;
    }

    ast.children.forEach(function validateBlock(block, index) {
      const path = "document.children[" + index + "]";
      if (!block || typeof block !== "object") {
        errors.push(createValidationError(path, "Block must be an object."));
        return;
      }

      if (!Object.keys(BLOCK_TYPES).map(function keyToValue(key) { return BLOCK_TYPES[key]; }).includes(block.type)) {
        errors.push(createValidationError(path + ".type", "Unknown block type: " + block.type));
      }

      if (block.type === BLOCK_TYPES.HEADING) {
        if (block.level < 1 || block.level > 3) {
          errors.push(createValidationError(path + ".level", "Heading level must be between 1 and 3."));
        }
      }

      if (block.type !== BLOCK_TYPES.DIVIDER) {
        validateInline(block.children, path + ".children", errors);
      }
    });

    return errors;
  }

  function validateInline(nodes, path, errors) {
    if (!Array.isArray(nodes)) {
      errors.push(createValidationError(path, "Inline children must be an array."));
      return;
    }

    nodes.forEach(function validateNode(node, index) {
      const nodePath = path + "[" + index + "]";
      if (!node || typeof node !== "object") {
        errors.push(createValidationError(nodePath, "Inline node must be an object."));
        return;
      }

      if (node.type === INLINE_TYPES.TEXT) {
        if (typeof node.value !== "string") {
          errors.push(createValidationError(nodePath + ".value", "Text nodes require a string value."));
        }
        return;
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        validateInline(node.children, nodePath + ".children", errors);
        return;
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        return;
      }

      errors.push(createValidationError(nodePath + ".type", "Unknown inline type: " + node.type));
    });
  }

  function withoutLeadingHeadings(input) {
    const ast = normalizeAstInput(input);
    let firstContentIndex = 0;

    while (firstContentIndex < ast.children.length && ast.children[firstContentIndex].type === BLOCK_TYPES.HEADING) {
      firstContentIndex += 1;
    }

    return Object.assign({}, ast, {
      children: ast.children.slice(firstContentIndex),
    });
  }

  function toPlainText(input) {
    const ast = normalizeAstInput(input);
    return getBlockChildren(ast).map(blockToPlainText).filter(Boolean).join("\n\n");
  }

  function toSearchableText(input) {
    const ast = normalizeAstInput(input);
    return getBlockChildren(ast).map(blockToSearchableText).filter(Boolean).join(" ");
  }

  function blockToPlainText(block) {
    if (block.type === BLOCK_TYPES.DIVIDER) {
      return "";
    }

    return inlineToText(block.children || [], "\n");
  }

  function blockToSearchableText(block) {
    if (block.type === BLOCK_TYPES.DIVIDER) {
      return "";
    }

    return normalizeWhitespace(inlineToText(block.children || [], " "));
  }

  function inlineToText(nodes, hardBreakValue) {
    return nodes.map(function textOf(node) {
      if (node.type === INLINE_TYPES.TEXT) {
        return node.value;
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        return inlineToText(node.children || [], hardBreakValue);
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        return hardBreakValue;
      }

      return "";
    }).join("");
  }

  function firstParagraphText(input) {
    const ast = normalizeAstInput(input);
    const paragraph = ast.children.find(function findParagraph(block) {
      return block.type === BLOCK_TYPES.PARAGRAPH || block.type === BLOCK_TYPES.PULL_QUOTE;
    });

    return paragraph ? blockToSearchableText(paragraph) : "";
  }

  function astToLegacyBlocks(input) {
    const ast = normalizeAstInput(input);

    return ast.children.map(function convertBlock(block) {
      if (block.type === BLOCK_TYPES.HEADING) {
        return {
          type: "h" + clampHeadingLevel(block.level),
          text: inlineToLegacyText(block.children || []),
        };
      }

      if (block.type === BLOCK_TYPES.PULL_QUOTE) {
        return {
          type: "p",
          text: inlineToLegacyText(block.children || []),
          pullQuote: true,
        };
      }

      if (block.type === BLOCK_TYPES.PARAGRAPH) {
        return {
          type: "p",
          text: inlineToLegacyText(block.children || []),
        };
      }

      if (block.type === BLOCK_TYPES.DIVIDER) {
        return { type: "hr" };
      }

      throw new Error("Unsupported block type: " + block.type);
    });
  }

  function legacyBlocksToAst(blocks) {
    return {
      type: BLOCK_TYPES.DOCUMENT,
      version: VERSION,
      sourceName: null,
      children: (blocks || []).map(legacyBlockToAst),
      diagnostics: [],
    };
  }

  function legacyBlockToAst(block) {
    if (!block || typeof block !== "object") {
      return {
        type: BLOCK_TYPES.PARAGRAPH,
        children: [{ type: INLINE_TYPES.TEXT, value: String(block || "") }],
      };
    }

    if (/^h[1-6]$/.test(block.type)) {
      return {
        type: BLOCK_TYPES.HEADING,
        level: clampHeadingLevel(Number(block.type.slice(1))),
        children: parseLegacyInline(block.text || ""),
      };
    }

    if (block.type === "hr") {
      return { type: BLOCK_TYPES.DIVIDER };
    }

    if (block.type === "p") {
      return {
        type: block.pullQuote ? BLOCK_TYPES.PULL_QUOTE : BLOCK_TYPES.PARAGRAPH,
        children: parseLegacyInline(block.text || ""),
      };
    }

    return {
      type: BLOCK_TYPES.PARAGRAPH,
      children: parseLegacyInline(block.text || ""),
    };
  }

  function parseLegacyInline(value) {
    const parts = String(value).split(HARD_BREAK_SENTINEL);
    const nodes = [];

    parts.forEach(function parsePart(part, index) {
      appendInlineNodes(nodes, parseInline(part, 0, []));
      if (index < parts.length - 1) {
        appendInlineNode(nodes, { type: INLINE_TYPES.HARD_BREAK });
      }
    });

    return nodes;
  }

  function inlineToLegacyText(nodes) {
    return nodes.map(function legacyText(node) {
      if (node.type === INLINE_TYPES.TEXT) {
        return node.value;
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        return "*" + inlineToLegacyText(node.children || []) + "*";
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        return HARD_BREAK_SENTINEL;
      }

      return "";
    }).join("");
  }

  function normalizeAstInput(input) {
    if (!input) {
      return createEmptyDocument();
    }

    if (input.type === BLOCK_TYPES.DOCUMENT) {
      return input;
    }

    if (Array.isArray(input)) {
      if (!input.length || isLegacyBlock(input[0])) {
        return legacyBlocksToAst(input);
      }

      return Object.assign(createEmptyDocument(), { children: input });
    }

    if (typeof input === "string") {
      return parseDocument(input);
    }

    if (input.type) {
      return Object.assign(createEmptyDocument(), { children: [input] });
    }

    return createEmptyDocument();
  }

  function getBlockChildren(input) {
    const ast = normalizeAstInput(input);
    return Array.isArray(ast.children) ? ast.children : [];
  }

  function createEmptyDocument() {
    return {
      type: BLOCK_TYPES.DOCUMENT,
      version: VERSION,
      sourceName: null,
      children: [],
      diagnostics: [],
      stats: { blocks: 0, words: 0 },
    };
  }

  function createDiagnostic(code, message, offset, details) {
    return {
      code,
      message,
      offset,
      details: details || {},
    };
  }

  function createValidationError(path, message) {
    return { path, message };
  }

  function createPosition(line, startOffset, endOffset) {
    return { line, startOffset, endOffset };
  }

  function computeLineOffsets(sourceText) {
    const offsets = [0];

    for (let index = 0; index < sourceText.length; index += 1) {
      if (sourceText[index] === "\n") {
        offsets.push(index + 1);
      }
    }

    return offsets;
  }

  function isPullQuoteText(text) {
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      return false;
    }

    const pairs = [
      ['"', '"'],
      ["'", "'"],
      ["\u201c", "\u201d"],
      ["\u2018", "\u2019"],
    ];

    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index];
      if (trimmed.startsWith(pair[0]) && trimmed.endsWith(pair[1])) {
        return true;
      }
    }

    return false;
  }

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  function isDividerLine(line) {
    return /^\s*---\s*$/.test(line);
  }

  function isLegacyBlock(block) {
    return !block || typeof block.type !== "string" || /^h[1-6]$/.test(block.type) || block.type === "p" || block.type === "hr";
  }

  function isWhitespace(value) {
    return /\s/.test(value);
  }

  function isOpeningBoundary(value) {
    return /[\s([{"'<>:;,-]/.test(value);
  }

  function isClosingBoundary(value) {
    return /[\s)\]}.!?",'<>:;,-]/.test(value);
  }

  function countLeadingWhitespace(value) {
    const match = /^\s*/.exec(value);
    return match ? match[0].length : 0;
  }

  function clampHeadingLevel(value) {
    return Math.max(1, Math.min(3, Number(value) || 1));
  }

  function normalizeWhitespace(value) {
    return String(value).replace(/\s+/g, " ").trim();
  }

  function wordCount(value) {
    const words = normalizeWhitespace(value).match(/\S+/g);
    return words ? words.length : 0;
  }

  return Object.freeze({
    VERSION,
    BLOCK_TYPES,
    INLINE_TYPES,
    DIAGNOSTIC_CODES,
    HARD_BREAK_SENTINEL,
    astToLegacyBlocks,
    blockToPlainText,
    blockToSearchableText,
    escapeHtml,
    firstParagraphText,
    formatDisplayText,
    legacyBlocksToAst,
    normalizeSource,
    parseDocument,
    parseInline,
    renderBlocks,
    renderDocument,
    serializeBlocks,
    serializeDocument,
    toPlainText,
    toSearchableText,
    validateDocument,
    withoutLeadingHeadings,
    wordCount,
  });
});
