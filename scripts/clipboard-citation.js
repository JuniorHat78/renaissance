(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.RenaissanceClipboardCitation = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function buildClipboardCitation() {
  "use strict";

  const NONE = "none";
  const LINK = "link";
  const FULL = "full";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cleanText(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function normalizeTier(value) {
    if (value === LINK || value === FULL) {
      return value;
    }
    return NONE;
  }

  function safeHttpUrl(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    try {
      const url = new URL(text, "https://renaissance.local/");
      return url.protocol === "http:" || url.protocol === "https:" ? text : "";
    } catch (_error) {
      return "";
    }
  }

  function paragraphHtml(text) {
    const escaped = escapeHtml(text).replace(/\n/g, "<br>");
    return escaped ? "<p>" + escaped + "</p>" : "";
  }

  function quoteHtml(selectedText) {
    const body = cleanText(selectedText);
    if (!body) {
      return "";
    }

    const paragraphs = body
      .split(/\n{2,}/)
      .map((paragraph) => paragraphHtml(paragraph.trim()))
      .join("");

    return paragraphs ? "<blockquote>" + paragraphs + "</blockquote>" : "";
  }

  function sourceHtml(url, tier, sourceLabel) {
    const href = safeHttpUrl(url);
    if (!href) {
      return "";
    }

    const link = '<a href="' + escapeHtml(href) + '" rel="noopener noreferrer">' + escapeHtml(href) + "</a>";
    if (tier === FULL) {
      const source = cleanText(sourceLabel);
      const cite = source ? "<cite>" + escapeHtml(source) + "</cite><br>" : "";
      return '<p class="renaissance-citation">&mdash; ' + cite + link + "</p>";
    }

    return '<p class="renaissance-citation">&mdash; ' + link + "</p>";
  }

  function plainText(options) {
    const settings = options || {};
    const body = cleanText(settings.selectedText);
    const tier = normalizeTier(settings.tier);
    const url = cleanText(settings.url);

    if (tier === NONE || !url) {
      return body;
    }

    if (tier === FULL) {
      const source = cleanText(settings.sourceLabel);
      const lead = source ? "\u2014 " + source + "\n  " : "\u2014 ";
      return body + "\n\n" + lead + url;
    }

    return body + "\n\n\u2014 " + url;
  }

  function html(options) {
    const settings = options || {};
    const tier = normalizeTier(settings.tier);
    if (tier === NONE) {
      return "";
    }

    const quote = quoteHtml(settings.selectedText);
    if (!quote) {
      return "";
    }

    return quote + sourceHtml(settings.url, tier, settings.sourceLabel);
  }

  return {
    escapeHtml,
    html,
    plainText,
    safeHttpUrl
  };
});
