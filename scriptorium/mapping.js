// Scriptorium — the source↔preview mapping (PURE; no DOM, no parser).
//
// The single piece of knowledge under the structural layer
// (SCRIPTORIUM-EDITOR.md §2): given the last parse, which block owns a source
// offset, and where in the source a block lives. Read one way it powers
// caret→highlight; the other, click→caret and command targeting. Built once
// here, pure and Node-testable; editor.js does the DOM wiring on top.
//
// Coordinate contract (§3.1): every offset is an index into the FULL raw buffer
// string, in UTF-16 code units — the exact unit textarea.setSelectionRange
// consumes. No translation layer exists or is needed; that identity is the
// keystone. Dual-mode like the AST modules: a browser global and a Node export.
(function initScriptoriumMapping(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScriptoriumMapping = Object.assign(root.ScriptoriumMapping || {}, factory());
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function buildScriptoriumMapping() {
  "use strict";

  // The block types render.js stamps data-source-start/end on (mirrors
  // core.isPassageBlock). These are exactly the blocks with a matching preview
  // element to highlight or jump to.
  var PASSAGE_TYPES = { heading: true, paragraph: true, pull_quote: true, list_item: true };

  // Containers whose children carry their own passage positions. We descend into
  // them when flattening the passage list (a blockquote's inner paragraph, a
  // list's items) so the flattened order matches the preview DOM order. The
  // containers themselves are unaddressable in the DOM (§3) but DO carry a
  // position, so they still appear in the top-level (command) index.
  var CONTAINER_TYPES = { blockquote: true, list: true };

  function offsetsOf(block) {
    var pos = block && block.position;
    if (!pos) {
      return null;
    }
    var start = Number(pos.startOffset);
    var end = Number(pos.endOffset);
    if (!isFinite(start) || !isFinite(end) || end < start) {
      return null;
    }
    return { start: start, end: end };
  }

  function entryFor(block, span) {
    return {
      start: span.start,
      end: span.end,
      type: block.type,
      level: typeof block.level === "number" ? block.level : null,
      ordered: block.type === "list" ? !!block.ordered : null,
    };
  }

  function byStart(a, b) {
    return a.start - b.start;
  }

  // Top-level blocks in document order, each with a source span. Every top-level
  // block carries a position (divider included), so this is the complete command
  // target set — "which block is the caret in" for block commands. (commandIndex
  // in the spec.)
  function indexTopLevel(ast) {
    var children = (ast && Array.isArray(ast.children)) ? ast.children : [];
    var out = [];
    for (var i = 0; i < children.length; i++) {
      var span = offsetsOf(children[i]);
      if (span) {
        out.push(entryFor(children[i], span));
      }
    }
    out.sort(byStart);
    return out;
  }

  // Flattened passage blocks in document order — exactly the blocks that get a
  // data-source-start element in the preview. Used for caret→highlight and
  // click→caret. (highlightIndex in the spec.)
  function indexPassages(ast) {
    var out = [];
    collectPassages((ast && Array.isArray(ast.children)) ? ast.children : [], out);
    out.sort(byStart);
    return out;
  }

  function collectPassages(blocks, out) {
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (PASSAGE_TYPES[block.type]) {
        var span = offsetsOf(block);
        if (span) {
          out.push(entryFor(block, span));
        }
        continue;
      }
      if (CONTAINER_TYPES[block.type] && Array.isArray(block.children)) {
        collectPassages(block.children, out);
      }
    }
  }

  // The mapping read offset→block. `list` is a sorted array (top-level or
  // passages). Returns the entry whose [start, end) contains `offset`; failing
  // that, the nearest PRECEDING entry (gap + staleness honesty, §4.5); failing
  // that (offset before the first block), null. Binary search on `start`.
  function blockAtOffset(list, offset) {
    if (!Array.isArray(list) || !list.length) {
      return null;
    }
    var o = Number(offset);
    if (!isFinite(o)) {
      return null;
    }
    var lo = 0;
    var hi = list.length - 1;
    var ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].start <= o) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans === -1) {
      return null;
    }
    return list[ans];
  }

  // Build both indices from one parse — the shape editor.js holds per refresh.
  function indexDocument(ast) {
    return { blocks: indexTopLevel(ast), passages: indexPassages(ast) };
  }

  return {
    PASSAGE_TYPES: PASSAGE_TYPES,
    indexDocument: indexDocument,
    indexTopLevel: indexTopLevel,
    indexPassages: indexPassages,
    blockAtOffset: blockAtOffset,
  };
});
