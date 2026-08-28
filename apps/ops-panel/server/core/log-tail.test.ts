import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogTailer,
  type LogFileObservation,
  type LogTailer,
} from "./log-tail.ts";

const encoder = new TextEncoder();

/**
 * A file whose bytes the test controls directly, so truncation, replacement and
 * disappearance are exercised without touching a filesystem.
 */
function fakeFile(initial = "") {
  let content = encoder.encode(initial);
  let fileId = "1:100";
  let present = true;
  return {
    append(text: string) {
      const addition = encoder.encode(text);
      const merged = new Uint8Array(content.length + addition.length);
      merged.set(content);
      merged.set(addition, content.length);
      content = merged;
    },
    truncate(text = "") {
      content = encoder.encode(text);
    },
    replace(text: string, nextFileId = "1:200") {
      content = encoder.encode(text);
      fileId = nextFileId;
    },
    remove() {
      present = false;
    },
    restore(text: string, nextFileId = "1:300") {
      content = encoder.encode(text);
      fileId = nextFileId;
      present = true;
    },
    observation(): LogFileObservation {
      return present
        ? { present: true, fileId, sizeBytes: content.length }
        : { present: false };
    },
    slice(offset: number, length: number) {
      return content.subarray(offset, offset + length);
    },
  };
}

let clock = 0;

/** One reader tick: observe, satisfy whatever the tailer asked for, collect. */
function pump(tailer: LogTailer, file: ReturnType<typeof fakeFile>) {
  clock += 10;
  const step = tailer.observe(file.observation(), clock);
  const lines = [...step.lines];
  const markers = [...step.markers];

  if (step.align) {
    tailer.adoptAlignment(
      step.align,
      file.slice(step.align.offset, step.align.length),
    );
  } else if (step.read) {
    const emission = tailer.ingest(
      step.read,
      file.slice(step.read.offset, step.read.length),
      clock,
    );
    lines.push(...emission.lines);
    markers.push(...emission.markers);
  }
  return { lines, markers, read: step.read, align: step.align };
}

function tailerFor(options: Partial<Parameters<typeof createLogTailer>[0]> = {}) {
  let sequence = 0;
  return createLogTailer({
    service: "worker",
    nextSequence: () => (sequence += 1),
    ...options,
  });
}

test("with no viewer attached the tail reads no file content", () => {
  const file = fakeFile("already here\n");
  const tailer = tailerFor();

  const first = pump(tailer, file);
  assert.equal(first.read, null);
  assert.equal(first.align, null);
  assert.equal(tailer.cursor(), null, "passive tailers keep no read position");

  file.append("more output\n");
  const second = pump(tailer, file);
  assert.equal(second.read, null);
  assert.deepEqual(second.lines, []);

  // Identity is still tracked, which is the whole point of passive mode.
  assert.equal(tailer.fileId(), "1:100");
  assert.equal(tailer.sizeBytes(), 25);
});

test("attaching aligns to the last complete line, then streams from there", () => {
  const file = fakeFile("history one\nhistory two\npartial-so-far");
  const tailer = tailerFor();
  const detach = tailer.attach();

  const aligned = pump(tailer, file);
  assert.ok(aligned.align, "a viewer arrival triggers a bounded backward scan");
  assert.equal(tailer.cursor(), 24, "aligned past the last terminator");
  assert.deepEqual(aligned.lines, []);

  file.append(" finished\n");
  const streamed = pump(tailer, file);
  assert.deepEqual(
    streamed.lines.map((line) => line.text),
    ["partial-so-far finished"],
  );
  assert.equal(streamed.lines[0]?.offset, 24);

  detach();
  assert.equal(tailer.cursor(), null, "detaching returns the tail to passive");
});

test("truncation ends the generation and says so", () => {
  const file = fakeFile("before\n");
  const tailer = tailerFor();
  tailer.attach();
  pump(tailer, file);
  file.append("first\n");
  const before = pump(tailer, file);
  assert.equal(before.lines[0]?.id, "line:worker:1:7");

  file.truncate("new\n");
  const after = pump(tailer, file);
  assert.equal(after.markers.length, 1);
  assert.equal(after.markers[0]?.kind, "restarted");
  assert.equal(after.markers[0]?.reason, "truncated");
  assert.match(after.markers[0]?.detail ?? "", /truncated/);
  assert.deepEqual(
    after.lines.map((line) => line.id),
    ["line:worker:2:0"],
    "the new generation restarts offsets without colliding with the old one",
  );
});

test("replacement by a new file is a restart, not a continuation", () => {
  const file = fakeFile("old\n");
  const tailer = tailerFor();
  tailer.attach();
  pump(tailer, file);

  file.replace("rotated content\n");
  const after = pump(tailer, file);
  assert.equal(after.markers[0]?.reason, "replaced");
  assert.deepEqual(
    after.lines.map((line) => line.text),
    ["rotated content"],
  );
  assert.equal(tailer.generation(), 2);
});

