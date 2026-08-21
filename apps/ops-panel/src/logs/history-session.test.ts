import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogHistoryPayload, LogLineRecord, LogRow } from "../api/panel-types.ts";
import {
  advanceDetachedBrowse,
  beginDetachedBrowse,
  browsedGenerations,
  describeDetachedBrowse,
  describeGenerationBreak,
  describeStartOfLog,
  detectGenerationBreak,
  oldestHeldByService,
  planBackwardReads,
  planContextRead,
  planStartRead,
} from "./history-session.ts";

function line(
  service: string,
  generation: number,
  offset: number,
): LogRow & { type: "line" } {
  return {
    type: "line",
    id: `line:${service}:${generation}:${offset}`,
    service,
    generation,
    offset,
    endOffset: offset + 10,
    text: `${service} at ${offset}`,
    observedAt: "2026-08-19T12:00:00.000Z",
    backfilled: false,
    partial: false,
  };
}

function marker(service: string, generation: number, offset: number): LogRow {
  return {
    type: "marker",
    id: `marker:${service}:${generation}:${offset}:restarted:1`,
    kind: "restarted",
    reason: "truncated",
    service,
    generation,
    offset,
    observedAt: "2026-08-19T12:00:00.000Z",
    detail: "Log restarted.",
  };
}

const everything = () => true;

test("the oldest held line per service is where backward paging resumes", () => {
  const rows: LogRow[] = [
    line("worker", 2, 400),
    line("frontend", 1, 90),
    line("worker", 2, 800),
    line("frontend", 1, 30),
  ];
  assert.deepEqual(
    [...oldestHeldByService(rows, everything)],
    [
      ["worker", { generation: 2, offset: 400 }],
      ["frontend", { generation: 1, offset: 30 }],
    ],
  );
});

test("an earlier generation wins over a lower offset in a later one", () => {
  const rows: LogRow[] = [line("worker", 2, 0), line("worker", 1, 900)];
  assert.deepEqual(oldestHeldByService(rows, everything).get("worker"), {
    generation: 1,
    offset: 900,
  });
});

test("markers never become a paging cursor", () => {
  // A marker's offset is wherever the tail happened to be, not a line start.
  const rows: LogRow[] = [marker("worker", 1, 5), line("worker", 1, 400)];
  assert.deepEqual(oldestHeldByService(rows, everything).get("worker"), {
    generation: 1,
    offset: 400,
  });
});

test("hidden services are not paged for", () => {
  const rows: LogRow[] = [line("worker", 1, 10), line("admin", 1, 10)];
  const edges = oldestHeldByService(rows, (service) => service === "worker");
  assert.deepEqual([...edges.keys()], ["worker"]);
});

test("a service with nothing on screen is read from the tail instead", () => {
  const edges = oldestHeldByService([line("worker", 3, 700)], everything);
  assert.deepEqual(planBackwardReads(["worker", "admin"], edges, new Set()), [
    { service: "worker", generation: 3, before: 700 },
    { service: "admin", generation: null, before: null },
  ]);
});

test("a service already at the start of its log is not asked again", () => {
  const edges = oldestHeldByService([line("worker", 1, 0)], everything);
  assert.deepEqual(
    planBackwardReads(["worker", "admin"], edges, new Set(["worker"])),
    [{ service: "admin", generation: null, before: null }],
  );
});

test("a live line from a newer generation ends browsing for that service", () => {
  const browsed = browsedGenerations(
    oldestHeldByService([line("worker", 2, 40), line("admin", 1, 10)], everything),
  );
  const arrivals: LogLineRecord[] = [
    { ...line("admin", 1, 90) },
    { ...line("worker", 3, 0) },
  ];
  assert.deepEqual(detectGenerationBreak(browsed, arrivals), {
    service: "worker",
    from: 2,
    to: 3,
  });
  assert.match(describeGenerationBreak("worker"), /returned to live/u);
});

test("live output from the generation being browsed is not a break", () => {
  const browsed = new Map([["worker", 2]]);
  assert.equal(detectGenerationBreak(browsed, [line("worker", 2, 9_000)]), null);
  assert.equal(detectGenerationBreak(browsed, [line("admin", 9, 0)]), null);
});

function page(overrides: Partial<LogHistoryPayload> = {}): LogHistoryPayload {
  return {
    service: "worker",
    generation: 4,
    present: true,
    fileSize: 5_000,
    direction: "forward",
    startCursor: 0,
    endCursor: 1_200,
    atStart: true,
    atEnd: false,
    fragmented: false,
    bytesRead: 1_200,
    readAt: "2026-08-19T12:00:00.000Z",
    lines: [],
    ...overrides,
  };
}

test("a detached browse starts at the first byte and pages forward", () => {
  const start = beginDetachedBrowse("worker", 4);
  assert.deepEqual(start, {
    service: "worker",
    generation: 4,
    origin: "start",
    next: 0,
    atStart: true,
    atEnd: false,
    linesRead: 0,
  });

  const first = advanceDetachedBrowse(
    start,
    page({ lines: [line("worker", 4, 0), line("worker", 4, 20)] }),
  );
  assert.equal(first.next, 1_200);
  assert.equal(first.linesRead, 2);
  assert.match(describeDetachedBrowse(first), /Read 2 lines from the start of worker/u);
  assert.match(describeDetachedBrowse(first), /Live output is held/u);

  const last = advanceDetachedBrowse(
    first,
    page({ startCursor: 1_200, endCursor: 5_000, atEnd: true, lines: [] }),
  );
  assert.equal(last.atEnd, true);
  assert.match(describeDetachedBrowse(last), /this is the end of the file/u);
});

test("context reads do not claim to have been read from the start", () => {
  const context = advanceDetachedBrowse(
    beginDetachedBrowse("worker", 4, "context"),
    page({ lines: [line("worker", 4, 900)] }),
  );
  assert.match(describeDetachedBrowse(context), /Showing 1 line of context in worker/u);
});

test("a page from another generation cannot move a detached browse", () => {
  const start = advanceDetachedBrowse(beginDetachedBrowse("worker", 4), page());
  const stale = advanceDetachedBrowse(start, page({ generation: 5, endCursor: 9_000 }));
  assert.deepEqual(stale, start);
});

/**
 * A search result is a past observation. If the file rotates between the
 * results coming back and the operator clicking one, an offset on its own gives
 * the server nothing to refuse with, and the reply would be unrelated bytes
 * from the replacement file presented as that match's context.
 */
test("opening a search result carries the generation the match was found in", () => {
  const match = line("worker", 4, 900);
  assert.deepEqual(planContextRead(match), {
    direction: "around",
    cursor: 900,
    generation: 4,
  });
});

test("reading from the start names no generation, because there is none yet", () => {
  assert.deepEqual(planStartRead(), {
    direction: "forward",
    cursor: 0,
    generation: null,
  });
});

test("reaching the start of a log is stated rather than left to spin", () => {
  assert.equal(describeStartOfLog([]), "");
  assert.match(describeStartOfLog(["worker"]), /beginning of worker's log/u);
  assert.match(describeStartOfLog(["admin", "worker"]), /admin, worker/u);
});
