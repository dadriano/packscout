import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  containsProtectedPublicationField,
  productionBatchByteCount,
  recomputeProductionBatchHash,
} from "@packscout/contracts";
import { CatalogReleaseAssembler } from "./catalog-release-assembler.ts";
import {
  fixtureCheckpoint,
  fixtureIds,
  fixtureSnapshot,
} from "./catalog-release-fixture.test-support.ts";
import type {
  CatalogReleaseBaseline,
  CatalogReleaseSourceSnapshot,
} from "./catalog-release-types.ts";
import type { PublicChangeCheckpoint } from "./public-change-settlement-service.ts";

function assembler(
  checkpoint: PublicChangeCheckpoint,
  snapshot: CatalogReleaseSourceSnapshot,
) {
  return new CatalogReleaseAssembler(
    { async getCheckpoint() { return checkpoint; } },
    { async loadSnapshot() { return snapshot; } },
  );
}

function baseline(plan: Awaited<ReturnType<CatalogReleaseAssembler["assemble"]>>): CatalogReleaseBaseline {
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") throw new Error("publish required");
  return {
    activePublicReleaseId: plan.publicReleaseId,
    observationSequence: plan.observationSequence,
    contentHash: plan.contentHash,
    publicConfigHash: plan.manifest.metadata.publicConfigHash,
    repackSearchIndexHash: plan.manifest.metadata.repackSearchIndexHash,
    publicVendorKeys: plan.publicVendorKeys,
  };
}

function changePack(
  snapshot: CatalogReleaseSourceSnapshot,
  platformKey: string,
  changes: Record<string, unknown>,
): CatalogReleaseSourceSnapshot {
  return {
    ...snapshot,
    revisions: snapshot.revisions.map((revision) =>
      revision.platformKey === platformKey && revision.recordKind === "pack"
        ? {
            ...revision,
            content: { ...(revision.content as Record<string, unknown>), ...changes },
          }
        : revision),
  };
}

test("assembly is byte-stable across repeated, full, and change-triggered builds", async () => {
  const checkpoint = fixtureCheckpoint();
  const service = assembler(checkpoint, fixtureSnapshot());
  const full = await service.assemble({
    requestedWatermark: 20n,
    baseline: null,
    trigger: "full_rebuild",
  });
  const incremental = await service.assemble({
    requestedWatermark: 20n,
    baseline: null,
    trigger: "settled_change",
  });
  assert.equal(full.classification, "publish");
  assert.equal(incremental.classification, "publish");
  if (full.classification !== "publish" || incremental.classification !== "publish") return;
  assert.equal(canonicalJson(full.manifest), canonicalJson(incremental.manifest));
  assert.equal(canonicalJson(full.batches), canonicalJson(incremental.batches));
  assert.deepEqual(full.entityHashes, incremental.entityHashes);
  assert.equal(full.contentHash, incremental.contentHash);
  assert.equal(full.publicReleaseId, incremental.publicReleaseId);
});

test("shuffled canonical source rows reconcile to identical release artifacts", async () => {
  const checkpoint = fixtureCheckpoint();
  const ordered = fixtureSnapshot();
  const shuffled: CatalogReleaseSourceSnapshot = {
    ...ordered,
    revisions: [...ordered.revisions].reverse(),
    providers: [...ordered.providers].reverse(),
    repackIdentities: [...ordered.repackIdentities].reverse(),
  };
  const [first, second] = await Promise.all([
    assembler(checkpoint, ordered).assemble({ requestedWatermark: 20n, baseline: null, trigger: "full_rebuild" }),
    assembler(checkpoint, shuffled).assemble({ requestedWatermark: 20n, baseline: null, trigger: "settled_change" }),
  ]);
  assert.equal(first.classification, "publish");
  assert.equal(second.classification, "publish");
  if (first.classification === "publish" && second.classification === "publish") {
    assert.equal(canonicalJson(first.manifest), canonicalJson(second.manifest));
    assert.equal(canonicalJson(first.batches), canonicalJson(second.batches));
    assert.deepEqual(first.entityHashes, second.entityHashes);
  }
});

