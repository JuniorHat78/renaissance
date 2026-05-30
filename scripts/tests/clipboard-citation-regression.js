#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const citation = require("../clipboard-citation");

function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    console.error("FAIL " + name + "\n  " + error.message);
    process.exitCode = 1;
  }
}

check("plain text keeps short selections clean", () => {
  const copied = citation.plainText({
    selectedText: "  a few words  ",
    url: "https://example.test/section.html?essay=a",
    tier: "none",
    sourceLabel: "Essay, Section I"
  });

  assert.equal(copied, "a few words");
});

check("plain text adds medium source links", () => {
  const copied = citation.plainText({
    selectedText: "A quoted sentence with enough shape.",
    url: "https://example.test/section.html?essay=a&section=1",
    tier: "link"
  });

  assert.equal(
    copied,
    "A quoted sentence with enough shape.\n\n\u2014 https://example.test/section.html?essay=a&section=1"
  );
});

check("plain text adds full source labels", () => {
  const copied = citation.plainText({
    selectedText: "A longer quotation.",
    url: "https://example.test/section.html?essay=a&section=1",
    tier: "full",
    sourceLabel: "Essay, Section I"
  });

  assert.equal(
    copied,
    "A longer quotation.\n\n\u2014 Essay, Section I\n  https://example.test/section.html?essay=a&section=1"
  );
});

check("rich citation escapes selected prose instead of cloning HTML", () => {
  const copied = citation.html({
    selectedText: 'Hello <img src=x onerror="alert(1)">\n<script>alert(2)</script>',
    url: "https://example.test/section.html?essay=a&section=1",
    tier: "full",
    sourceLabel: 'Essay <One> & "Section"'
  });

  assert.match(copied, /^<blockquote>/);
  assert.doesNotMatch(copied, /<img\b/i);
  assert.doesNotMatch(copied, /<script\b/i);
  assert.doesNotMatch(copied, /onerror="/i);
  assert.match(copied, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(copied, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(copied, /<cite>Essay &lt;One&gt; &amp; &quot;Section&quot;<\/cite>/);
});

check("rich citation rejects script-like hrefs", () => {
  const copied = citation.html({
    selectedText: "A quoted sentence.",
    url: "javascript:alert(1)",
    tier: "link"
  });

  assert.match(copied, /^<blockquote>/);
  assert.doesNotMatch(copied, /href=/i);
  assert.doesNotMatch(copied, /javascript:/i);
});

check("rich citation preserves paragraph and hard line shape safely", () => {
  const copied = citation.html({
    selectedText: "First line\nsecond line\n\nSecond paragraph",
    url: "https://example.test/section.html",
    tier: "link"
  });

  assert.match(copied, /<p>First line<br>second line<\/p><p>Second paragraph<\/p>/);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("Clipboard citation regression checks passed.");
