#!/usr/bin/env node

// Pure unit test for the reading-attention core. No DOM, no browser, no server
// — just synthetic tick streams fed into the model, asserting that reading
// flips paragraphs read while scrubbing/hiding/gapping earn nothing. Runs in
// the standalone gate.

const assert = require("node:assert/strict");
const attention = require("../reading-attention.js");

const { DEFAULTS } = attention;

// Ticks needed to read a paragraph at a given dt, full credit, plus a margin.
function ticksToRead(words, dt, options) {
  const wpm = (options && options.wpm) || DEFAULTS.wpm;
  const readFraction = (options && options.readFraction) || DEFAULTS.readFraction;
  const requiredMs = (words / wpm) * 60000 * readFraction;
  return Math.ceil(requiredMs / dt);
}

// Feed a steady stream of ticks. The first tick only primes the clock; each
// subsequent tick advances `now` by `dt`. Returns the final `now`.
function stream(model, spec) {
  const dt = spec.dt || 250;
  let now = typeof spec.start === "number" ? spec.start : 1000;
  model.tick({
    now,
    zone: spec.zone,
    velocity: spec.velocity || 0,
    visible: spec.visible !== false
  });
  for (let i = 0; i < spec.count; i += 1) {
    now += dt;
    model.tick({
      now,
      zone: spec.zone,
      velocity: spec.velocity || 0,
      visible: spec.visible !== false
    });
  }
  return now;
}

const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL " + name);
  }
}

const DT = 250;

test("steady reading flips a paragraph read and reports word-weighted progress", () => {
  const model = attention.create([
    { index: 1, words: 100 },
    { index: 2, words: 100 }
  ]);

  // Read only paragraph 1, comfortably past its required dwell.
  const count = ticksToRead(100, DT) + 10;
  stream(model, { count, dt: DT, zone: [{ index: 1, weight: 1 }] });

  const summary = model.summary();
  assert.equal(summary.progress, 0.5, "reading one of two equal paragraphs is 50% by words");
  assert.equal(summary.furthestRead, 1, "paragraph 1 is the furthest read");
  assert.equal(summary.frontier, 2, "frontier is the first unread paragraph");
});

test("progress is word-weighted, not paragraph-count-weighted", () => {
  const model = attention.create([
    { index: 1, words: 300 },
    { index: 2, words: 100 }
  ]);

  // Read the long paragraph only.
  const count = ticksToRead(300, DT) + 10;
  stream(model, { count, dt: DT, zone: [{ index: 1, weight: 1 }] });

  const summary = model.summary();
  assert.equal(summary.progress, 0.75, "the 300-word paragraph is 75% of 400 total words");
});

test("a fast scrub earns no credit", () => {
  const model = attention.create([
    { index: 1, words: 100 },
    { index: 2, words: 100 }
  ]);

  // Velocity well above the zero-credit threshold, both paragraphs in zone.
  stream(model, {
    count: ticksToRead(100, DT) * 3,
    dt: DT,
    velocity: DEFAULTS.velocityZero + 10,
    zone: [{ index: 1, weight: 1 }, { index: 2, weight: 1 }]
  });

  const summary = model.summary();
  assert.equal(summary.progress, 0, "scrubbing past paragraphs reads nothing");
  assert.equal(summary.furthestRead, 0, "nothing is the furthest read");
  assert.equal(summary.frontier, 1, "frontier stays at the first paragraph");
});

test("a hidden tab earns no credit (presence gate)", () => {
  const model = attention.create([{ index: 1, words: 100 }]);
  stream(model, {
    count: ticksToRead(100, DT) * 2,
    dt: DT,
    visible: false,
    zone: [{ index: 1, weight: 1 }]
  });
  assert.equal(model.summary().progress, 0, "time spent hidden does not count as reading");
});

test("oversized tick gaps earn no credit", () => {
  const model = attention.create([{ index: 1, words: 100 }]);
  // Every interval exceeds maxTickGapMs, so each tick is treated as a gap.
  stream(model, {
    count: 40,
    dt: DEFAULTS.maxTickGapMs + 500,
    zone: [{ index: 1, weight: 1 }]
  });
  assert.equal(model.summary().progress, 0, "throttled/woken intervals do not accrue dwell");
});

test("zone weight scales how fast dwell accrues", () => {
  const full = attention.create([{ index: 1, words: 100 }]);
  const half = attention.create([{ index: 1, words: 100 }]);

  // A tick budget just past what full weight needs — full reads, half (which
  // accrues at 0.4x) does not yet.
  const count = ticksToRead(100, DT) + 2;
  stream(full, { count, dt: DT, zone: [{ index: 1, weight: 1 }] });
  stream(half, { count, dt: DT, zone: [{ index: 1, weight: 0.4 }] });

  assert.equal(full.summary().progress, 1, "full-weight reading flips the paragraph");
  assert.equal(half.summary().progress, 0, "partial overlap accrues slower and has not flipped yet");
});

