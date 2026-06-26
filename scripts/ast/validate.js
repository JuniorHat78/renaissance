// Renaissance AST — validate (NODE / BUILD-TIME ONLY; never shipped to the browser).
//
// Pure AST invariant checking: an already-parsed document in, structured errors
// out. It does NOT tokenize text, so it is not part of the parser the Rust core
// replaces — it survives the parse.js cutover (SCRIPTORIUM-RUST-PARSER.md §14.3)
// and is folded into ast/index.js in Node. The browser never loads it: the reader
// trusts its hydrated AST and does not validate at runtime. Moved verbatim out of
// the retired parse.js (same codes, same paths). See docs/specs/AST-COMPILER.md.
"use strict";

const core = require("./core.js");

const {
  BLOCK_TYPES,
  INLINE_TYPES,
  BLOCK_TYPE_VALUES,
  INLINE_TYPE_VALUES,
  normalizeAstInput,
} = core;

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

function isSafeLinkUrl(url) {
  const href = String(url || "").trim();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!href || /[ -<>]/.test(href)) {
    return false;
  }

  if (!schemeMatch) {
    return true;
  }

  return ["http", "https", "mailto", "tel"].includes(schemeMatch[1].toLowerCase());
}

function createValidationError(code, path, message) {
  return { code, severity: "error", path, message };
}

module.exports = { validateDocument };
