import assert from "node:assert/strict";
import test from "node:test";
import { runDrainedDatabaseTransaction } from "./drained-database-transaction.ts";
import { PrismaProviderWorkerLeaseRepository } from "./provider-worker-lease-repository.ts";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";

test("drained transaction preserves the original timeout while waiting for its late callback before close", async () => {
  const timeout = new Error("transaction timeout"), late = new Error("late callback failure");
  const events: string[] = [];
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const work = runDrainedDatabaseTransaction(async callback => {
    void callback(undefined).catch(() => undefined);
    await Promise.resolve();
    throw timeout;
  }, async () => { events.push("callback-start"); await gate; events.push("callback-end"); throw late; });
  const closed = work.catch(error => { assert.equal(error, timeout); }).finally(() => { events.push("close"); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["callback-start"]);
  unblock(); await closed;
  assert.deepEqual(events, ["callback-start", "callback-end", "close"]);
});

for (const action of ["acquire", "renew", "release"] as const) {
  test(`normal lease ${action} keeps timeout failure and drains its actual repository callback`, async () => {
    const timeout = new Error("simulated Prisma deadline"), events: string[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const row = { worker_role: "import", lease_owner: "fixture:owner", lease_fence: 5n, heartbeat_at: new Date(),
      lease_expires_at: new Date(Date.now() + 60_000), row_version: 2n, database_now: new Date() };
    const transaction = {
      $queryRaw: async () => { events.push("query-start"); await gate; events.push("query-end"); return [row]; },
      provider_worker_states: { updateMany: async () => { events.push("mutation-attempt"); throw new Error("Transaction already closed"); } },
    } as unknown as ProviderTransactionClient;
    const database = { $transaction: async (callback: (tx: ProviderTransactionClient) => Promise<unknown>, options: unknown) => {
      assert.deepEqual(options, { maxWait: 5_000, timeout: 10_000, isolationLevel: "Serializable" });
      void callback(transaction).catch(() => undefined); await Promise.resolve(); throw timeout;
    } } as unknown as ProviderPrismaClient;
    const repository = new PrismaProviderWorkerLeaseRepository(database);
    const operation = repository[action]({ role: "import", owner: "fixture:owner", fence: 5n, leaseMilliseconds: 60_000 });
    const result = operation.catch(error => { assert.equal(error, timeout); }).finally(() => { events.push("close"); });
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ["query-start"]);
    unblock(); await result;
    assert.deepEqual(events, ["query-start", "query-end", "mutation-attempt", "close"]);
  });
}
