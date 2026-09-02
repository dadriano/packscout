import assert from "node:assert/strict";
import test from "node:test";
import { createProviderHarness } from
  "./provider-canonical-integration-support.ts";
import {
  ProviderCanonicalRepository,
  createProviderCanonicalTransaction,
} from "./provider-canonical-repository.ts";
import { PrismaProviderPromotionJobRepository } from
  "./provider-promotion-job-repository.ts";

test("material canonical changes and their provider wake commit or roll back together", async () => {
  const harness = await createProviderHarness();
  try {
    const jobs = new PrismaProviderPromotionJobRepository(harness.client);
    assert.equal((await jobs.loadWakeIntent()).requestedGeneration, 0n);

    await assert.rejects(harness.client.$transaction(async (transaction) => {
      await createProviderCanonicalTransaction(transaction).upsertCategory({
        categoryKey: "atomic-wake-rollback",
        parentCategoryId: null,
        displayName: "Rolled back",
      });
      throw new Error("roll back canonical transaction");
    }));
    assert.equal(await harness.client.categories.count(), 0);
    assert.equal(await harness.client.promotion_changes.count(), 0);
    assert.equal((await jobs.loadWakeIntent()).requestedGeneration, 0n);

    const canonical = new ProviderCanonicalRepository(harness.client);
    const first = await canonical.upsertCategory({
      categoryKey: "atomic-wake",
      parentCategoryId: null,
      displayName: "Atomic wake",
    });
    assert.equal(first.materialChange, true);
    const firstWake = await jobs.loadWakeIntent();
    assert.equal(firstWake.requestedGeneration, 1n);
    assert.equal(firstWake.latestCause, "canonical_settlement");
    assert.equal(firstWake.pending, true);

    const repeated = await canonical.upsertCategory({
      categoryKey: "atomic-wake",
      parentCategoryId: null,
      displayName: "Atomic wake",
    });
    assert.equal(repeated.materialChange, false);
    assert.deepEqual(await jobs.loadWakeIntent(), firstWake,
      "a byte-identical canonical replay creates no new wake");

    const second = await canonical.upsertCategory({
      categoryKey: "atomic-wake",
      parentCategoryId: null,
      displayName: "Atomic wake updated",
    });
    assert.equal(second.materialChange, true);
    assert.equal((await jobs.loadWakeIntent()).requestedGeneration, 2n);
  } finally {
    await harness.close();
  }
});
