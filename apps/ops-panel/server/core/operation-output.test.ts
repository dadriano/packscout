import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationOutputCollector } from "./operation-output.ts";
import { redactSecrets } from "./secret-redaction.ts";

test("lines are completed only when their terminator arrives", () => {
  const collector = createOperationOutputCollector();
  assert.deepEqual(collector.append("Applying migra"), []);
  const emitted = collector.append("tion 001\nApplying 002\n");
  assert.deepEqual(
    emitted.map((line) => line.text),
    ["Applying migration 001", "Applying 002"],
  );
  assert.equal(collector.produced(), 2);
});

test("a trailing unterminated line is published by the flush, not dropped", () => {
  const collector = createOperationOutputCollector();
  collector.append("done\nno newline here");
  const flushed = collector.flush();
  assert.deepEqual(
    flushed.map((line) => line.text),
    ["no newline here"],
  );
  assert.deepEqual(collector.flush(), []);
});

test("a carriage return before the newline is not kept as text", () => {
  const collector = createOperationOutputCollector();
  const emitted = collector.append("windows line\r\n");
  assert.deepEqual(
    emitted.map((line) => line.text),
    ["windows line"],
  );
});

test("output stops being retained at the cap and the overflow is counted", () => {
  const collector = createOperationOutputCollector({ lineLimit: 3 });
  collector.append("one\ntwo\nthree\nfour\nfive\n");

  assert.equal(collector.lines().length, 3);
  assert.deepEqual(
    collector.lines().map((line) => line.text),
    ["one", "two", "three"],
  );
  assert.equal(collector.produced(), 5);
  assert.equal(collector.truncated(), true);
  const notice = collector.describeTruncation();
  assert.ok(notice);
  assert.match(notice, /after 3 lines/u);
  assert.match(notice, /2 further lines/u);
  assert.match(notice, /was not interrupted/u);
});

test("lines beyond the cap are not emitted to subscribers either", () => {
  const collector = createOperationOutputCollector({ lineLimit: 2 });
  assert.equal(collector.append("one\ntwo\n").length, 2);
  assert.deepEqual(collector.append("three\nfour\n"), []);
  assert.equal(collector.produced(), 4);
});

test("an untruncated run reports no truncation notice", () => {
  const collector = createOperationOutputCollector({ lineLimit: 10 });
  collector.append("one\ntwo\n");
  assert.equal(collector.truncated(), false);
  assert.equal(collector.describeTruncation(), null);
});

test("a single monstrous line is cut rather than retained whole", () => {
  const collector = createOperationOutputCollector({ maxLineLength: 12 });
  const [line] = collector.append(`${"x".repeat(400)}\n`);
  assert.ok(line);
  assert.equal(line.text.length, 12);
  assert.ok(line.text.endsWith("…"));
});

/**
 * The failure this guards against is a child that never writes a terminator:
 * before the fragment was capped, nothing in this module counted or bounded it,
 * so it grew for the whole operation timeout.
 */
test("a child that never writes a newline cannot grow the pending fragment", () => {
  const collector = createOperationOutputCollector({ maxLineLength: 2_000 });
  const chunk = "y".repeat(64 * 1024);
  for (let index = 0; index < 200; index += 1) {
    assert.deepEqual(collector.append(chunk), [], "no line completed yet");
    assert.ok(
      collector.pendingLength() <= 2_000,
      `the unterminated fragment grew to ${collector.pendingLength()} characters`,
    );
  }
  assert.equal(collector.produced(), 0, "nothing was published without a terminator");

  const [line] = collector.flush();
  assert.ok(line);
  assert.equal(line.text.length, 2_000);
  assert.ok(line.text.endsWith("…"), "the line admits that it was cut");
});

test("a newline-free fragment that is later terminated is published as cut", () => {
  const collector = createOperationOutputCollector({ maxLineLength: 10 });
  collector.append("0123456789abcdef");
  assert.equal(collector.pendingLength(), 10);
  const [line] = collector.append("ghij\ntail\n");
  assert.ok(line);
  assert.equal(line.text, "012345678…");
  assert.equal(collector.pendingLength(), 0, "the terminator released the fragment");
  assert.deepEqual(
    collector.lines().map((entry) => entry.text),
    ["012345678…", "tail"],
  );
});

test("every retained line passes through the caller's redaction first", () => {
  const secret = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
  const collector = createOperationOutputCollector({
    sanitize: (text) => redactSecrets(text, [secret]),
  });
  const [line] = collector.append(`could not connect to ${secret}\n`);
  assert.ok(line);
  assert.ok(!line.text.includes("hunter2"));
  assert.match(line.text, /\[redacted\]/u);
});

test("a panel-written note joins the output under the same cap", () => {
  const collector = createOperationOutputCollector({ lineLimit: 2 });
  collector.append("one\n");
  assert.deepEqual(
    collector.note("the panel stopped waiting").map((line) => line.text),
    ["the panel stopped waiting"],
  );
  assert.deepEqual(collector.note("dropped"), []);
  assert.equal(collector.truncated(), true);
});

test("line indexes count the whole run, including dropped lines", () => {
  const collector = createOperationOutputCollector({ lineLimit: 2 });
  const emitted = collector.append("one\ntwo\n");
  assert.deepEqual(
    emitted.map((line) => line.index),
    [1, 2],
  );
  collector.append("three\n");
  assert.equal(collector.produced(), 3);
});

test("a line limit that is not a positive integer is refused outright", () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => createOperationOutputCollector({ lineLimit: limit }));
  }
});