test("two-vendor fixture satisfies strict ordering, origins, batching, and protected-field boundaries", async () => {
  const plan = await assembler(fixtureCheckpoint(), fixtureSnapshot()).assemble({
    requestedWatermark: 20n,
    baseline: null,
    trigger: "full_rebuild",
  });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  assert.deepEqual(plan.counts, {
    vendors: 2,
    categories: 2,
    collectibles: 2,
    repacks: 2,
    repackChases: 2,
    searchShards: 1,
  });
  assert.equal(containsProtectedPublicationField(plan), false);
  assert.deepEqual(plan.batches.map(({ kind }) => kind), [
    "vendors", "categories", "collectibles", "repacks", "repack_chases", "search_shards",
  ]);
  const categoryBatch = plan.batches.find(({ kind }) => kind === "categories")!;
  assert.deepEqual(
    categoryBatch.records.map((record) => (record as { depth: number }).depth),
    [0, 1],
  );
  for (const batch of plan.batches) {
    assert.ok(batch.records.length <= 100);
    assert.ok(batch.byteCount <= 48 * 1_024);
    assert.equal(batch.byteCount, productionBatchByteCount(batch.records));
    assert.equal(
      batch.batchHash,
      await recomputeProductionBatchHash({ kind: batch.kind, records: batch.records }),
    );
  }
  assert.deepEqual(plan.manifest.publicAssetOrigins, [
    "https://alpha.example", "https://beta.example",
  ]);
  assert.ok(plan.manifest.repacks.every(({ primaryImage }) =>
    primaryImage === null || !primaryImage.url.includes("unapproved")));
  const soldOut = plan.manifest.repacks.find(({ publicRepackId }) =>
    publicRepackId === fixtureIds.betaRepack)!;
  assert.equal(soldOut.availability, "sold_out");
  assert.equal(soldOut.actionAvailability.repackLink, false);
  assert.equal(soldOut.actions.repackLink, undefined);
});

test("disabled listings are absent and unavailable values use bounded reasons", async () => {
  const unavailable = changePack(fixtureSnapshot(), "alpha", {
    priceValueMinor: null,
    priceCurrency: null,
  });
  const plan = await assembler(fixtureCheckpoint(), unavailable).assemble({
    requestedWatermark: 20n,
    baseline: null,
    trigger: "settled_change",
  });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  const alpha = plan.manifest.repacks.find(({ publicRepackId }) =>
    publicRepackId === fixtureIds.alphaRepack)!;
  assert.deepEqual(alpha.price.usdComparison, {
    status: "unavailable",
    value: null,
    reason: "PRICE_UNAVAILABLE",
  });
  assert.equal(alpha.evEstimates.packScout.status, "unavailable");
  if (alpha.evEstimates.packScout.status === "unavailable") {
    assert.equal(alpha.evEstimates.packScout.reason, "PRICE_UNAVAILABLE");
    assert.equal(alpha.evEstimates.packScout.metrics, null);
  }

  const disabled = changePack(fixtureSnapshot(), "alpha", { availability: "disabled" });
  const disabledPlan = await assembler(fixtureCheckpoint(), disabled).assemble({
    requestedWatermark: 20n,
    baseline: null,
    trigger: "settled_change",
  });
  assert.equal(disabledPlan.classification, "publish");
  if (disabledPlan.classification === "publish") {
    assert.deepEqual(
      disabledPlan.manifest.repacks.map(({ publicRepackId }) => publicRepackId),
      [fixtureIds.betaRepack],
    );
  }
});

