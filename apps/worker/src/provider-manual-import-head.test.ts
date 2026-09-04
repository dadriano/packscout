import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedHeadTransactionMilliseconds } from "./provider-manual-import-head.ts";

test("a head batch keeps the mode budget without a page deadline and shrinks to the remaining page window with one", () => {
  const now = () => 1_000_000;
  assert.equal(boundedHeadTransactionMilliseconds(480_000, undefined, now), 480_000);
  // Plenty of page window left: the mode budget binds.
  assert.equal(boundedHeadTransactionMilliseconds(480_000, 1_000_000 + 600_000, now), 480_000);
  // The executor admits head work with 35 s left; the batch keeps a 5 s margin.
  assert.equal(boundedHeadTransactionMilliseconds(480_000, 1_000_000 + 35_000, now), 30_000);
  // Never below the repository's 1 s floor, even past the deadline.
  assert.equal(boundedHeadTransactionMilliseconds(480_000, 1_000_000 + 2_000, now), 1_000);
  assert.equal(boundedHeadTransactionMilliseconds(480_000, 1_000_000 - 60_000, now), 1_000);
  // A small local budget is never widened by a generous window.
  assert.equal(boundedHeadTransactionMilliseconds(30_000, 1_000_000 + 600_000, now), 30_000);
});
