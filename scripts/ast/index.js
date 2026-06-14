(function initRenaissanceAst(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.RenaissanceAst = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function buildRenaissanceAst() {
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
    const sourceText = normalized.value;
    const lines = sourceText.split("\n");
    const lineOffsets = computeLineOffsets(sourceText);
    const diagnostics = normalized.diagnostics.slice();
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

      const blockQuoteLine = parseBlockQuoteLine(line, lineNumber, offset);
      if (blockQuoteLine) {
        flushParagraph();
        const quoteLines = [];
        while (index < lines.length) {
          const currentLine = parseBlockQuoteLine(lines[index], index + 1, lineOffsets[index]);
          if (!currentLine) {
            break;
          }
          quoteLines.push(currentLine);
          index += 1;
        }
        index -= 1;
        blocks.push(createBlockQuote(quoteLines, diagnostics));
        continue;
      }

      const listLine = parseListLine(line, lineNumber, offset);
      if (listLine) {
        flushParagraph();
        const listLines = [];
        const ordered = listLine.ordered;
        while (index < lines.length) {
          const currentLine = parseListLine(lines[index], index + 1, lineOffsets[index]);
          if (!currentLine || currentLine.ordered !== ordered) {
            break;
          }
          listLines.push(currentLine);
          index += 1;
        }
        index -= 1;
        blocks.push(createList(listLines, ordered, diagnostics));
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
      diagnostics: diagnostics.map(function addPosition(diagnostic) {
        return attachDiagnosticPosition(diagnostic, lineOffsets);
      }),
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

  function parseBlockQuoteLine(line, lineNumber, offset) {
    const match = /^(\s*)>\s?(.*)$/.exec(line);
    if (!match) {
      return null;
    }

    const markerLength = match[1].length + 1 + (line[match[1].length + 1] === " " ? 1 : 0);
    return createParagraphLine(match[2], lineNumber, offset + markerLength);
  }

  function parseListLine(line, lineNumber, offset) {
    const match = /^(\s*)((?:[-+]|\d+[.)])\s+)(.+?)\s*$/.exec(line);
    if (!match) {
      return null;
    }

    const marker = match[2];
    const text = match[3];
    const markerStart = match[1].length;
    const textOffset = offset + markerStart + marker.length;
    return {
      ordered: /^\d/.test(marker),
      text,
      lineNumber,
      offset: textOffset,
      sourceOffset: offset,
      sourceLength: line.length,
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

  function createBlockQuote(lines, diagnostics) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    return {
      type: BLOCK_TYPES.BLOCK_QUOTE,
      children: [createParagraph(lines, diagnostics)],
      position: createPosition(first.lineNumber, first.offset, last.offset + last.sourceLength),
    };
  }

  function createList(lines, ordered, diagnostics) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    return {
      type: BLOCK_TYPES.LIST,
      ordered: Boolean(ordered),
      children: lines.map(function createItem(line) {
        return createListItem(line, diagnostics);
      }),
      position: createPosition(first.lineNumber, first.sourceOffset, last.sourceOffset + last.sourceLength),
    };
  }

  function createListItem(line, diagnostics) {
    return {
      type: BLOCK_TYPES.LIST_ITEM,
      children: parseInline(line.text, line.offset, diagnostics),
      position: createPosition(line.lineNumber, line.offset, line.sourceOffset + line.sourceLength),
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

      if (node.type === INLINE_TYPES.EMPHASIS || node.type === INLINE_TYPES.STRONG) {
        appendInlineNode(normalized, {
          type: node.type,
          children: normalizeInlineSeparators(node.children || []),
        });
        return;
      }

      if (node.type === INLINE_TYPES.LINK) {
        appendInlineNode(normalized, {
          type: INLINE_TYPES.LINK,
          href: node.href,
          children: normalizeInlineSeparators(node.children || []),
        });
        return;
      }

      if (node.type === INLINE_TYPES.CODE) {
        appendInlineNode(normalized, {
          type: INLINE_TYPES.CODE,
          value: normalizeInlineCodeText(node.value),
        });
        return;
      }

      appendInlineNode(normalized, node);
    });

    return normalized;
  }

  function normalizeInlineCodeText(value) {
    return String(value).replace(new RegExp(HARD_BREAK_SENTINEL + "\n", "g"), "\n").replace(/\s+/g, " ");
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

  function parseInline(input, baseOffset, diagnostics, depth, suppressUnmatchedDiagnostics) {
    const text = input == null ? "" : String(input);
    const nodes = [];
    const inlineDepth = Number(depth) || 0;
    let cursor = 0;

    while (cursor < text.length) {
      const char = text[cursor];

      if (char === "`") {
        const closeIndex = text.indexOf("`", cursor + 1);
        if (closeIndex === -1) {
          appendText(nodes, char);
          if (!suppressUnmatchedDiagnostics) {
            diagnostics.push(createDiagnostic(
              DIAGNOSTIC_CODES.UNMATCHED_CODE_MARKER,
              "Treating unmatched code marker as literal text.",
              baseOffset + cursor
            ));
          }
          cursor += 1;
          continue;
        }

        appendInlineNode(nodes, {
          type: INLINE_TYPES.CODE,
          value: text.slice(cursor + 1, closeIndex),
        });
        cursor = closeIndex + 1;
        continue;
      }

      if (char === "[") {
        const link = parseLinkToken(text, cursor);
        if (!link) {
          appendText(nodes, char);
          cursor += 1;
          continue;
        }

        if (!isSafeLinkUrl(link.href)) {
          appendText(nodes, text.slice(cursor, link.endIndex));
          diagnostics.push(createDiagnostic(
            DIAGNOSTIC_CODES.UNSAFE_LINK_URL,
            "Treating unsafe link URL as literal text.",
            baseOffset + link.hrefOffset,
            { href: link.href }
          ));
          cursor = link.endIndex;
          continue;
        }

        appendInlineNode(nodes, {
          type: INLINE_TYPES.LINK,
          href: link.href,
          children: parseInlineChildren(link.label, baseOffset + cursor + 1, diagnostics, inlineDepth),
        });
        cursor = link.endIndex;
        continue;
      }

      if (char === "*" && text[cursor + 1] === "*") {
        if (!canOpenStrong(text, cursor)) {
          appendText(nodes, "*");
          cursor += 1;
          continue;
        }

        const closeIndex = findClosingStrong(text, cursor + 2);
        if (closeIndex === -1) {
          appendText(nodes, "**");
          if (!suppressUnmatchedDiagnostics) {
            diagnostics.push(createDiagnostic(
              DIAGNOSTIC_CODES.UNMATCHED_STRONG_MARKER,
              "Treating unmatched strong marker as literal text.",
              baseOffset + cursor
            ));
          }
          cursor += 2;
          continue;
        }

        appendInlineNode(nodes, {
          type: INLINE_TYPES.STRONG,
          children: parseInlineChildren(text.slice(cursor + 2, closeIndex), baseOffset + cursor + 2, diagnostics, inlineDepth),
        });
        cursor = closeIndex + 2;
        continue;
      }

      if (char === "*") {
        if (!canOpenEmphasis(text, cursor)) {
          appendText(nodes, char);
          cursor += 1;
          continue;
        }

        const closeIndex = findClosingEmphasis(text, cursor + 1);
        if (closeIndex === -1) {
          appendText(nodes, char);
          if (!suppressUnmatchedDiagnostics) {
            diagnostics.push(createDiagnostic(
              DIAGNOSTIC_CODES.UNMATCHED_EMPHASIS_MARKER,
              "Treating unmatched emphasis marker as literal text.",
              baseOffset + cursor
            ));
          }
          cursor += 1;
          continue;
        }

        appendInlineNode(nodes, {
          type: INLINE_TYPES.EMPHASIS,
          children: parseInlineChildren(text.slice(cursor + 1, closeIndex), baseOffset + cursor + 1, diagnostics, inlineDepth),
        });
        cursor = closeIndex + 1;
        continue;
      }

      appendText(nodes, char);
      cursor += 1;
    }

    return nodes;
  }

  function parseInlineChildren(text, baseOffset, diagnostics, depth) {
    if (depth >= MAX_INLINE_DEPTH) {
      return text ? [{ type: INLINE_TYPES.TEXT, value: text }] : [];
    }

    return parseInline(text, baseOffset, diagnostics, depth + 1, true);
  }

  function parseLinkToken(text, openIndex) {
    const labelEnd = text.indexOf("](", openIndex + 1);
    if (labelEnd === -1 || labelEnd === openIndex + 1) {
      return null;
    }

    const hrefStart = labelEnd + 2;
    const hrefEnd = text.indexOf(")", hrefStart);
    if (hrefEnd === -1 || hrefEnd === hrefStart) {
      return null;
    }

    return {
      label: text.slice(openIndex + 1, labelEnd),
      href: text.slice(hrefStart, hrefEnd).trim(),
      hrefOffset: hrefStart,
      endIndex: hrefEnd + 1,
    };
  }

  function isSafeLinkUrl(url) {
    const href = String(url || "").trim();
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    if (!href || /[\u0000-\u001f<>]/.test(href)) {
      return false;
    }

    if (!schemeMatch) {
      return true;
    }

    return ["http", "https", "mailto", "tel"].includes(schemeMatch[1].toLowerCase());
  }

  function findClosingStrong(text, start) {
    for (let index = start; index < text.length - 1; index += 1) {
      if (text[index] !== "*" || text[index + 1] !== "*") {
        continue;
      }

      if (canCloseStrong(text, index)) {
        return index;
      }
    }

    return -1;
  }

  function canOpenStrong(text, index) {
    const previous = index > 0 ? text[index - 1] : "";
    const next = index < text.length - 2 ? text[index + 2] : "";

    if (!next || isWhitespace(next) || next === "*") {
      return false;
    }

    return !previous || isWhitespace(previous) || isOpeningBoundary(previous);
  }

  function canCloseStrong(text, index) {
    const previous = index > 0 ? text[index - 1] : "";
    const next = index < text.length - 2 ? text[index + 2] : "";

    if (!previous || isWhitespace(previous) || previous === "*") {
      return false;
    }

    return !next || isWhitespace(next) || isClosingBoundary(next);
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

    const context = createPassageContext();
    getBlockChildren(ast).forEach(function renderBlockNode(block) {
      container.appendChild(createBlockElement(container.ownerDocument, block, context));
    });

    return container;
  }

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

  function applyPassageAttributes(element, block, context) {
    const record = passageRecordForBlock(block, context);
    if (!record) {
      return null;
    }

    setDomAttribute(element, "data-passage-id", record.passageId);
    setDomAttribute(element, "data-passage-index", String(record.passageIndex));
    setDomAttribute(element, "data-passage-type", record.blockType);
    if (record.sourceStart !== null) {
      setDomAttribute(element, "data-source-start", String(record.sourceStart));
    }
    if (record.sourceEnd !== null) {
      setDomAttribute(element, "data-source-end", String(record.sourceEnd));
    }
    return record;
  }

  function createBlockElement(documentRef, block, context) {
    const passageContext = context || createPassageContext();
    if (block.type === BLOCK_TYPES.HEADING) {
      const level = clampHeadingLevel(block.level);
      const element = documentRef.createElement("h" + level);
      appendInlineDom(documentRef, element, block.children || []);
      applyPassageAttributes(element, block, passageContext);
      return element;
    }

    if (block.type === BLOCK_TYPES.PULL_QUOTE) {
      const element = documentRef.createElement("p");
      element.className = "pull-quote";
      appendInlineDom(documentRef, element, block.children || []);
      applyPassageAttributes(element, block, passageContext);
      return element;
    }

    if (block.type === BLOCK_TYPES.PARAGRAPH) {
      const element = documentRef.createElement("p");
      appendInlineDom(documentRef, element, block.children || []);
      applyPassageAttributes(element, block, passageContext);
      return element;
    }

    if (block.type === BLOCK_TYPES.BLOCK_QUOTE) {
      const element = documentRef.createElement("blockquote");
      (block.children || []).forEach(function appendQuoteBlock(child) {
        element.appendChild(createBlockElement(documentRef, child, passageContext));
      });
      return element;
    }

    if (block.type === BLOCK_TYPES.LIST) {
      const element = documentRef.createElement(block.ordered ? "ol" : "ul");
      (block.children || []).forEach(function appendListItem(item) {
        element.appendChild(createBlockElement(documentRef, item, passageContext));
      });
      return element;
    }

    if (block.type === BLOCK_TYPES.LIST_ITEM) {
      const element = documentRef.createElement("li");
      appendInlineDom(documentRef, element, block.children || []);
      applyPassageAttributes(element, block, passageContext);
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

      if (node.type === INLINE_TYPES.STRONG) {
        const element = documentRef.createElement("strong");
        appendInlineDom(documentRef, element, node.children || []);
        parent.appendChild(element);
        return;
      }

      if (node.type === INLINE_TYPES.CODE) {
        const element = documentRef.createElement("code");
        element.appendChild(documentRef.createTextNode(node.value || ""));
        parent.appendChild(element);
        return;
      }

      if (node.type === INLINE_TYPES.LINK) {
        const element = documentRef.createElement("a");
        setDomAttribute(element, "href", node.href || "#");
        if (isExternalLink(node.href)) {
          setDomAttribute(element, "rel", "noopener noreferrer");
        }
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

  function setDomAttribute(element, name, value) {
    if (element && typeof element.setAttribute === "function") {
      element.setAttribute(name, value);
      return;
    }

    element[name] = value;
  }

  function isExternalLink(href) {
    return /^https?:\/\//i.test(String(href || ""));
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

    if (block.type === BLOCK_TYPES.BLOCK_QUOTE) {
      return "<blockquote>" + (block.children || []).map(serializeBlock).join("") + "</blockquote>";
    }

    if (block.type === BLOCK_TYPES.LIST) {
      const tag = block.ordered ? "ol" : "ul";
      return "<" + tag + ">" + (block.children || []).map(serializeBlock).join("") + "</" + tag + ">";
    }

    if (block.type === BLOCK_TYPES.LIST_ITEM) {
      return "<li>" + serializeInline(block.children || []) + "</li>";
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

      if (node.type === INLINE_TYPES.STRONG) {
        return "<strong>" + serializeInline(node.children || []) + "</strong>";
      }

      if (node.type === INLINE_TYPES.CODE) {
        return "<code>" + escapeHtml(node.value || "") + "</code>";
      }

      if (node.type === INLINE_TYPES.LINK) {
        return '<a href="' + escapeAttribute(node.href || "#") + '">' + serializeInline(node.children || []) + "</a>";
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

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function formatDisplayText(value) {
    return String(value).replace(/\s*\u2014\s*/g, "\u2009\u2014\u2009");
  }

  function validateDocument(input) {
    const ast = normalizeAstInput(input);
    const errors = [];

    if (!ast || ast.type !== BLOCK_TYPES.DOCUMENT) {
      errors.push(createValidationError("invalid-document-root", "document.type", "Root node must be a document."));
      return errors;
    }

    if (!Array.isArray(ast.children)) {
      errors.push(createValidationError("invalid-document-children", "document.children", "Document children must be an array."));
      return errors;
    }

    ast.children.forEach(function validateBlock(block, index) {
      const path = "document.children[" + index + "]";
      if (!block || typeof block !== "object") {
        errors.push(createValidationError("invalid-block", path, "Block must be an object."));
        return;
      }

      if (!BLOCK_TYPE_VALUES.includes(block.type)) {
        errors.push(createValidationError("unknown-block-type", path + ".type", "Unknown block type: " + block.type));
        return;
      }

      if (block.type === BLOCK_TYPES.HEADING) {
        if (!Number.isFinite(Number(block.level)) || block.level < 1 || block.level > 3) {
          errors.push(createValidationError("invalid-heading-level", path + ".level", "Heading level must be between 1 and 3."));
        }
      }

      validatePosition(block.position, path + ".position", errors);

      if (block.type === BLOCK_TYPES.BLOCK_QUOTE) {
        validateBlockChildren(block.children, path + ".children", errors);
        return;
      }

      if (block.type === BLOCK_TYPES.LIST) {
        if (typeof block.ordered !== "boolean") {
          errors.push(createValidationError("invalid-list-ordered", path + ".ordered", "List ordered flag must be a boolean."));
        }
        validateListItems(block.children, path + ".children", errors);
        return;
      }

      if (block.type === BLOCK_TYPES.LIST_ITEM) {
        validateInline(block.children, path + ".children", errors);
        return;
      }

      if (block.type === BLOCK_TYPES.DIVIDER) {
        if (block.children !== undefined) {
          errors.push(createValidationError("divider-children", path + ".children", "Divider blocks must not have inline children."));
        }
        return;
      }

      validateInline(block.children, path + ".children", errors);
    });

    return errors;
  }

  function validateBlockChildren(children, path, errors) {
    if (!Array.isArray(children)) {
      errors.push(createValidationError("invalid-block-children", path, "Block children must be an array."));
      return;
    }

    children.forEach(function validateChildBlock(block, index) {
      const childPath = path + "[" + index + "]";
      if (!block || typeof block !== "object") {
        errors.push(createValidationError("invalid-block", childPath, "Block must be an object."));
        return;
      }

      if (!BLOCK_TYPE_VALUES.includes(block.type)) {
        errors.push(createValidationError("unknown-block-type", childPath + ".type", "Unknown block type: " + block.type));
        return;
      }

      if (block.type === BLOCK_TYPES.DIVIDER) {
        errors.push(createValidationError("invalid-nested-divider", childPath, "Divider blocks are not valid inside nested block containers."));
        return;
      }

      validatePosition(block.position, childPath + ".position", errors);

      if (block.type === BLOCK_TYPES.BLOCK_QUOTE) {
        validateBlockChildren(block.children, childPath + ".children", errors);
        return;
      }

      if (block.type === BLOCK_TYPES.LIST) {
        if (typeof block.ordered !== "boolean") {
          errors.push(createValidationError("invalid-list-ordered", childPath + ".ordered", "List ordered flag must be a boolean."));
        }
        validateListItems(block.children, childPath + ".children", errors);
        return;
      }

      if (block.type === BLOCK_TYPES.LIST_ITEM) {
        validateInline(block.children, childPath + ".children", errors);
        return;
      }

      if (block.type === BLOCK_TYPES.HEADING) {
        if (!Number.isFinite(Number(block.level)) || block.level < 1 || block.level > 3) {
          errors.push(createValidationError("invalid-heading-level", childPath + ".level", "Heading level must be between 1 and 3."));
        }
      }

      validateInline(block.children, childPath + ".children", errors);
    });
  }

  function validateListItems(children, path, errors) {
    if (!Array.isArray(children)) {
      errors.push(createValidationError("invalid-list-items", path, "List children must be list item nodes."));
      return;
    }

    children.forEach(function validateItem(item, index) {
      const itemPath = path + "[" + index + "]";
      if (!item || item.type !== BLOCK_TYPES.LIST_ITEM) {
        errors.push(createValidationError("invalid-list-item", itemPath, "List children must be list item nodes."));
        return;
      }
      validatePosition(item.position, itemPath + ".position", errors);
      validateInline(item.children, itemPath + ".children", errors);
    });
  }

  function validatePosition(position, path, errors) {
    if (position === undefined) {
      return;
    }

    if (!position || typeof position !== "object") {
      errors.push(createValidationError("invalid-position", path, "Position must be an object when present."));
      return;
    }

    const line = Number(position.line);
    const startOffset = Number(position.startOffset);
    const endOffset = Number(position.endOffset);
    if (!Number.isFinite(line) || line < 1) {
      errors.push(createValidationError("invalid-position-line", path + ".line", "Position line must be a positive number."));
    }
    if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset < startOffset) {
      errors.push(createValidationError("invalid-position-range", path, "Position offsets must be finite and ordered."));
    }
  }

  function validateInline(nodes, path, errors) {
    if (!Array.isArray(nodes)) {
        errors.push(createValidationError("invalid-inline-children", path, "Inline children must be an array."));
      return;
    }

    nodes.forEach(function validateNode(node, index) {
      const nodePath = path + "[" + index + "]";
      if (!node || typeof node !== "object") {
        errors.push(createValidationError("invalid-inline-node", nodePath, "Inline node must be an object."));
        return;
      }

      if (!INLINE_TYPE_VALUES.includes(node.type)) {
        errors.push(createValidationError("unknown-inline-type", nodePath + ".type", "Unknown inline type: " + node.type));
        return;
      }

      if (node.type === INLINE_TYPES.TEXT) {
        if (typeof node.value !== "string") {
          errors.push(createValidationError("invalid-text-value", nodePath + ".value", "Text nodes require a string value."));
        } else if (node.value.length === 0) {
          errors.push(createValidationError("empty-text-value", nodePath + ".value", "Text nodes should not be empty."));
        }
        return;
      }

      if (node.type === INLINE_TYPES.EMPHASIS || node.type === INLINE_TYPES.STRONG) {
        validateInline(node.children, nodePath + ".children", errors);
        return;
      }

      if (node.type === INLINE_TYPES.CODE) {
        if (typeof node.value !== "string") {
          errors.push(createValidationError("invalid-code-value", nodePath + ".value", "Code nodes require a string value."));
        }
        if (node.children !== undefined) {
          errors.push(createValidationError("invalid-code-children", nodePath + ".children", "Code nodes must not have inline children."));
        }
        return;
      }

      if (node.type === INLINE_TYPES.LINK) {
        if (typeof node.href !== "string" || !isSafeLinkUrl(node.href)) {
          errors.push(createValidationError("invalid-link-href", nodePath + ".href", "Link href must be a safe URL string."));
        }
        validateInline(node.children, nodePath + ".children", errors);
        return;
      }

      if (node.type === INLINE_TYPES.HARD_BREAK) {
        if (node.children !== undefined || node.value !== undefined) {
          errors.push(createValidationError("invalid-hard-break", nodePath, "Hard break nodes must not carry text or children."));
        }
        return;
      }
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
    const paragraph = ast.children.find(function findParagraph(block) {
      return block.type === BLOCK_TYPES.PARAGRAPH || block.type === BLOCK_TYPES.PULL_QUOTE;
    });

    return paragraph ? blockToSearchableText(paragraph) : "";
  }

  function astToLegacyBlocks(input) {
    const ast = normalizeAstInput(input);
    const blocks = [];

    ast.children.forEach(function convert(block) {
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

  function createDiagnostic(code, message, offset, details, severity) {
    return {
      code,
      severity: severity || "info",
      message,
      offset,
      details: details || {},
    };
  }

  function attachDiagnosticPosition(diagnostic, lineOffsets) {
    if (!diagnostic || diagnostic.position) {
      return diagnostic;
    }

    return Object.assign({}, diagnostic, {
      position: positionAtOffset(diagnostic.offset || 0, lineOffsets),
    });
  }

  function positionAtOffset(offset, lineOffsets) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    let lineIndex = 0;

    for (let index = 0; index < lineOffsets.length; index += 1) {
      if (lineOffsets[index] > safeOffset) {
        break;
      }
      lineIndex = index;
    }

    return {
      line: lineIndex + 1,
      column: safeOffset - lineOffsets[lineIndex] + 1,
    };
  }

  function createValidationError(code, path, message) {
    return { code, severity: "error", path, message };
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
    return /[\s)\]}.!?",'<>:;\-]/.test(value);
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
    passagesFromDocument,
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
