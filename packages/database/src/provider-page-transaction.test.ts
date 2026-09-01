import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import { ProviderPageTransactionExpiredError, ProviderPageTransactionWindowError,
  providerPageQueryExpiration, runProviderPageTransaction } from "./provider-page-transaction.ts";

function expiration(operation = "query") {
  return new Prisma.PrismaClientKnownRequestError("private query text", { code: "P2028", clientVersion: "6.19.3",
    meta: { error: `Transaction already closed: A ${operation} cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms, however 30001 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.` } });
}

test("only the trusted expired-query template is classified positively, without disclosing metadata", () => {
  const classified = providerPageQueryExpiration(expiration());
  assert.ok(classified instanceof ProviderPageTransactionExpiredError);
  assert.equal(classified.timeoutMilliseconds, 30_000);
  assert.equal(classified.elapsedMilliseconds, 30_001);
  assert.equal(classified.message.includes("private"), false);
  for (const error of [expiration("commit"), { code: "P2028" },
    new Prisma.PrismaClientKnownRequestError("expired transaction", { code: "P2028", clientVersion: "test", meta: { error: "Transaction not found." } }),
    new Proxy({}, { getPrototypeOf() { throw new Error("private trap"); } })]) {
    assert.equal(providerPageQueryExpiration(error), null);
  }
});

test("a retry waits for rollback settlement and invokes the same operation once more", async () => {
  const order: string[] = [];
  let release!: () => void;
  const rollback = new Promise<void>(resolve => { release = resolve; });
  const database = { async $transaction(operation: (tx: ProviderTransactionClient) => Promise<string>) {
    order.push("begin");
    try { const result = await operation({} as ProviderTransactionClient); order.push("commit"); return result; }
    catch (error) { order.push("rollback_started"); await rollback; order.push("rollback_finished"); throw error; }
  } } as unknown as Pick<ProviderPrismaClient, "$transaction">;
  const work = runProviderPageTransaction({ database, deadlineAt: 55_000, now: () => 0,
    operation: async (_tx, attempt) => { order.push(`attempt_${attempt}`); if (!attempt) throw expiration(); return "committed"; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["begin", "attempt_0", "rollback_started"]);
  release();
  assert.equal(await work, "committed");
  assert.deepEqual(order, ["begin", "attempt_0", "rollback_started", "rollback_finished", "begin", "attempt_1", "commit"]);
});

test("unknown P2028 and commit acknowledgement errors are never retried", async () => {
  for (const phase of ["callback", "commit"] as const) {
    let attempts = 0;
    const unknown = new Prisma.PrismaClientKnownRequestError("private details", { code: "P2028", clientVersion: "test" });
    const database = { async $transaction(operation: (tx: ProviderTransactionClient) => Promise<void>) {
      attempts += 1; await operation({} as ProviderTransactionClient); throw expiration();
    } } as unknown as Pick<ProviderPrismaClient, "$transaction">;
    await assert.rejects(runProviderPageTransaction({ database, deadlineAt: 55_000, now: () => 0,
      operation: async () => { if (phase === "callback") throw unknown; },
    }));
    assert.equal(attempts, 1);
  }
});

test("two attempts, remaining operation window and retry authority decisions are respected", async () => {
  let clock = 0; const timeouts: number[] = []; let calls = 0;
  const database = { async $transaction(operation: (tx: ProviderTransactionClient) => Promise<string>, options: { timeout: number }) {
    timeouts.push(options.timeout); return operation({} as ProviderTransactionClient);
  } } as unknown as Pick<ProviderPrismaClient, "$transaction">;
  await assert.rejects(runProviderPageTransaction({ database, deadlineAt: 55_000, now: () => clock,
    operation: async () => { calls += 1; clock += 30_000; throw expiration(); },
  }), ProviderPageTransactionExpiredError);
  assert.deepEqual(timeouts, [30_000, 20_000]); assert.equal(calls, 2);
  await assert.rejects(runProviderPageTransaction({ database, deadlineAt: 60_000, now: () => clock,
    operation: async () => { assert.fail("Exhausted window must not enter a transaction."); },
  }), ProviderPageTransactionWindowError);
  clock = 0; calls = 0;
  assert.equal(await runProviderPageTransaction({ database, deadlineAt: 55_000, now: () => clock,
    operation: async (_tx, attempt) => { calls += 1; if (!attempt) throw expiration(); return "lease_lost"; },
  }), "lease_lost");
  assert.equal(calls, 2);
});
