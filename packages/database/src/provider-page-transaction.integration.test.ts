import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { createProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import { runProviderPageTransaction } from "./provider-page-transaction.ts";

function expiration() {
  return new Prisma.PrismaClientKnownRequestError("synthetic protected query", {
    code: "P2028", clientVersion: "6.19.3", meta: { error: "Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms, however 30001 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction." },
  });
}

test("settled callback rollback removes canonical and promotion writes before the one page retry", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
    context.skip("An explicit disposable PostgreSQL test target is required."); return;
  }
  const harness = await createProviderHarness(); const { client } = harness;
  try {
    let attempts = 0;
    const result = await runProviderPageTransaction({ database: client, deadlineAt: Date.now() + 55_000,
      operation: async (tx, attempt) => {
        attempts += 1;
        assert.equal(await tx.categories.count(), 0, "The earlier transaction must have rolled back.");
        assert.equal(await tx.promotion_changes.count(), 0);
        const category = await createProviderCanonicalTransaction(tx).upsertCategory({
          categoryKey: "atomic-page", parentCategoryId: null, displayName: "Atomic page",
        });
        if (attempt === 0) throw expiration();
        return category;
      },
    });
    assert.equal(attempts, 2); assert.equal(result.rowVersion, 1n);
    assert.equal(await client.categories.count(), 1);
    assert.equal(await client.promotion_changes.count(), 1);
    assert.equal((await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } })).last_sequence, 1n);
  } finally { await harness.close(); }
});

test("the installed Prisma engine exposes the exact expired-query template, without error text escaping", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
    context.skip("An explicit disposable PostgreSQL test target is required."); return;
  }
  const { providerPageQueryExpiration } = await import("./provider-page-transaction.ts");
  const harness = await createProviderHarness();
  try {
    await assert.rejects(harness.client.$transaction(async tx => {
      await new Promise(resolve => setTimeout(resolve, 120));
      await tx.categories.count();
    }, { timeout: 50 }), error => {
      const expired = providerPageQueryExpiration(error);
      assert.ok(expired, "The installed Prisma engine must prove query expiration before any automatic retry.");
      assert.equal(expired.timeoutMilliseconds, 50);
      assert.ok(expired.elapsedMilliseconds >= 50);
      return true;
    });
  } finally { await harness.close(); }
});
