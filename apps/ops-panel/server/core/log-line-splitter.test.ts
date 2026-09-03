import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogLineSplitter } from "./log-line-splitter.ts";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

test("complete lines carry byte-accurate, contiguous offsets", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  const lines = splitter.append(bytes("first\nsecond\n"), 0);

  assert.deepEqual(
    lines.map((line) => [line.text, line.offset, line.endOffset]),
    [
      ["first", 0, 6],
      ["second", 6, 13],
    ],
  );
  assert.deepEqual(
    lines.map((line) => line.id),
    ["line:worker:1:0", "line:worker:1:6"],
  );
  assert.equal(splitter.pendingOffset(), 13);
});

test("offsets count bytes, not characters", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  const lines = splitter.append(bytes("héllo ✅\nnext\n"), 0);

  assert.equal(lines[0]?.text, "héllo ✅");
  // 'é' is two bytes and '✅' is three, so the line is 10 bytes plus a newline.
  assert.equal(lines[0]?.endOffset, 11);
  assert.equal(lines[1]?.offset, 11);
});

test("an unterminated tail is held rather than split in two", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  assert.deepEqual(splitter.append(bytes("half"), 0), []);
  assert.equal(splitter.pendingBytes(), 4);

  const lines = splitter.append(bytes("-written\n"), 5);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, "half-written");
  assert.equal(lines[0]?.partial, false);
  assert.equal(lines[0]?.offset, 0);
});

test("a held line is force-flushed once its hold expires", () => {
  const splitter = createLogLineSplitter({ service: "worker", holdMs: 100 });
  splitter.append(bytes("progress"), 1_000);

  assert.deepEqual(splitter.flush(1_050), [], "still inside the hold");
  const flushed = splitter.flush(1_100);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.text, "progress");
  assert.equal(flushed[0]?.partial, true);
  assert.equal(splitter.pendingBytes(), 0);

  // The continuation is its own record; offsets stay contiguous across it.
  const rest = splitter.append(bytes(" done\n"), 1_200);
  assert.equal(rest[0]?.offset, 8);
  assert.equal(rest[0]?.text, " done");
});

test("a line longer than the size cap is published instead of buffered", () => {
  const splitter = createLogLineSplitter({ service: "worker", maxLineBytes: 8 });
  const lines = splitter.append(bytes("0123456789ab"), 0);

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, "01234567");
  assert.equal(lines[0]?.partial, true);
  assert.equal(splitter.pendingBytes(), 4);
});

test("a carriage return before the terminator is not part of the text", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  const lines = splitter.append(bytes("windows\r\n"), 0);
  assert.equal(lines[0]?.text, "windows");
  assert.equal(lines[0]?.endOffset, 9);
});

test("resetting into a new generation restarts identity at the new offset", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  splitter.append(bytes("old\n"), 0);
  splitter.reset(2, 0);

  const lines = splitter.append(bytes("new\n"), 0);
  assert.equal(lines[0]?.id, "line:worker:2:0");
  assert.equal(splitter.generation(), 2);
});

test("a repositioned cursor drops the partial line it landed inside", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  splitter.reset(1, 100, { dropLeadingPartial: true });

  const lines = splitter.append(bytes("tail-of-a-line\nwhole\n"), 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, "whole");
  assert.equal(lines[0]?.offset, 115);
});

test("a repositioned cursor that never finds a terminator publishes nothing", () => {
  const splitter = createLogLineSplitter({ service: "worker" });
  splitter.reset(1, 0, { dropLeadingPartial: true });

  assert.deepEqual(splitter.append(bytes("no terminator here"), 0), []);
  assert.equal(splitter.pendingOffset(), 18);
});
