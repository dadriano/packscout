import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  canonicalJson,
  providerCatalogReleaseBatchByteCount,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  safeParseProviderCatalogReleasePlanV1,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogCompletedReleaseProofV1,
  type ProviderCatalogReleasePublishPlanV1,
} from "@packscout/contracts";
import type { ProviderCatalogReleaseSourceRepository } from "@packscout/database";
import { ProviderCatalogReleaseAssembler } from "./provider-catalog-release-assembler.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import type { ProviderCatalogCheckpoint } from "./provider-catalog-settlement-service.ts";
import type {
  ProviderCatalogReleaseBaselinePort,
  ProviderCatalogReleaseCheckpointPort,
  ProviderCatalogReleaseCompleteBaseline,
  ProviderCatalogReleaseSourcePort,
  ProviderCatalogReleaseSourceSnapshot,
} from "./provider-catalog-release-types.ts";

const bindDatabaseSourcePort = (
  source: ProviderCatalogReleaseSourceRepository,
): ProviderCatalogReleaseSourcePort => source;
void bindDatabaseSourcePort;

function completeProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderCatalogCompletedReleaseProofV1 {
  return {
    state: "complete",
    platformKey: plan.platformKey,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    dataAsOf: plan.dataAsOf,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
  };
}

class FixtureCheckpoints implements ProviderCatalogReleaseCheckpointPort {
  constructor(readonly checkpoint: ProviderCatalogCheckpoint) {}

  async getCheckpoint(): Promise<ProviderCatalogCheckpoint> {
    return this.checkpoint;
  }
}

class FixtureSource implements ProviderCatalogReleaseSourcePort {
  readonly calls: Array<Readonly<{ checkpoint: ProviderCatalogCheckpoint }>> = [];

  constructor(readonly snapshot: ProviderCatalogReleaseSourceSnapshot) {}

  async loadProviderSnapshot(input: Readonly<{
    checkpoint: ProviderCatalogCheckpoint;
  }>): Promise<ProviderCatalogReleaseSourceSnapshot> {
    this.calls.push(input);
    return this.snapshot;
  }
}

class FixtureBaselines implements ProviderCatalogReleaseBaselinePort {
  readonly calls: Array<Parameters<ProviderCatalogReleaseBaselinePort["findComplete"]>[0]> = [];

  constructor(
    readonly proofs: readonly ProviderCatalogReleaseCompleteBaseline[] = [],
  ) {}

  async findComplete(
    input: Parameters<ProviderCatalogReleaseBaselinePort["findComplete"]>[0],
  ): Promise<ProviderCatalogReleaseCompleteBaseline | null> {
    this.calls.push(input);
    return this.proofs.find((proof) =>
      proof.platformKey === input.platformKey &&
      canonicalJson(proof.sharedConfigurationEpoch) ===
        canonicalJson(input.sharedConfigurationEpoch) &&
      proof.publicProviderReleaseId === input.publicProviderReleaseId &&
      proof.providerReleaseFingerprint === input.providerReleaseFingerprint) ?? null;
  }
}

function fixtureAssembler(input: Readonly<{
  checkpoint?: ProviderCatalogCheckpoint;
  snapshot?: ProviderCatalogReleaseSourceSnapshot;
  proofs?: readonly ProviderCatalogReleaseCompleteBaseline[];
}> = {}) {
  const checkpoint = input.checkpoint ?? providerFixtureCheckpoint();
  const source = new FixtureSource(
    input.snapshot ?? providerFixtureSnapshot({
      checkpoint: checkpoint.settledAt === null
        ? providerFixtureCheckpoint()
        : checkpoint,
    }),
  );
  const baselines = new FixtureBaselines(input.proofs);
  return {
    assembler: new ProviderCatalogReleaseAssembler(
      new FixtureCheckpoints(checkpoint),
      source,
      baselines,
    ),
    source,
    baselines,
  };
}

