// Scriptorium — block operations (pure, Node-testable).
//
// Move / duplicate / delete the block at the caret, as line-range text surgery
// over the parsed top-level block list. Above the caret (§4): pure buffer
// transforms; the editor applies them via execCommand and the result re-parses
// (the per-command spirit — same blocks, reordered/copied/removed). Blocks are
// passed in as { start, end } offsets; line spans are recomputed here so a
// blockquote's marker-excluded start still moves its whole line.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScriptoriumBlockOps = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  function lineStart(text, i) {
    var n = text.lastIndexOf("\n", Math.max(0, i - 1));
    return n === -1 ? 0 : n + 1;
  }
  function lineEnd(text, i) {
    var n = text.indexOf("\n", i);
    return n === -1 ? text.length : n;
  }

  // Expand a block's [start,end) to the full lines it occupies.
  function lineSpan(text, start, end) {
    var s = Math.max(0, Math.min(start, text.length));
    var e = Math.max(s, Math.min(end, text.length));
    return { from: lineStart(text, s), to: lineEnd(text, e) };
  }

  function spansOf(text, blocks) {
    var sp = (blocks || []).map(function (b) {
      return lineSpan(text, b.start, b.end);
    });
    sp.sort(function (a, b) { return a.from - b.from; });
    return sp;
  }

  // Index of the span containing the caret, else the nearest preceding one,
  // else 0 (or -1 when there are no blocks).
  function indexAt(spans, caret) {
    if (!spans.length) {
      return -1;
    }
    var best = -1;
    for (var i = 0; i < spans.length; i += 1) {
      if (caret >= spans[i].from && caret <= spans[i].to) {
        return i;
      }
      if (spans[i].from <= caret) {
        best = i;
      }
    }
    return best === -1 ? 0 : best;
  }

  // Swap the caret's block with its previous (dir<0) or next (dir>0) sibling,
  // preserving the whitespace gap between them. Returns { text, caret }.
  function move(text, blocks, caret, dir) {
    text = String(text == null ? "" : text);
    var sp = spansOf(text, blocks);
    var i = indexAt(sp, caret);
    if (i < 0) {
      return { text: text, caret: caret };
    }
    var j = dir < 0 ? i - 1 : i + 1;
    if (j < 0 || j >= sp.length) {
      return { text: text, caret: caret };
    }
    var lo = Math.min(i, j);
    var hi = Math.max(i, j);
    var A = sp[lo];
    var B = sp[hi];
    var before = text.slice(0, A.from);
    var aText = text.slice(A.from, A.to);
    var between = text.slice(A.to, B.from);
    var bText = text.slice(B.from, B.to);
    var after = text.slice(B.to);
    var swapped = before + bText + between + aText + after;
    var orig = sp[i];
    var offsetInBlock = Math.max(0, caret - orig.from);
    var newStart = i < j
      ? before.length + bText.length + between.length // moved down
      : before.length; // moved up
    return { text: swapped, caret: newStart + offsetInBlock };
  }

  // Insert a copy of the caret's block right after it (separated by a blank
  // line); leave the caret in the copy. Returns { text, caret }.
  function duplicate(text, blocks, caret) {
    text = String(text == null ? "" : text);
    var sp = spansOf(text, blocks);
    var i = indexAt(sp, caret);
    if (i < 0) {
      return { text: text, caret: caret };
    }
    var s = sp[i];
    var blockText = text.slice(s.from, s.to);
    var inserted = "\n\n" + blockText;
    var newText = text.slice(0, s.to) + inserted + text.slice(s.to);
    var dupStart = s.to + 2; // past the inserted "\n\n"
    return { text: newText, caret: dupStart + Math.max(0, caret - s.from) };
  }

  // Delete the caret's block and one separating blank line (following, or
  // preceding at EOF) so no double blank is left. Returns { text, caret }.
  function remove(text, blocks, caret) {
    text = String(text == null ? "" : text);
    var sp = spansOf(text, blocks);
    var i = indexAt(sp, caret);
    if (i < 0) {
      return { text: text, caret: caret };
    }
    var from = sp[i].from;
    var to = sp[i].to;
    var consumed = 0;
    var k = to;
    while (k < text.length && text.charAt(k) === "\n" && consumed < 2) {
      k += 1;
      consumed += 1;
    }
    if (consumed === 0 && from > 0) {
      while (from > 0 && text.charAt(from - 1) === "\n") {
        from -= 1;
      }
    } else {
      to = k;
    }
    var newText = text.slice(0, from) + text.slice(to);
    return { text: newText, caret: Math.min(from, newText.length) };
  }

  return {
    lineSpan: lineSpan,
    spansOf: spansOf,
    indexAt: indexAt,
    move: move,
    duplicate: duplicate,
    remove: remove,
  };
});
