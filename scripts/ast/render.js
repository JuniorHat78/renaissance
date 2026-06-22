// Renaissance AST — render (shipped to the browser).
//
// The DOM renderer and the HTML serializer. Consume-only: it turns a content AST
// into elements (or an HTML string) and never tokenizes text. Depends on core for
// constants, helpers, normalizeAstInput, and passage numbering. Loaded after
// core.js in the browser; in Node it is folded into ast/index.js.
// See docs/specs/AST-COMPILER.md.
(function initRenaissanceAstRender(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else {
    root.RenaissanceAst = Object.assign(root.RenaissanceAst || {}, factory(root.RenaissanceAst));
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function buildRenaissanceAstRender(core) {
  "use strict";

  const {
    BLOCK_TYPES,
    INLINE_TYPES,
    createPassageContext,
    passageRecordForBlock,
    isExternalLink,
    escapeHtml,
    escapeAttribute,
    formatDisplayText,
    getBlockChildren,
    clampHeadingLevel,
    normalizeAstInput,
  } = core;

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

  return {
    renderDocument,
    renderBlocks,
    serializeDocument,
    serializeBlocks,
  };
});
