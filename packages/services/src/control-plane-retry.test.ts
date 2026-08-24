import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlPlaneRetryExhaustedError,
  ControlPlaneTransactionError,
  RuntimeControlPlaneFence,
  RuntimeLocallyFencedError,
  runControlPlaneTransaction,
} from "./control-plane-retry.ts";

test("transient retries use exactly 0, 100, 400 ms and revalidate every attempt", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const timeouts: number[] = [];
  const result = await runControlPlaneTransaction({
    runtimeFence: new RuntimeControlPlaneFence(),
    revalidate: (attempt) => { attempts.push(attempt); },
    transact: ({ attempt, timeoutMilliseconds }) => {
      timeouts.push(timeoutMilliseconds);
      if (attempt < 3) throw new ControlPlaneTransactionError("serialization");
      return "committed";
    },
    onExhausted: () => assert.fail("must not fence a successful transaction"),
    sleep: async (delay) => { delays.push(delay); },
    now: () => 0,
  });
  assert.equal(result, "committed");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [100, 400]);
  assert.deepEqual(timeouts, [750, 750, 750]);
});

test("nontransient failures never retry or self-fence", async () => {
  const fence = new RuntimeControlPlaneFence();
  let attempts = 0;
  await assert.rejects(
    runControlPlaneTransaction({
      runtimeFence: fence,
      revalidate: () => { attempts += 1; },
      transact: () => { throw new ControlPlaneTransactionError("lost_ownership"); },
      onExhausted: () => assert.fail("not retry exhaustion"),
      sleep: async () => undefined,
      now: () => 0,
    }),
    (error) =>
      error instanceof ControlPlaneTransactionError &&
      error.code === "lost_ownership",
  );
  assert.equal(attempts, 1);
  assert.equal(fence.state, "active");
});

test("a stale revalidation propagates without retrying or fencing the owner", async () => {
  const fence = new RuntimeControlPlaneFence();
  let transactions = 0;
  await assert.rejects(
    runControlPlaneTransaction({
      runtimeFence: fence,
      revalidate: () => {
        throw new ControlPlaneTransactionError("stale_fence");
      },
      transact: () => {
        transactions += 1;
        return "must-not-run";
      },
      onExhausted: () => assert.fail("stale work is not retry exhaustion"),
      sleep: async () => undefined,
      now: () => 0,
    }),
    (error) =>
      error instanceof ControlPlaneTransactionError &&
      error.code === "stale_fence",
  );
  assert.equal(transactions, 0);
  assert.equal(fence.state, "active");
});

test("a local fence in the assertion-to-transaction gap starts no transaction", async () => {
  class GapFence extends RuntimeControlPlaneFence {
    #assertions = 0;

    override assertActive(): void {
      super.assertActive();
      this.#assertions += 1;
      if (this.#assertions === 2) this.fence();
    }
  }

  const fence = new GapFence();
  let transactions = 0;
  await assert.rejects(
    runControlPlaneTransaction({
      runtimeFence: fence,
      revalidate: () => undefined,
      transact: () => {
        transactions += 1;
        return "must-not-run";
      },
      onExhausted: () => assert.fail("local fencing is not retry exhaustion"),
      now: () => 0,
    }),
    RuntimeLocallyFencedError,
  );
  assert.equal(transactions, 0);
});

test("exhaustion fences locally before its durable fence callback", async () => {
  const fence = new RuntimeControlPlaneFence();
  let exhaustedState: string | undefined;
  await assert.rejects(
    runControlPlaneTransaction({
      runtimeFence: fence,
      revalidate: () => undefined,
      transact: () => { throw new ControlPlaneTransactionError("timeout"); },
      onExhausted: () => { exhaustedState = fence.state; },
      sleep: async () => undefined,
      now: () => 0,
    }),
    ControlPlaneRetryExhaustedError,
  );
  assert.equal(exhaustedState, "fenced_draining");
  assert.equal(fence.signal.aborted, true);
  assert.throws(() => fence.assertActive(), RuntimeLocallyFencedError);
});

test("a hung transaction is aborted at the fixed attempt deadline and cannot outlive the wall clock", async () => {
  const fence = new RuntimeControlPlaneFence();
  const clockValues = [0, 0, 0, 4_000];
  let transactionSignal: AbortSignal | undefined;
  const startedAt = Date.now();

  await assert.rejects(
    runControlPlaneTransaction({
      runtimeFence: fence,
      revalidate: () => undefined,
      transact: ({ signal }) => {
        transactionSignal = signal;
        return new Promise<string>(() => undefined);
      },
      onExhausted: () => undefined,
      now: () => clockValues.shift() ?? 4_000,
    }),
    ControlPlaneRetryExhaustedError,
  );

  const elapsed = Date.now() - startedAt;
  assert.equal(transactionSignal?.aborted, true);
  assert.equal(fence.state, "fenced_draining");
  assert.ok(elapsed >= 500, `deadline fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 2_500, `deadline failed to bound the call: ${elapsed}ms`);
});
