import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampHistoryBudget,
  DEFAULT_HISTORY_BUDGET_BYTES,
  MAX_HISTORY_BUDGET_BYTES,
  MIN_HISTORY_BUDGET_BYTES,
  planContextHalves,
  planHistoryChunk,
  readBackwardPage,
  readForwardPage,
  type HistoryPage,
} from "./log-history.ts";

const encoder = new TextEncoder();

/** "a\nbb\nccc\ndddd\n": offsets 0, 2, 5, 9; 14 bytes in total. */
const FILE = encoder.encode("a\nbb\nccc\ndddd\n");

function slice(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  return bytes.subarray(offset, offset + length);
}

function pageBackward(
  cursor: number,
  budget: number,
  maxLines = 100,
  file = FILE,
): HistoryPage {
  const chunk = planHistoryChunk({
    direction: "backward",
    cursor,
    fileSize: file.length,
    budgetBytes: budget,
  });
  return readBackwardPage({
    service: "worker",
    generation: 3,
    chunk,
    bytes: slice(file, chunk.offset, chunk.length),
    fileSize: file.length,
    maxLines,
    readAtMs: 1_000,
  });
}

function pageForward(
  cursor: number,
  budget: number,
  maxLines = 100,
  file = FILE,
): HistoryPage {
  const chunk = planHistoryChunk({
    direction: "forward",
    cursor,
    fileSize: file.length,
    budgetBytes: budget,
  });
  return readForwardPage({
    service: "worker",
    generation: 3,
    chunk,
    bytes: slice(file, chunk.offset, chunk.length),
    fileSize: file.length,
    maxLines,
    readAtMs: 1_000,
  });
}

test("a requested byte budget is clamped rather than trusted", () => {
  assert.equal(clampHistoryBudget(undefined), DEFAULT_HISTORY_BUDGET_BYTES);
  assert.equal(clampHistoryBudget("not a number"), DEFAULT_HISTORY_BUDGET_BYTES);
  assert.equal(clampHistoryBudget(1), MIN_HISTORY_BUDGET_BYTES);
  assert.equal(clampHistoryBudget(1e12), MAX_HISTORY_BUDGET_BYTES);
  assert.equal(clampHistoryBudget(8_192), 8_192);
});

test("a chunk plan never reads the whole file, in either direction", () => {
  assert.deepEqual(
    planHistoryChunk({
      direction: "backward",
      cursor: 10_000,
      fileSize: 10_000,
      budgetBytes: 256,
    }),
    { offset: 9_744, length: 256 },
  );
  assert.deepEqual(
    planHistoryChunk({
      direction: "forward",
      cursor: 9_900,
      fileSize: 10_000,
      budgetBytes: 256,
    }),
    { offset: 9_900, length: 100 },
  );
});

test("a chunk plan clamps a cursor that points outside the file", () => {
  assert.deepEqual(
    planHistoryChunk({
      direction: "forward",
      cursor: 50_000,
      fileSize: 100,
      budgetBytes: 256,
    }),
    { offset: 100, length: 0 },
  );
  assert.deepEqual(
    planHistoryChunk({
      direction: "backward",
      cursor: -20,
      fileSize: 100,
      budgetBytes: 256,
    }),
    { offset: 0, length: 0 },
  );
});

test("backward paging returns the requested number of whole lines", () => {
  const page = pageBackward(14, 1_024, 2);
  assert.deepEqual(
    page.lines.map((line) => [line.id, line.text, line.offset, line.endOffset]),
    [
      ["line:worker:3:5", "ccc", 5, 9],
      ["line:worker:3:9", "dddd", 9, 14],
    ],
  );
  assert.equal(page.nextCursor, 5);
  assert.equal(page.atStart, false);
  assert.equal(page.fragmented, false);
});

test("backward paging walks to the start of the file and says it arrived", () => {
  const visited: number[] = [];
  let cursor = FILE.length;
  let atStart = false;
  const texts: string[] = [];
  while (!atStart) {
    const page = pageBackward(cursor, 1_024, 2);
    assert.ok(page.nextCursor < cursor, "every page must move the cursor back");
    visited.push(page.nextCursor);
    texts.unshift(...page.lines.map((line) => line.text));
    cursor = page.nextCursor;
    atStart = page.atStart;
  }
  assert.deepEqual(visited, [5, 0]);
  assert.deepEqual(texts, ["a", "bb", "ccc", "dddd"]);
});

test("backward paging honours a byte budget smaller than the file", () => {
  const wide = encoder.encode(`${"x".repeat(5_999)}\n`);
  const page = pageBackward(wide.length, MIN_HISTORY_BUDGET_BYTES, 100, wide);
  assert.equal(page.bytesRead, MIN_HISTORY_BUDGET_BYTES);
  assert.ok(page.bytesRead < wide.length, "the whole file is never read at once");
});