async function publishFixture(
  input: Parameters<typeof fixtureAssembler>[0] = {},
  trigger: "full_rebuild" | "settled_change" = "settled_change",
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const plan = await fixtureAssembler(input).assembler.assemble({ trigger });
  assert.equal(plan.classification, "publish");
  return plan as ProviderCatalogReleasePublishPlanV1;
}

test("provider assembly is byte-stable for repetition, shuffled rows, and triggers", async () => {
  const repeated = fixtureAssembler();
  const first = await repeated.assembler.assemble({ trigger: "settled_change" });
  const second = await repeated.assembler.assemble({ trigger: "settled_change" });
  const shuffled = await fixtureAssembler({
    snapshot: providerFixtureSnapshot({ reverseRows: true }),
  }).assembler.assemble({ trigger: "full_rebuild" });

  assert.deepEqual(second, first);
  assert.deepEqual(shuffled, first);
  assert.equal(repeated.source.calls.length, 2);
  assert.deepEqual(Object.keys(repeated.source.calls[0]!), ["checkpoint"]);
});

test("publish batches are bounded, reconciled, and remain valid public V2 entities", async () => {
  const plan = await publishFixture();

  await verifyProviderCatalogReleasePlanV1(plan);
  assert.equal(plan.batchCount, plan.batches.length);
  for (const batch of plan.batches) {
    assert.ok(batch.records.length <= MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS);
    assert.ok(batch.byteCount <= MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES);
    assert.equal(batch.byteCount, providerCatalogReleaseBatchByteCount(batch.records));
    if (batch.kind === "vendors") batch.records.forEach((value) => publicVendorSchema.parse(value));
    if (batch.kind === "categories") batch.records.forEach((value) => publicCategorySchema.parse(value));
    if (batch.kind === "collectibles") batch.records.forEach((value) => publicCollectibleSchema.parse(value));
    if (batch.kind === "repacks") batch.records.forEach((value) => publicRepackDetailSchema.parse(value));
    if (batch.kind === "repack_chases") batch.records.forEach((value) => publicRepackChaseSchema.parse(value));
  }
});

test("platform A emits no platform B provider-owned records", async () => {
  const published = await publishFixture();
  const providerOwnedRecords: unknown[] = [];
  for (const batch of published.batches) {
    if (batch.kind !== "categories") providerOwnedRecords.push(...batch.records);
  }
  assert.equal(JSON.stringify(providerOwnedRecords).includes("beta"), false);

  const contaminated = await fixtureAssembler({
    snapshot: providerFixtureSnapshot({ includeForeignRows: true }),
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(contaminated.classification, "blocked");
  if (contaminated.classification === "blocked") {
    assert.equal(contaminated.reason, "PROVIDER_SCOPE_MISMATCH");
  }
});

test("same epoch and exact immutable proof reuses the retained release", async () => {
  const published = await publishFixture();
  const proof = completeProof(published);
  const laterCheckpoint = providerFixtureCheckpoint({ settledSequence: 21n });
  const laterSnapshot = providerFixtureSnapshot({
    checkpoint: laterCheckpoint,
    lastSuccessfulObservationAt: new Date("2026-08-15T03:05:00.000Z"),
  });
  const fixture = fixtureAssembler({
    checkpoint: laterCheckpoint,
    snapshot: laterSnapshot,
    proofs: [proof],
  });

  const reused = await fixture.assembler.assemble({ trigger: "settled_change" });

  assert.equal(reused.classification, "reuse");
  if (reused.classification === "reuse") {
    assert.equal(reused.publicProviderReleaseId, published.publicProviderReleaseId);
    assert.equal(reused.providerReleaseFingerprint, published.providerReleaseFingerprint);
    assert.equal(reused.dataAsOf, published.dataAsOf);
    assert.equal(reused.batchCount, published.batchCount);
    assert.deepEqual(reused.batches, []);
    assert.equal(
      reused.observation.lastSuccessfulObservationAt,
      "2026-08-15T03:05:00.000Z",
    );
  }
  assert.equal(
    fixture.baselines.calls[0]!.publicProviderReleaseId,
    published.publicProviderReleaseId,
  );
});

test("a later epoch publishes even with identical records and an older identity approval", async () => {
  const prior = await publishFixture();
  const checkpoint = providerFixtureCheckpoint({
    configurationKey: "catalog-v2",
    revision: 2,
    configurationHash: "b".repeat(64),
    configurationSequence: 21n,
    settledSequence: 30n,
  });
  const configuration = providerFixtureApprovedConfiguration({
    configurationKey: "catalog-v2",
    revision: 2,
  });
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });

  const plan = await fixtureAssembler({
    checkpoint,
    snapshot,
    proofs: [completeProof(prior)],
  }).assembler.assemble({ trigger: "settled_change" });

  assert.equal(plan.classification, "publish");
  if (plan.classification === "publish") {
    assert.notEqual(plan.publicProviderReleaseId, prior.publicProviderReleaseId);
    assert.equal(plan.contentHash, prior.contentHash);
  }
});

