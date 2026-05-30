#!/usr/bin/env node
"use strict";

function firstDifference(expected, actual) {
  const left = String(expected);
  const right = String(actual);
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return describeDifference(left, right, index);
    }
  }

  if (left.length !== right.length) {
    return describeDifference(left, right, length);
  }

  return "values are identical";
}

function describeDifference(expected, actual, index) {
  return [
    "first difference at offset " + String(index),
    "expected: " + snippet(expected, index),
    "actual:   " + snippet(actual, index),
  ].join("\n");
}

function snippet(value, index) {
  const start = Math.max(0, index - 60);
  const end = Math.min(value.length, index + 60);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < value.length ? "..." : "";
  return JSON.stringify(prefix + value.slice(start, end) + suffix);
}

module.exports = { firstDifference };
