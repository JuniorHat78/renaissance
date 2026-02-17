# Renaissance Essay Platform Spec

Date: 2026-02-17  
Status: Approved spec only (no implementation in this step)

## 1. Product Model

### 1.1 Identity
- `Renaissance` is the publication/archive.
- `Etching God into Sand` is one essay in that archive.
- Essay sections are currently unnamed and referenced by order.

### 1.2 Core Experience
- Browse essays from the archive home.
- Open an essay landing page.
- Read essay sections sequentially with long-form typography.
- Search within the current essay with ordered, per-occurrence hits.

## 2. Information Architecture

### 2.1 Pages
- `index.html`: archive home (essay list).
- `essay.html?essay=<slug>`: essay landing + section list + essay-scoped search.
- `section.html?essay=<slug>&section=<n>`: section reader with prev/next navigation.

### 2.2 Navigation
- Global: `Home`.
- Essay context: `Back to Essay`.
- Section navigation: `Previous Section`, `Next Section`.
- Optional action: explicit bottom CTA for `Next Section`.

## 3. Content and Metadata

### 3.1 Canonical Text Source
- Section source text files remain canonical.
- Current essay source directory remains `raw/` unless migrated later.

### 3.2 Essay Registry (Proposed)
- `data/essays.json` contains all essays.
- Example fields per essay:
  - `id`
  - `slug`
  - `title`
  - `summary`
  - `published` (boolean/date-ready field)
  - `source_dir`
  - `section_order` (array of numbers)

### 3.3 Optional Section Title Overlay
- Per-essay optional map:
  - `section_titles`: `{ "1": "Optional Name", ... }`
- If absent, UI uses generic section labels.

## 4. Section Labeling Rules

- Default display label: `Section <RomanNumeral>`.
- Fallback if numeral unavailable: `Section <NN>`.
- If `section_titles` exists, prefer custom title while still showing section number context.

## 5. Search Specification

### 5.1 Scope
- Default scope: current essay only.
- No cross-essay aggregation in this phase.

### 5.2 Match Unit
- One occurrence equals one result row.
- A section with many matches yields many result rows.

### 5.3 Ordering
- Primary sort: section order ascending.
- Secondary sort: character index ascending within section.

### 5.4 Result Metadata
- Top summary:
  - total hits across essay
  - number of sections containing hits
- Per-section summary line:
  - section label + count in that section
- Each result row:
  - section label
  - occurrence index within section
  - highlighted snippet
  - link to section route

### 5.5 Query Behavior
- Case-insensitive literal matching for initial release.
- Multi-token behavior can remain logical AND, provided ordering rules above are preserved.

## 6. UI and Theme Constraints

### 6.1 Visual Direction
- Literary print-style UI.
- Warm rust accent in light theme.
- Warm charcoal palette in dark theme.
- No dashboard-heavy cards or oversized search container.

### 6.2 Home (Archive) UI
- Compact search control area.
- Essay list as clear index rows.
- Minimal chrome and restrained ornamentation.

### 6.3 Reader UI
- Centered long-form column.
- Clean line rhythm, readable serif body.
- Restrained controls for navigation.

## 7. Runtime and Encoding Requirements

- Must work in both modes:
  - `http://localhost` static server mode
  - direct `file://` mode via embedded fallback data
- Must preserve punctuation and symbols (no mojibake artifacts).

## 8. Non-Goals (This Phase)

- Cross-essay global search.
- CMS/editor for essay authoring.
- Automated section-title generation.
- Scrollytelling interactions.

## 9. Acceptance Criteria

1. Home page lists essays; `Etching God into Sand` appears as one entry.
2. Essay page renders section TOC and essay-scoped search.
3. Search for terms like `sand` returns per-occurrence rows, in strict reading order.
4. Search displays total counts and per-section counts.
5. Section navigation works (`Prev/Next`, `Back to Essay`).
6. UI remains consistent with warm rust / warm charcoal design system.
7. All core behavior works in both `http://` and `file://` modes.
