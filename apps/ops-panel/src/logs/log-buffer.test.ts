import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogLineRecord, LogMarkerRecord, LogRow } from "../api/panel-types.ts";
import { createClientMarkerFactory } from "./client-markers.ts";
import { createLogBuffer, toLogRows, type LogBufferOptions } from "./log-buffer.ts";

function line(
  service: string,
  generation: number,
  offset: number,
  text = `${service}-${offset}`,
): LogLineRecord {
  return {
    id: `line:${service}:${generation}:${offset}`,
    service,
    generation,
    offset,
    endOffset: offset + text.length + 1,
    text,
    observedAt: "2026-08-19T12:00:00.000Z",
    backfilled: false,
    partial: false,
  };
}

function row(
  service: string,
  generation: number,
  offset: number,
  text?: string,
): LogRow {
  return { type: "line", ...line(service, generation, offset, text) };
}

function series(count: number, from = 0): LogRow[] {
  return Array.from({ length: count }, (_, index) => row("worker", 1, from + index));
}

function buffer(options: Partial<LogBufferOptions> = {}) {
  return createLogBuffer({
    createMarker: (input) =>
      createClientMarkerFactory()({
        reason: input.reason,
        detail: input.detail,
        skippedLines: input.skippedLines,
      }),
    ...options,
  });
}

test("a line that arrives twice is stored once", () => {
  const store = buffer();
  store.append([row("worker", 1, 0), row("worker", 1, 7)]);
  const change = store.append([row("worker", 1, 7), row("worker", 1, 14)]);

  assert.equal(change.duplicates, 1);
  assert.equal(change.admitted, 1);
  assert.deepEqual(
    store.rows().map((entry) => entry.offset),
    [0, 7, 14],
  );
});

test("the same offset in a different generation is a different line", () => {
  const store = buffer();
  store.append([row("worker", 1, 0, "before restart")]);
  store.append([row("worker", 2, 0, "after restart")]);

  assert.equal(store.size(), 2);
  assert.deepEqual(
    store.rows().map((entry) => (entry.type === "line" ? entry.text : entry.detail)),
    ["before restart", "after restart"],
  );
});

test("an initial window prepended under live output merges without gaps", () => {
  const store = buffer();
  // The live stream arrives first; the window read lands afterwards and
  // overlaps it, exactly as the real ordering does.
  store.append([row("worker", 1, 20), row("worker", 1, 30)]);
  const change = store.prepend([
    row("worker", 1, 0),
    row("worker", 1, 10),
    row("worker", 1, 20),
  ]);

  assert.equal(change.duplicates, 1);
  assert.deepEqual(
    store.rows().map((entry) => entry.offset),
    [0, 10, 20, 30],
  );
});

test("while following, the head is trimmed to the following limit", () => {
  const store = buffer({ followingLimit: 10, browsingLimit: 100 });
  store.append(series(25));

  assert.equal(store.size(), 10);
  assert.equal(store.rows()[0]?.offset, 15, "the oldest rows went, not the newest");
  assert.equal(store.has("line:worker:1:0"), false);
});

test("while scrolled back, eviction never passes the row being read", () => {
  const store = buffer({ followingLimit: 10, browsingLimit: 12 });
  store.append(series(12));
  store.setFollowing(false);
  // Rows 2..11 survived the following-limit trim; anchor on offset 5.
  store.setAnchor("line:worker:1:5");

  store.append(series(3, 100));
  assert.deepEqual(
    store.rows().map((entry) => entry.offset),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 100, 101, 102],
    "the head was trimmed only as far as the ceiling required",
  );

  const change = store.append(series(5, 200));
  assert.equal(store.rows()[0]?.offset, 5, "eviction stopped exactly at the anchor");
  assert.equal(store.size(), 12, "and the ceiling still holds");
  assert.equal(change.refused, 3, "the rest were refused rather than silently lost");
});

