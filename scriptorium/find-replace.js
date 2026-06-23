// Scriptorium — the find & replace engine (pure, Node-testable).
//
// Above the caret (SCRIPTORIUM.md §4): this only computes match spans and
// proposed buffer text. The editor applies edits via execCommand to preserve
// the native undo stack, and moves the caret with setSelectionRange. No DOM, no
// second parser — find/replace is plain text surgery over the buffer.
//
// Matching always goes through ONE compiled RegExp (literal queries are escaped),
// so case-insensitive search can never desync offsets the way toLowerCase() can
// when a character's lower-case form changes length.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScriptoriumFindReplace = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  var WORD = /[A-Za-z0-9_]/;

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Compile a query into a global RegExp. Returns { ok, re } or { ok:false, error }.
  // - literal (default): the query is escaped; wholeWord wraps it in \b…\b.
  // - regex: the query is used as-is (the author owns the metacharacters).
  function compile(query, options) {
    options = options || {};
    if (query == null || query === "") {
      return { ok: false, error: "empty" };
    }
    var flags = "g" + (options.caseSensitive ? "" : "i");
    var source;
    if (options.regex) {
      source = String(query);
    } else {
      source = escapeRegex(query);
      if (options.wholeWord) {
        source = "\\b" + source + "\\b";
      }
    }
    try {
      return { ok: true, re: new RegExp(source, flags) };
    } catch (error) {
      return { ok: false, error: "invalid-regex" };
    }
  }

  // True iff a compiled (or compilable) query is usable.
  function isValid(query, options) {
    return compile(query, options).ok;
  }

  // All non-overlapping matches as { start, end } (UTF-16 offsets into text),
  // in document order. Empty/invalid query → []. Zero-width matches advance by
  // one code unit so a pattern like `a*` can't loop forever.
  function findMatches(text, query, options) {
    text = String(text == null ? "" : text);
    var compiled = compile(query, options);
    if (!compiled.ok) {
      return [];
    }
    var re = compiled.re;
    var matches = [];
    var m;
    var guard = 0;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      var start = m.index;
      var end = start + m[0].length;
      matches.push({ start: start, end: end });
      if (m[0].length === 0) {
        re.lastIndex += 1; // zero-width: step past to make progress
      }
      if (++guard > 1000000) {
        break; // pathological catastrophe guard
      }
    }
    return matches;
  }

  // Index of the next match at/after the caret (forward) or the last match
  // before it (backward), wrapping around. Returns -1 when there are none.
  function nextMatchIndex(matches, caret, forward) {
    if (!matches.length) {
      return -1;
    }
    caret = Number(caret) || 0;
    if (forward === false) {
      for (var i = matches.length - 1; i >= 0; i -= 1) {
        if (matches[i].start < caret) {
          return i;
        }
      }
      return matches.length - 1; // wrap to the last
    }
    for (var j = 0; j < matches.length; j += 1) {
      if (matches[j].start >= caret) {
        return j;
      }
    }
    return 0; // wrap to the first
  }

  // Splice `replacement` into [start, end). Returns the new buffer + the caret
  // selection covering the inserted text (so a subsequent replace targets it).
  function replaceRange(text, start, end, replacement) {
    text = String(text == null ? "" : text);
    replacement = String(replacement == null ? "" : replacement);
    var s = Math.max(0, Math.min(start, text.length));
    var e = Math.max(s, Math.min(end, text.length));
    return {
      text: text.slice(0, s) + replacement + text.slice(e),
      selectionStart: s,
      selectionEnd: s + replacement.length,
    };
  }

  // Replace every match. In literal mode the replacement is inserted verbatim
  // (a `$` in it is NOT a backreference); in regex mode `$1`/`$&` are honored,
  // matching author expectations. Returns { text, count }.
  function replaceAll(text, query, replacement, options) {
    text = String(text == null ? "" : text);
    var compiled = compile(query, options);
    if (!compiled.ok) {
      return { text: text, count: 0 };
    }
    var matches = findMatches(text, query, options);
    if (!matches.length) {
      return { text: text, count: 0 };
    }
    var isRegex = !!(options && options.regex);
    var repl = String(replacement == null ? "" : replacement);
    var out = "";
    var cursor = 0;
    for (var i = 0; i < matches.length; i += 1) {
      var mm = matches[i];
      out += text.slice(cursor, mm.start);
      out += isRegex ? expand(text.slice(mm.start, mm.end), repl, compiled.re) : repl;
      cursor = mm.end;
    }
    out += text.slice(cursor);
    return { text: out, count: matches.length };
  }

  // Expand $&/$1..$9 in a regex-mode replacement for a single matched slice.
  function expand(matched, replacement, re) {
    // Re-run the regex against just the matched slice to recover capture groups.
    var single = new RegExp(re.source, re.flags.replace("g", ""));
    var m = single.exec(matched);
    if (!m) {
      return replacement;
    }
    return replacement.replace(/\$(\$|&|\d{1,2})/g, function (whole, token) {
      if (token === "$") return "$";
      if (token === "&") return m[0];
      var n = parseInt(token, 10);
      return m[n] != null ? m[n] : "";
    });
  }

  return {
    escapeRegex: escapeRegex,
    compile: compile,
    isValid: isValid,
    findMatches: findMatches,
    nextMatchIndex: nextMatchIndex,
    replaceRange: replaceRange,
    replaceAll: replaceAll,
    WORD: WORD,
  };
});
