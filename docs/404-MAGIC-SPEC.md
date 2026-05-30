# Magical 404 Spec

This spec captures the intended direction for `404.html` and related
not-found states. The goal is useful magic: the archive should feel alive when a
reader gets lost, but it should still help them recover quickly.

## Intent

The 404 should not be a generic dead end. It should behave like a small archive
desk that reads the failed address, offers the nearest drawer, and gives the
reader obvious ways back into the site.

Keep the implementation self-contained. GitHub Pages serves `404.html` for
missing paths at arbitrary depths, so the page cannot rely on relative external
CSS or JS.

## Principles

- Recovery comes first. The magic should reveal useful routes, not hide them.
- Use one physical `404.html` with several internal modes.
- Keep animation short, subtle, and reduced-motion aware.
- Keep copy quiet and concrete. Avoid novelty-page jokes.
- Suggestions should be explainable: closest essay, closest section, search for
  parsed terms, archive fallback.
- Never auto-redirect unless the route is certain. Prefer a prominent
  suggestion.
- Keep `/renaissance/` subpath links correct.
- Keep the existing `#archive-link`, `#search-link`, and `#did-you-mean`
  recovery hooks stable for tests and future scripts.

## Modes

### Unknown Path

Trigger:
- Missing path does not clearly map to an essay, section, search URL, or asset.

Mood:
- Lost corridor in the archive.

Recovery surface:
- Show the missing path as a shelf mark.
- Parse path tokens into a search query.
- Suggest full search with the parsed query.
- Suggest the archive index.

Animation:
- Bookmark line slides into place.
- Suggestion rows appear in sequence.

### Essay Link

Trigger:
- Query includes `essay=<slug>`.
- Path contains a known or near-known essay slug.

Mood:
- Misfiled catalogue entry.

Recovery surface:
- If slug is valid, suggest `essay.html?essay=<slug>`.
- If slug is near a known essay, suggest the closest essay.
- Offer a search link prefilled with the prettified slug.
- Offer archive fallback.

Copy shape:
- "This shelf mark resembles..."
- "Closest essay in the catalogue."

### Section Link

Trigger:
- Query includes both `essay=<slug>` and `section=<number>`.
- The section number is missing, invalid, or out of range.

Mood:
- Missing folio.

Recovery surface:
- If essay is valid and section is out of range, suggest the nearest valid
  section.
- Offer the essay table of contents.
- Offer previous or final section when useful.
- Keep full archive/search fallback.

Copy shape:
- "The folio number is outside this essay."
- "Nearest section."

### Search Link

Trigger:
- Path or query resembles search state, such as `q=`, `query=`, `search=`, or
  old search URLs.

Mood:
- Index card with a smudged heading.

Recovery surface:
- Prefill the 404 search field.
- Suggest `search.html?q=<terms>`.
- If terms resemble an essay or section title, show that as the first
  suggestion.

Animation:
- Search suggestion row appears first.
- Keep this mode especially restrained so it does not fight the search page.

### Asset Or Old File

Trigger:
- Missing path ends with `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.pdf`,
  `.txt`, `.xml`, `.json`, or `.html`.

Mood:
- Missing enclosure.

Recovery surface:
- For old HTML paths, parse file name into a search query.
- For image names that include an essay slug, suggest the matching essay.
- For `.txt`, try to infer essay/section from filename or nearby path segments.
- Otherwise show search and archive fallback.

Copy shape:
- "The enclosure is no longer attached to this card."

### Offline

Trigger:
- `navigator.onLine === false`.

Mood:
- Lamp-lit offline shelf.

Recovery surface:
- Tell the reader they are offline.
- Keep archive link visible because cached shell pages may still work.
- Avoid implying uncached search/content will definitely be available.
- If cached-known suggestions are available later, show them as "may be cached."

Copy shape:
- "The network is out, but the local shelf may still open."

## Suggestion Model

The first pass can stay lightweight and inline:

- Keep a small hardcoded published catalogue in `404.html`.
- Match against essay slug, essay title, summary, section number, and section
  title.
- Score exact slug/title containment highest.
- Score token overlap next.
- Render at most one primary suggestion and two secondary suggestions.

Later, when the archive grows:

- Generate a tiny `notfound-catalogue` JSON object during the existing content
  generation step.
- Include only published essay and section metadata.
- Keep the 404 page self-contained by embedding that generated object inline.

## Visual Language

The page should share the interface grammar:

- Shelf mark: small bordered label showing the failed path.
- Primary suggestion: paper slip, not a large card.
- Actions: quiet archive buttons.
- Search submit: same angled archive-tab treatment as the main search button.
- Motion: line reveal, shelf glint, suggestion fade. No large illustration.

Avoid:

- Big mascot-style illustrations.
- Oversized rounded cards.
- Heavy shadows.
- Joke copy that blocks recovery.
- Decorative animation that repeats forever.

## App-Shell Not-Found States

The browser-level `404.html` should inspire but not replace app-shell failures:

- `essay.html?essay=<bad-slug>` should show the essay shell with a matching
  recovery tone.
- `section.html?essay=<bad-slug>&section=<n>` should show the section shell with
  the same recovery model.
- Both should remain `noindex`.
- Both should link to archive and full search under the project subpath.

Future improvement:
- Share a small recovery helper between essay/section shell scripts if the copy
  and suggestion logic start duplicating too much.

## Phased Plan

### Phase 1: Current Shell

- Self-contained 404 layout.
- Missing path shelf mark.
- Search form.
- Essay/section query recognition.
- Basic suggestions and animation.

### Phase 2: Contextual Modes

- Add route mode detection: unknown, essay, section, search, asset, offline.
- Swap eyebrow, lead copy, primary suggestion, and secondary suggestions per
  mode.
- Keep the same visual shell.

### Phase 3: Better Matching

- Improve typo/near-match scoring for essay and section names.
- Show nearest valid section when section number is out of range.
- Add old asset/file inference.

### Phase 4: Shared Recovery Tone

- Bring matching recovery copy and suggestions into `essay.html` and
  `section.html` app-shell not-found states.
- Keep noindex behavior.
- Keep controls consistent with `docs/INTERFACE-GRAMMAR.md`.

### Phase 5: Generated Catalogue

- Generate a compact published catalogue for 404 suggestions.
- Keep it inline or otherwise path-depth safe.
- Update QA docs with the expected coverage.

## Open Questions

- Should the 404 copy use "shelf mark", "drawer", "folio", or a smaller set of
  recurring archive nouns?
- Should unpublished essays ever appear in 404 suggestions during local
  development?
- Should a high-confidence exact old URL ever redirect automatically, or should
  all recovery stay user-chosen?
- How much offline intelligence is worth adding before the site has many cached
  essays?
