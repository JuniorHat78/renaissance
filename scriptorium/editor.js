// Scriptorium — the editor (LOCAL author tooling; never shipped to readers).
//
// A split-pane authoring view for Renaissance sections. LEFT is a plain
// <textarea>; RIGHT is render(parse(buffer)) using the site's OWN AST modules;
// the side rail surfaces the parser's DIAGNOSTIC_CODES live plus a heading
// outline. See docs/specs/SCRIPTORIUM.md.
//
// THE SPINE (§2): every preview/diagnostic/outline rides the ONE parse
// authority. core.js + render.js + parse.js are loaded by editor.html; parse.js
// registers its parser into core, so RenaissanceAst.parseDocument(text) and
// RenaissanceAst.renderBlocks(el, ast) here are the exact deploy path. There is
// no editor-private parser.
//
// THE CARET BOUNDARY (§4 — sacred): the editing surface is the <textarea> and
// nothing else. No contenteditable, no custom caret. The browser owns glyph
// entry, selection, IME, and undo/redo; we own everything above the caret
// (preview, diagnostics, outline). Nothing in this file writes into the
// editing surface except in response to an explicit author action (load a
// section) — we never reformat the buffer under the caret as they type.
(function initScriptoriumEditor() {
  "use strict";

  const DEBOUNCE_MS = 120;

  const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

  // Human labels for the parser's diagnostic codes. Kept in sync with
  // core.js DIAGNOSTIC_CODES by keying off the live object below; this map is
  // only for friendlier display and degrades to the raw code if absent.
  const DIAGNOSTIC_LABELS = {
    "bom-removed": "Byte-order mark removed",
    "crlf-normalized": "CRLF normalized to LF",
    "heading-level-clamped": "Heading level clamped",
    "unsafe-link-url": "Unsafe link URL",
    "unmatched-code-marker": "Unmatched code marker",
    "unmatched-emphasis-marker": "Unmatched emphasis marker",
    "unmatched-strong-marker": "Unmatched strong marker",
  };

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      const self = this;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(function run() {
        timer = null;
        fn.apply(self, args);
      }, wait);
    };
  }

  // Coalesce bursty events (scroll) to one call per animation frame.
  function throttleFrame(fn) {
    let scheduled = false;
    return function throttled() {
      if (scheduled) {
        return;
      }
      scheduled = true;
      window.requestAnimationFrame(function run() {
        scheduled = false;
        fn();
      });
    };
  }

  function clearChildren(node) {
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  // Verify the spine is actually present before we pretend to be an editor.
  // If parse.js failed to load we must NOT silently fall back to anything —
  // that would be a second parse path, which §2 forbids.
  function getAstApi() {
    const ast = window.RenaissanceAst;
    if (!ast || typeof ast.parseDocument !== "function" || typeof ast.renderBlocks !== "function") {
      return null;
    }
    return ast;
  }

  ready(function start() {
    const ast = getAstApi();
    // The pure offset↔block mapping (SCRIPTORIUM-EDITOR.md §2). Optional: if it
    // failed to load the editor still edits and previews; only the structural
    // feel (highlight / click-to-jump / scroll-sync) goes quiet.
    const mapping = window.ScriptoriumMapping || null;
    // The AST-aware commands (§5). Optional in the same spirit: no commands
    // module, no toolbar — the editor still authors by hand.
    const commands = window.ScriptoriumCommands || null;

    // ----- parse engine (SCRIPTORIUM-RUST-PARSER.md) ----------------------
    // Default: the ONE JS parse authority (parse.js), exactly the deploy path.
    // Opt-in via ?engine=wasm: the oracle-validated, byte-identical Rust parser
    // compiled to wasm. This is NOT a silent second parser (§2) — it is explicit,
    // and the equivalence oracle proves it yields the identical AST, so preview /
    // commands / mapping are unaffected. Any load failure leaves us on JS.
    let parse = function parseJs(source) {
      return ast.parseDocument(source);
    };
    function wantsWasmEngine() {
      try {
        return new URLSearchParams(window.location.search).get("engine") === "wasm";
      } catch (error) {
        return false;
      }
    }

    const els = {
      essaySelect: document.getElementById("essay-select"),
      sectionSelect: document.getElementById("section-select"),
      saveButton: document.getElementById("save-button"),
      saveStatus: document.getElementById("save-status"),
      editor: document.getElementById("editor"),
      preview: document.getElementById("preview"),
      diagnostics: document.getElementById("diagnostics"),
      diagCount: document.getElementById("diag-count"),
      outline: document.getElementById("outline"),
      docStats: document.getElementById("doc-stats"),
      toolbar: document.getElementById("toolbar"),
    };

    if (!ast) {
      renderFatal(els, "The AST modules did not load (core.js / render.js / parse.js). " +
        "Scriptorium authors through the one parse authority and refuses to run without it.");
      return;
    }

    // ----- in-memory state -----------------------------------------------
    const state = {
      essays: [],            // [{slug,title,section_order,section_meta,...}]
      essayBySlug: {},
      current: { slug: null, n: null },
      loadedText: "",        // last text we put INTO the textarea (for dirty check)
      saving: false,
      passages: [],          // flattened addressable blocks (caret↔preview, §4)
      blocks: [],            // top-level blocks (command targeting, §5.3)
      previewByStart: {},    // source-start offset -> rendered preview element
      activeEl: null,        // currently highlighted preview element
    };

    // ----- the spine: parse + render --------------------------------------
    // ONE parse per refresh. The same AST feeds preview, diagnostics, and
    // outline so they can never disagree with each other or with the shipped
    // render.
    function refreshFromBuffer() {
      const source = els.editor.value;

      let parsed;
      try {
        parsed = parse(source);
      } catch (error) {
        renderPreviewError(els.preview, error);
        renderDiagnostics(els, [{
          code: "parse-error",
          severity: "error",
          message: String((error && error.message) || error),
          position: null,
        }]);
        clearOutline(els.outline);
        clearStructure();
        return;
      }

      // Preview = the real consume-side DOM render. renderBlocks accepts the
      // already-parsed AST (normalizeAstInput passes a document through
      // untouched), so no second parse happens here.
      try {
        ast.renderBlocks(els.preview, parsed);
      } catch (error) {
        renderPreviewError(els.preview, error);
      }

      // Structural index from the SAME parse — one parse feeds preview,
      // diagnostics, outline, AND the source↔preview mapping (§2).
      rebuildStructure(parsed);

      renderDiagnostics(els, (parsed && parsed.diagnostics) || []);
      renderOutline(els, parsed);
      renderStats(els, parsed);
      updateSaveState();
    }

    const scheduleRefresh = debounce(refreshFromBuffer, DEBOUNCE_MS);

    // ----- diagnostics ----------------------------------------------------
    function renderDiagnostics(targets, diagnostics) {
      const list = Array.isArray(diagnostics) ? diagnostics.slice() : [];
      list.sort(function bySeverityThenOffset(a, b) {
        const ra = SEVERITY_RANK[a && a.severity] != null ? SEVERITY_RANK[a.severity] : 3;
        const rb = SEVERITY_RANK[b && b.severity] != null ? SEVERITY_RANK[b.severity] : 3;
        if (ra !== rb) {
          return ra - rb;
        }
        return (offsetOf(a)) - (offsetOf(b));
      });

      clearChildren(targets.diagnostics);
      targets.diagCount.textContent = String(list.length);
      targets.diagCount.classList.toggle("badge-clean", list.length === 0);
      targets.diagCount.classList.toggle("badge-flag", list.length > 0);

      if (!list.length) {
        const empty = document.createElement("li");
        empty.className = "diag-empty muted";
        empty.textContent = "Clean — no diagnostics.";
        targets.diagnostics.appendChild(empty);
        return;
      }

      list.forEach(function appendDiag(diag) {
        targets.diagnostics.appendChild(buildDiagnosticItem(diag));
      });
    }

    function offsetOf(diag) {
      if (!diag) {
        return 0;
      }
      if (diag.position && Number.isFinite(Number(diag.position.line))) {
        return Number(diag.position.line) * 100000 + Number(diag.position.column || 0);
      }
      return Number.isFinite(Number(diag.offset)) ? Number(diag.offset) : 0;
    }

    function buildDiagnosticItem(diag) {
      const item = document.createElement("li");
      const severity = (diag && diag.severity) || "info";
      item.className = "diag diag-" + severity;

      const head = document.createElement("div");
      head.className = "diag-head";

      const label = document.createElement("span");
      label.className = "diag-label";
      label.textContent = DIAGNOSTIC_LABELS[diag && diag.code] || (diag && diag.code) || "diagnostic";
      head.appendChild(label);

      const where = locationLabel(diag);
      if (where) {
        const loc = document.createElement("button");
        loc.type = "button";
        loc.className = "diag-loc";
        loc.textContent = where;
        // Caret boundary stays honored: jumping a diagnostic only MOVES the
        // textarea's own selection/caret. The browser still owns the caret;
        // we never inject a custom one.
        loc.addEventListener("click", function jump() {
          focusOffset(diag);
        });
        head.appendChild(loc);
      }

      item.appendChild(head);

      if (diag && diag.message) {
        const msg = document.createElement("div");
        msg.className = "diag-message muted";
        msg.textContent = diag.message;
        item.appendChild(msg);
      }

      return item;
    }

    function locationLabel(diag) {
      if (!diag) {
        return "";
      }
      if (diag.position && Number.isFinite(Number(diag.position.line))) {
        const col = Number(diag.position.column);
        return "ln " + Number(diag.position.line) + (Number.isFinite(col) ? ":" + col : "");
      }
      if (Number.isFinite(Number(diag.offset))) {
        return "@" + Number(diag.offset);
      }
      return "";
    }

    // Move the textarea's NATIVE caret/selection to a diagnostic. This is the
    // browser's caret, addressed by offset — not a custom one.
    function focusOffset(diag) {
      const offset = Number.isFinite(Number(diag && diag.offset)) ? Number(diag.offset) : null;
      if (offset == null) {
        return;
      }
      const bounded = Math.max(0, Math.min(offset, els.editor.value.length));
      els.editor.focus();
      try {
        els.editor.setSelectionRange(bounded, bounded);
      } catch (error) {
        /* setSelectionRange can throw on detached nodes; ignore */
      }
    }

    // ----- outline (from the AST headings) --------------------------------
    function renderOutline(targets, parsed) {
      const children = (parsed && Array.isArray(parsed.children)) ? parsed.children : [];
      const headings = children.filter(function isHeading(block) {
        return block && block.type === ast.BLOCK_TYPES.HEADING;
      });

      clearChildren(targets.outline);

      if (!headings.length) {
        clearOutline(targets.outline);
        return;
      }

      headings.forEach(function appendHeading(block) {
        const item = document.createElement("li");
        const level = ast.clampHeadingLevel ? ast.clampHeadingLevel(block.level) : Math.max(1, Math.min(3, Number(block.level) || 1));
        item.className = "outline-item outline-h" + level;

        const link = document.createElement("button");
        link.type = "button";
        link.className = "outline-link";
        link.textContent = headingText(block);

        const start = block.position && Number.isFinite(Number(block.position.startOffset))
          ? Number(block.position.startOffset)
          : null;
        if (start != null) {
          // Outline navigation also only nudges the native caret.
          link.addEventListener("click", function jumpToHeading() {
            focusOffset({ offset: start });
          });
        }

        item.appendChild(link);
        targets.outline.appendChild(item);
      });
    }

    function clearOutline(node) {
      clearChildren(node);
      const empty = document.createElement("li");
      empty.className = "outline-empty muted";
      empty.textContent = "No headings.";
      node.appendChild(empty);
    }

    // Read heading text straight off the AST inline children via the shared
    // projection — no private text extraction.
    function headingText(block) {
      if (ast.blockToSearchableText) {
        const text = ast.blockToSearchableText(block);
        if (text) {
          return text;
        }
      }
      return "(untitled heading)";
    }

    // ----- stats ----------------------------------------------------------
    function renderStats(targets, parsed) {
      const stats = (parsed && parsed.stats) || {};
      const blocks = Number.isFinite(Number(stats.blocks)) ? Number(stats.blocks) : 0;
      const words = Number.isFinite(Number(stats.words)) ? Number(stats.words) : 0;
      targets.docStats.textContent = blocks + (blocks === 1 ? " block · " : " blocks · ") +
        words + (words === 1 ? " word" : " words");
    }

    function renderPreviewError(node, error) {
      clearChildren(node);
      const box = document.createElement("p");
      box.className = "preview-error";
      box.textContent = "Preview failed: " + String((error && error.message) || error);
      node.appendChild(box);
    }

    // ----- structural layer: source <-> preview (SCRIPTORIUM-EDITOR.md §4) -
    // ONE mapping per parse, read both ways. render.js already stamps
    // data-source-start on every passage element; we index the parse (mapping.js,
    // pure) and bind those offsets to the elements so the caret can light up a
    // block and a click can move the caret. The caret stays the browser's — we
    // only ever MOVE the native selection, never install our own (§7).
    function rebuildStructure(parsed) {
      if (!mapping) {
        return;
      }
      const index = mapping.indexDocument(parsed);
      state.passages = index.passages;
      state.blocks = index.blocks;
      state.previewByStart = bindPreviewElements();
      state.activeEl = null;
      syncActiveFromCaret(false); // highlight, but don't yank the preview around
    }

    function clearStructure() {
      state.passages = [];
      state.blocks = [];
      state.previewByStart = {};
      if (state.activeEl) {
        state.activeEl.classList.remove("active-block");
      }
      state.activeEl = null;
    }

    // Bind each passage's source-start offset to its rendered preview element.
    // render.js stamps data-source-start with the same full-buffer offset the
    // mapping holds, so the join is by value (first element wins on a collision).
    function bindPreviewElements() {
      const map = {};
      const nodes = els.preview.querySelectorAll("[data-source-start]");
      for (let i = 0; i < nodes.length; i++) {
        const start = nodes[i].getAttribute("data-source-start");
        if (start != null && map[start] === undefined) {
          map[start] = nodes[i];
        }
      }
      return map;
    }

    function elementForEntry(entry) {
      if (!entry) {
        return null;
      }
      return state.previewByStart[String(entry.start)] || null;
    }

    function setActiveElement(el) {
      if (state.activeEl === el) {
        return;
      }
      if (state.activeEl) {
        state.activeEl.classList.remove("active-block");
      }
      state.activeEl = el || null;
      if (state.activeEl) {
        state.activeEl.classList.add("active-block");
      }
    }

    // caret -> preview. Highlight the passage the caret sits in (nearest
    // preceding in a gap, §4.5). `reveal` scrolls it into view, but only on an
    // explicit caret move and only when it isn't already visible — never on
    // every keystroke (§4.2), which would make the preview twitch.
    function syncActiveFromCaret(reveal) {
      if (!mapping || !state.passages.length) {
        setActiveElement(null);
        return;
      }
      const entry = mapping.blockAtOffset(state.passages, els.editor.selectionStart);
      const el = elementForEntry(entry);
      setActiveElement(el);
      if (reveal && el && !isInPreviewViewport(el)) {
        el.scrollIntoView({ block: "nearest" });
      }
    }

    function isInPreviewViewport(el) {
      const box = els.preview.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    }

    // preview -> caret. Click a preview block: move the NATIVE caret to that
    // block's source start. Clicking a gap / unaddressable region is a no-op.
    function jumpFromPreviewClick(event) {
      let node = event.target;
      while (node && node !== els.preview &&
             !(node.getAttribute && node.getAttribute("data-source-start") != null)) {
        node = node.parentNode;
      }
      if (!node || node === els.preview) {
        return;
      }
      const start = Number(node.getAttribute("data-source-start"));
      if (!Number.isFinite(start)) {
        return;
      }
      const bounded = Math.max(0, Math.min(start, els.editor.value.length));
      els.editor.focus();
      try {
        els.editor.setSelectionRange(bounded, bounded);
      } catch (error) {
        /* detached node; ignore */
      }
      syncActiveFromCaret(true);
    }

    // source scroll -> preview scroll (one-way, §4.4). Estimate the first visible
    // source line from the textarea's scrollTop and line height, find the passage
    // there, and align its preview element to the preview's top. Anchored to a
    // real element, so uneven block heights don't drift; one-way, so no feedback
    // latch is needed.
    function syncScrollFromSource() {
      if (!mapping || !state.passages.length) {
        return;
      }
      const lineHeight = measuredLineHeight();
      if (!lineHeight) {
        return;
      }
      const topLine = Math.floor(els.editor.scrollTop / lineHeight);
      const offset = offsetOfLine(els.editor.value, topLine);
      const el = elementForEntry(mapping.blockAtOffset(state.passages, offset));
      if (!el) {
        return;
      }
      const box = els.preview.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      els.preview.scrollTop += rect.top - box.top;
    }

    function measuredLineHeight() {
      const computed = window.getComputedStyle(els.editor);
      const fromLine = parseFloat(computed.lineHeight);
      if (Number.isFinite(fromLine) && fromLine > 0) {
        return fromLine;
      }
      const fromSize = parseFloat(computed.fontSize);
      return Number.isFinite(fromSize) && fromSize > 0 ? fromSize * 1.65 : 0;
    }

    // select-node (§6): set the native selection to the source span of the
    // top-level block at the caret. Uses the prebuilt command index — no reparse.
    function selectBlockAtCaret() {
      if (!mapping || !state.blocks.length) {
        return;
      }
      const entry = mapping.blockAtOffset(state.blocks, els.editor.selectionStart);
      if (!entry) {
        return;
      }
      els.editor.focus();
      try {
        els.editor.setSelectionRange(
          Math.min(entry.start, els.editor.value.length),
          Math.min(entry.end, els.editor.value.length)
        );
      } catch (error) {
        /* ignore */
      }
      syncActiveFromCaret(true);
    }

    // Double-click a preview passage selects its whole source span (§6).
    function selectFromPreviewDblClick(event) {
      let node = event.target;
      while (node && node !== els.preview &&
             !(node.getAttribute && node.getAttribute("data-source-start") != null)) {
        node = node.parentNode;
      }
      if (!node || node === els.preview) {
        return;
      }
      const start = Number(node.getAttribute("data-source-start"));
      const end = Number(node.getAttribute("data-source-end"));
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return;
      }
      els.editor.focus();
      try {
        els.editor.setSelectionRange(
          Math.min(start, els.editor.value.length),
          Math.min(end, els.editor.value.length)
        );
      } catch (error) {
        /* ignore */
      }
      syncActiveFromCaret(false);
    }

    function offsetOfLine(text, lineIndex) {
      if (lineIndex <= 0) {
        return 0;
      }
      let seen = 0;
      let from = 0;
      while (seen < lineIndex) {
        const nl = text.indexOf("\n", from);
        if (nl === -1) {
          return text.length;
        }
        from = nl + 1;
        seen += 1;
      }
      return from;
    }

    // ----- commands (SCRIPTORIUM-EDITOR.md §5) ----------------------------
    // Run an AST-aware command: the pure function proposes a verified edit; we
    // apply it to the textarea preserving the NATIVE undo stack (§5.4) and let
    // the normal refresh repaint. If the oracle refused, we say so and touch
    // nothing.
    function runCommand(id) {
      if (!commands || els.editor.disabled) {
        return;
      }
      const text = els.editor.value;
      const result = commands.apply(id, text, els.editor.selectionStart, els.editor.selectionEnd, parse);
      if (!result || !result.ok) {
        setStatus((result && result.reason) || "Command not applicable here.", "error");
        return;
      }
      applyBufferEdit(result.text, result.selectionStart, result.selectionEnd);
      refreshFromBuffer();
      syncActiveFromCaret(true);
    }

    // Apply a new buffer as a MINIMAL diff via execCommand("insertText") so the
    // change enters the textarea's native undo stack — one Ctrl+Z reverses a
    // command (§5.4). Falls back to setRangeText if execCommand is unavailable
    // (correct, but coarser undo).
    function applyBufferEdit(newText, selectionStart, selectionEnd) {
      const old = els.editor.value;
      els.editor.focus();
      if (old !== newText) {
        const max = Math.min(old.length, newText.length);
        let prefix = 0;
        while (prefix < max && old[prefix] === newText[prefix]) {
          prefix += 1;
        }
        let suffix = 0;
        while (
          suffix < max - prefix &&
          old[old.length - 1 - suffix] === newText[newText.length - 1 - suffix]
        ) {
          suffix += 1;
        }
        const from = prefix;
        const to = old.length - suffix;
        const insert = newText.slice(prefix, newText.length - suffix);

        els.editor.setSelectionRange(from, to);
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, insert);
        } catch (error) {
          inserted = false;
        }
        if (!inserted || els.editor.value !== newText) {
          // execCommand unavailable / blocked: fall back (coarser undo).
          els.editor.value = newText;
        }
      }
      const bounded = Math.min(selectionStart, els.editor.value.length);
      const boundedEnd = Math.min(selectionEnd, els.editor.value.length);
      try {
        els.editor.setSelectionRange(bounded, boundedEnd);
      } catch (error) {
        /* ignore */
      }
    }

    // ----- save state -----------------------------------------------------
    function isDirty() {
      return els.editor.value !== state.loadedText;
    }

    function updateSaveState() {
      const loaded = state.current.slug != null && state.current.n != null;
      els.saveButton.disabled = state.saving || !loaded || !isDirty();
      if (!state.saving) {
        if (loaded && isDirty()) {
          setStatus("Unsaved changes", "dirty");
        } else if (loaded) {
          setStatus("Saved", "ok");
        } else {
          setStatus("", "");
        }
      }
    }

    function setStatus(text, kind) {
      els.saveStatus.textContent = text;
      els.saveStatus.className = "save-status" + (kind ? " status-" + kind : "");
    }

    // ----- server API (shared contract) -----------------------------------
    function api(path, options) {
      return fetch(path, options).then(function handle(response) {
        if (!response.ok) {
          return response.text().then(function asText(body) {
            throw new Error("HTTP " + response.status + (body ? ": " + body : ""));
          });
        }
        return response.json();
      });
    }

    function loadEssays() {
      return api("/api/essays").then(function applyEssays(payload) {
        const essays = (payload && Array.isArray(payload.essays)) ? payload.essays : [];
        state.essays = essays;
        state.essayBySlug = {};
        essays.forEach(function index(essay) {
          if (essay && essay.slug) {
            state.essayBySlug[essay.slug] = essay;
          }
        });
        populateEssaySelect();
      });
    }

    function populateEssaySelect() {
      clearChildren(els.essaySelect);
      if (!state.essays.length) {
        els.essaySelect.appendChild(makeOption("", "No essays"));
        els.essaySelect.disabled = true;
        return;
      }
      els.essaySelect.disabled = false;
      els.essaySelect.appendChild(makeOption("", "Choose essay…"));
      state.essays.forEach(function addEssay(essay) {
        els.essaySelect.appendChild(makeOption(essay.slug, essay.title || essay.slug));
      });
    }

    function populateSectionSelect(essay) {
      clearChildren(els.sectionSelect);
      const order = (essay && Array.isArray(essay.section_order)) ? essay.section_order : [];
      if (!order.length) {
        els.sectionSelect.appendChild(makeOption("", "No sections"));
        els.sectionSelect.disabled = true;
        return;
      }
      els.sectionSelect.disabled = false;
      els.sectionSelect.appendChild(makeOption("", "Choose section…"));
      const meta = (essay && essay.section_meta) || {};
      order.forEach(function addSection(n) {
        const key = String(n);
        const sectionMeta = meta[key] || meta[n] || {};
        const title = sectionMeta.title ? key + " · " + sectionMeta.title : "Section " + key;
        els.sectionSelect.appendChild(makeOption(key, title));
      });
    }

    function makeOption(value, label) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }

    function loadSection(slug, n) {
      setStatus("Loading…", "busy");
      return api("/api/section?slug=" + encodeURIComponent(slug) + "&n=" + encodeURIComponent(n))
        .then(function applySection(payload) {
          const text = (payload && typeof payload.text === "string") ? payload.text : "";
          state.current = { slug: slug, n: String(n) };
          // The ONLY place we write into the editing surface, and only on an
          // explicit author load — never under the caret while typing.
          els.editor.value = text;
          state.loadedText = text;
          els.editor.disabled = false;
          refreshFromBuffer();
          updateSaveState();
        })
        .catch(function failed(error) {
          setStatus("Load failed: " + error.message, "error");
        });
    }

    function saveSection() {
      if (state.saving || state.current.slug == null || state.current.n == null) {
        return;
      }
      state.saving = true;
      els.saveButton.disabled = true;
      setStatus("Saving…", "busy");

      const body = JSON.stringify({
        slug: state.current.slug,
        n: state.current.n,
        text: els.editor.value,
      });

      api("/api/section", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body,
      }).then(function saved() {
        state.saving = false;
        state.loadedText = els.editor.value;
        setStatus("Saved", "ok");
        updateSaveState();
      }).catch(function failed(error) {
        state.saving = false;
        setStatus("Save failed: " + error.message, "error");
        updateSaveState();
      });
    }

    // ===== command palette + slash menu + find/replace ===================
    // All above the caret (§4): overlays and buffer text-surgery only. The pure
    // brains live in palette.js / find-replace.js (unit-tested); here we own the
    // DOM and map ids to actions that ride the existing oracle-verified commands.
    const palette = window.ScriptoriumPalette || null;
    const findReplace = window.ScriptoriumFindReplace || null;
    const blockOps = window.ScriptoriumBlockOps || null;

    // Block operations (move / duplicate / delete) parse the buffer fresh for an
    // exact top-level block list, then apply the pure transform from block-ops.js.
    function blockOpsBlocks() {
      try {
        const ast2 = parse(els.editor.value);
        return (ast2.children || [])
          .filter(function has(b) { return b.position; })
          .map(function span(b) { return { start: b.position.startOffset, end: b.position.endOffset }; });
      } catch (error) {
        return [];
      }
    }
    function runBlockOp(kind) {
      if (!blockOps || els.editor.disabled) {
        return;
      }
      const blocks = blockOpsBlocks();
      if (!blocks.length) {
        return;
      }
      const caret = els.editor.selectionStart;
      const text = els.editor.value;
      let res;
      if (kind === "up") {
        res = blockOps.move(text, blocks, caret, -1);
      } else if (kind === "down") {
        res = blockOps.move(text, blocks, caret, 1);
      } else if (kind === "duplicate") {
        res = blockOps.duplicate(text, blocks, caret);
      } else if (kind === "delete") {
        res = blockOps.remove(text, blocks, caret);
      } else {
        return;
      }
      if (!res || res.text === text) {
        return;
      }
      applyBufferEdit(res.text, res.caret, res.caret);
      refreshFromBuffer();
      syncActiveFromCaret(true);
    }

    // Caret pixel coordinates via a hidden mirror div (the canonical textarea
    // technique) — used to anchor the slash menu at the caret. Returns viewport
    // coords { top, left, height }.
    function caretCoordinates(el, position) {
      const div = document.createElement("div");
      const computed = window.getComputedStyle(el);
      const s = div.style;
      s.position = "absolute";
      s.visibility = "hidden";
      s.whiteSpace = "pre-wrap";
      s.wordWrap = "break-word";
      s.overflow = "hidden";
      [
        "boxSizing", "width", "height", "borderTopWidth", "borderRightWidth",
        "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight",
        "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight",
        "fontStretch", "fontSize", "lineHeight", "fontFamily", "textAlign",
        "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
      ].forEach(function copyProp(p) {
        s[p] = computed[p];
      });
      const rect = el.getBoundingClientRect();
      s.left = window.scrollX + rect.left + "px";
      s.top = window.scrollY + rect.top + "px";
      div.textContent = el.value.slice(0, position);
      const span = document.createElement("span");
      span.textContent = el.value.slice(position) || ".";
      div.appendChild(span);
      document.body.appendChild(div);
      const top = rect.top + (span.offsetTop - el.scrollTop);
      const left = rect.left + (span.offsetLeft - el.scrollLeft);
      const height = parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) || 16;
      document.body.removeChild(div);
      return { top: top, left: left, height: height };
    }

    function jumpToOffset(offset) {
      const n = Math.max(0, Math.min(Number(offset) || 0, els.editor.value.length));
      els.editor.focus();
      els.editor.setSelectionRange(n, n);
      syncActiveFromCaret(true);
    }

    function blockSnippet(passage) {
      const raw = els.editor.value.slice(passage.start, passage.end).replace(/\s+/g, " ").trim();
      return raw.length > 48 ? raw.slice(0, 48) + "…" : (raw || "(empty)");
    }

    // Render a label with the fuzzy-matched characters wrapped in <mark>.
    function highlightInto(node, label, positions) {
      const set = {};
      (positions || []).forEach(function mark(p) { set[p] = true; });
      for (let i = 0; i < label.length; i += 1) {
        if (set[i]) {
          const m = document.createElement("mark");
          m.className = "cmd-mark";
          m.textContent = label.charAt(i);
          node.appendChild(m);
        } else {
          node.appendChild(document.createTextNode(label.charAt(i)));
        }
      }
    }

    // ---- command palette (Ctrl/Cmd+Shift+P) ----
    let paletteEl = null;
    let paletteInput = null;
    let paletteList = null;
    let paletteItems = [];
    let paletteResults = [];
    let paletteIndex = 0;
    let paletteRunById = {};

    function ensurePaletteDom() {
      if (paletteEl) {
        return;
      }
      paletteEl = document.createElement("div");
      paletteEl.className = "cmd-overlay";
      paletteEl.hidden = true;
      const panel = document.createElement("div");
      panel.className = "cmd-panel";
      paletteInput = document.createElement("input");
      paletteInput.type = "text";
      paletteInput.className = "cmd-input";
      paletteInput.setAttribute("placeholder", "Run a command, jump to a section or block…");
      paletteInput.setAttribute("aria-label", "Command palette");
      paletteList = document.createElement("ul");
      paletteList.className = "cmd-list";
      paletteList.setAttribute("role", "listbox");
      panel.appendChild(paletteInput);
      panel.appendChild(paletteList);
      paletteEl.appendChild(panel);
      document.body.appendChild(paletteEl);
      paletteEl.addEventListener("mousedown", function onBackdrop(event) {
        if (event.target === paletteEl) {
          closePalette();
        }
      });
      paletteInput.addEventListener("input", renderPalette);
      paletteInput.addEventListener("keydown", onPaletteKey);
    }

    function buildPaletteItems() {
      const items = [];
      paletteRunById = {};
      function add(id, label, hint, keywords, run) {
        items.push({ id: id, label: label, hint: hint, keywords: keywords });
        paletteRunById[id] = run;
      }
      if (commands && commands.CATALOG) {
        commands.CATALOG.forEach(function eachCmd(c) {
          add("cmd:" + c.id, c.title || c.label, c.key || "", (c.title || "") + " " + (c.label || ""), function run() {
            runCommand(c.id);
          });
        });
      }
      add("act:save", "Save section", "Ctrl/Cmd+S", "save write disk", saveSection);
      add("act:select", "Select current block", "Ctrl/Cmd+Alt+L", "select node block", selectBlockAtCaret);
      if (blockOps) {
        add("blk:up", "Move block up", "Alt+↑", "move block up reorder", function run() { runBlockOp("up"); });
        add("blk:down", "Move block down", "Alt+↓", "move block down reorder", function run() { runBlockOp("down"); });
        add("blk:dup", "Duplicate block", "", "duplicate block copy", function run() { runBlockOp("duplicate"); });
        add("blk:del", "Delete block", "", "delete remove block", function run() { runBlockOp("delete"); });
      }
      if (findReplace) {
        add("act:find", "Find…", "Ctrl/Cmd+F", "find search", function run() { openFindBar(false); });
        add("act:replace", "Find & replace…", "Ctrl/Cmd+H", "replace substitute", function run() { openFindBar(true); });
      }
      add("act:focus", "Toggle focus mode", "", "focus typewriter dim distraction", toggleFocusMode);
      add("act:autosave", "Toggle autosave", "", "autosave auto save idle", toggleAutosave);
      add("act:prev-section", "Previous section", "", "previous prev section navigate", function run() { gotoAdjacentSection(-1); });
      add("act:next-section", "Next section", "", "next section navigate", function run() { gotoAdjacentSection(1); });
      const essay = state.current.slug ? state.essayBySlug[state.current.slug] : null;
      if (essay && Array.isArray(essay.section_order)) {
        essay.section_order.forEach(function eachSection(n) {
          const meta = essay.section_meta && essay.section_meta[String(n)];
          const title = meta && meta.title ? meta.title : "Section " + n;
          add("sec:" + n, "Go to " + n + " — " + title, "section", "section go " + n + " " + title, function run() {
            loadSection(state.current.slug, String(n));
          });
        });
      }
      (state.passages || []).forEach(function eachBlock(p, i) {
        const snippet = blockSnippet(p);
        add("blk:" + i, "↦ " + snippet, p.type, "block jump " + p.type + " " + snippet, function run() {
          jumpToOffset(p.start);
        });
      });
      return items;
    }

    function openPalette() {
      if (!palette) {
        return;
      }
      ensurePaletteDom();
      paletteItems = buildPaletteItems();
      paletteInput.value = "";
      paletteEl.hidden = false;
      renderPalette();
      paletteInput.focus();
    }

    function closePalette() {
      if (paletteEl && !paletteEl.hidden) {
        paletteEl.hidden = true;
        els.editor.focus();
      }
    }

    function renderPalette() {
      paletteResults = palette.filter(paletteInput.value, paletteItems);
      paletteIndex = 0;
      paletteList.innerHTML = "";
      paletteResults.slice(0, 50).forEach(function renderRow(r, i) {
        const li = document.createElement("li");
        li.className = "cmd-row" + (i === paletteIndex ? " cmd-row-active" : "");
        li.setAttribute("role", "option");
        const labelEl = document.createElement("span");
        labelEl.className = "cmd-label";
        highlightInto(labelEl, r.label, r.positions);
        li.appendChild(labelEl);
        const hint = paletteItemHint(r.id);
        if (hint) {
          const h = document.createElement("span");
          h.className = "cmd-hint";
          h.textContent = hint;
          li.appendChild(h);
        }
        li.addEventListener("mousedown", function onPick(event) {
          event.preventDefault();
          paletteIndex = i;
          acceptPalette();
        });
        paletteList.appendChild(li);
      });
    }

    function paletteItemHint(id) {
      for (let i = 0; i < paletteItems.length; i += 1) {
        if (paletteItems[i].id === id) {
          return paletteItems[i].hint || "";
        }
      }
      return "";
    }

    function movePalette(delta) {
      const max = Math.min(paletteResults.length, 50);
      if (!max) {
        return;
      }
      paletteIndex = (paletteIndex + delta + max) % max;
      const rows = paletteList.children;
      for (let i = 0; i < rows.length; i += 1) {
        rows[i].className = "cmd-row" + (i === paletteIndex ? " cmd-row-active" : "");
      }
      if (rows[paletteIndex]) {
        rows[paletteIndex].scrollIntoView({ block: "nearest" });
      }
    }

    function acceptPalette() {
      const r = paletteResults[paletteIndex];
      closePalette();
      if (r && paletteRunById[r.id]) {
        paletteRunById[r.id]();
      }
    }

    function onPaletteKey(event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        movePalette(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        movePalette(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        acceptPalette();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    }

    // ---- slash menu (type "/" at a line/word start) ----
    let slashEl = null;
    let slashList = null;
    let slashResults = [];
    let slashIndex = 0;
    let slashCtx = null;
    let slashItems = null;

    // The block-ish commands worth a slash shortcut, by catalog id.
    const SLASH_IDS = ["heading-1", "heading-2", "heading-3", "heading-0", "pull-quote", "blockquote", "divider", "link"];

    function slashCommandItems() {
      if (slashItems) {
        return slashItems;
      }
      slashItems = [];
      if (commands && commands.CATALOG) {
        const byId = {};
        commands.CATALOG.forEach(function index(c) { byId[c.id] = c; });
        SLASH_IDS.forEach(function pick(id) {
          const c = byId[id];
          if (c) {
            slashItems.push({ id: id, label: c.title || c.label, keywords: (c.title || "") + " " + id });
          }
        });
      }
      return slashItems;
    }

    function ensureSlashDom() {
      if (slashEl) {
        return;
      }
      slashEl = document.createElement("div");
      slashEl.className = "cmd-slash";
      slashEl.hidden = true;
      slashList = document.createElement("ul");
      slashList.className = "cmd-list";
      slashList.setAttribute("role", "listbox");
      slashEl.appendChild(slashList);
      document.body.appendChild(slashEl);
    }

    function slashOpen() {
      return slashEl && !slashEl.hidden;
    }

    function hideSlash() {
      if (slashEl) {
        slashEl.hidden = true;
      }
      slashCtx = null;
    }

    function updateSlash() {
      if (!palette || !commands || els.editor.disabled) {
        return;
      }
      const ctx = palette.slashContext(els.editor.value, els.editor.selectionStart);
      if (!ctx.active) {
        hideSlash();
        return;
      }
      const results = palette.filter(ctx.query, slashCommandItems());
      if (!results.length) {
        hideSlash();
        return;
      }
      ensureSlashDom();
      slashCtx = ctx;
      slashResults = results;
      slashIndex = 0;
      renderSlash();
      const coords = caretCoordinates(els.editor, ctx.start);
      slashEl.style.left = Math.round(coords.left) + "px";
      slashEl.style.top = Math.round(coords.top + coords.height) + "px";
      slashEl.hidden = false;
    }

    function renderSlash() {
      slashList.innerHTML = "";
      slashResults.forEach(function renderRow(r, i) {
        const li = document.createElement("li");
        li.className = "cmd-row" + (i === slashIndex ? " cmd-row-active" : "");
        li.setAttribute("role", "option");
        const labelEl = document.createElement("span");
        labelEl.className = "cmd-label";
        highlightInto(labelEl, r.label, r.positions);
        li.appendChild(labelEl);
        li.addEventListener("mousedown", function onPick(event) {
          event.preventDefault();
          slashIndex = i;
          acceptSlash();
        });
        slashList.appendChild(li);
      });
    }

    function moveSlash(delta) {
      const max = slashResults.length;
      if (!max) {
        return;
      }
      slashIndex = (slashIndex + delta + max) % max;
      const rows = slashList.children;
      for (let i = 0; i < rows.length; i += 1) {
        rows[i].className = "cmd-row" + (i === slashIndex ? " cmd-row-active" : "");
      }
    }

    function acceptSlash() {
      const r = slashResults[slashIndex];
      if (!r || !slashCtx) {
        hideSlash();
        return;
      }
      const id = r.id;
      const caret = els.editor.selectionStart;
      // Remove the typed "/query" first, leaving the caret where it was, then run
      // the command so it operates on a clean block (no stray slash text).
      const value = els.editor.value;
      const cleaned = value.slice(0, slashCtx.start) + value.slice(caret);
      applyBufferEdit(cleaned, slashCtx.start, slashCtx.start);
      hideSlash();
      refreshFromBuffer();
      runCommand(id);
    }

    function onSlashKey(event) {
      if (!slashOpen()) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        moveSlash(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveSlash(-1);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        acceptSlash();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideSlash();
      }
    }

    // ---- find & replace (Ctrl/Cmd+F / Ctrl/Cmd+H) ----
    let findBar = null;
    let findInput = null;
    let replaceInput = null;
    let replaceRow = null;
    let findCountEl = null;
    let findMatchesCache = [];
    const findOptions = { caseSensitive: false, wholeWord: false, regex: false };

    function ensureFindDom() {
      if (findBar) {
        return;
      }
      findBar = document.createElement("div");
      findBar.className = "find-bar";
      findBar.hidden = true;

      const findRow = document.createElement("div");
      findRow.className = "find-row";
      findInput = document.createElement("input");
      findInput.type = "text";
      findInput.className = "find-field";
      findInput.setAttribute("placeholder", "Find");
      findInput.setAttribute("aria-label", "Find");
      findCountEl = document.createElement("span");
      findCountEl.className = "find-count";
      findRow.appendChild(findInput);
      findRow.appendChild(findCountEl);
      findRow.appendChild(makeToggle("Aa", "caseSensitive", "Match case"));
      findRow.appendChild(makeToggle("|w|", "wholeWord", "Whole word"));
      findRow.appendChild(makeToggle(".*", "regex", "Regular expression"));
      findRow.appendChild(makeFindBtn("‹", "Previous match", function () { gotoMatch(false); }));
      findRow.appendChild(makeFindBtn("›", "Next match", function () { gotoMatch(true); }));
      findRow.appendChild(makeFindBtn("✕", "Close (Esc)", closeFindBar));

      replaceRow = document.createElement("div");
      replaceRow.className = "find-row";
      replaceInput = document.createElement("input");
      replaceInput.type = "text";
      replaceInput.className = "find-field";
      replaceInput.setAttribute("placeholder", "Replace");
      replaceInput.setAttribute("aria-label", "Replace");
      replaceRow.appendChild(replaceInput);
      replaceRow.appendChild(makeFindBtn("Replace", "Replace current match", replaceCurrent));
      replaceRow.appendChild(makeFindBtn("All", "Replace all", replaceAllMatches));

      findBar.appendChild(findRow);
      findBar.appendChild(replaceRow);
      // Anchor the bar at the top of the editor pane.
      els.editor.parentNode.insertBefore(findBar, els.editor);

      findInput.addEventListener("input", recomputeFind);
      findInput.addEventListener("keydown", onFindKey);
      replaceInput.addEventListener("keydown", onFindKey);
    }

    function makeToggle(label, optKey, title) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "find-toggle";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", function toggle() {
        findOptions[optKey] = !findOptions[optKey];
        b.className = "find-toggle" + (findOptions[optKey] ? " find-toggle-on" : "");
        recomputeFind();
      });
      return b;
    }

    function makeFindBtn(label, title, fn) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "find-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    }

    function openFindBar(withReplace) {
      if (!findReplace) {
        return;
      }
      ensureFindDom();
      replaceRow.hidden = !withReplace;
      findBar.hidden = false;
      const sel = els.editor.value.slice(els.editor.selectionStart, els.editor.selectionEnd);
      if (sel && sel.indexOf("\n") === -1) {
        findInput.value = sel;
      }
      recomputeFind();
      findInput.focus();
      findInput.select();
    }

    function closeFindBar() {
      if (findBar && !findBar.hidden) {
        findBar.hidden = true;
        els.editor.focus();
      }
    }

    function recomputeFind() {
      const q = findInput.value;
      const invalid = q !== "" && !findReplace.isValid(q, findOptions);
      findInput.classList.toggle("find-invalid", invalid);
      findMatchesCache = invalid ? [] : findReplace.findMatches(els.editor.value, q, findOptions);
      findCountEl.textContent = !q ? "" : invalid ? "bad regex" : findMatchesCache.length + " match" + (findMatchesCache.length === 1 ? "" : "es");
    }

    function gotoMatch(forward) {
      if (!findMatchesCache.length) {
        return;
      }
      const caret = forward ? els.editor.selectionEnd : els.editor.selectionStart;
      const idx = findReplace.nextMatchIndex(findMatchesCache, caret, forward);
      const m = findMatchesCache[idx];
      if (!m) {
        return;
      }
      els.editor.focus();
      els.editor.setSelectionRange(m.start, m.end);
      syncActiveFromCaret(true);
      // Keep the find field usable: refocus it but the selection stays visible.
      findInput.focus();
    }

    function replaceCurrent() {
      if (!findMatchesCache.length) {
        return;
      }
      const start = els.editor.selectionStart;
      const end = els.editor.selectionEnd;
      // Only replace when the selection is exactly a current match.
      const onMatch = findMatchesCache.some(function eq(m) { return m.start === start && m.end === end; });
      if (!onMatch || start === end) {
        gotoMatch(true);
        return;
      }
      const result = findReplace.replaceRange(els.editor.value, start, end, replaceInput.value);
      applyBufferEdit(result.text, result.selectionStart, result.selectionEnd);
      refreshFromBuffer();
      recomputeFind();
      gotoMatch(true);
    }

    function replaceAllMatches() {
      const res = findReplace.replaceAll(els.editor.value, findInput.value, replaceInput.value, findOptions);
      if (!res.count) {
        setStatus("Nothing to replace.", "");
        return;
      }
      const caret = Math.min(els.editor.selectionStart, res.text.length);
      applyBufferEdit(res.text, caret, caret);
      refreshFromBuffer();
      recomputeFind();
      setStatus("Replaced " + res.count + " match" + (res.count === 1 ? "" : "es") + ".", "ok");
    }

    function onFindKey(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        gotoMatch(!event.shiftKey);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeFindBar();
      }
    }

    // ---- focus / typewriter mode ----
    let focusMode = false;
    function toggleFocusMode() {
      focusMode = !focusMode;
      document.body.classList.toggle("focus-mode", focusMode);
      setStatus(focusMode ? "Focus mode on" : "Focus mode off", "");
      if (focusMode) {
        typewriterCenter();
      }
    }
    function typewriterCenter() {
      if (!focusMode) {
        return;
      }
      const c = caretCoordinates(els.editor, els.editor.selectionStart);
      const rect = els.editor.getBoundingClientRect();
      const relTop = c.top - rect.top + els.editor.scrollTop;
      els.editor.scrollTop = Math.max(0, relTop - els.editor.clientHeight / 2);
    }

    // ---- autosave (off by default) ----
    let autosaveOn = false;
    let autosaveTimer = null;
    function toggleAutosave() {
      autosaveOn = !autosaveOn;
      setStatus(autosaveOn ? "Autosave on" : "Autosave off", "");
    }
    function scheduleAutosave() {
      if (!autosaveOn) {
        return;
      }
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(function fire() {
        if (autosaveOn && !state.saving && state.current.slug != null && state.current.n != null && isDirty()) {
          saveSection();
        }
      }, 1500);
    }

    // ---- jump to the adjacent section in the current essay ----
    function gotoAdjacentSection(dir) {
      const essay = state.current.slug ? state.essayBySlug[state.current.slug] : null;
      if (!essay || !Array.isArray(essay.section_order)) {
        return;
      }
      const order = essay.section_order.map(String);
      const idx = order.indexOf(String(state.current.n));
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= order.length) {
        return;
      }
      loadSection(state.current.slug, order[j]);
    }

    // ----- wiring ---------------------------------------------------------
    els.editor.addEventListener("input", scheduleRefresh);
    els.editor.addEventListener("input", scheduleAutosave);
    els.editor.addEventListener("keyup", typewriterCenter);
    els.editor.addEventListener("click", typewriterCenter);
    if (palette) {
      els.editor.addEventListener("input", updateSlash);
      els.editor.addEventListener("keydown", onSlashKey);
      els.editor.addEventListener("blur", hideSlash);
    }
    if (blockOps) {
      // Alt+↑ / Alt+↓ move the caret's block (familiar from other editors).
      els.editor.addEventListener("keydown", function onBlockMove(event) {
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          runBlockOp(event.key === "ArrowUp" ? "up" : "down");
        }
      });
    }

    // Structural sync (§4). Caret moves (click/keyup) highlight + reveal the
    // active block; clicking the preview moves the native caret; scrolling the
    // source drives the preview. All native-caret-only.
    els.preview.addEventListener("click", jumpFromPreviewClick);
    els.preview.addEventListener("dblclick", selectFromPreviewDblClick);
    els.editor.addEventListener("click", function onEditorClick() {
      syncActiveFromCaret(true);
    });
    els.editor.addEventListener("keyup", function onEditorKeyup() {
      syncActiveFromCaret(true);
    });
    els.editor.addEventListener("scroll", throttleFrame(syncScrollFromSource));

    // Toolbar (§5.5): reveal it only if the commands module loaded, then run a
    // command by its data-cmd. mousedown+preventDefault keeps the textarea's
    // selection alive across the click so the command sees what's selected.
    if (commands && els.toolbar) {
      els.toolbar.hidden = false;
      els.toolbar.addEventListener("mousedown", function keepSelection(event) {
        if (event.target.closest("[data-cmd]")) {
          event.preventDefault();
        }
      });
      els.toolbar.addEventListener("click", function onToolClick(event) {
        const button = event.target.closest("[data-cmd]");
        if (button) {
          runCommand(button.getAttribute("data-cmd"));
        }
      });
    }

    els.essaySelect.addEventListener("change", function onEssayChange() {
      const slug = els.essaySelect.value;
      const essay = state.essayBySlug[slug];
      state.current = { slug: null, n: null };
      els.sectionSelect.value = "";
      populateSectionSelect(essay);
      updateSaveState();
    });

    els.sectionSelect.addEventListener("change", function onSectionChange() {
      const slug = els.essaySelect.value;
      const n = els.sectionSelect.value;
      if (!slug || !n) {
        return;
      }
      loadSection(slug, n);
    });

    els.saveButton.addEventListener("click", saveSection);

    // Keyboard chords. Ctrl/Cmd+S saves; the rest run AST-aware commands. We
    // intercept ONLY these chords — native undo/redo, selection, IME, and plain
    // typing are left entirely to the textarea (§4 caret boundary). Headings use
    // Ctrl/Cmd+Alt+0..3 because browsers eat plain Ctrl+1..3 for tab-switching.
    document.addEventListener("keydown", function onKey(event) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) {
        return;
      }
      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        saveSection();
        return;
      }

      // Command palette / find / replace — work regardless of the commands
      // module, and only with the non-Alt modifier so they don't shadow the
      // Alt block chords.
      if (event.shiftKey && key === "p") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (!event.altKey && key === "f") {
        event.preventDefault();
        openFindBar(false);
        return;
      }
      if (!event.altKey && key === "h") {
        event.preventDefault();
        openFindBar(true);
        return;
      }

      if (!commands || els.editor.disabled) {
        return;
      }

      let commandId = null;
      if (event.altKey) {
        // Alt chords: headings + block toggles + select-node.
        if (/^[0-3]$/.test(event.key)) {
          commandId = "heading-" + event.key;
        } else if (key === "q") {
          commandId = "pull-quote";
        } else if (key === "b") {
          commandId = "blockquote";
        } else if (key === "h") {
          commandId = "divider";
        } else if (key === "l") {
          event.preventDefault();
          selectBlockAtCaret();
          return;
        }
      } else {
        // Plain mod chords: inline formatting + link.
        if (key === "b") {
          commandId = "strong";
        } else if (key === "i") {
          commandId = "emphasis";
        } else if (key === "`") {
          commandId = "code";
        } else if (key === "k") {
          commandId = "link";
        }
      }

      if (commandId) {
        event.preventDefault();
        runCommand(commandId);
      }
    });

    // ----- boot -----------------------------------------------------------
    refreshFromBuffer(); // empty buffer → clean preview/diagnostics baseline

    // Opt-in wasm engine: load asynchronously so the editor is instantly usable
    // on JS; on success swap `parse` and repaint (the AST is identical, so this
    // is seamless). A load failure simply leaves us on JS.
    if (wantsWasmEngine() && window.ScriptoriumWasmParser) {
      window.ScriptoriumWasmParser.load("scriptorium_parser.wasm").then(function ready() {
        parse = function parseWasm(source) {
          return window.ScriptoriumWasmParser.parseDocument(source);
        };
        document.body.setAttribute("data-parse-engine", "wasm");
        refreshFromBuffer();
        // eslint-disable-next-line no-console
        console.info("[scriptorium] parse engine: wasm (Rust, oracle-validated byte-identical).");
      }).catch(function failed(error) {
        document.body.setAttribute("data-parse-engine", "js (wasm failed)");
        // eslint-disable-next-line no-console
        console.warn("[scriptorium] wasm engine failed to load; staying on JS:", error);
      });
    } else {
      document.body.setAttribute("data-parse-engine", "js");
    }

    loadEssays().catch(function essaysFailed(error) {
      clearChildren(els.essaySelect);
      els.essaySelect.appendChild(makeOption("", "Server offline"));
      els.essaySelect.disabled = true;
      setStatus("Could not reach the author server: " + error.message, "error");
    });
  });

  function renderFatal(els, message) {
    if (els && els.preview) {
      clearChildren(els.preview);
      const box = document.createElement("p");
      box.className = "preview-error";
      box.textContent = message;
      els.preview.appendChild(box);
    }
    if (els && els.editor) {
      els.editor.disabled = true;
    }
  }
})();
