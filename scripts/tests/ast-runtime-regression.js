#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const Ast = require("../ast");

check("script-looking input serializes as escaped text", () => {
  const documentNode = Ast.parseDocument('<script>alert("nope")</script>');
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, '<p>&lt;script&gt;alert(&quot;nope&quot;)&lt;/script&gt;</p>');
  assert.ok(!/<script/i.test(html), "serialized output must not contain a script tag");
});

check("multiplication stars are not emphasis", () => {
  const documentNode = Ast.parseDocument("2 * 3 = 6, and x*y* stays literal.");
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, "<p>2 * 3 = 6, and x*y* stays literal.</p>");
});

check("multi-line emphasis remains compatible with essay corpus", () => {
  const documentNode = Ast.parseDocument("*first line\nsecond line*");
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, "<p><em>first line second line</em></p>");
  assert.equal(Ast.toSearchableText(documentNode), "first line second line");
});

check("hard breaks inside emphasis stay structural", () => {
  const documentNode = Ast.parseDocument("*first line  \nsecond line*");
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, "<p><em>first line<br>second line</em></p>");
});

check("recursive inline dialect supports strong code and links", () => {
  const documentNode = Ast.parseDocument("A *soft **bold** [linked `code`](notes.html)* line.");
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, '<p>A <em>soft <strong>bold</strong> <a href="notes.html">linked <code>code</code></a></em> line.</p>');
  assert.equal(Ast.toSearchableText(documentNode), "A soft bold linked code line.");
});

check("unsafe inline links stay literal text", () => {
  const documentNode = Ast.parseDocument("[bad](javascript:alert(1))");
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, "<p>[bad](javascript:alert(1))</p>");
  assert.equal(documentNode.diagnostics[0].code, "unsafe-link-url");
});

check("lists and blockquotes render as structural blocks", () => {
  const documentNode = Ast.parseDocument("- First\n- **Second**\n\n> Quoted *line*.");
  const html = Ast.serializeDocument(documentNode);
  assert.equal(html, "<ul><li>First</li><li><strong>Second</strong></li></ul><blockquote><p>Quoted <em>line</em>.</p></blockquote>");
  assert.equal(Ast.toSearchableText(documentNode), "First Second Quoted line.");
});

check("leading headings can be removed without mutating the source document", () => {
  const documentNode = Ast.parseDocument("# Title\n\n## Deck\n\nBody text.");
  const content = Ast.withoutLeadingHeadings(documentNode);
  assert.equal(documentNode.children.length, 3);
  assert.equal(content.children.length, 1);
  assert.equal(Ast.toSearchableText(content), "Body text.");
});

check("parsed AST documents validate cleanly", () => {
  const documentNode = Ast.parseDocument("# Title\n\nBody with *emphasis*.\n\n---");
  assert.deepEqual(Ast.validateDocument(documentNode), []);
});

check("parser diagnostics include severity and source position", () => {
  const documentNode = Ast.parseDocument("Opening line\n\n#### Too deep\n\nTrailing *marker");
  assert.equal(documentNode.diagnostics.length, 2);

  const headingDiagnostic = documentNode.diagnostics.find((diagnostic) => diagnostic.code === "heading-level-clamped");
  assert.ok(headingDiagnostic, "Expected heading clamp diagnostic");
  assert.equal(headingDiagnostic.severity, "info");
  assert.deepEqual(headingDiagnostic.position, { line: 3, column: 1 });

  const emphasisDiagnostic = documentNode.diagnostics.find((diagnostic) => diagnostic.code === "unmatched-emphasis-marker");
  assert.ok(emphasisDiagnostic, "Expected unmatched emphasis diagnostic");
  assert.equal(emphasisDiagnostic.severity, "info");
  assert.deepEqual(emphasisDiagnostic.position, { line: 5, column: 10 });
});

check("validator reports structured invariant errors", () => {
  const errors = Ast.validateDocument({
    type: "document",
    children: [
      { type: "raw_html", value: "<script></script>" },
      { type: "heading", level: 9, children: [{ type: "text", value: "Bad" }] },
      { type: "divider", children: [{ type: "text", value: "Nope" }] },
      {
        type: "paragraph",
        position: { line: 0, startOffset: 8, endOffset: 2 },
        children: [
          { type: "text", value: "" },
          { type: "hard_break", value: "\n" },
          { type: "html", value: "<b>raw</b>" },
        ],
      },
    ],
  });
  const codes = errors.map((error) => error.code);
  assert.ok(codes.includes("unknown-block-type"), "unknown block types should be rejected");
  assert.ok(codes.includes("invalid-heading-level"), "bad heading levels should be rejected");
  assert.ok(codes.includes("divider-children"), "divider children should be rejected");
  assert.ok(codes.includes("invalid-position-line"), "bad position lines should be rejected");
  assert.ok(codes.includes("invalid-position-range"), "bad position ranges should be rejected");
  assert.ok(codes.includes("empty-text-value"), "empty text nodes should be rejected");
  assert.ok(codes.includes("invalid-hard-break"), "hard breaks should not carry payload");
  assert.ok(codes.includes("unknown-inline-type"), "unknown inline nodes should be rejected");
  assert.ok(errors.every((error) => error.severity === "error"), "validation errors should carry severity");
});

check("DOM renderer builds nodes instead of assigning HTML strings", () => {
  const documentRef = createFakeDocument();
  const container = documentRef.createElement("article");
  let innerHtmlAssigned = false;
  Object.defineProperty(container, "innerHTML", {
    set() {
      innerHtmlAssigned = true;
      throw new Error("innerHTML should not be assigned");
    },
  });

  Ast.renderBlocks(container, Ast.parseDocument('A <tag> and *emphasis*.'));

  assert.equal(innerHtmlAssigned, false);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].tagName, "p");
  assert.equal(flattenText(container), "A <tag> and emphasis.");
});

console.log("AST runtime regression checks passed.");

function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    console.error("FAIL " + name + "\n  " + error.message);
    process.exit(1);
  }
}

function createFakeDocument() {
  return {
    createElement(tagName) {
      return createFakeNode(tagName, this);
    },
    createTextNode(value) {
      return {
        nodeType: "text",
        textContent: String(value),
        ownerDocument: this,
      };
    },
  };
}

function createFakeNode(tagName, documentRef) {
  const node = {
    tagName,
    children: [],
    className: "",
    ownerDocument: documentRef,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) {
        this.children.splice(index, 1);
      }
      return child;
    },
  };

  Object.defineProperty(node, "firstChild", {
    get() {
      return this.children[0] || null;
    },
  });

  return node;
}

function flattenText(node) {
  if (node.nodeType === "text") {
    return node.textContent;
  }

  return (node.children || []).map(flattenText).join("");
}
