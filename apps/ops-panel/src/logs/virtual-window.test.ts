import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeFixedWindow,
  computeMeasuredWindow,
  createRowMetrics,
  isAtBottom,
} from "./virtual-window.ts";

test("exact virtualization renders only the slice under the viewport", () => {
  const window = computeFixedWindow({
    scrollTop: 4_000,
    viewportHeight: 400,
    rowHeight: 20,
    rowCount: 50_000,
    overscan: 5,
  });

  assert.equal(window.startIndex, 195);
  assert.equal(window.endIndex, 226);
  assert.equal(window.offsetTop, 3_900);
  assert.equal(window.totalHeight, 1_000_000);
  assert.ok(
    window.endIndex - window.startIndex < 40,
    "a full buffer still mounts a handful of rows",
  );
});

test("exact virtualization clamps at both ends", () => {
  assert.deepEqual(
    computeFixedWindow({
      scrollTop: 0,
      viewportHeight: 100,
      rowHeight: 20,
      rowCount: 3,
    }),
    { startIndex: 0, endIndex: 3, offsetTop: 0, totalHeight: 60 },
  );
  assert.deepEqual(
    computeFixedWindow({
      scrollTop: 0,
      viewportHeight: 100,
      rowHeight: 20,
      rowCount: 0,
    }),
    { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 },
  );
});

test("measured rows fall back to an estimate until they are seen", () => {
  const metrics = createRowMetrics(20);
  metrics.setRowCount(100);
  assert.equal(metrics.totalHeight(), 2_000);

  metrics.measure(0, 60);
  metrics.measure(1, 40);
  // Two estimated rows were replaced by their real heights; the other 98 stand.
  assert.equal(metrics.totalHeight(), 2_060);
  assert.equal(metrics.offsetOf(2), 100);
});

test("measured virtualization follows the real heights it has learned", () => {
  const metrics = createRowMetrics(20);
  metrics.setRowCount(10);
  for (let index = 0; index < 10; index += 1) metrics.measure(index, 50);

  const window = computeMeasuredWindow({
    scrollTop: 120,
    viewportHeight: 100,
    metrics,
    rowCount: 10,
    overscan: 0,
  });
  assert.equal(window.startIndex, 2);
  assert.equal(window.endIndex, 5);
  assert.equal(window.offsetTop, 100);
  assert.equal(window.totalHeight, 500);
});

test("evicting from the head shifts measurements with the rows", () => {
  const metrics = createRowMetrics(20);
  metrics.setRowCount(4);
  metrics.measure(0, 100);
  metrics.measure(1, 30);
  metrics.measure(2, 30);
  metrics.measure(3, 30);

  metrics.shift(1);
  metrics.setRowCount(3);
  assert.equal(metrics.heightAt(0), 30, "the tall row went with the eviction");
  assert.equal(metrics.totalHeight(), 90);
});

test("a wrap toggle discards measurements taken under the old layout", () => {
  const metrics = createRowMetrics(20);
  metrics.setRowCount(3);
  metrics.measure(0, 80);
  assert.equal(metrics.totalHeight(), 120);

  metrics.clear();
  assert.equal(metrics.totalHeight(), 60);
});

test("following is inferred from how close the viewport is to the bottom", () => {
  assert.equal(isAtBottom(900, 100, 1_000), true);
  assert.equal(isAtBottom(890, 100, 1_000), true, "within the threshold");
  assert.equal(isAtBottom(400, 100, 1_000), false);
});
