import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetryingSingleFlight } from "./runtime-loader.ts";

test("concurrent cold-start requests share one runtime initialization", async () => {
  let calls = 0;
  let release: ((value: string) => void) | undefined;
  const getRuntime = createRetryingSingleFlight(() => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });

  const first = getRuntime();
  const second = getRuntime();
  assert.equal(calls, 1);
  release?.("ready");
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  assert.equal(await getRuntime(), "ready");
  assert.equal(calls, 1);
});

test("a failed initialization is retried by the next request", async () => {
  let calls = 0;
  const getRuntime = createRetryingSingleFlight(async () => {
    calls += 1;
    if (calls === 1) throw new Error("database waking");
    return "ready";
  });

  await assert.rejects(getRuntime, /database waking/);
  assert.equal(await getRuntime(), "ready");
  assert.equal(calls, 2);
});
