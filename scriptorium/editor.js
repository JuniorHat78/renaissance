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
        parsed = ast.parseDocument(source);
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

    // ----- wiring ---------------------------------------------------------
    els.editor.addEventListener("input", scheduleRefresh);

    // Structural sync (§4). Caret moves (click/keyup) highlight + reveal the
    // active block; clicking the preview moves the native caret; scrolling the
    // source drives the preview. All native-caret-only.
    els.preview.addEventListener("click", jumpFromPreviewClick);
    els.editor.addEventListener("click", function onEditorClick() {
      syncActiveFromCaret(true);
    });
    els.editor.addEventListener("keyup", function onEditorKeyup() {
      syncActiveFromCaret(true);
    });
    els.editor.addEventListener("scroll", throttleFrame(syncScrollFromSource));

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

    // Ctrl/Cmd+S → save (native textarea undo/redo, selection, IME are all
    // left untouched; we only intercept the save chord).
    document.addEventListener("keydown", function onKey(event) {
      const isSaveChord = (event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S");
      if (isSaveChord) {
        event.preventDefault();
        saveSection();
      }
    });

    // ----- boot -----------------------------------------------------------
    refreshFromBuffer(); // empty buffer → clean preview/diagnostics baseline
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
