import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { createProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import { providerPageQueryExpiration } from "./provider-page-transaction.ts";

const timeoutMilliseconds = 1000;
const delayMilliseconds = 3000;
const cases = ["active_query", "delayed_next_query", "expired_commit", "deferred_commit", "constraints_in_callback"] as const;

function safeExpiration(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return { subtype: "not_prisma" };
  const field = Object.getOwnPropertyDescriptor(error.meta ?? {}, "error");
  const value: unknown = field && "value" in field ? field.value : undefined;
  if (error.code !== "P2028" || typeof value !== "string") return { subtype: "not_transaction_invalid" };
  const match = /^(?:Transaction already closed: )?A (query|batch query|commit|rollback) cannot be executed on an expired transaction\. The timeout for this transaction was ([0-9]+) ms, however ([0-9]+) ms passed since the start of the transaction\. Consider increasing the interactive transaction timeout or doing less work in the transaction\.?$/u.exec(value);
  return match ? { subtype: `expired_${match[1]!.replace(" ", "_")}`,
    reportedTimeoutMilliseconds: Number(match[2]), reportedElapsedMilliseconds: Number(match[3]) }
    : { subtype: "other_transaction_invalid", detailLength: value.length };
}

for (const scenario of cases) {
  test(`real transaction expiration matrix: ${scenario}`, async context => {
    if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
      context.skip("An explicit disposable PostgreSQL test target is required."); return;
    }
    const harness = await createProviderHarness(); const { client } = harness;
    let callbackFailure: unknown; let outerFailure: unknown;
    let callbackCompleted = false; let writeCompleted = false;
    const startedAt = performance.now();
    try {
      if (scenario === "deferred_commit" || scenario === "constraints_in_callback") {
        await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_delay_category_commit() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NULL; END; $$`);
        await client.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER synthetic_delay_category_commit
          AFTER INSERT ON categories DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION synthetic_delay_category_commit()`);
      }
      try {
        await client.$transaction(async transaction => {
          try {
            await createProviderCanonicalTransaction(transaction).upsertCategory({
              categoryKey: "synthetic-timeout", parentCategoryId: null, displayName: "Synthetic timeout",
            });
            writeCompleted = true;
            if (scenario === "active_query") {
              await transaction.$executeRaw`SELECT pg_sleep(3)`;
            } else if (scenario === "delayed_next_query" || scenario === "expired_commit") {
              await delay(delayMilliseconds);
              if (scenario === "delayed_next_query") await transaction.categories.count();
            }
            if (scenario === "constraints_in_callback") {
              await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
            }
            callbackCompleted = true;
          } catch (error) { callbackFailure = error; throw error; }
        }, { maxWait: 5000, timeout: timeoutMilliseconds,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) { outerFailure = error; }
      const elapsedMilliseconds = Math.round(performance.now() - startedAt);
      const diagnostic = safeExpiration(outerFailure);
      const categories = await client.categories.count();
      const promotions = await client.promotion_changes.count();
      const ledger = await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } });
      context.diagnostic(JSON.stringify({ scenario, ...diagnostic, elapsedMilliseconds,
        callbackCompleted, callbackFailureMatchesOuter: callbackFailure !== undefined && callbackFailure === outerFailure,
        currentQueryClassifierAccepted: providerPageQueryExpiration(outerFailure) !== null,
        writeCompleted, durableCategories: categories, durablePromotions: promotions,
        durableLedgerSequence: ledger.last_sequence.toString() }));
      assert.ok(outerFailure instanceof Prisma.PrismaClientKnownRequestError);
      assert.equal(outerFailure.code, "P2028");
      const commitCase = scenario === "expired_commit" || scenario === "deferred_commit";
      assert.equal(diagnostic.subtype, commitCase ? "expired_commit" : "expired_query");
      assert.equal(providerPageQueryExpiration(outerFailure) !== null, !commitCase);
      assert.equal(writeCompleted, true, "The timeout must occur after canonical and promotion writes.");
      if (scenario === "deferred_commit") {
        assert.equal(categories, 1, "An expired COMMIT acknowledgement does not prove rollback.");
        assert.equal(promotions, 1); assert.equal(ledger.last_sequence, 1n);
      } else {
        assert.equal(categories, 0); assert.equal(promotions, 0); assert.equal(ledger.last_sequence, 0n);
      }
      if (scenario === "expired_commit" || scenario === "deferred_commit") {
        assert.equal(callbackCompleted, true); assert.equal(callbackFailure, undefined);
      } else {
        assert.equal(callbackCompleted, false); assert.equal(callbackFailure, outerFailure);
      }
    } finally { await harness.close(); }
  });
}
