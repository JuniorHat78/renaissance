# Search Ranking Spec

This document records the current deterministic ranking model for Renaissance
search. It is intentionally small: enough structure to keep results predictable
without turning the site into a search product.

For the Transition and Spotlight sprint, this document becomes a legacy/current
state note. The target replacement is `ORACLE-SEARCH-SPEC.md`. The new work may
replace the runtime API, result shape, URL grammar, and ranking model rather
than preserving compatibility with this implementation.

## Goals

- Keep reading order available as the default sort.
- Make relevance sort reward structural matches before body matches.
- Keep ranking deterministic across browsers.
- Keep runtime search working while leaving room for a generated index or worker
  if the archive grows.

## Modes

- `contains`: substring match.
- `exact_phrase`: word-boundary phrase match with whitespace tolerance.
- `fuzzy`: bounded Levenshtein matches against indexed word tokens.

Base scores:

- exact phrase: `300`
- contains: `200`
- fuzzy: `130 - distance * 15`

## Field Boosts

Relevance sort adds a field boost to the base score:

- essay title: `+80`
- section title: `+60`
- section label: `+30`
- body: `+0`

This means a title hit should outrank a body hit for the same mode. Body hits
remain occurrence-level results and still preserve normal snippets.

## Tie Breaks

When scores are equal, results fall back to reading order:

1. essay order
2. section order
3. hit index

Title and label hits use negative synthetic indexes so they appear before body
hits inside the same section when reading-order tie breaks apply.

## Growth Thresholds

Move beyond runtime indexing when any of these become true:

- generated text/index assets exceed the documented asset budget
- index construction becomes visibly slow on mobile
- the archive grows past a handful of long essays
- ranking fixtures become difficult to satisfy with runtime-only metadata

Preferred next steps, in order:

1. generate compact search metadata
2. add artifact size budgets
3. move indexing into a Web Worker
4. consider a prebuilt index only if runtime indexing remains too slow

Current decision: do not generate a standalone search index yet. The generated
site registry already provides compact recovery/search metadata, the current
runtime index remains inside the asset budget, and query behavior is covered by
fixtures for whitespace, punctuation, case sensitivity, fuzzy typo input, and
empty/noisy state.
