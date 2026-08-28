import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignToLastLineStart,
  alignWindowStart,
  clampWindowLines,
  MAX_WINDOW_LINES,
  planBackwardScan,
} from "./log-window.ts";

const encoder = new TextEncoder();

test("a backward scan never reads more than its bound, or before the start", () => {
  assert.deepEqual(planBackwardScan(1_000, 256), { offset: 744, length: 256 });
  assert.deepEqual(planBackwardScan(100, 256), { offset: 0, length: 100 });
  assert.deepEqual(planBackwardScan(0, 256), { offset: 0, length: 0 });
});

test("attach alignment lands just past the last terminator", () => {
  const bytes = encoder.encode("one\ntwo\nhalf");
  assert.deepEqual(alignToLastLineStart(bytes, 0), { offset: 8, found: true });
});

test("attach alignment reports when the bound hid every terminator", () => {
  const bytes = encoder.encode("no terminator");
  assert.deepEqual(alignToLastLineStart(bytes, 500), {
    offset: 500,
    found: false,
  });
  // A slice that starts at the beginning of the generation is authoritative.
  assert.deepEqual(alignToLastLineStart(bytes, 0), { offset: 0, found: true });
});

test("a window of the last N lines starts at the right byte", () => {
  const bytes = encoder.encode("a\nbb\nccc\ndddd\n");
  // The last two lines are "ccc" (offset 5) and "dddd" (offset 9).
  assert.deepEqual(alignWindowStart(bytes, 0, 2), {
    offset: 5,
    complete: false,
    lineCount: 2,
  });
});

test("a window that reaches the generation start says it is complete", () => {
  const bytes = encoder.encode("a\nbb\n");
  assert.deepEqual(alignWindowStart(bytes, 0, 10), {
    offset: 0,
    complete: true,
    lineCount: 2,
  });
});

test("a bounded slice drops its leading partial line and admits incompleteness", () => {
  const bytes = encoder.encode("f-a-line\nwhole\n");
  assert.deepEqual(alignWindowStart(bytes, 400, 10), {
    offset: 409,
    complete: false,
    lineCount: 1,
  });
});

test("a bounded slice with no terminator yields no window rather than a fragment", () => {
  const bytes = encoder.encode("still inside one enormous line");
  assert.deepEqual(alignWindowStart(bytes, 400, 10), {
    offset: 430,
    complete: false,
    lineCount: 0,
  });
});

test("a requested window size is clamped rather than trusted", () => {
  assert.equal(clampWindowLines(undefined), 500);
  assert.equal(clampWindowLines("not a number"), 500);
  assert.equal(clampWindowLines(-5), 1);
  assert.equal(clampWindowLines(1_000_000), MAX_WINDOW_LINES);
  assert.equal(clampWindowLines("250"), 250);
});