test("read is monotonic — scrolling away does not un-read", () => {
  const model = attention.create([{ index: 1, words: 100 }, { index: 2, words: 100 }]);
  stream(model, { count: ticksToRead(100, DT) + 10, dt: DT, zone: [{ index: 1, weight: 1 }] });
  assert.equal(model.summary().furthestRead, 1, "paragraph 1 read");

  // Now scrub fast over everything, then hide — paragraph 1 stays read.
  stream(model, { count: 30, dt: DT, velocity: DEFAULTS.velocityZero + 10, zone: [{ index: 1, weight: 1 }, { index: 2, weight: 1 }], start: 1e6 });
  stream(model, { count: 30, dt: DT, visible: false, zone: [{ index: 1, weight: 1 }], start: 2e6 });
  assert.equal(model.summary().furthestRead, 1, "paragraph 1 remains read after scrubbing and hiding");
  assert.equal(model.summary().progress, 0.5, "progress does not regress");
});

test("furthestRead and frontier handle out-of-order reading", () => {
  const model = attention.create([
    { index: 1, words: 100 },
    { index: 2, words: 100 },
    { index: 3, words: 100 }
  ]);
  // Read paragraph 2 only (reader jumped past 1).
  stream(model, { count: ticksToRead(100, DT) + 10, dt: DT, zone: [{ index: 2, weight: 1 }] });
  const summary = model.summary();
  assert.equal(summary.furthestRead, 2, "furthest read is the highest-index read paragraph");
  assert.equal(summary.frontier, 1, "frontier is the first unread paragraph, even if it is behind furthestRead");
});

test("serialize/hydrate round-trips the read set", () => {
  const model = attention.create([
    { index: 1, words: 100 },
    { index: 2, words: 100 },
    { index: 3, words: 100 }
  ]);
  stream(model, { count: ticksToRead(100, DT) + 10, dt: DT, zone: [{ index: 1, weight: 1 }] });
  const before = model.summary();
  const state = model.serialize();
  assert.deepEqual(state.readParagraphs, [1], "serialized read set is exactly the read paragraphs");

  const revived = attention.create([
    { index: 1, words: 100 },
    { index: 2, words: 100 },
    { index: 3, words: 100 }
  ], { state });
  const after = revived.summary();
  assert.equal(after.progress, before.progress, "hydrated progress matches");
  assert.equal(after.furthestRead, before.furthestRead, "hydrated furthestRead matches");
  assert.equal(after.frontier, before.frontier, "hydrated frontier matches");
});

test("hydrate preserves partial dwell so a reload resumes mid-paragraph", () => {
  const model = attention.create([{ index: 1, words: 400 }]);
  // Accrue some dwell but not enough to flip the long paragraph.
  const partialCount = Math.floor(ticksToRead(400, DT) / 2);
  stream(model, { count: partialCount, dt: DT, zone: [{ index: 1, weight: 1 }] });
  assert.equal(model.summary().progress, 0, "long paragraph not yet read");

  const state = model.serialize();
  assert.ok(state.partial && state.partial.index === 1 && state.partial.dwellMs > 0, "partial dwell is serialized");

  // A revived model that gets the remaining ticks should finish the paragraph,
  // proving the partial dwell carried over (the remaining budget alone is < required).
  const revived = attention.create([{ index: 1, words: 400 }], { state });
  stream(revived, { count: ticksToRead(400, DT) - partialCount + 4, dt: DT, zone: [{ index: 1, weight: 1 }] });
  assert.equal(revived.summary().progress, 1, "carried-over dwell plus the rest finishes the paragraph");
});

test("empty / malformed input is inert", () => {
  assert.equal(attention.create([]).summary().progress, 0, "no paragraphs -> 0 progress");
  assert.equal(attention.create(null).summary().frontier, null, "null paragraphs -> null frontier");
  const model = attention.create([{ index: 1, words: 50 }]);
  model.tick(null);
  model.tick({});
  model.tick({ now: 1000 });
  model.tick({ now: 1100, zone: null, velocity: "x", visible: true });
  assert.equal(model.summary().progress, 0, "garbage ticks do not crash or credit");
});

if (failures.length > 0) {
  console.error("\nReading-attention regression failures:");
  failures.forEach((failure) => console.error("- " + failure));
  process.exit(1);
}

console.log("\nReading-attention regression checks passed.");
