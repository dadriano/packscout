import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  MAX_PRODUCTION_BATCH_BYTES,
  MAX_PRODUCTION_BATCH_COUNT,
  MAX_PRODUCTION_BATCH_RECORDS,
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
} from "@packscout/contracts";
import { buildCatalogReleasePublishPlan } from "./catalog-release-artifacts.ts";
import { CatalogReleaseAssembler } from "./catalog-release-assembler.ts";
import {
  fixtureCheckpoint,
  fixtureConfiguration,
  fixtureSnapshot,
} from "./catalog-release-fixture.test-support.ts";
import { prepareCatalogPromotion } from "./catalog-promotion-operations.ts";

const LOCAL_PREPARATION_TARGET_MILLISECONDS = 60_000;

function syntheticRepackId(index: number): string {
  return `80000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

function syntheticCollectibleId(index: number): string {
  return `90000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

test("protocol-maximum local catalog preparation stays bounded and completes within one minute", {
  timeout: 120_000,
}, async () => {
  const checkpoint = fixtureCheckpoint();
  const seed = await new CatalogReleaseAssembler(
    { async getCheckpoint() { return checkpoint; } },
    { async loadSnapshot() { return fixtureSnapshot(); } },
  ).assemble({
    requestedWatermark: checkpoint.settledSequence,
    baseline: null,
    trigger: "full_rebuild",
  });
  assert.equal(seed.classification, "publish");
  if (seed.classification !== "publish") return;
  const seedRepack = seed.manifest.repacks[0]!;
  const seedChase = seed.manifest.repackChases[0]!;
  const seedCollectible = seed.manifest.collectibles[0]!;
  const collectibleCount = Math.ceil(
    MAX_PUBLIC_REPACKS_PER_RELEASE / MAX_REPACK_CHASES_PER_COLLECTIBLE,
  );
  const collectibles = Array.from(
    { length: collectibleCount },
    (_, offset) => ({
      ...seedCollectible,
      publicCollectibleId: syntheticCollectibleId(offset + 1),
    }),
  );
  const repacks = Array.from(
    { length: MAX_PUBLIC_REPACKS_PER_RELEASE },
    (_, offset) => {
      const publicRepackId = syntheticRepackId(offset + 1);
      const publicCollectibleId = syntheticCollectibleId(
        Math.floor(offset / MAX_REPACK_CHASES_PER_COLLECTIBLE) + 1,
      );
      return {
        ...seedRepack,
        publicRepackId,
        topChase: seedRepack.topChase === null
          ? null
          : {
              ...seedRepack.topChase,
              publicRepackId,
              publicCollectibleId,
              collectible: {
                ...seedRepack.topChase.collectible,
                publicCollectibleId,
              },
            },
      };
    },
  );
  const repackChases = Array.from(
    { length: MAX_PUBLIC_REPACKS_PER_RELEASE },
    (_, offset) => ({
      ...seedChase,
      publicRepackId: syntheticRepackId(offset + 1),
      publicCollectibleId: syntheticCollectibleId(
        Math.floor(offset / MAX_REPACK_CHASES_PER_COLLECTIBLE) + 1,
      ),
      collectible: {
        ...seedChase.collectible,
        publicCollectibleId: syntheticCollectibleId(
          Math.floor(offset / MAX_REPACK_CHASES_PER_COLLECTIBLE) + 1,
        ),
      },
    }),
  );

  const startedAt = performance.now();
  const plan = await buildCatalogReleasePublishPlan({
    requestedWatermark: checkpoint.settledSequence,
    observationSequence: Number(checkpoint.settledSequence),
    expectedPredecessorPublicReleaseId: null,
    configuration: fixtureConfiguration,
    configurationHash: "a".repeat(64),
    vendors: seed.manifest.vendors,
    categories: seed.manifest.categories,
    collectibles,
    repacks,
    repackChases,
    dataAsOf: checkpoint.settledAt!,
    settledAt: checkpoint.settledAt!,
    delayedVendorCount: 0,
  });
  const prepared = prepareCatalogPromotion({ plan, baseline: null });
  const elapsedMilliseconds = performance.now() - startedAt;

  assert.equal(plan.counts.repacks, MAX_PUBLIC_REPACKS_PER_RELEASE);
  assert.equal(plan.counts.repackChases, MAX_PUBLIC_REPACKS_PER_RELEASE);
  assert.ok(plan.batches.length <= MAX_PRODUCTION_BATCH_COUNT);
  for (const batch of plan.batches) {
    assert.ok(batch.records.length <= MAX_PRODUCTION_BATCH_RECORDS);
    assert.ok(batch.byteCount <= MAX_PRODUCTION_BATCH_BYTES);
  }
  for (const operation of prepared.operations) {
    assert.ok(Buffer.byteLength(operation.bodyJson, "utf8") <=
      MAX_PRODUCTION_HTTP_BODY_BYTES);
  }
  assert.ok(
    elapsedMilliseconds < LOCAL_PREPARATION_TARGET_MILLISECONDS,
    `local catalog preparation took ${String(Math.ceil(elapsedMilliseconds))}ms`,
  );
});
