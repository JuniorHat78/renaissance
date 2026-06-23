// Scriptorium — AST-aware commands (PURE; no DOM).
//
// Each command is a pure proposal over the buffer (SCRIPTORIUM-EDITOR.md §5.1):
//
//     apply(id, text, start, end, parseFn)
//       -> { ok, text, selectionStart, selectionEnd, reason }
//
// The spine, applied to editing (§5.2): a command never TRUSTS that the markup
// it inserts parses as intended — it CHECKS, through the one parse authority
// (parseFn, injected so this module forks nothing). It applies its candidate,
// re-parses, and asserts the intended node materialized (and that visible text
// was preserved, and no new error was introduced). If the oracle fails the
// command reverts with a reason — it may never leave the buffer in a state whose
// parse contradicts the author's intent. Dual-mode: a browser global + a Node
// export, requireable for the oracle tests.
(function initScriptoriumCommands(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScriptoriumCommands = Object.assign(root.ScriptoriumCommands || {}, factory());
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function buildScriptoriumCommands() {
  "use strict";

  var BLOCK_SET = {
    document: true, heading: true, paragraph: true, pull_quote: true,
    blockquote: true, list: true, list_item: true, divider: true,
  };

  // Inline marker specs (verified by the parser's real grammar via the oracle).
  var INLINE = {
    strong: { open: "**", close: "**", type: "strong" },
    emphasis: { open: "*", close: "*", type: "emphasis" },
    code: { open: "`", close: "`", type: "code" },
  };

  // Toolbar / keybinding metadata. editor.js renders + binds from this; `key`
  // documents the chord it wires (headings avoid Ctrl+1..3, which browsers eat
  // for tab-switching — see editor.js).
  var CATALOG = [
    { id: "strong", label: "B", title: "Bold", key: "Ctrl/Cmd+B" },
    { id: "emphasis", label: "I", title: "Italic", key: "Ctrl/Cmd+I" },
    { id: "code", label: "</>", title: "Code", key: "Ctrl/Cmd+`" },
    { id: "link", label: "link", title: "Link", key: "Ctrl/Cmd+K" },
    { id: "heading-1", label: "H1", title: "Heading 1", key: "Ctrl/Cmd+Alt+1" },
    { id: "heading-2", label: "H2", title: "Heading 2", key: "Ctrl/Cmd+Alt+2" },
    { id: "heading-3", label: "H3", title: "Heading 3", key: "Ctrl/Cmd+Alt+3" },
    { id: "heading-0", label: "¶", title: "Body text", key: "Ctrl/Cmd+Alt+0" },
    { id: "pull-quote", label: "PQ", title: "Pull-quote", key: "Ctrl/Cmd+Alt+Q" },
    { id: "blockquote", label: "›", title: "Blockquote", key: "Ctrl/Cmd+Alt+B" },
    { id: "divider", label: "—", title: "Divider", key: "Ctrl/Cmd+Alt+H" },
  ];

  // ----- AST projections used by the oracle (pure walks) --------------------

  function isBlock(node) {
    return !!(node && BLOCK_SET[node.type]);
  }

  // Visible text of an inline node (markers absorbed into structure). Used to
  // assert a formatting toggle preserves what the reader sees.
  function inlineText(node) {
    if (!node) {
      return "";
    }
    if (node.type === "text" || node.type === "code") {
      return node.value || "";
    }
    if (node.type === "hard_break") {
      return "";
    }
    if (Array.isArray(node.children)) {
      return node.children.map(inlineText).join("");
    }
    return "";
  }

  function blockText(block) {
    if (!block || block.type === "divider") {
      return "";
    }
    if (Array.isArray(block.children)) {
      return block.children
        .map(function part(child) { return isBlock(child) ? blockText(child) : inlineText(child); })
        .join("");
    }
    return "";
  }

  function plainText(ast) {
    var children = (ast && Array.isArray(ast.children)) ? ast.children : [];
    return children.map(blockText).join("\n");
  }

  function countInline(ast, type) {
    var n = 0;
    function visitInline(node) {
      if (!node) {
        return;
      }
      if (node.type === type) {
        n += 1;
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(visitInline);
      }
    }
    function visitBlock(block) {
      if (!block || !Array.isArray(block.children)) {
        return;
      }
      block.children.forEach(function each(child) {
        if (isBlock(child)) {
          visitBlock(child);
        } else {
          visitInline(child);
        }
      });
    }
    ((ast && ast.children) || []).forEach(visitBlock);
    return n;
  }

  function errorCount(ast) {
    var diags = (ast && Array.isArray(ast.diagnostics)) ? ast.diagnostics : [];
    return diags.filter(function isError(d) { return d && d.severity === "error"; }).length;
  }

  function topBlockAt(ast, offset) {
    var children = (ast && Array.isArray(ast.children)) ? ast.children : [];
    var found = null;
    for (var i = 0; i < children.length; i++) {
      var pos = children[i].position;
      if (pos && Number(pos.startOffset) <= offset && offset <= Number(pos.endOffset)) {
        found = children[i];
      }
    }
    return found;
  }

  // ----- result helpers -----------------------------------------------------

  function ok(text, selectionStart, selectionEnd) {
    return { ok: true, text: text, selectionStart: selectionStart, selectionEnd: selectionEnd, reason: "" };
  }

  function fail(reason) {
    return { ok: false, text: null, selectionStart: null, selectionEnd: null, reason: reason };
  }

  // ----- inline toggles -----------------------------------------------------

  function applyInline(spec, text, start, end, parseFn) {
    // Empty selection: insert the marker pair and place the caret between them
    // (§5.3). No oracle — there is no content to verify yet.
    if (start === end) {
      var inserted = text.slice(0, start) + spec.open + spec.close + text.slice(start);
      var caret = start + spec.open.length;
      return ok(inserted, caret, caret);
    }

    var before = parseFn(text);

    // Toggle OFF: the selection is exactly wrapped by the markers already.
    var wrappedBefore =
      start >= spec.open.length &&
      text.slice(start - spec.open.length, start) === spec.open &&
      text.slice(end, end + spec.close.length) === spec.close;

    if (wrappedBefore) {
      var unwrapped =
        text.slice(0, start - spec.open.length) +
        text.slice(start, end) +
        text.slice(end + spec.close.length);
      var us = start - spec.open.length;
      var ue = end - spec.open.length;
      var afterOff = parseFn(unwrapped);
      if (oracleInline(spec.type, before, afterOff, -1)) {
        return ok(unwrapped, us, ue);
      }
      return fail("Couldn't remove " + spec.type + " here.");
    }

    // Toggle ON: wrap the selection.
    var wrapped =
      text.slice(0, start) + spec.open + text.slice(start, end) + spec.close + text.slice(end);
    var ws = start + spec.open.length;
    var we = end + spec.open.length;
    var afterOn = parseFn(wrapped);
    if (oracleInline(spec.type, before, afterOn, 1)) {
      return ok(wrapped, ws, we);
    }
    return fail("Couldn't make that " + spec.type + " here — try selecting whole words.");
  }

  // The per-command oracle for inline formatting: the count of nodes of the
  // intended type changed by exactly `delta`, the visible text is unchanged
  // (markers were absorbed, not left literal), and no new parse error appeared.
  function oracleInline(type, before, after, delta) {
    return (
      countInline(after, type) === countInline(before, type) + delta &&
      plainText(after) === plainText(before) &&
      errorCount(after) <= errorCount(before)
    );
  }

  // ----- link ---------------------------------------------------------------

  function applyLink(text, start, end, parseFn) {
    var before = parseFn(text);
    var label = start === end ? "link text" : text.slice(start, end);
    var placeholder = "https://";
    var insert = "[" + label + "](" + placeholder + ")";
    var candidate = text.slice(0, start) + insert + text.slice(end);
    // Caret lands ON the URL placeholder so the author types over it (§5.3).
    var urlStart = start + 1 + label.length + 2; // past "[label]("
    var urlEnd = urlStart + placeholder.length;
    var after = parseFn(candidate);
    if (
      countInline(after, "link") === countInline(before, "link") + 1 &&
      errorCount(after) <= errorCount(before)
    ) {
      return ok(candidate, urlStart, urlEnd);
    }
    return fail("Couldn't insert a link here.");
  }

  // ----- heading ------------------------------------------------------------

  function applyHeading(level, text, start, parseFn) {
    var before = parseFn(text);
    var lineStart = text.lastIndexOf("\n", start - 1) + 1; // 0 if on the first line
    var lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    var line = text.slice(lineStart, lineEnd);
    var stripped = line.replace(/^#{1,6}[ \t]+/, "");
    var prefix = level > 0 ? new Array(level + 1).join("#") + " " : "";
    var newLine = prefix + stripped;
    var candidate = text.slice(0, lineStart) + newLine + text.slice(lineEnd);

    var delta = newLine.length - line.length;
    var caret = Math.max(lineStart, start + delta);

    // Oracle: the block at the line is now a heading of `level` (or a paragraph
    // when demoting to body, level 0).
    var after = parseFn(candidate);
    var block = topBlockAt(after, lineStart);
    if (errorCount(after) > errorCount(before)) {
      return fail("Couldn't change the heading here.");
    }
    if (level === 0) {
      if (block && block.type === "paragraph") {
        return ok(candidate, caret, caret);
      }
      return fail("Couldn't make this body text here.");
    }
    if (block && block.type === "heading" && Number(block.level) === level) {
      return ok(candidate, caret, caret);
    }
    return fail("Couldn't make this a heading here.");
  }

  // ----- block toggles (pull-quote / blockquote / divider) -----------------

  function countTopBlocks(ast, type) {
    var children = (ast && Array.isArray(ast.children)) ? ast.children : [];
    return children.filter(function is(b) { return b.type === type; }).length;
  }

  // Matching quote pairs the parser recognizes for a pull-quote (isPullQuoteText).
  var QUOTE_PAIRS = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]];

  function stripQuotes(text) {
    var t = text.trim();
    for (var i = 0; i < QUOTE_PAIRS.length; i++) {
      if (t.length >= 2 && t[0] === QUOTE_PAIRS[i][0] && t[t.length - 1] === QUOTE_PAIRS[i][1]) {
        return t.slice(1, -1);
      }
    }
    return t;
  }

  function blockSpan(block) {
    var pos = block && block.position;
    if (!pos) {
      return null;
    }
    return { start: Number(pos.startOffset), end: Number(pos.endOffset) };
  }

  // The full line range covering a block's span (from the start of the span's
  // first line to the end of its last line). Needed for line-prefix operations
  // like blockquote, whose content span EXCLUDES the '> ' marker.
  function blockLineSpan(text, span) {
    var start = text.lastIndexOf("\n", span.start - 1) + 1;
    var end = text.indexOf("\n", span.end);
    if (end === -1) {
      end = text.length;
    }
    return { start: start, end: end };
  }

  // The top-level block the caret belongs to. Direct containment first; failing
  // that (the caret sits on a marker like a blockquote's '> ', which is OUTSIDE
  // the block's recorded span), the block whose span overlaps the caret's line.
  function blockAtCaret(ast, text, offset) {
    var direct = topBlockAt(ast, offset);
    if (direct) {
      return direct;
    }
    var lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    var lineEnd = text.indexOf("\n", offset);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    var children = (ast && Array.isArray(ast.children)) ? ast.children : [];
    for (var i = 0; i < children.length; i++) {
      var pos = children[i].position;
      if (pos && Number(pos.startOffset) <= lineEnd && Number(pos.endOffset) >= lineStart) {
        return children[i];
      }
    }
    return null;
  }

  // A pull-quote is a single-line paragraph whose text is wrapped in quote marks
  // (§5.3, parser's isPullQuoteText). Toggle wraps / unwraps and the oracle
  // confirms the block type actually flipped.
  function applyPullQuote(text, start, parseFn) {
    var before = parseFn(text);
    var block = blockAtCaret(before, text, start);
    if (!block || (block.type !== "paragraph" && block.type !== "pull_quote")) {
      return fail("Pull-quotes apply to a paragraph.");
    }
    var span = blockSpan(block);
    if (!span) {
      return fail("Couldn't locate the block.");
    }
    var slice = text.slice(span.start, span.end);
    if (slice.indexOf("\n") !== -1) {
      return fail("Pull-quotes are a single line.");
    }

    var wasPull = block.type === "pull_quote";
    var replacement = wasPull ? stripQuotes(slice) : '"' + slice.trim() + '"';
    var candidate = text.slice(0, span.start) + replacement + text.slice(span.end);
    // Count-based oracle: the pull_quote block count moves by one in the right
    // direction (probing by offset is unreliable — block positions shift with
    // markers). No new error either.
    var after = parseFn(candidate);
    var delta = countTopBlocks(after, "pull_quote") - countTopBlocks(before, "pull_quote");
    if (errorCount(after) <= errorCount(before) && delta === (wasPull ? -1 : 1)) {
      var caret = span.start + replacement.length;
      return ok(candidate, caret, caret);
    }
    return fail("Couldn't toggle the pull-quote here.");
  }

  // A blockquote is `> `-prefixed lines (§5.3, parser's parseBlockQuoteLine).
  // Toggle adds / strips the prefix on every line of the block.
  function applyBlockquote(text, start, parseFn) {
    var before = parseFn(text);
    var block = blockAtCaret(before, text, start);
    if (!block) {
      return fail("Place the caret in a block first.");
    }
    var span = blockSpan(block);
    if (!span) {
      return fail("Couldn't locate the block.");
    }
    var wasQuote = block.type === "blockquote";
    // Operate on the full LINE range — the blockquote's content span excludes
    // its '> ' marker, so stripping the content slice alone would leave it.
    var ls = blockLineSpan(text, span);
    var lines = text.slice(ls.start, ls.end).split("\n");
    var rewritten = wasQuote
      ? lines.map(function strip(line) { return line.replace(/^(\s*)>[ \t]?/, "$1"); })
      : lines.map(function add(line) { return "> " + line; });
    var candidate = text.slice(0, ls.start) + rewritten.join("\n") + text.slice(ls.end);
    // Count-based oracle: the blockquote count moves by one in the right
    // direction, no new error.
    var after = parseFn(candidate);
    var delta = countTopBlocks(after, "blockquote") - countTopBlocks(before, "blockquote");
    if (errorCount(after) <= errorCount(before) && delta === (wasQuote ? -1 : 1)) {
      return ok(candidate, ls.start, ls.start);
    }
    return fail("Couldn't toggle the blockquote here.");
  }

  // Insert a divider (`---`) as its own block at the caret's line. isDividerLine
  // flushes the current paragraph, so no surrounding blank line is required.
  function applyDivider(text, start, parseFn) {
    var before = parseFn(text);
    var lineStart = text.lastIndexOf("\n", start - 1) + 1;
    var candidate = text.slice(0, lineStart) + "---\n" + text.slice(lineStart);
    var after = parseFn(candidate);
    if (
      errorCount(after) <= errorCount(before) &&
      countTopBlocks(after, "divider") === countTopBlocks(before, "divider") + 1
    ) {
      var caret = lineStart + 4; // just past "---\n"
      return ok(candidate, caret, caret);
    }
    return fail("Couldn't insert a divider here.");
  }

  // ----- select-node (not a buffer edit — a selection span) -----------------
  // The source [start, end) of the top-level block containing `offset`, for the
  // editor to set as the native selection (§6). Returns null if none.
  function blockRangeAt(ast, offset) {
    var block = topBlockAt(ast, offset);
    return blockSpan(block);
  }

  // ----- dispatch -----------------------------------------------------------

  function apply(id, text, start, end, parseFn) {
    if (typeof parseFn !== "function") {
      return fail("No parser available.");
    }
    var s = Math.max(0, Math.min(Number(start) || 0, text.length));
    var e = Math.max(s, Math.min(Number(end) || 0, text.length));

    if (INLINE[id]) {
      return applyInline(INLINE[id], text, s, e, parseFn);
    }
    if (id === "link") {
      return applyLink(text, s, e, parseFn);
    }
    var headingMatch = /^heading-([0-3])$/.exec(id);
    if (headingMatch) {
      return applyHeading(Number(headingMatch[1]), text, s, parseFn);
    }
    if (id === "pull-quote") {
      return applyPullQuote(text, s, parseFn);
    }
    if (id === "blockquote") {
      return applyBlockquote(text, s, parseFn);
    }
    if (id === "divider") {
      return applyDivider(text, s, parseFn);
    }
    return fail("Unknown command: " + id);
  }

  return {
    CATALOG: CATALOG,
    apply: apply,
    blockRangeAt: blockRangeAt,
    // exposed for tests
    plainText: plainText,
    countInline: countInline,
    countTopBlocks: countTopBlocks,
    topBlockAt: topBlockAt,
  };
});
