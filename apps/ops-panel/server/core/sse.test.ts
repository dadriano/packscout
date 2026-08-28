import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createServerSentStream,
  formatHeartbeat,
  formatRetryHint,
  formatServerSentEvent,
  SSE_HEADERS,
} from "./sse.ts";

function harness() {
  const written: string[] = [];
  const timers: Array<{ handler: () => void; milliseconds: number }> = [];
  let closed = 0;
  let released = 0;
  const stream = createServerSentStream({
    write: (chunk) => written.push(chunk),
    close: () => {
      closed += 1;
    },
    retryMs: 2_000,
    heartbeatMs: 5_000,
    setTimer: (handler, milliseconds) => {
      timers.push({ handler, milliseconds });
      return timers.length - 1;
    },
    clearTimer: () => {
      timers.pop();
    },
    onTeardown: () => {
      released += 1;
    },
  });
  return {
    stream,
    written,
    timers,
    counts: () => ({ closed, released }),
  };
}

test("stream headers disable caching and proxy buffering", () => {
  assert.equal(SSE_HEADERS["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(SSE_HEADERS["cache-control"], "no-cache, no-transform");
  assert.equal(SSE_HEADERS["x-accel-buffering"], "no");
});

test("events are named and carry JSON payloads", () => {
  assert.equal(
    formatServerSentEvent({ event: "sources", data: '{"a":1}' }),
    'event: sources\ndata: {"a":1}\n\n',
  );
  assert.equal(
    formatServerSentEvent({ event: "sources", data: "one\ntwo", id: "7" }),
    "id: 7\nevent: sources\ndata: one\ndata: two\n\n",
  );
  assert.throws(
    () => formatServerSentEvent({ event: "bad name", data: "{}" }),
    /event name is invalid/,
  );
});

test("retry hints and heartbeats use the documented framing", () => {
  assert.equal(formatRetryHint(3_000), "retry: 3000\n\n");
  assert.equal(formatHeartbeat(), ": heartbeat\n\n");
  assert.throws(() => formatRetryHint(-1), /non-negative/);
});

test("opening a stream emits the retry hint and schedules heartbeats", () => {
  const { stream, written, timers } = harness();
  stream.open();
  assert.deepEqual(written, ["retry: 2000\n\n"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.milliseconds, 5_000);

  timers[0]?.handler();
  assert.equal(written.at(-1), ": heartbeat\n\n");
});

test("teardown releases per-connection resources exactly once", () => {
  const { stream, written, timers, counts } = harness();
  stream.open();
  stream.send("sources", { services: ["worker"] });
  assert.equal(written.at(-1), 'event: sources\ndata: {"services":["worker"]}\n\n');

  stream.teardown();
  stream.teardown();
  assert.equal(timers.length, 0);
  assert.deepEqual(counts(), { closed: 1, released: 1 });
  assert.equal(stream.isOpen(), false);
});

test("writes after teardown are refused instead of throwing", () => {
  const { stream, written } = harness();
  stream.open();
  stream.teardown();
  const before = written.length;
  assert.equal(stream.send("sources", {}), false);
  assert.equal(stream.heartbeat(), false);
  assert.equal(written.length, before);
});

test("a torn-down stream cannot be reopened", () => {
  const { stream, written, timers } = harness();
  stream.teardown();
  stream.open();
  assert.equal(written.length, 0);
  assert.equal(timers.length, 0);
});
