import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchoredScrollTop,
  captureScrollAnchor,
  HISTORY_TRIGGER_PX,
  indexOfRow,
  shouldLoadOlder,
} from "./scroll-anchor.ts";

test("an anchor records where a row sits inside the viewport", () => {
  assert.deepEqual(captureScrollAnchor("line:worker:1:400", 1_240, 1_200), {
    id: "line:worker:1:400",
    gap: 40,
  });
  assert.equal(captureScrollAnchor(undefined, 0, 0), null);
});

test("prepended rows move the scroll position by exactly what was inserted", () => {
  const anchor = captureScrollAnchor("line:worker:1:400", 1_240, 1_200);
  assert.ok(anchor);
  // Three rows of 20px went in above: the row is now 60px further down, and the
  // reader must move down the same 60px to keep looking at it.
  assert.equal(anchoredScrollTop(anchor, 1_300), 1_260);
});

test("an anchor never scrolls above the top of the buffer", () => {
  const anchor = captureScrollAnchor("line:worker:1:0", 10, 0);
  assert.ok(anchor);
  assert.equal(anchoredScrollTop(anchor, 4), 0);
});

test("older pages load near the top, and never while following the tail", () => {
  assert.equal(shouldLoadOlder({ scrollTop: 0, following: false, rowCount: 40 }), true);
  assert.equal(
    shouldLoadOlder({ scrollTop: HISTORY_TRIGGER_PX, following: false, rowCount: 40 }),
    true,
  );
  assert.equal(
    shouldLoadOlder({
      scrollTop: HISTORY_TRIGGER_PX + 1,
      following: false,
      rowCount: 40,
    }),
    false,
  );
  assert.equal(shouldLoadOlder({ scrollTop: 0, following: true, rowCount: 40 }), false);
  assert.equal(shouldLoadOlder({ scrollTop: 0, following: false, rowCount: 0 }), false);
});

test("a row that was evicted while history loaded reports no index", () => {
  assert.equal(indexOfRow(["a", "b"], "b"), 1);
  assert.equal(indexOfRow(["a", "b"], "gone"), -1);
});