test("a full buffer under a pinned anchor refuses rows and says how many", () => {
  const store = buffer({ followingLimit: 6, browsingLimit: 6 });
  store.append(series(6));
  store.setFollowing(false);
  store.setAnchor("line:worker:1:0");

  const change = store.append(series(3, 50));
  assert.equal(change.refused, 3, "nothing could be evicted, so nothing was added");
  assert.equal(store.size(), 6);
  assert.equal(store.rows()[0]?.offset, 0, "the reader's row never moved");

  store.setFollowing(true);
  const marker = store.rows().at(-1);
  assert.equal(marker?.type, "marker");
  assert.equal(marker?.type === "marker" ? marker.reason : null, "browsing");
  assert.equal(marker?.type === "marker" ? marker.skippedLines : null, 3);
});

test("returning to live re-applies the softer following limit", () => {
  const store = buffer({ followingLimit: 5, browsingLimit: 50 });
  store.append(series(5));
  store.setFollowing(false);
  store.setAnchor("line:worker:1:0");
  store.append(series(20, 100));
  assert.equal(store.size(), 25);

  store.setFollowing(true);
  assert.equal(store.size(), 5);
  assert.equal(store.rows()[0]?.offset, 115);
});

test("pausing holds rows out of the view and releases them on resume", () => {
  const store = buffer({ pauseLimit: 10 });
  store.append(series(2));
  store.setPaused(true);
  store.append(series(3, 50));

  assert.equal(store.size(), 2, "the view does not move while paused");
  assert.equal(store.heldCount(), 3);

  store.setPaused(false);
  assert.equal(store.size(), 5);
  assert.equal(store.heldCount(), 0);
  assert.ok(
    store.rows().every((entry) => entry.type === "line"),
    "nothing was skipped, so nothing is claimed to have been",
  );
});

test("a pause that overruns its bound reports exactly what it dropped", () => {
  const store = buffer({ pauseLimit: 3 });
  store.setPaused(true);
  store.append(series(10));

  assert.equal(store.heldCount(), 3);
  assert.equal(store.skippedWhilePaused(), 7);

  store.setPaused(false);
  const rows = store.rows();
  assert.equal(rows.length, 4, "three held rows plus the marker that explains the rest");
  assert.deepEqual(
    rows.slice(0, 3).map((entry) => entry.offset),
    [7, 8, 9],
    "the newest held rows survive; the oldest are the ones dropped",
  );

  const marker = rows.at(-1);
  assert.equal(marker?.type, "marker");
  assert.equal(marker?.type === "marker" ? marker.reason : null, "paused");
  assert.equal(marker?.type === "marker" ? marker.skippedLines : null, 7);
  assert.match(
    marker?.type === "marker" ? marker.detail : "",
    /7 lines skipped while paused/,
  );
});

test("a paused buffer still recognises rows it already holds", () => {
  const store = buffer();
  store.append([row("worker", 1, 0)]);
  store.setPaused(true);
  const change = store.append([row("worker", 1, 0)]);
  assert.equal(change.duplicates, 1);
  assert.equal(change.held, 0);
});

test("resetting clears identities so a refetched window is admitted again", () => {
  const store = buffer();
  store.append(series(3));
  store.reset();
  assert.equal(store.size(), 0);

  store.append(series(3));
  assert.equal(store.size(), 3, "a reconnect refetch is not mistaken for a duplicate");
});

test("a batch orders a flushed partial before the restart that caused it", () => {
  const flushed: LogLineRecord = { ...line("worker", 1, 40, "half"), partial: true };
  const restarted: LogMarkerRecord = {
    id: "marker:worker:2:0:restarted:9",
    kind: "restarted",
    reason: "truncated",
    service: "worker",
    generation: 2,
    offset: 0,
    observedAt: "2026-08-19T12:00:00.000Z",
    detail: "Log restarted — the file was truncated in place.",
  };
  const fresh = line("worker", 2, 0, "fresh");

  assert.deepEqual(
    toLogRows([flushed, fresh], [restarted]).map((entry) =>
      entry.type === "line" ? entry.text : entry.kind,
    ),
    ["half", "restarted", "fresh"],
  );
});

test("a batch keeps each service's lines in offset order", () => {
  const rows = toLogRows(
    [line("worker", 1, 10), line("admin", 1, 0), line("worker", 1, 0)],
    [],
  );
  assert.deepEqual(
    rows.map((entry) => `${entry.service}:${entry.offset}`),
    ["admin:0", "worker:0", "worker:10"],
  );
});