test("ignored source revisions preserve same-epoch release reuse", async () => {
  const prior = await publishFixture();
  const snapshot = providerFixtureSnapshot({
    lastSuccessfulObservationAt: new Date("2026-08-15T03:00:00.000Z"),
  });
  const laterDataSnapshot: ProviderCatalogReleaseSourceSnapshot = {
    ...snapshot,
    revisions: [
      ...snapshot.revisions,
      {
        entityId: "alpha-platform-alpha",
        revisionId: "alpha-platform-alpha-revision",
        platformKey: "alpha",
        recordKind: "platform",
        externalId: "alpha",
        content: {},
        sourceUpdatedAt: new Date("2026-08-15T02:30:00.000Z"),
        sourceCollectedAt: new Date("2026-08-15T02:30:00.000Z"),
        acceptedAt: new Date("2026-08-15T02:30:00.000Z"),
        publicChangeSequence: 10n,
      },
    ],
  };

  const plan = await fixtureAssembler({
    snapshot: laterDataSnapshot,
    proofs: [completeProof(prior)],
  }).assembler.assemble({ trigger: "settled_change" });

  assert.equal(plan.classification, "reuse");
  if (plan.classification === "reuse") {
    assert.equal(plan.contentHash, prior.contentHash);
    assert.equal(plan.dataAsOf, prior.dataAsOf);
    assert.equal(plan.publicProviderReleaseId, prior.publicProviderReleaseId);
    assert.deepEqual(plan.batches, []);
  }
});

test("blocked checkpoint at the first cause returns a stable blocked plan", async () => {
  const checkpoint = providerFixtureCheckpoint({
    settledSequence: 0n,
    sourceHeadSequence: 1n,
    blockedState: {
      kind: "blocked",
      reason: "pending_derivation",
      causeSequence: 1n,
    },
  });
  const fixture = fixtureAssembler({ checkpoint });

  const plan = await fixture.assembler.assemble({ trigger: "settled_change" });

  assert.equal(plan.classification, "blocked");
  if (plan.classification === "blocked") {
    assert.equal(plan.reason, "SETTLED_DERIVATION_INCOMPLETE");
    assert.equal(plan.providerCheckpoint.settledSequence, "0");
    assert.equal(plan.providerCheckpoint.settledAt, null);
  }
  assert.equal(fixture.source.calls.length, 0);
});

