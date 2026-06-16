(function initRenaissanceReadingAttention(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.RenaissanceReadingAttention = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildRenaissanceReadingAttention() {
  "use strict";

  // The attention model answers a question the scrollbar cannot: how much of a
  // section did the reader actually READ, as opposed to scroll past. It is pure
  // — no DOM, no timers, no storage. The reader feeds it a stream of ticks
  // (`tick({ now, zone, velocity, visible })`) sampled by a heartbeat, and asks
  // `summary()` for { progress, furthestRead, frontier }. Because it is just
  // arithmetic over numbers, it runs identically in Node (synthetic tick
  // streams in the unit test) and in the browser (the section.js heartbeat).
  //
  // The unit of accounting is the paragraph. Each paragraph has an EXPECTED
  // read time derived from its word count (words / WPM). A paragraph flips to
  // "read" once its accumulated active-reading dwell reaches READ_FRACTION of
  // that expected time. Three gates decide whether a tick's elapsed time counts
  // as dwell:
  //   1. velocity — a fast scrub earns ~0; reading pace earns full.
  //   2. zone weight — only paragraphs overlapping the reading sightline accrue,
  //      weighted by how much of them is in the zone (supplied by the caller).
  //   3. presence — time while the tab is hidden does not count.
  // Dwell is capped per paragraph so leaving the tab parked on one paragraph
  // cannot inflate it, and "read" is monotonic: once true it never flips back.

  const DEFAULTS = {
    // Words per minute used to derive each paragraph's expected read time.
    wpm: 240,
    // A paragraph counts as read once dwell reaches this fraction of expected.
    readFraction: 0.5,
    // Velocity gate, in px/ms of scroll speed. At/below FULL the tick earns
    // full credit (you are sitting on the text); at/above ZERO it earns none
    // (you are scrubbing); linear in between. Reading is mostly stationary with
    // small nudges, so it lives comfortably under FULL.
    velocityFull: 0.5,
    velocityZero: 4,
    // Per-paragraph dwell is capped at this multiple of expected time, so an
    // idle tab parked on a paragraph cannot accrue unbounded credit.
    dwellCapFactor: 2,
    // Ticks separated by more than this (tab throttling, wake from sleep, a
    // hidden interval catching up) are treated as a gap and earn nothing.
    maxTickGapMs: 1200,
    // A paragraph always has at least this many words for timing, so a heading
    // or one-word line clears on essentially the first qualifying tick rather
    // than dividing by zero.
    minWords: 1
  };

  function toFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toPositiveInt(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
  }

  function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function create(paragraphs, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const wpm = positive(opts.wpm, DEFAULTS.wpm);
    const readFraction = clamp(opts.readFraction, 0.01, 1);
    const dwellCapFactor = positive(opts.dwellCapFactor, DEFAULTS.dwellCapFactor);
    const velocityFull = Math.max(0, toFiniteNumber(opts.velocityFull, DEFAULTS.velocityFull));
    const velocityZero = Math.max(velocityFull + 0.0001, toFiniteNumber(opts.velocityZero, DEFAULTS.velocityZero));
    const maxTickGapMs = positive(opts.maxTickGapMs, DEFAULTS.maxTickGapMs);
    const minWords = positive(opts.minWords, DEFAULTS.minWords);

    const records = [];
    const byIndex = new Map();

    (Array.isArray(paragraphs) ? paragraphs : []).forEach((entry) => {
      if (!entry) {
        return;
      }
      const index = toPositiveInt(entry.index);
      if (index === null || byIndex.has(index)) {
        return;
      }
      const words = Math.max(minWords, toFiniteNumber(entry.words, 0));
      const expectedMs = (words / wpm) * 60000;
      const record = {
        index,
        words,
        requiredMs: expectedMs * readFraction,
        capMs: expectedMs * dwellCapFactor,
        dwellMs: 0,
        read: false
      };
      records.push(record);
      byIndex.set(index, record);
    });

    records.sort((a, b) => a.index - b.index);

    const totalWords = records.reduce((sum, record) => sum + record.words, 0);
    let lastNow = null;

    function markRead(record) {
      record.read = true;
      if (record.dwellMs < record.requiredMs) {
        record.dwellMs = record.requiredMs;
      }
    }

    // Velocity gate: 1 at reading pace, ramping linearly to 0 at scrub speed.
    function velocityFactor(velocity) {
      const speed = Math.abs(toFiniteNumber(velocity, 0));
      if (speed <= velocityFull) {
        return 1;
      }
      if (speed >= velocityZero) {
        return 0;
      }
      return (velocityZero - speed) / (velocityZero - velocityFull);
    }

    function tick(sample) {
      const data = sample || {};
      const now = toFiniteNumber(data.now, NaN);
      if (!Number.isFinite(now)) {
        return;
      }

      const previous = lastNow;
      lastNow = now;

      // First tick only establishes the clock.
      if (previous === null) {
        return;
      }

      const dt = now - previous;
      // Non-positive (clock skew / duplicate sample) or an oversized gap
      // (throttled hidden tab, wake from sleep) earns nothing; the clock has
      // already advanced so the next tick measures a fresh interval.
      if (dt <= 0 || dt > maxTickGapMs) {
        return;
      }

      // Presence gate.
      if (data.visible === false) {
        return;
      }

      const factor = velocityFactor(data.velocity);
      if (factor <= 0) {
        return;
      }

      const zone = Array.isArray(data.zone) ? data.zone : [];
      for (let i = 0; i < zone.length; i += 1) {
        const slot = zone[i];
        if (!slot) {
          continue;
        }
        const index = toPositiveInt(slot.index);
        if (index === null) {
          continue;
        }
        const record = byIndex.get(index);
        if (!record || record.read) {
          continue;
        }
        const weight = clamp(slot.weight, 0, 1);
        if (weight <= 0) {
          continue;
        }
        record.dwellMs = Math.min(record.capMs, record.dwellMs + dt * weight * factor);
        if (record.dwellMs >= record.requiredMs) {
          markRead(record);
        }
      }
    }

    function summary() {
      let readWords = 0;
      let furthestRead = 0;
      let frontier = null;

      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record.read) {
          readWords += record.words;
          if (record.index > furthestRead) {
            furthestRead = record.index;
          }
        } else if (frontier === null) {
          // The resume point: the first paragraph not yet read.
          frontier = record.index;
        }
      }

      if (frontier === null) {
        // Everything read (or nothing tracked) — resume at the end if we have
        // paragraphs, otherwise there is no meaningful frontier.
        frontier = records.length ? records[records.length - 1].index : null;
      }

      return {
        progress: totalWords > 0 ? readWords / totalWords : 0,
        furthestRead,
        frontier,
        readWords,
        totalWords
      };
    }

    function serialize() {
      const readParagraphs = [];
      let partial = null;

      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record.read) {
          readParagraphs.push(record.index);
        } else if (record.dwellMs > 0) {
          // Keep the in-progress paragraph's partial dwell so a reload resumes
          // mid-paragraph instead of discarding it. Only the furthest such
          // paragraph is worth carrying.
          partial = { index: record.index, dwellMs: Math.round(record.dwellMs) };
        }
      }

      const result = { readParagraphs };
      if (partial) {
        result.partial = partial;
      }
      return result;
    }

    function hydrate(state) {
      if (!state || typeof state !== "object") {
        return;
      }

      const readList = Array.isArray(state.readParagraphs) ? state.readParagraphs : [];
      for (let i = 0; i < readList.length; i += 1) {
        const index = toPositiveInt(readList[i]);
        if (index === null) {
          continue;
        }
        const record = byIndex.get(index);
        if (record) {
          markRead(record);
        }
      }

      if (state.partial) {
        const index = toPositiveInt(state.partial.index);
        const record = index !== null ? byIndex.get(index) : null;
        if (record && !record.read) {
          record.dwellMs = Math.min(record.capMs, Math.max(0, toFiniteNumber(state.partial.dwellMs, 0)));
          if (record.dwellMs >= record.requiredMs) {
            markRead(record);
          }
        }
      }
    }

    if (options && options.state) {
      hydrate(options.state);
    }

    return {
      tick,
      summary,
      serialize,
      hydrate,
      // Exposed for the heartbeat/debug; not part of the core contract.
      paragraphCount: records.length
    };
  }

  return {
    create,
    DEFAULTS
  };
});