test("disappearing and reappearing produce distinct markers and generations", () => {
  const file = fakeFile("running\n");
  const tailer = tailerFor();
  tailer.attach();
  pump(tailer, file);

  file.remove();
  const gone = pump(tailer, file);
  assert.equal(gone.markers[0]?.kind, "disappeared");
  assert.equal(gone.markers[0]?.reason, "missing");
  assert.match(gone.markers[0]?.detail ?? "", /waiting/i);
  assert.equal(tailer.isPresent(), false);

  file.restore("back again\n");
  const back = pump(tailer, file);
  assert.equal(back.markers[0]?.kind, "appeared");
  assert.deepEqual(
    back.lines.map((line) => line.id),
    ["line:worker:2:0"],
    "a reappeared file is read from its start under a fresh generation",
  );
});

test("an unterminated line survives a restart as a forced flush", () => {
  const file = fakeFile("");
  const tailer = tailerFor();
  tailer.attach();
  pump(tailer, file);

  file.append("half-written");
  const held = pump(tailer, file);
  assert.deepEqual(held.lines, [], "held rather than published mid-line");

  file.truncate("fresh\n");
  const restarted = pump(tailer, file);
  assert.equal(restarted.lines[0]?.text, "half-written");
  assert.equal(restarted.lines[0]?.partial, true);
  assert.equal(restarted.lines[0]?.generation, 1);
  assert.equal(restarted.markers[0]?.kind, "restarted");
  assert.equal(restarted.lines[1]?.text, "fresh");
  assert.equal(restarted.lines[1]?.generation, 2);
});

test("reads are capped per tick and resume exactly where they stopped", () => {
  const file = fakeFile("");
  const tailer = tailerFor({ readCapBytes: 8 });
  tailer.attach();
  pump(tailer, file);

  file.append("aaa\nbbb\nccc\n");
  const first = pump(tailer, file);
  assert.deepEqual(first.read, { offset: 0, length: 8 });
  assert.deepEqual(
    first.lines.map((line) => line.text),
    ["aaa", "bbb"],
  );

  const second = pump(tailer, file);
  assert.deepEqual(second.read, { offset: 8, length: 4 });
  assert.deepEqual(
    second.lines.map((line) => line.text),
    ["ccc"],
  );
});

test("a tail that falls too far behind skips forward and admits the gap", () => {
  const file = fakeFile("");
  const tailer = tailerFor({ readCapBytes: 8, catchUpLimitBytes: 16 });
  tailer.attach();
  pump(tailer, file);

  file.append("x".repeat(40) + "\nlast line\n");
  const caught = pump(tailer, file);

  const skipped = caught.markers.find((marker) => marker.kind === "skipped");
  assert.ok(skipped, "the gap is reported, never silently swallowed");
  assert.equal(skipped?.reason, "catch_up");
  assert.equal(skipped?.skippedBytes, 43);
  assert.deepEqual(caught.read, { offset: 43, length: 8 });
  assert.deepEqual(
    caught.lines.map((line) => line.text),
    [],
    "the partial line the cursor landed inside is dropped, not published",
  );

  // Streaming resumes on the next whole line, with offsets that still line up
  // with the file, so a later history read addresses the same bytes.
  file.append("resumed\n");
  const next = pump(tailer, file);
  assert.deepEqual(
    next.lines.map((line) => [line.text, line.offset]),
    [["resumed", 51]],
  );
});

test("stale byte ranges are refused so offsets can never be fabricated", () => {
  const file = fakeFile("one\n");
  const tailer = tailerFor();
  tailer.attach();
  pump(tailer, file);
  file.append("two\n");
  const step = tailer.observe(file.observation(), clock);
  assert.ok(step.read);

  file.truncate("");
  tailer.observe(file.observation(), clock);
  const emission = tailer.ingest(
    step.read,
    encoder.encode("two\n"),
    clock,
  );
  assert.deepEqual(emission.lines, []);
});

test("a held line is published once its hold expires, without new bytes", () => {
  const file = fakeFile("");
  const tailer = tailerFor({ holdMs: 50 });
  tailer.attach();
  pump(tailer, file);
  file.append("still going");
  pump(tailer, file);

  assert.deepEqual(tailer.tick(clock).lines, [], "inside the hold");
  const flushed = tailer.tick(clock + 100).lines;
  assert.equal(flushed[0]?.text, "still going");
  assert.equal(flushed[0]?.partial, true);
});

test("viewers are reference counted; the last one to leave releases the tail", () => {
  const file = fakeFile("a\n");
  const tailer = tailerFor();
  const first = tailer.attach();
  const second = tailer.attach();
  pump(tailer, file);
  assert.equal(tailer.viewerCount(), 2);
  assert.notEqual(tailer.cursor(), null);

  first();
  first();
  assert.equal(tailer.viewerCount(), 1, "detaching twice releases one viewer");
  assert.notEqual(tailer.cursor(), null);

  second();
  assert.equal(tailer.viewerCount(), 0);
  assert.equal(tailer.cursor(), null);
});
