import assert from "node:assert/strict";
import { test } from "node:test";
import { startMachineryAlertLoop } from "./machinery-alert-runtime.ts";

/**
 * The bounded evaluation loop the admin server hosts. It has to keep running
 * through a failing cycle — the conditions it detects are exactly the ones that
 * make reads fail — and it must never let cycles pile up or hold shutdown open.
 */

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("the loop refuses a cadence outside its bounds", () => {
  assert.throws(
    () => startMachineryAlertLoop({ cycle: () => Promise.resolve(), intervalMs: 999 }),
    RangeError,
  );
});

test("cycles never overlap, a failing cycle is reported, and stopping drains the one in flight", async () => {
  const gate = deferred();
  const started: number[] = [];
  const failures: unknown[] = [];
  let cycles = 0;
  const loop = startMachineryAlertLoop({
    intervalMs: 1_000,
    cycle: async () => {
      cycles += 1;
      started.push(cycles);
      if (cycles === 1) {
        await gate.promise;
        throw new Error("evidence unavailable");
      }
    },
    onFailure: (error) => failures.push(error),
  });

  // Two ticks arrive while the first cycle is still in flight; the second must
  // wait rather than run concurrently against the same evidence.
  const { setTimeout: wait } = await import("node:timers/promises");
  await wait(2_100);
  assert.deepEqual(started, [1], "only one cycle runs at a time");

  gate.resolve();
  await loop.stop();
  assert.equal(failures.length, 1, "the failing cycle is reported, not thrown");
  // A cycle queued behind the stop is abandoned rather than run afterwards.
  assert.deepEqual(started, [1]);
  // Stopping is idempotent and stays settled.
  await loop.stop();
});
