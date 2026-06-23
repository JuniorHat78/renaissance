// Scriptorium — command-surface helpers (pure, Node-testable).
//
// The brains behind the command palette (Ctrl/Cmd+K) and the slash menu (/):
//   - fuzzyMatch / filter: rank a list of command + navigation items against a
//     query, with positions for label highlighting.
//   - slashContext: detect a "/command" trigger at the caret in the buffer.
// No DOM and no parser here — editor.js owns the overlay and maps item ids to
// actions (each of which rides the existing oracle-verified command surface).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScriptoriumPalette = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  var ALNUM = /[A-Za-z0-9]/;

  function isUpper(ch) {
    return ch >= "A" && ch <= "Z";
  }
  function isLower(ch) {
    return ch >= "a" && ch <= "z";
  }

  // A word/segment boundary at index i of text: start-of-string, a non-alnum
  // char before, or a lower→Upper camel transition. Drives the "matched at a
  // word start" scoring bonus.
  function isBoundary(text, i) {
    if (i <= 0) {
      return true;
    }
    var prev = text.charAt(i - 1);
    var cur = text.charAt(i);
    if (!ALNUM.test(prev)) {
      return true;
    }
    return isLower(prev) && isUpper(cur);
  }

  // Subsequence fuzzy match (case-insensitive). Returns { score, positions } or
  // null when not every query char appears in order. Higher score is better:
  // consecutive runs, word-start hits, exact-case, and earliness all help.
  function fuzzyMatch(query, text) {
    query = String(query == null ? "" : query);
    text = String(text == null ? "" : text);
    if (query === "") {
      return { score: 0, positions: [] };
    }
    var q = query.toLowerCase();
    var t = text.toLowerCase();
    var positions = [];
    var qi = 0;
    var score = 0;
    var prevMatch = -2;
    var consec = 0;
    for (var ti = 0; ti < t.length && qi < q.length; ti += 1) {
      if (t.charAt(ti) === q.charAt(qi)) {
        var bonus = 1;
        if (ti === prevMatch + 1) {
          consec += 1;
          bonus += consec * 4;
        } else {
          consec = 0;
        }
        if (isBoundary(text, ti)) {
          bonus += 8;
        }
        if (text.charAt(ti) === query.charAt(qi)) {
          bonus += 1; // exact-case nudge
        }
        score += bonus;
        positions.push(ti);
        prevMatch = ti;
        qi += 1;
      }
    }
    if (qi < q.length) {
      return null;
    }
    // Prefer earlier first-hit and tighter (shorter) candidates on ties.
    score -= positions[0] * 0.1;
    score -= text.length * 0.01;
    return { score: score, positions: positions };
  }

  // Rank items against a query. Each item: { id, label, keywords? }. Returns
  // [{ id, label, score, positions }] sorted best-first; ties keep input order.
  // An empty query returns every item in its original order (score 0).
  function filter(query, items) {
    items = items || [];
    query = String(query == null ? "" : query).trim();
    if (query === "") {
      return items.map(function (it, i) {
        return { id: it.id, label: it.label, score: 0, positions: [], order: i };
      });
    }
    var scored = [];
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      var onLabel = fuzzyMatch(query, it.label || "");
      if (onLabel) {
        scored.push({ id: it.id, label: it.label, score: onLabel.score + 20, positions: onLabel.positions, order: i });
        continue;
      }
      // Fall back to keywords (no label highlight when matched there).
      var kw = it.keywords ? String(it.keywords) : "";
      if (kw) {
        var onKw = fuzzyMatch(query, kw);
        if (onKw) {
          scored.push({ id: it.id, label: it.label, score: onKw.score, positions: [], order: i });
        }
      }
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.order - b.order;
    });
    return scored;
  }

  // Detect a slash trigger at the caret. Active when, scanning back from the
  // caret, we reach a "/" with NO intervening whitespace, and that "/" sits at
  // the start of text/line or right after whitespace (so http://, and/or, a/b
  // mid-word never trigger). Returns { active, start, query } — start is the "/"
  // offset, query is the text after it up to the caret.
  function slashContext(text, caret) {
    text = String(text == null ? "" : text);
    caret = Math.max(0, Math.min(Number(caret) || 0, text.length));
    var i = caret;
    while (i > 0) {
      var ch = text.charAt(i - 1);
      if (ch === "/") {
        var before = i - 2 >= 0 ? text.charAt(i - 2) : "";
        if (before === "" || before === "\n" || /\s/.test(before)) {
          return { active: true, start: i - 1, query: text.slice(i, caret) };
        }
        return { active: false, start: -1, query: "" };
      }
      if (/\s/.test(ch)) {
        return { active: false, start: -1, query: "" };
      }
      i -= 1;
    }
    return { active: false, start: -1, query: "" };
  }

  return {
    isBoundary: isBoundary,
    fuzzyMatch: fuzzyMatch,
    filter: filter,
    slashContext: slashContext,
  };
});
