import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogStreamSession } from "./stream-session.ts";

test("the first connection loads its windows without claiming a seam", () => {
  const session = createLogStreamSession();
  assert.equal(session.phase(), "connecting");

  assert.deepEqual(session.opened(), {
    phase: "live",
    action: "load-initial-window",
    markSeam: false,
  });
});

test("a failure before the first connection is still just connecting", () => {
  const session = createLogStreamSession();
  assert.deepEqual(session.failed(), {
    phase: "connecting",
    action: "none",
    markSeam: false,
  });
});

test("a drop after a good connection is reported as reconnecting", () => {
  const session = createLogStreamSession();
  session.opened();
  assert.deepEqual(session.failed(), {
    phase: "reconnecting",
    action: "none",
    markSeam: false,
  });
});

test("coming back resets the buffer and marks the seam", () => {
  const session = createLogStreamSession();
  session.opened();
  session.failed();

  assert.deepEqual(session.opened(), {
    phase: "live",
    action: "reset-and-refetch",
    markSeam: true,
    },
    "the gap is admitted rather than papered over by appending onto stale rows",
  );
});

test("every later reconnection is treated the same way", () => {
  const session = createLogStreamSession();
  session.opened();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    session.failed();
    const transition = session.opened();
    assert.equal(transition.action, "reset-and-refetch");
    assert.equal(transition.markSeam, true);
  }
});

test("a duplicate open on a live stream never discards a good buffer", () => {
  const session = createLogStreamSession();
  session.opened();
  assert.deepEqual(session.opened(), {
    phase: "live",
    action: "none",
    markSeam: false,
  });
});
