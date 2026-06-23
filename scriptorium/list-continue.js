// Scriptorium — list continuation on Enter (pure, Node-testable).
//
// The boundary-respecting kind of "smart typing" (§7): NOT ambient reflow, but a
// single explicit edit bound to the Enter key. When Enter is pressed at the end
// of a list item, continue the list with the next marker; on an empty item, end
// the list (clear the marker). Returns null to let Enter behave normally.
//
// Marker grammar matches parse.js: bullets are - or +, ordered is \d+ then . or ).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScriptoriumListContinue = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  var LIST_RE = /^(\s*)([-+]|\d+[.)])(\s+)(.*)$/;

  function currentLine(text, caret) {
    var ls = text.lastIndexOf("\n", caret - 1) + 1;
    var le = text.indexOf("\n", caret);
    if (le === -1) {
      le = text.length;
    }
    return { ls: ls, le: le, line: text.slice(ls, le) };
  }

  // Returns { text, caret } for the continuation edit, or null when Enter should
  // do its normal thing. Only fires at the end of a list-item line.
  function enterEdit(text, caret) {
    text = String(text == null ? "" : text);
    caret = Math.max(0, Math.min(Number(caret) || 0, text.length));
    var cl = currentLine(text, caret);
    if (caret !== cl.le) {
      return null; // only continue from the end of the line
    }
    var m = LIST_RE.exec(cl.line);
    if (!m) {
      return null;
    }
    var indent = m[1];
    var marker = m[2];
    var content = m[4];

    if (content.trim() === "") {
      // Empty item → end the list: clear this line entirely.
      return { text: text.slice(0, cl.ls) + text.slice(cl.le), caret: cl.ls };
    }

    var nextMarker;
    if (/^\d/.test(marker)) {
      var num = parseInt(marker, 10) + 1;
      var delim = marker.replace(/^\d+/, ""); // "." or ")"
      nextMarker = indent + num + delim + " ";
    } else {
      nextMarker = indent + marker + " ";
    }
    var insert = "\n" + nextMarker;
    return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  return { enterEdit: enterEdit };
});