test("a line longer than the budget comes back as a bounded fragment whose cursor progresses", () => {
  const enormous = encoder.encode(`${"x".repeat(20_000)}\n`);
  const budget = MIN_HISTORY_BUDGET_BYTES;
  const first = pageBackward(enormous.length, budget, 100, enormous);

  assert.equal(first.fragmented, true);
  assert.equal(first.bytesRead, budget);
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0]?.partial, true);
  assert.equal(first.lines[0]?.text.length, budget - 1, "the terminator is stripped");
  assert.equal(first.nextCursor, enormous.length - budget);

  // The loop terminates: every page is bounded and every cursor moves.
  let cursor = enormous.length;
  let pages = 0;
  let atStart = false;
  while (!atStart && pages < 100) {
    const page = pageBackward(cursor, budget, 100, enormous);
    assert.ok(page.bytesRead <= budget, "a page never exceeds its budget");
    assert.ok(page.nextCursor < cursor, "a fragment page still progresses");
    cursor = page.nextCursor;
    atStart = page.atStart;
    pages += 1;
  }
  assert.equal(atStart, true);
  assert.equal(pages, Math.ceil(20_001 / budget));
});

test("a backward page that cannot prove a line boundary flags what it returns", () => {
  // The chunk starts exactly on "dddd", but nothing in the slice proves it.
  const page = pageBackward(14, 5);
  assert.equal(page.fragmented, true);
  assert.equal(page.nextCursor, 9);
  assert.deepEqual(
    page.lines.map((line) => [line.text, line.partial]),
    [["dddd", true]],
  );
});

test("forward paging starts at the cursor and stops on a line boundary", () => {
  const page = pageForward(0, 6);
  assert.deepEqual(
    page.lines.map((line) => [line.text, line.offset]),
    [
      ["a", 0],
      ["bb", 2],
    ],
  );
  // "cc" was read but not published: the bytes that finish that line are the
  // next page, and half a line is never presented as a whole one.
  assert.equal(page.nextCursor, 5);
  assert.equal(page.atEnd, false);
  assert.equal(page.bytesRead, 6);
});

test("forward paging reaching the end of the file says so", () => {
  const page = pageForward(9, 1_024);
  assert.deepEqual(page.lines.map((line) => line.text), ["dddd"]);
  assert.equal(page.atEnd, true);
  assert.equal(page.nextCursor, 14);
});

test("forward paging publishes a trailing unterminated line only at end of file", () => {
  const unterminated = encoder.encode("first\nsecond");
  const page = pageForward(0, 1_024, 100, unterminated);
  assert.deepEqual(
    page.lines.map((line) => [line.text, line.partial]),
    [
      ["first", false],
      ["second", true],
    ],
  );
  assert.equal(page.atEnd, true);
});

test("forward paging caps a page by line count and resumes exactly after it", () => {
  const page = pageForward(0, 1_024, 2);
  assert.deepEqual(page.lines.map((line) => line.text), ["a", "bb"]);
  assert.equal(page.nextCursor, 5);
  assert.equal(page.atEnd, false, "a line cap is not the end of the file");

  const next = pageForward(page.nextCursor, 1_024, 2);
  assert.deepEqual(next.lines.map((line) => line.text), ["ccc", "dddd"]);
  assert.equal(next.atEnd, true);
});

test("forward paging fragments a line larger than its budget rather than stalling", () => {
  const enormous = encoder.encode(`${"y".repeat(20_000)}\n`);
  const budget = MIN_HISTORY_BUDGET_BYTES;
  let cursor = 0;
  let pages = 0;
  let atEnd = false;
  while (!atEnd && pages < 100) {
    const page = pageForward(cursor, budget, 100, enormous);
    assert.ok(page.bytesRead <= budget, "a page never exceeds its budget");
    assert.ok(page.nextCursor > cursor, "a fragment page still progresses");
    if (page.fragmented) {
      assert.equal(page.lines.length, 1);
      assert.equal(page.lines[0]?.partial, true);
    }
    cursor = page.nextCursor;
    atEnd = page.atEnd;
    pages += 1;
  }
  assert.equal(atEnd, true);
  assert.equal(cursor, enormous.length);
});

test("an empty read reports the boundary it is sitting on instead of spinning", () => {
  const atStart = pageBackward(0, 1_024);
  assert.deepEqual(atStart.lines, []);
  assert.equal(atStart.atStart, true);
  assert.equal(atStart.nextCursor, 0);

  const atEnd = pageForward(14, 1_024);
  assert.deepEqual(atEnd.lines, []);
  assert.equal(atEnd.atEnd, true);
  assert.equal(atEnd.nextCursor, 14);
});

test("history records are marked as read rather than observed", () => {
  const page = pageBackward(14, 1_024);
  assert.ok(page.lines.every((line) => line.backfilled));
  assert.ok(page.lines.every((line) => line.id.startsWith("line:worker:3:")));
});

test("context around a match leans above the line it centres on", () => {
  assert.deepEqual(planContextHalves(40), { before: 20, after: 20 });
  assert.deepEqual(planContextHalves(41), { before: 21, after: 20 });
  assert.deepEqual(planContextHalves(1), { before: 1, after: 1 });
});
