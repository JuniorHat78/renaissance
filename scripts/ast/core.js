// Renaissance AST — core (shipped to the browser).
//
// The shared spine and every consume-side projection: type constants, escaping,
// passage records, searchable-text and legacy projections, plus normalizeAstInput.
// It never tokenizes text — turning a string or legacy blocks into an AST is
// delegated to a parser registered by ast/parse.js (absent in the browser, where
// the reader only ever hands in already-parsed ASTs). Loaded first in the browser
// shells; in Node it is folded into ast/index.js. See docs/specs/AST-COMPILER.md.
(function initRenaissanceAstCore(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RenaissanceAst = Object.assign(root.RenaissanceAst || {}, factory());
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function buildRenaissanceAstCore() {
  "use strict";

  const VERSION = "0.2.0";

  const HARD_BREAK_SENTINEL = "\x01";

  const MAX_INLINE_DEPTH = 12;

  const BLOCK_TYPES = Object.freeze({
    DOCUMENT: "document",
    HEADING: "heading",
    PARAGRAPH: "paragraph",
    PULL_QUOTE: "pull_quote",
    BLOCK_QUOTE: "blockquote",
    LIST: "list",
    LIST_ITEM: "list_item",
    DIVIDER: "divider",
  });

  const INLINE_TYPES = Object.freeze({
    TEXT: "text",
    EMPHASIS: "emphasis",
    STRONG: "strong",
    CODE: "code",
    LINK: "link",
    HARD_BREAK: "hard_break",
  });

  const BLOCK_TYPE_VALUES = Object.freeze(Object.keys(BLOCK_TYPES).map(function blockTypeValue(key) {
    return BLOCK_TYPES[key];
  }));

  const INLINE_TYPE_VALUES = Object.freeze(Object.keys(INLINE_TYPES).map(function inlineTypeValue(key) {
    return INLINE_TYPES[key];
  }));

  const DIAGNOSTIC_CODES = Object.freeze({
    BOM_REMOVED: "bom-removed",
    CRLF_NORMALIZED: "crlf-normalized",
    HEADING_LEVEL_CLAMPED: "heading-level-clamped",
    UNSAFE_LINK_URL: "unsafe-link-url",
    UNMATCHED_CODE_MARKER: "unmatched-code-marker",
    UNMATCHED_EMPHASIS_MARKER: "unmatched-emphasis-marker",
    UNMATCHED_STRONG_MARKER: "unmatched-strong-marker",
  });

  function createPassageContext() {
    return { passageIndex: 0 };
  }

  function isPassageBlock(block) {
    return block &&
      (
        block.type === BLOCK_TYPES.HEADING ||
        block.type === BLOCK_TYPES.PARAGRAPH ||
        block.type === BLOCK_TYPES.PULL_QUOTE ||
        block.type === BLOCK_TYPES.LIST_ITEM
      );
  }

  function passageRecordForBlock(block, context) {
    if (!isPassageBlock(block)) {
      return null;
    }

    const text = blockToSearchableText(block);
    if (!text) {
      return null;
    }

    context.passageIndex += 1;
    const position = block.position || {};
    return {
      passageId: "p" + String(context.passageIndex),
      passageIndex: context.passageIndex,
      blockType: block.type,
      text,
      sourceStart: Number.isFinite(Number(position.startOffset)) ? Number(position.startOffset) : null,
      sourceEnd: Number.isFinite(Number(position.endOffset)) ? Number(position.endOffset) : null,
      sourceLine: Number.isFinite(Number(position.line)) ? Number(position.line) : null,
    };
  }

  function isExternalLink(href) {
    return /^https?:\/\//i.test(String(href || ""));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function formatDisplayText(value) {
    return String(value).replace(/\s*\u2014\s*/g, "\u2009\u2014\u2009");
  }

  function withoutLeadingHeadings(input) {
    const ast = normalizeAstInput(input);
    const children = getBlockChildren(ast);
    let firstContentIndex = 0;

    while (firstContentIndex < children.length && children[firstContentIndex].type === BLOCK_TYPES.HEADING) {
      firstContentIndex += 1;
    }

    return Object.assign({}, ast, {
      children: children.slice(firstContentIndex),
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

  function passagesFromDocument(input) {
    const ast = normalizeAstInput(input);
    const context = createPassageContext();
    const passages = [];

    getBlockChildren(ast).forEach(function appendTopLevel(block) {
      appendPassageRecords(block, context, passages);
    });

    return passages;
  }

  function appendPassageRecords(block, context, passages) {
    if (!block) {
      return;
    }

    if (block.type === BLOCK_TYPES.BLOCK_QUOTE || block.type === BLOCK_TYPES.LIST) {
      (block.children || []).forEach(function appendChild(child) {
        appendPassageRecords(child, context, passages);
      });
      return;
    }

    const record = passageRecordForBlock(block, context);
    if (record) {
      passages.push(record);
    }
  }

  function blockToPlainText(block) {
    if (block.type === BLOCK_TYPES.DIVIDER) {
      return "";
    }

    if (block.type === BLOCK_TYPES.BLOCK_QUOTE) {
      return (block.children || []).map(blockToPlainText).filter(Boolean).join("\n");
    }

    if (block.type === BLOCK_TYPES.LIST) {
      return (block.children || []).map(blockToPlainText).filter(Boolean).join("\n");
    }

    return inlineToText(block.children || [], "\n");
  }

  function blockToSearchableText(block) {
    if (block.type === BLOCK_TYPES.DIVIDER) {
      return "";
    }

    if (block.type === BLOCK_TYPES.BLOCK_QUOTE || block.type === BLOCK_TYPES.LIST) {
      return normalizeWhitespace((block.children || []).map(blockToSearchableText).filter(Boolean).join(" "));
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

      if (node.type === INLINE_TYPES.STRONG || node.type === INLINE_TYPES.LINK) {
        return inlineToText(node.children || [], hardBreakValue);
      }

      if (node.type === INLINE_TYPES.CODE) {
        return node.value || "";
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        return hardBreakValue;
      }

      return "";
    }).join("");
  }

  function firstParagraphText(input) {
    const ast = normalizeAstInput(input);
    const paragraph = getBlockChildren(ast).find(function findParagraph(block) {
      return block.type === BLOCK_TYPES.PARAGRAPH || block.type === BLOCK_TYPES.PULL_QUOTE;
    });

    return paragraph ? blockToSearchableText(paragraph) : "";
  }

  function astToLegacyBlocks(input) {
    const ast = normalizeAstInput(input);
    const blocks = [];

    getBlockChildren(ast).forEach(function convert(block) {
      appendLegacyBlock(blocks, block);
    });

    return blocks;
  }

  function appendLegacyBlock(target, block) {
      if (block.type === BLOCK_TYPES.HEADING) {
        target.push({
          type: "h" + clampHeadingLevel(block.level),
          text: inlineToLegacyText(block.children || []),
        });
        return;
      }

      if (block.type === BLOCK_TYPES.PULL_QUOTE) {
        target.push({
          type: "p",
          text: inlineToLegacyText(block.children || []),
          pullQuote: true,
        });
        return;
      }

      if (block.type === BLOCK_TYPES.PARAGRAPH) {
        target.push({
          type: "p",
          text: inlineToLegacyText(block.children || []),
        });
        return;
      }

      if (block.type === BLOCK_TYPES.BLOCK_QUOTE) {
        (block.children || []).forEach(function appendQuoteChild(child) {
          target.push({
            type: "p",
            text: "> " + blockToPlainText(child),
          });
        });
        return;
      }

      if (block.type === BLOCK_TYPES.LIST) {
        (block.children || []).forEach(function appendListItem(item, index) {
          const marker = block.ordered ? String(index + 1) + ". " : "- ";
          target.push({
            type: "p",
            text: marker + inlineToLegacyText(item.children || []),
          });
        });
        return;
      }

      if (block.type === BLOCK_TYPES.LIST_ITEM) {
        target.push({
          type: "p",
          text: inlineToLegacyText(block.children || []),
        });
        return;
      }

      if (block.type === BLOCK_TYPES.DIVIDER) {
        target.push({ type: "hr" });
        return;
      }

      throw new Error("Unsupported block type: " + block.type);
  }

  function inlineToLegacyText(nodes) {
    return nodes.map(function legacyText(node) {
      if (node.type === INLINE_TYPES.TEXT) {
        return node.value;
      }

      if (node.type === INLINE_TYPES.EMPHASIS) {
        return "*" + inlineToLegacyText(node.children || []) + "*";
      }

      if (node.type === INLINE_TYPES.STRONG) {
        return "**" + inlineToLegacyText(node.children || []) + "**";
      }

      if (node.type === INLINE_TYPES.CODE) {
        return "`" + (node.value || "") + "`";
      }

      if (node.type === INLINE_TYPES.LINK) {
        return "[" + inlineToLegacyText(node.children || []) + "](" + (node.href || "") + ")";
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        return HARD_BREAK_SENTINEL;
      }

      return "";
    }).join("");
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

  function isLegacyBlock(block) {
    return !block || typeof block.type !== "string" || /^h[1-6]$/.test(block.type) || block.type === "p" || block.type === "hr";
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

  let stringParser = null;
  let legacyConverter = null;

  // parse.js registers these at load. They stay null in the browser (parse.js
  // is not shipped) — normalizeAstInput then only accepts already-parsed ASTs,
  // which is exactly the reader's contract. A string/legacy input in the
  // browser is a programming error and fails loudly.
  function registerStringParser(fn) {
    stringParser = fn;
  }

  function registerLegacyConverter(fn) {
    legacyConverter = fn;
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
        if (!legacyConverter) {
          throw new Error("RenaissanceAst: legacy block input requires the parser (ast/parse.js), which is not loaded.");
        }
        return legacyConverter(input);
      }

      return Object.assign(createEmptyDocument(), { children: input });
    }

    if (typeof input === "string") {
      if (!stringParser) {
        throw new Error("RenaissanceAst: string input requires the parser (ast/parse.js), which is not loaded.");
      }
      return stringParser(input);
    }

    if (input.type) {
      return Object.assign(createEmptyDocument(), { children: [input] });
    }

    return createEmptyDocument();
  }

  return {
    VERSION,
    HARD_BREAK_SENTINEL,
    MAX_INLINE_DEPTH,
    BLOCK_TYPES,
    INLINE_TYPES,
    BLOCK_TYPE_VALUES,
    INLINE_TYPE_VALUES,
    DIAGNOSTIC_CODES,
    createPassageContext,
    isPassageBlock,
    passageRecordForBlock,
    isExternalLink,
    escapeHtml,
    escapeAttribute,
    formatDisplayText,
    withoutLeadingHeadings,
    toPlainText,
    toSearchableText,
    passagesFromDocument,
    appendPassageRecords,
    blockToPlainText,
    blockToSearchableText,
    inlineToText,
    firstParagraphText,
    astToLegacyBlocks,
    appendLegacyBlock,
    inlineToLegacyText,
    getBlockChildren,
    createEmptyDocument,
    isLegacyBlock,
    clampHeadingLevel,
    normalizeWhitespace,
    wordCount,
    normalizeAstInput,
    registerStringParser,
    registerLegacyConverter,
  };
});
