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

check("leading headings can be removed without mutating the source document", () => {
  const documentNode = Ast.parseDocument("# Title\n\n## Deck\n\nBody text.");
  const content = Ast.withoutLeadingHeadings(documentNode);
  assert.equal(documentNode.children.length, 3);
  assert.equal(content.children.length, 1);
  assert.equal(Ast.toSearchableText(content), "Body text.");
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
