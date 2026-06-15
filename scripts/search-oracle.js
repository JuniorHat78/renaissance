(function initRenaissanceOracle(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.RenaissanceOracle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildRenaissanceOracle() {
  "use strict";

  // The oracle turns a raw query + the generated search index into ranked
  // results. Scoring is a sum of explicit signals, each emitting {reason,
  // points}, so a result's score IS its own explanation. Nothing here touches
  // the DOM: it runs identically in Node (fixtures, explain harness) and the
  // browser (Spotlight, full search).

  // Tunables. These are deliberately legible; ranking quality is a taste call,
  // and these are the dials to turn.
  const TERM_SCALE = 80;          // idf -> points for a body-term match
  const TITLE_TERM_SCALE = 150;   // idf -> points for a term inside a title
  const TITLE_BASE = 200;         // flat bonus for any section-title hit
  const EXACT_TITLE_BONUS = 150;
  const PHRASE_BONUS = 120;       // on top of the matched terms' idf weight
  const COVERAGE_BONUS = 90;      // multi-term query fully covered by a passage
  const AFFINITY_SCALE = 40;      // section title shares a query term
  const HEADING_BOOST = 60;
  const PULL_QUOTE_BOOST = 30;
  const CONTEXT_BOOST = 50;       // passage is in the essay you're reading
  const MOTIF_SCALE = 25;         // lexicon synonym present in a matched passage
  const SECTION_JUMP_SCORE = 1000;
  const IMPORTANCE_FLOOR = 0.5;   // matched idf / total query idf for multi-term

  const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

  function normalize(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function tokenize(text) {
    const matches = normalize(text).match(/[a-z0-9]+/g);
    return matches ? matches : [];
  }

  function romanToInt(value) {
    const lower = String(value || "").toLowerCase();
    if (!/^[ivxlcdm]+$/.test(lower)) {
      return null;
    }
    let total = 0;
    for (let i = 0; i < lower.length; i += 1) {
      const current = ROMAN[lower[i]];
      const next = ROMAN[lower[i + 1]];
      total += next && next > current ? -current : current;
    }
    return total > 0 ? total : null;
  }

  // Read what the reader probably meant before deciding how to match.
  function parseQuery(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) {
      return { kind: "empty", raw: text, text: "", tokens: [] };
    }

    const quoted = text.match(/^"(.+)"$/);
    if (quoted) {
      const phrase = normalize(quoted[1]);
      return { kind: "phrase", raw: text, text: phrase, tokens: tokenize(phrase) };
    }

    const sectionWord = text.match(/^section\s+(.+)$/i);
    const target = sectionWord ? sectionWord[1].trim() : text;
    const asNumber = /^\d+$/.test(target) ? Number.parseInt(target, 10) : romanToInt(target);
    if (asNumber && (sectionWord || /^(\d+|[ivxlcdm]+)$/i.test(target))) {
      return { kind: "section-jump", raw: text, text: normalize(text), tokens: [], sectionNumber: asNumber };
    }

    const normalized = normalize(text);
    return { kind: "term", raw: text, text: normalized, tokens: tokenize(normalized) };
  }

  // Inverse document frequency over passages: rare terms (omega) weigh far more
  // than common ones (the). Terms absent from the stored table are df=1.
  function makeIdf(index) {
    const total = (index && index.stats && index.stats.passages) || 1;
    const terms = (index && index.terms) || {};
    return function idf(term) {
      const df = terms[term] || 1;
      return Math.log(1 + total / df);
    };
  }

  function findMatches(text, query, idf) {
    const haystack = normalize(text);
    if (!haystack) {
      return null;
    }

    if (query.kind === "phrase") {
      const index = haystack.indexOf(query.text);
      if (index === -1) {
        return null;
      }
      return {
        exactPhrase: true,
        firstIndex: index,
        firstLength: query.text.length,
        matchedTerms: query.tokens.slice(),
        matchedIdf: query.tokens.reduce((sum, token) => sum + idf(token), 0),
      };
    }

    if (!query.tokens.length) {
      return null;
    }

    let firstIndex = Infinity;
    let firstLength = 0;
    const matchedTerms = [];
    for (const token of query.tokens) {
      const at = haystack.indexOf(token);
      if (at === -1) {
        continue;
      }
      matchedTerms.push(token);
      if (at < firstIndex) {
        firstIndex = at;
        firstLength = token.length;
      }
    }
    if (!matchedTerms.length) {
      return null;
    }
    return {
      exactPhrase: false,
      firstIndex,
      firstLength,
      matchedTerms,
      matchedIdf: matchedTerms.reduce((sum, token) => sum + idf(token), 0),
    };
  }

  function makeSnippet(text, index, length) {
    const lead = 60;
    const tail = 90;
    // Clip to word boundaries so snippets never start or end mid-word.
    let start = Math.max(0, index - lead);
    while (start > 0 && /\w/.test(text[start - 1])) {
      start -= 1;
    }
    let end = Math.min(text.length, index + length + tail);
    while (end < text.length && /\w/.test(text[end])) {
      end += 1;
    }
    const window = text.slice(start, end);
    const leadTrim = window.length - window.trimStart().length;
    const body = window.trim();
    const prefix = start > 0 ? "… " : "";
    const suffix = end < text.length ? " …" : "";
    return {
      text: prefix + body + suffix,
      highlight: { start: prefix.length + (index - start) - leadTrim, length },
    };
  }

  function plainSnippet(text) {
    return { text: String(text || ""), highlight: { start: 0, length: 0 } };
  }

  function reason(label, points) {
    return { label, points };
  }

  function makeResult(fields, reasons) {
    const score = reasons.reduce((total, item) => total + item.points, 0);
    return Object.assign({ score, reasons }, fields);
  }

  function firstPassageId(section) {
    return section.passages[0] ? section.passages[0].passageId : "";
  }

  // Lexicon seam: map each query token to related terms from a curated synonym
  // group. Today the oracle uses these only to BOOST passages that already
  // match (deferred build: creating matches from synonyms, essay aliases, and
  // motif easter eggs). Returns Map<token, relatedTerms[]>.
  function buildExpansions(lexicon, tokens) {
    const expansions = new Map();
    const groups = (lexicon && Array.isArray(lexicon.synonyms)) ? lexicon.synonyms : [];
    if (!groups.length || !tokens.length) {
      return expansions;
    }
    for (const token of tokens) {
      const related = [];
      for (const group of groups) {
        if (group.includes(token)) {
          for (const term of group) {
            if (term !== token && !related.includes(term)) {
              related.push(term);
            }
          }
        }
      }
      if (related.length) {
        expansions.set(token, related);
      }
    }
    return expansions;
  }

  function rank(index, raw, context) {
    const query = parseQuery(raw);
    const ctx = context || {};
    const currentEssay = ctx.essaySlug || null;
    const limit = ctx.limit || 12;
    const perSection = ctx.perSection || 2;
    const idf = makeIdf(index);
    const totalIdf = query.tokens.reduce((sum, token) => sum + idf(token), 0) || 1;
    const expansions = buildExpansions(ctx.lexicon, query.tokens);
    const essays = (index && Array.isArray(index.essays)) ? index.essays : [];
    const results = [];

    for (const essay of essays) {
      const essayContext = essay.slug === currentEssay;

      for (const section of essay.sections) {
        const base = {
          essaySlug: essay.slug,
          essayTitle: essay.title,
          sectionNumber: section.sectionNumber,
          sectionTitle: section.title,
        };

        if (query.kind === "section-jump") {
          if (section.sectionNumber === query.sectionNumber) {
            results.push(makeResult(
              Object.assign({ kind: "section-jump", passageId: firstPassageId(section), blockType: "section", snippet: plainSnippet(section.title) }, base),
              [reason("jumped to section " + query.sectionNumber, SECTION_JUMP_SCORE)]
            ));
          }
          continue;
        }

        if (query.kind === "empty") {
          continue;
        }

        // Title hits answer "did they name a section?" and must out-rank body.
        const titleMatch = findMatches(section.title, query, idf);
        if (titleMatch) {
          const reasons = [reason("in section title", TITLE_BASE)];
          for (const term of titleMatch.matchedTerms) {
            reasons.push(reason("title term: " + term, Math.round(idf(term) * TITLE_TERM_SCALE)));
          }
          if (normalize(section.title) === query.text) {
            reasons.push(reason("exact title", EXACT_TITLE_BONUS));
          }
          if (essayContext) {
            reasons.push(reason("current essay", CONTEXT_BOOST));
          }
          results.push(makeResult(
            Object.assign({ kind: "title", passageId: firstPassageId(section), blockType: "section", snippet: makeSnippet(section.title, titleMatch.firstIndex, titleMatch.firstLength) }, base),
            reasons
          ));
        }

        // A section whose title shares a query term is "about" that term, so
        // its passages get a small affinity lift (raises load-bearing passages).
        const titleTokens = tokenize(section.title);
        const sharedTitleTerms = query.tokens.filter((token) => titleTokens.includes(token));

        const passageHits = [];
        for (const passage of section.passages) {
          const match = findMatches(passage.text, query, idf);
          if (!match) {
            continue;
          }
          // Importance gate: for a multi-term query, only show a passage if its
          // matched terms carry a real share of the query's weight. This drops
          // "only the common half matched" noise without a magic stopword list.
          if (query.tokens.length > 1 && !match.exactPhrase && (match.matchedIdf / totalIdf) < IMPORTANCE_FLOOR) {
            continue;
          }

          const reasons = [];
          if (match.exactPhrase) {
            reasons.push(reason("exact phrase “" + query.text + "”", Math.round(match.matchedIdf * TERM_SCALE) + PHRASE_BONUS));
          } else {
            for (const term of match.matchedTerms) {
              reasons.push(reason("term: " + term, Math.round(idf(term) * TERM_SCALE)));
            }
            if (query.tokens.length > 1 && match.matchedTerms.length === query.tokens.length) {
              reasons.push(reason("all terms", COVERAGE_BONUS));
            }
          }
          for (const term of sharedTitleTerms) {
            reasons.push(reason("section is about “" + term + "”", Math.round(idf(term) * AFFINITY_SCALE)));
          }
          if (expansions.size) {
            const haystack = normalize(passage.text);
            for (const [token, related] of expansions) {
              const found = related.find((term) => haystack.indexOf(term) !== -1);
              if (found) {
                reasons.push(reason("related: " + found + " (≈ " + token + ")", Math.round(idf(found) * MOTIF_SCALE)));
              }
            }
          }
          if (passage.blockType === "heading") {
            reasons.push(reason("heading", HEADING_BOOST));
          } else if (passage.blockType === "pull_quote") {
            reasons.push(reason("pull quote", PULL_QUOTE_BOOST));
          }
          if (essayContext) {
            reasons.push(reason("current essay", CONTEXT_BOOST));
          }
          passageHits.push(makeResult(
            Object.assign({
              kind: "passage",
              passageId: passage.passageId,
              blockType: passage.blockType,
              rangeStart: match.firstIndex,
              rangeEnd: match.firstIndex + match.firstLength,
              snippet: makeSnippet(passage.text, match.firstIndex, match.firstLength),
            }, base),
            reasons
          ));
        }
        passageHits.sort((a, b) => b.score - a.score);
        results.push(...passageHits.slice(0, perSection));
      }
    }

    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.sectionNumber !== b.sectionNumber) {
        return a.sectionNumber - b.sectionNumber;
      }
      return String(a.passageId).localeCompare(String(b.passageId), undefined, { numeric: true });
    });

    return { query, results: results.slice(0, limit), totalMatched: results.length };
  }

  return {
    parseQuery,
    rank,
    makeIdf,
    normalize,
    tokenize,
    romanToInt,
  };
});
