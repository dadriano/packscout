import assert from "node:assert/strict";
import { test } from "node:test";
import type { Readable } from "node:stream";
import { createLogStreamHub, type LogStreamHub } from "./core/log-stream-hub.ts";
import type { ByteRange } from "./core/log-window.ts";
import {
  createLogHistoryReader,
  LogGenerationChangedError,
  RawLogUnidentifiedError,
} from "./log-history-reader.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ORIGINAL_IDENTITY = "1:2";

async function collect(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk as Uint8Array);
  return chunks.map((chunk) => decoder.decode(chunk)).join("");
}

function harness(
  content: string,
  options: { present?: boolean; identity?: string } = {},
) {
  const bytes = encoder.encode(content);
  const reads: ByteRange[] = [];
  const opens: string[] = [];
  let closed = 0;
  // What the descriptor would report — changed by `replaceFile` to stand in for
  // a rotation that has put a different inode behind the same name.
  let identity = options.identity ?? ORIGINAL_IDENTITY;
  // What a *future* open would find behind the name. An already open handle
  // keeps answering from the bytes it was opened on, exactly as a descriptor
  // does once the name has been rotated away from it.
  let current = bytes;
  const hub: LogStreamHub = createLogStreamHub();
  // One observation gives the service a generation without giving it a cursor:
  // no viewer is attached, so the tail reads nothing.
  hub
    .tailer("worker")
    .observe(
      { present: true, fileId: ORIGINAL_IDENTITY, sizeBytes: bytes.length },
      1_000,
    );

  const reader = createLogHistoryReader({
    directory: "/logs",
    hub,
    now: () => 1_700_000_000_000,
    openFile: async (filePath) => {
      if (options.present === false) return null;
      opens.push(filePath);
      const opened = current;
      const openedIdentity = identity;
      return {
        identity: openedIdentity,
        sizeBytes: opened.length,
        modifiedAtMs: 1_600_000_000_000,
        read: async (range) => {
          reads.push(range);
          return opened.subarray(range.offset, range.offset + range.length);
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  return {
    reader,
    reads,
    opens,
    hub,
    size: bytes.length,
    closedCount: () => closed,
    /** A rotation the tail's poll has not caught up with yet. */
    replaceFile(nextIdentity = "1:99", nextContent?: string) {
      identity = nextIdentity;
      if (nextContent !== undefined) current = encoder.encode(nextContent);
    },
    /** A rotation the tail *has* noticed, so its generation has moved on. */
    observeRotation(nextIdentity = "1:99") {
      identity = nextIdentity;
      hub
        .tailer("worker")
        .observe(
          { present: true, fileId: nextIdentity, sizeBytes: bytes.length },
          2_000,
        );
    },
  };
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

/**
 * The gap the counter alone cannot cover. Between a rotation and the tail's
 * next poll, `generation()` still reports the old number while the pathname
 * already resolves to a different inode — so a page that looked well-formed
 * would come back full of the new file's bytes wearing the old file's offsets.
 */
test("a page whose file was replaced behind its name is refused, not answered", async () => {
  const space = harness("a\nbb\nccc\n");
  space.replaceFile();

  await assert.rejects(
    () =>
      space.reader.readPage({
        service: "worker",
        direction: "backward",
        cursor: 5,
        generation: 1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LogGenerationChangedError);
      assert.equal(error.reason, "identity");
      assert.equal(error.code, "ops_panel_log_generation_changed");
      return true;
    },
  );
  assert.deepEqual(space.reads, [], "no bytes of the replacement file were read");
  assert.equal(space.closedCount(), 1, "the descriptor was still closed");
});

test("a replaced file is refused even when the caller named no generation", async () => {
  const space = harness("a\nbb\n");
  space.replaceFile();
  await assert.rejects(
    () =>
      space.reader.readPage({
        service: "worker",
        direction: "backward",
        cursor: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LogGenerationChangedError);
      assert.equal(error.requestedGeneration, null);
      return true;
    },
  );
});

/**
 * Two independent opens could straddle a rotation and put the bytes above a
 * match and the bytes below it into one pane from two different files.
 */
test("context above and below a match comes from one descriptor", async () => {
  const space = harness("a\nbb\nccc\ndddd\n");
  const page = await space.reader.readPage({
    service: "worker",
    direction: "around",
    cursor: 5,
    lines: 4,
    generation: 1,
  });
  assert.equal(page.lines.length, 4);
  assert.equal(space.opens.length, 1, "one open for both halves");
  assert.equal(space.reads.length, 2, "still one bounded read above, one below");
  assert.equal(space.closedCount(), 1);
});

/**
 * The other half of the same story: once the tail *has* noticed the rotation,
 * only a request that carries the generation it was searching can be refused.
 * A context read that drops it would be answered from the replacement file.
 */
test("context around a match found in an earlier generation is refused", async () => {
  const space = harness("a\nbb\nccc\ndddd\n");
  space.observeRotation();

  await assert.rejects(
    () =>
      space.reader.readPage({
        service: "worker",
        direction: "around",
        cursor: 5,
        lines: 4,
        generation: 1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof LogGenerationChangedError);
      assert.equal(error.requestedGeneration, 1);
      assert.equal(error.currentGeneration, 2);
      assert.equal(error.reason, "generation");
      return true;
    },
  );
  assert.deepEqual(space.reads, [], "a refused request reads no file content");
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
  const space = harness("a\nbb\n");
  const file = await space.reader.describeRawFile("worker");
  assert.equal(file.fileName, "worker.log");
  assert.equal(file.identity, ORIGINAL_IDENTITY);
  assert.equal(file.sizeBytes, space.size);
  assert.deepEqual(space.opens, ["/logs/worker.log"], "the name is opened once");
  assert.equal(space.reads.length, 0, "describing a file reads none of its bytes");
  await file.close();
});

test("a raw download streams the descriptor it measured, not the name", async () => {
  const space = harness("a\nbb\n");
  const file = await space.reader.describeRawFile("worker");

  // A rotation lands between the measurement and the first byte of transfer.
  space.replaceFile("1:99", "replacement-generation\n");

  assert.equal(await collect(file.open()), "a\nbb\n");
  assert.deepEqual(
    space.opens,
    ["/logs/worker.log"],
    "streaming never re-opens the name it was measured through",
  );
  await file.close();
});

test("releasing a raw download closes its descriptor exactly once", async () => {
  const space = harness("a\nbb\n");
  const file = await space.reader.describeRawFile("worker");
  await file.close();
  await file.close();
  assert.equal(space.closedCount(), 1);
});

test("a descriptor that cannot say which file it is refuses the download", async () => {
  const space = harness("a\nbb\n", { identity: "0:0" });
  await assert.rejects(
    () => space.reader.describeRawFile("worker"),
    (error: unknown) => {
      assert.ok(error instanceof RawLogUnidentifiedError);
      assert.equal(error.code, "ops_panel_log_file_unidentified");
      assert.equal(error.service, "worker");
      return true;
    },
  );
  assert.equal(space.closedCount(), 1, "a refused download leaves nothing open");
});

test("an unsafe service name never reaches the filesystem", async () => {
  const { reader } = harness("a\n");
  await assert.rejects(() => reader.describeRawFile("../etc/passwd"));
});
