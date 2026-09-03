import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { providerSnapshot } = await tsImport(
  "./promote-distributed-clutchpacks-to-local-convex.mts",
  import.meta.url,
);

test("an absent central active configuration refuses before provider access", async () => {
  let transactionStarted = false;
  await assert.rejects(
    providerSnapshot(
      { async $transaction() { transactionStarted = true; } },
      { active_config_version: null },
    ),
    (error) => error.code === "CLUTCHPACKS_CENTRAL_STATE_UNSUPPORTED",
  );
  assert.equal(transactionStarted, false);
});

test("an absent import worker row is ineligible, not an idle lease or null dereference", async () => {
  let isolation;
  const one = async () => ({});
  const zero = async () => 0;
  const transaction = {
    database_identity: { findUnique: one },
    provider_runtime: { findUnique: one },
    provider_runs: {
      async findFirst() { return { finished_at: new Date("2026-08-29T21:37:36.800Z") }; },
      count: zero,
    },
    promotion_ledger: { findUnique: one },
    promotion_changes: { aggregate: one },
    packs: {
      async count() { return 1; },
      async findMany() { return [{}]; },
    },
    collectibles: { count: zero },
    pack_contents: { count: zero },
    provider_worker_states: { async findUnique() { return null; } },
  };
  await assert.rejects(
    providerSnapshot(
      {
        async $transaction(operation, options) {
          isolation = options.isolationLevel;
          return await operation(transaction);
        },
      },
      { active_config_version: { id: "fixture-config" } },
    ),
    (error) => error.code === "CLUTCHPACKS_SNAPSHOT_INELIGIBLE",
  );
  assert.equal(isolation, "RepeatableRead");
});