test("unsettled ready checkpoint and incomplete backfill fail closed", async () => {
  const unsettledCheckpoint = providerFixtureCheckpoint({
    settledSequence: 20n,
    sourceHeadSequence: 21n,
  });
  const unsettled = await fixtureAssembler({
    checkpoint: unsettledCheckpoint,
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(unsettled.classification, "blocked");
  if (unsettled.classification === "blocked") {
    assert.equal(unsettled.reason, "PROVIDER_CHECKPOINT_UNSETTLED");
  }

  const inactive = await fixtureAssembler({
    snapshot: providerFixtureSnapshot({ lifecycleState: "pending_backfill" }),
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(inactive.classification, "blocked");
  if (inactive.classification === "blocked") {
    assert.equal(inactive.reason, "INITIAL_BACKFILL_INCOMPLETE");
  }
});

test("source head completion recorded after the final settlement remains publishable", async () => {
  const checkpoint = providerFixtureCheckpoint();
  assert.ok(checkpoint.settledAt);
  const plan = await fixtureAssembler({
    checkpoint,
    snapshot: providerFixtureSnapshot({
      checkpoint,
      completedBackfillAt: new Date(checkpoint.settledAt.getTime() + 10_000),
      lastSuccessfulObservationAt: new Date(
        checkpoint.settledAt.getTime() + 10_000,
      ),
    }),
  }).assembler.assemble({ trigger: "settled_change" });

  assert.equal(plan.classification, "publish");
});

test("association confirmation after observation time does not block publication", async () => {
  const checkpoint = providerFixtureCheckpoint();
  const snapshot = providerFixtureSnapshot({
    checkpoint,
    lastSuccessfulObservationAt: new Date("2026-08-15T02:30:00.000Z"),
  });
  const plan = await fixtureAssembler({
    checkpoint,
    snapshot: {
      ...snapshot,
      assetPackAssociations: snapshot.assetPackAssociations.map((association) => ({
        ...association,
        associatedAt: new Date("2026-08-15T02:45:00.000Z"),
      })),
    },
  }).assembler.assemble({ trigger: "settled_change" });

  assert.equal(plan.classification, "publish");
});

test("asset-pack associations cannot exceed the exact settled boundary", async () => {
  const checkpoint = providerFixtureCheckpoint();
  const base = providerFixtureSnapshot({ checkpoint });
  for (const association of [
    {
      ...base.assetPackAssociations[0]!,
      publicChangeSequence: checkpoint.settledSequence + 1n,
    },
    {
      ...base.assetPackAssociations[0]!,
      associatedAt: new Date(checkpoint.settledAt!.getTime() + 1),
    },
  ]) {
    const plan = await fixtureAssembler({
      checkpoint,
      snapshot: { ...base, assetPackAssociations: [association] },
    }).assembler.assemble({ trigger: "settled_change" });

    assert.equal(plan.classification, "blocked");
    if (plan.classification === "blocked") {
      assert.equal(plan.reason, "PROVIDER_SOURCE_INVALID");
    }
  }
});

test("missing identity, invalid references, origins, arithmetic, and protected data fail closed", async () => {
  const base = providerFixtureSnapshot();
  const missingIdentity = await fixtureAssembler({
    snapshot: { ...base, repackIdentities: [] },
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(missingIdentity.classification, "blocked");
  if (missingIdentity.classification === "blocked") {
    assert.equal(missingIdentity.reason, "PUBLIC_IDENTITY_MAPPING_MISSING");
  }

  const badReferenceSnapshot: ProviderCatalogReleaseSourceSnapshot = {
    ...base,
    assetPackAssociations: base.assetPackAssociations.map((association) => ({
      ...association,
      packExternalId: "missing-pack",
    })),
  };
  const badReference = await fixtureAssembler({
    snapshot: badReferenceSnapshot,
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(badReference.classification, "blocked");
  if (badReference.classification === "blocked") {
    assert.equal(badReference.reason, "PUBLIC_REFERENCE_INVALID");
  }

  const unapprovedOriginSnapshot: ProviderCatalogReleaseSourceSnapshot = {
    ...base,
    revisions: base.revisions.map((revision) =>
      revision.recordKind === "pack"
        ? {
            ...revision,
            content: {
              ...(revision.content as Record<string, unknown>),
              imageUrls: ["https://unapproved.example/pack.png"],
            },
          }
        : revision),
  };
  const unapprovedOrigin = await fixtureAssembler({
    snapshot: unapprovedOriginSnapshot,
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(unapprovedOrigin.classification, "blocked");
  if (unapprovedOrigin.classification === "blocked") {
    assert.equal(unapprovedOrigin.reason, "PUBLIC_ORIGIN_UNAPPROVED");
  }

  const actionConfiguration = providerFixtureApprovedConfiguration();
  const unapprovedActionConfiguration = {
    ...actionConfiguration,
    platforms: actionConfiguration.platforms.map((platform) => ({
      ...platform,
      vendor: {
        ...platform.vendor,
        publicPromo: { code: "", label: "Unapproved" },
      },
    })),
  } as unknown as ReturnType<typeof providerFixtureApprovedConfiguration>;
  const unapprovedAction = await fixtureAssembler({
    snapshot: providerFixtureSnapshot({
      configuration: unapprovedActionConfiguration,
    }),
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(unapprovedAction.classification, "blocked");
  if (unapprovedAction.classification === "blocked") {
    assert.equal(unapprovedAction.reason, "PUBLIC_ACTION_UNAPPROVED");
  }

  const arithmeticSnapshot: ProviderCatalogReleaseSourceSnapshot = {
    ...base,
    revisions: base.revisions.map((revision) => {
      if (revision.recordKind !== "ev_input") return revision;
      const content = revision.content as Record<string, unknown>;
      return {
        ...revision,
        content: {
          ...content,
          probabilityBuckets: [{
            ...((content.probabilityBuckets as readonly Record<string, unknown>[])[0]!),
            probability: -0.1,
          }],
        },
      };
    }),
  };
  const arithmetic = await fixtureAssembler({
    snapshot: arithmeticSnapshot,
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(arithmetic.classification, "blocked");
  if (arithmetic.classification === "blocked") {
    assert.equal(arithmetic.reason, "PUBLIC_ARITHMETIC_INVALID");
  }

  const unsafeMoneySnapshot: ProviderCatalogReleaseSourceSnapshot = {
    ...base,
    revisions: base.revisions.map((revision) =>
      revision.recordKind === "pack"
        ? {
            ...revision,
            content: {
              ...(revision.content as Record<string, unknown>),
              priceValueMinor: Number.MAX_SAFE_INTEGER + 1,
            },
          }
        : revision),
  };
  const unsafeMoney = await fixtureAssembler({
    snapshot: unsafeMoneySnapshot,
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(unsafeMoney.classification, "blocked");
  if (unsafeMoney.classification === "blocked") {
    assert.equal(unsafeMoney.reason, "CANONICAL_PROJECTION_INVALID");
  }

  const protectedSnapshot: ProviderCatalogReleaseSourceSnapshot = {
    ...base,
    revisions: base.revisions.map((revision) =>
      revision.recordKind === "pack"
        ? {
            ...revision,
            content: {
              ...(revision.content as Record<string, unknown>),
              createdByActorKey: "private-actor",
            },
          }
        : revision),
  };
  const protectedPlan = await fixtureAssembler({
    snapshot: protectedSnapshot,
  }).assembler.assemble({ trigger: "settled_change" });
  assert.equal(protectedPlan.classification, "blocked");
  if (protectedPlan.classification === "blocked") {
    assert.equal(protectedPlan.reason, "PROTECTED_PUBLICATION_FIELD");
  }
});

test("an emitted image outside the governed origin set cannot validate", async () => {
  const plan = await publishFixture();
  const tampered = structuredClone(plan);
  const collectibleBatch = tampered.batches.find(
    (batch) => batch.kind === "collectibles",
  );
  assert.equal(collectibleBatch?.kind, "collectibles");
  if (collectibleBatch?.kind === "collectibles") {
    collectibleBatch.records[0]!.primaryImage = {
      url: "https://unapproved.example/card.png",
      alt: "Unapproved",
    };
  }

  const parsed = safeParseProviderCatalogReleasePlanV1(tampered);
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some(
      ({ message }) => message ===
        "data_release.collectible_reference_invalid",
    ));
  }
});
