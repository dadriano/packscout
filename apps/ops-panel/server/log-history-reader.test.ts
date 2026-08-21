import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogStreamHub, type LogStreamHub } from "./core/log-stream-hub.ts";
import type { ByteRange } from "./core/log-window.ts";
import {
  createLogHistoryReader,
  LogGenerationChangedError,
} from "./log-history-reader.ts";

const encoder = new TextEncoder();

function harness(content: string, options: { present?: boolean } = {}) {
  const bytes = encoder.encode(content);
  const reads: ByteRange[] = [];
  const hub: LogStreamHub = createLogStreamHub();
  // One observation gives the service a generation without giving it a cursor:
  // no viewer is attached, so the tail reads nothing.
  hub
    .tailer("worker")
    .observe({ present: true, fileId: "1:2", sizeBytes: bytes.length }, 1_000);

  const reader = createLogHistoryReader({
    directory: "/logs",
    hub,
    now: () => 1_700_000_000_000,
    statFile: async (filePath) => {
      if (options.present === false) throw new Error(`missing: ${filePath}`);
      return { size: bytes.length, mtimeMs: 1_600_000_000_000 };
    },
    readRange: async (_filePath, range) => {
      reads.push(range);
      return bytes.subarray(range.offset, range.offset + range.length);
    },
  });
  return { reader, reads, size: bytes.length };
}

test("a backward page reads only its budget and reports where to resume", async () => {
  const { reader, reads } = harness("a\nbb\nccc\ndddd\n");

  const page = await reader.readPage({
    service: "worker",
    direction: "backward",
    cursor: null,
    lines: 2,
  });

  assert.equal(page.present, true);
  assert.deepEqual(page.lines.map((line) => line.text), ["ccc", "dddd"]);
  assert.equal(page.startCursor, 5);
  assert.equal(page.endCursor, 14);
  assert.equal(page.atStart, false);
  assert.equal(reads.length, 1);
  assert.ok(reads[0] !== undefined && reads[0].length <= 256 * 1024);
});

test("backward paging to the beginning states that it arrived", async () => {
  const { reader } = harness("a\nbb\nccc\ndddd\n");
  const page = await reader.readPage({
    service: "worker",
    direction: "backward",
    cursor: 5,
    lines: 500,
  });
  assert.deepEqual(page.lines.map((line) => line.text), ["a", "bb"]);
  assert.equal(page.atStart, true);
  assert.equal(page.startCursor, 0);
});

test("a forward page with no cursor starts at the beginning of the file", async () => {
  const { reader } = harness("a\nbb\nccc\ndddd\n");
  const page = await reader.readPage({
    service: "worker",
    direction: "forward",
    cursor: null,
    lines: 2,
  });
  assert.deepEqual(page.lines.map((line) => line.text), ["a", "bb"]);
  assert.equal(page.startCursor, 0);
  assert.equal(page.endCursor, 5);
  assert.equal(page.atEnd, false);
});

test("context around an offset is centred on it and bounded on both sides", async () => {
  const { reader, reads } = harness("a\nbb\nccc\ndddd\n");
  const page = await reader.readPage({
    service: "worker",
    direction: "around",
    cursor: 5,
    lines: 4,
  });
  assert.deepEqual(page.lines.map((line) => line.text), ["a", "bb", "ccc", "dddd"]);
  assert.equal(page.atStart, true);
  assert.equal(page.atEnd, true);
  assert.equal(reads.length, 2, "one bounded read above, one below");
});

test("a request naming a generation the file no longer has is refused", async () => {
  const { reader, reads } = harness("a\nbb\n");
  await assert.rejects(
    () =>
      reader.readPage({
        service: "worker",
        direction: "backward",
        cursor: 5,
        generation: 7,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LogGenerationChangedError);
      assert.equal(error.requestedGeneration, 7);
      assert.equal(error.currentGeneration, 1);
      assert.equal(error.code, "ops_panel_log_generation_changed");
      return true;
    },
  );
  assert.equal(reads.length, 0, "a refused request reads no file content");
});

test("a matching generation is read normally", async () => {
  const { reader } = harness("a\nbb\n");
  const page = await reader.readPage({
    service: "worker",
    direction: "backward",
    cursor: null,
    generation: 1,
  });
  assert.equal(page.generation, 1);
  assert.deepEqual(page.lines.map((line) => line.text), ["a", "bb"]);
});

test("a missing file answers as absent rather than failing", async () => {
  const { reader } = harness("a\n", { present: false });
  const page = await reader.readPage({
    service: "worker",
    direction: "backward",
    cursor: null,
  });
  assert.equal(page.present, false);
  assert.deepEqual(page.lines, []);
  assert.equal(page.atStart, true);
  assert.equal(page.atEnd, true);
});

test("a raw download is described, never buffered", async () => {
  const { reader, reads, size } = harness("a\nbb\n");
  const file = await reader.describeRawFile("worker");
  assert.equal(file.fileName, "worker.log");
  assert.equal(file.filePath, "/logs/worker.log");
  assert.equal(file.sizeBytes, size);
  assert.equal(reads.length, 0, "describing a file reads none of its bytes");
});

test("an unsafe service name never reaches the filesystem", async () => {
  const { reader } = harness("a\n");
  await assert.rejects(() => reader.describeRawFile("../etc/passwd"));
});
