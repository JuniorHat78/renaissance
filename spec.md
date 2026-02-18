# Renaissance Essay Platform Spec

Date: 2026-02-18  
Status: Approved spec only (pre-implementation update)

## 1. Product Model

### 1.1 Identity
- `Renaissance` is the publication/archive.
- `Etching God into Sand` is one essay in that archive.
- Sections are ordered; metadata titles/subtitles are optional overlays.

### 1.2 Search Experience Model
- Inline search is for fast preview and discovery.
- Full search analysis happens on dedicated results page.
- Search outputs and highlights are shareable by URL.

## 2. Information Architecture

### 2.1 Pages
- `index.html`: archive home + global inline preview search.
- `essay.html?essay=<slug>`: essay landing + local inline preview search.
- `search.html`: full search results page (global or scoped).
- `section.html?essay=<slug>&section=<n>`: section reader with deep-link highlight behavior.

### 2.2 Search Surface Placement
- Home: compact search input in header/top-right.
- Essay: compact search input in hero/top-right.
- Advanced controls collapsed by default.

## 3. Inline Preview Search Contract

### 3.1 Scope
- Home inline search defaults to global (`all essays`) with optional scope selector.
- Essay inline search is fixed to current essay scope.

### 3.2 Preview Structure
- Results grouped by section.
- Show section-level hit count.
- Show first N occurrences per section (`preview_limit`, default `3`).
- Include `View Full Results` CTA.

### 3.3 CTA Behavior
- CTA routes to `search.html` and carries query/options state.
- No full pagination in inline preview area.

## 4. Full Results Page Contract (`search.html`)

### 4.1 Inputs
- URL state supported:
  - `q`
  - `scope`
  - `mode`
  - `sort`
  - `case`
  - `page`
  - `page_size`

### 4.2 Controls
- Match modes: `contains`, `exact_phrase`, `fuzzy`.
- Sort modes: `reading_order`, `relevance`.
- Scope: `all` or essay slug.
- Case-sensitive toggle.
- Pagination: `Previous` / `Next`.
- Page size: `25`, `50`, `100` (default `50`).

## 5. Query and Ranking Rules

### 5.1 Match Unit
- One occurrence equals one result item.
- Grouping/viewing layer may summarize by section, but canonical hit unit remains occurrence.

### 5.2 Sorting
- `reading_order`: essay order, section order, in-text occurrence order.
- `relevance`: exact phrase > exact token > fuzzy token; ties resolved by reading order.

### 5.3 Fuzzy
- Typo-tolerant, lightweight client-side matching.
- Fuzzy default is off.
- UI must indicate when fuzzy mode is active.

## 6. Shareable Result and Highlight Links

### 6.1 Occurrence Deep Links
- Format:
  - `section.html?essay=<slug>&section=<n>&q=<term>&occ=<k>`
- Behavior:
  - resolve k-th occurrence of query in section
  - scroll to match
  - apply visible highlight state

### 6.2 Manual Text Selection Links
- Add `Copy Link to Highlight` action for user-selected text.
- Include robust fallback params (example: `hl` + context tokens) to re-find highlight.

### 6.3 Chromium Text Fragment Support
- Generate Chromium-friendly links using `#:~:text=...` when possible.
- Also generate/retain fallback params for non-Chromium environments.

### 6.4 Anchor Priority
- If multiple anchor hints exist, resolve in order:
  1) explicit highlight payload (`p`, `r`, `hl` / selection payload)
  2) `occ`
  3) plain `q` (no forced anchor target)

### 6.5 Contextual Share Trigger (Section Reader)
- Section reader exposes contextual highlight-share actions when user selects text in `#section-content`.
- Desktop behavior:
  - show a floating `Copy highlight link` action near selected text.
- Mobile behavior:
  - show a fixed bottom mini action bar for the same action.
- Existing top-page `Copy Link to Highlight` remains available as fallback.
- Action must reuse existing share payload contract:
  - Chromium `#:~:text=...`
  - fallback query params (`hl`, optional `hlp`, `hls`).

### 6.6 Compact Source-Link Anchors
- Section source links may use compact anchors to reduce URL length:
  - `p=<start>-<end>` for full paragraph range selections.
  - `r=<start>-<end>` for contiguous character-offset selections (base36).
- Existing text payload anchors (`hl`, optional `hlp`, `hls`) remain supported for backward compatibility.

### 6.7 Source URL Base Resolution
- Source links generated from selection should use:
  - current `http/https` origin when served from web context
  - canonical public URL as fallback when runtime is `file://` (if canonical URL is available)
- Local filesystem paths should not be preferred in copied source links when public canonical base exists.

## 7. URL State and Share Stability

- Search state must round-trip via URL.
- Refresh and shared links must restore same state.
- Full results and section deep-links must be deterministic.

## 8. UI Constraints and Polish Requirements

- Preserve warm rust / warm charcoal visual language.
- Keep search controls compact and non-dashboard-like.
- Improve select/dropdown styling to match theme.
- Fix checkbox alignment for case-sensitive control.
- Maintain visual hierarchy and spacing consistency on mobile and desktop.

## 9. Accessibility and Interaction

- Keyboard-accessible controls, pagination, and copy-link actions.
- Clear focus-visible states.
- ARIA live regions for async search result updates.
- Highlight target should be focusable or otherwise navigably announced.
- Non-color cues required for active state and selected hits.
- Contextual share action dismisses on collapsed selection or `Esc`.
- Native browser context menu remains untouched (no custom right-click replacement).

## 10. Runtime and Encoding Requirements

- Must work in:
  - `http://localhost` static server mode
  - `file://` mode via embedded fallback data
- Must preserve punctuation and symbols (no mojibake artifacts).

## 11. Non-Goals (This Phase)

- Backend search index service.
- Search analytics dashboards.
- Semantic/vector retrieval.
- CMS/editor authoring workflows.

## 12. Acceptance Criteria

1. Inline search on home and essay pages shows grouped preview-only hits with configurable preview cap.
2. `View Full Results` from inline surfaces opens `search.html` with preserved query/options.
3. `search.html` supports full controls + pagination and restores state from URL.
4. `occ` links land on correct in-section occurrence and visibly highlight target.
5. Manual highlight links are copyable and reopen to matched text.
6. Chromium text-fragment links work where supported and fallback links work where not.
7. UI polish pass resolves dropdown and checkbox alignment issues.
8. Behavior remains correct in both `http://` and `file://` modes.
9. In long sections, text can be selected and shared without scrolling to top controls.