test("later delayed providers retain their settled projection while observation freshness stays separate", async () => {
  const first = await assembler(fixtureCheckpoint(), fixtureSnapshot()).assemble({
    requestedWatermark: 20n,
    baseline: null,
    trigger: "full_rebuild",
  });
  const previous = baseline(first);
  const delayedSnapshot = changePack(fixtureSnapshot(), "alpha", {
    name: "Alpha Pack Settled Change",
  });
  const delayed = await assembler(
    fixtureCheckpoint({ sequence: 30n, delayedBeta: true }),
    delayedSnapshot,
  ).assemble({
    requestedWatermark: 30n,
    baseline: previous,
    trigger: "settled_change",
  });
  assert.equal(delayed.classification, "publish");
  if (delayed.classification !== "publish") return;
  assert.equal(delayed.manifest.metadata.delayedVendorCount, 1);
  assert.equal(delayed.manifest.metadata.freshness, "delayed");
  const priorBeta = first.classification === "publish"
    ? first.manifest.repacks.find(({ publicRepackId }) => publicRepackId === fixtureIds.betaRepack)
    : null;
  const delayedBeta = delayed.manifest.repacks.find(({ publicRepackId }) =>
    publicRepackId === fixtureIds.betaRepack);
  assert.equal(canonicalJson(delayedBeta), canonicalJson(priorBeta));

  const newlyEnabledBaseline = { ...previous, publicVendorKeys: ["alpha"] };
  const newlyEnabledDelayed = await assembler(
    fixtureCheckpoint({ sequence: 30n, delayedBeta: true }),
    delayedSnapshot,
  ).assemble({
    requestedWatermark: 30n,
    baseline: newlyEnabledBaseline,
    trigger: "settled_change",
  });
  assert.equal(newlyEnabledDelayed.classification, "blocked");
  if (newlyEnabledDelayed.classification === "blocked") {
    assert.equal(newlyEnabledDelayed.reason, "INITIAL_PROVIDER_DELAYED");
  }

  const unchanged = await assembler(
    fixtureCheckpoint({ sequence: 31n }),
    fixtureSnapshot(),
  ).assemble({
    requestedWatermark: 31n,
    baseline: previous,
    trigger: "settled_change",
  });
  assert.equal(unchanged.classification, "refresh_unchanged");
  if (unchanged.classification === "refresh_unchanged") {
    assert.equal(unchanged.publicReleaseId, previous.activePublicReleaseId);
    assert.equal(unchanged.refreshRequest.observationSequence, 31);
  }
});

test("transient source failures propagate for bounded runner retry", async () => {
  const service = new CatalogReleaseAssembler(
    { async getCheckpoint() { return fixtureCheckpoint(); } },
    { async loadSnapshot() { throw new Error("temporary database outage"); } },
  );
  await assert.rejects(
    service.assemble({ requestedWatermark: 20n, baseline: null, trigger: "settled_change" }),
    /temporary database outage/,
  );
});

test("unsettled, regressed, incomplete, unapproved, delayed-first, and unmapped states fail closed", async () => {
  const ready = fixtureSnapshot();
  const cases = [
    {
      service: assembler(fixtureCheckpoint(), ready),
      requestedWatermark: 21n,
      baseline: null,
      reason: "WATERMARK_UNSETTLED",
    },
    {
      service: assembler(fixtureCheckpoint(), ready),
      requestedWatermark: 19n,
      baseline: null,
      reason: "WATERMARK_REGRESSED",
    },
    {
      service: assembler(fixtureCheckpoint(), fixtureSnapshot({ betaBackfill: false })),
      requestedWatermark: 20n,
      baseline: null,
      reason: "INITIAL_BACKFILL_INCOMPLETE",
    },
    {
      service: assembler(fixtureCheckpoint(), fixtureSnapshot({ configuration: null })),
      requestedWatermark: 20n,
      baseline: null,
      reason: "PUBLIC_CONFIGURATION_UNAPPROVED",
    },
    {
      service: assembler(fixtureCheckpoint({ delayedBeta: true }), ready),
      requestedWatermark: 20n,
      baseline: null,
      reason: "INITIAL_PROVIDER_DELAYED",
    },
    {
      service: assembler(fixtureCheckpoint(), {
        ...ready,
        repackIdentities: ready.repackIdentities.slice(0, 1),
      }),
      requestedWatermark: 20n,
      baseline: null,
      reason: "PUBLIC_IDENTITY_MAPPING_MISSING",
    },
  ] as const;
  for (const fixture of cases) {
    const plan = await fixture.service.assemble({
      requestedWatermark: fixture.requestedWatermark,
      baseline: fixture.baseline,
      trigger: "settled_change",
    });
    assert.equal(plan.classification, "blocked");
    if (plan.classification === "blocked") assert.equal(plan.reason, fixture.reason);
  }
});
