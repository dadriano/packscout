import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ProviderManualImportOperationDrain } from "./provider-manual-import-operation-drain.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("gateway timeout keeps resources open until every admitted callback settles", async () => {
  const owner = new ProviderManualImportOperationDrain();
  const page = deferred<object>();
  const otherLane = deferred<void>();
  const gatewayDeadline = deferred<"timed_out">();
  const events: string[] = [];
  let pageCalls = 0;
  const result = owner.run(async () => {
    pageCalls += 1;
    const value = await page.promise;
    events.push("page settled");
    return value;
  });
  const otherResult = owner.run(async () => {
    await otherLane.promise;
    events.push("other lane settled");
  });
  const response = Promise.race([result.then(() => "completed"), gatewayDeadline.promise]);
  gatewayDeadline.resolve("timed_out");
  assert.equal(await response, "timed_out");
  const cleanup = (async () => {
    await owner.drain();
    events.push("gateway closed", "central closed");
  })();
  let lateCalls = 0;
  await assert.rejects(owner.run(async () => { lateCalls += 1; }), /admission is closed/u);
  assert.equal(lateCalls, 0);
  assert.deepEqual(events, []);
  const committed = Object.freeze({ checkpoint: "fixture-committed" });
  page.resolve(committed);
  assert.strictEqual(await result, committed);
  await setImmediate();
  assert.deepEqual(events, ["page settled"]);
  otherLane.resolve();
  await otherResult;
  await cleanup;
  assert.deepEqual(events, ["page settled", "other lane settled", "gateway closed", "central closed"]);
  assert.equal(pageCalls, 1);
});

test("late callback rejection remains unchanged and never becomes an unhandled rejection", async () => {
  const owner = new ProviderManualImportOperationDrain();
  const callback = deferred<never>();
  const failure = new Error("fixture transaction rollback settled");
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", observe);
  try {
    const result = owner.run(() => callback.promise);
    await setImmediate();
    callback.reject(failure);
    // An outer caller may already have timed out and abandoned its result.
    // Leave it unobserved for a turn before attaching the late caller's check.
    await setImmediate();
    assert.deepEqual(unhandled, []);
    await assert.rejects(result, (error: unknown) => error === failure);
    await owner.drain();
  } finally {
    process.off("unhandledRejection", observe);
  }
});

test("drain owns callbacks admitted before invocation and rejects admission even when empty", async () => {
  const owner = new ProviderManualImportOperationDrain();
  const failure = new Error("fixture synchronous callback failure");
  const result = owner.run(() => { throw failure; });
  const drained = owner.drain();
  assert.strictEqual(owner.drain(), drained);
  await assert.rejects(result, (error: unknown) => error === failure);
  await drained;
  const empty = new ProviderManualImportOperationDrain();
  await empty.drain();
  let called = false;
  await assert.rejects(empty.run(async () => { called = true; }), /admission is closed/u);
  assert.equal(called, false);
});
