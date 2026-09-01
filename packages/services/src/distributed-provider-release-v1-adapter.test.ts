import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseBatch,
  type ProviderReleaseDescriptor,
} from "@packscout/contracts";
import { buildProviderCatalogReleasePublishPlan } from
  "./provider-catalog-release-artifacts.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import { projectProviderCatalogRelease } from
  "./provider-catalog-release-public-projection.ts";
import {
  DistributedProviderReleaseAdapterError,
  adaptDistributedProviderReleaseToCatalogV1,
} from "./distributed-provider-release-v1-adapter.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

async function activePlan(): Promise<ProviderCatalogReleasePublishPlanV1> {
  const configuration = providerFixtureApprovedConfiguration();
  const snapshot = providerFixtureSnapshot({ configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: snapshot.checkpoint.platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

function localBatch(
  batchOrdinal: number,
  batchKind: string,
  records: readonly unknown[],
): ProviderReleaseBatch {
  return {
    batchOrdinal,
    batchKind,
    batchIndex: 0,
    records,
    recordCount: records.length,
    byteCount: 1,
    bodyHash: HASH_A,
  } as unknown as ProviderReleaseBatch;
}

async function localSource(options: Readonly<{
  catalogVersionId?: string;
  catalogContentHash?: string;
  throughChangeSequence?: string;
  selectedThroughChangeSequence?: bigint;
  classification?: "publish" | "reuse";
  includeCollectibles?: boolean;
}> = {}) {
  const plan = await activePlan();
  const records = <Kind extends ProviderCatalogReleasePublishPlanV1["batches"][number]["kind"]>(
    kind: Kind,
  ): readonly unknown[] => plan.batches
    .filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records as readonly unknown[]);
  const batches = [
    localBatch(0, "provider", records("vendors")),
    localBatch(1, "category", records("categories")),
    ...(options.includeCollectibles === false
      ? []
      : [localBatch(2, "collectible", records("collectibles"))]),
    localBatch(3, "repack", records("repacks")),
    localBatch(4, "chase", records("repack_chases")),
    localBatch(5, "retired-repack", []),
    localBatch(6, "search-index", []),
  ];
  const throughChangeSequence = options.throughChangeSequence ?? "20";
  const descriptor: ProviderReleaseDescriptor = {
    providerReleaseId: "30000000-0000-5000-8000-000000000001",
    predecessorCompleteReleaseId: null,
    providerId: "30000000-0000-4000-8000-000000000001",
    providerKey: plan.platformKey,
    publicProviderId: records("vendors")[0] !== undefined
      ? (records("vendors")[0] as { publicVendorId: string }).publicVendorId
      : "30000000-0000-5000-8000-000000000002",
    throughChangeSequence,
    catalogVersionId: options.catalogVersionId
      ?? "40000000-0000-4000-8000-000000000001",
    catalogContentHash: options.catalogContentHash ?? HASH_A,
    centralSchemaVersion: "distributed-central-v1",
    correlationEventSequence: "7",
    correlationSnapshotHash: HASH_B,
    publicProfileVersionId: "50000000-0000-4000-8000-000000000001",
    publicProfileHash: HASH_C,
    providerSchemaVersion: "distributed-provider-v1",
    publicSchemaVersion: PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
    categoryCount: records("categories").length,
    collectibleReferenceCount: records("collectibles").length,
    repackCount: records("repacks").length,
    chaseCount: records("repack_chases").length,
    retiredRepackCount: 0,
    batchCount: batches.length,
    contentHash: HASH_D,
    indexHash: HASH_A,
    dataAsOf: plan.dataAsOf,
    lastSuccessfulObservationAt:
      plan.observation.lastSuccessfulObservationAt,
    staleAt: plan.observation.staleAt,
    freshness: plan.observation.freshness,
  };
  return {
    descriptor,
    batches,
    selectedThroughChangeSequence: options.selectedThroughChangeSequence
      ?? BigInt(throughChangeSequence),
    classification: options.classification ?? "publish" as const,
  };
}

test("distributed release adapter round-trips through the active V1 verifier", async () => {
  const adapted = await adaptDistributedProviderReleaseToCatalogV1(
    await localSource(),
  );

  assert.equal(adapted.classification, "publish");
  assert.equal(adapted.platformKey, "alpha");
  assert.equal(adapted.providerCheckpoint.settledSequence, "20");
  assert.equal(
    adapted.sharedConfigurationEpoch.configurationKey,
    "catalog-version:40000000-0000-4000-8000-000000000001",
  );
  assert.equal(adapted.sharedConfigurationEpoch.publicChangeSequence, "20");
  assert.equal(adapted.counts.collectibles > 0, true);
  assert.equal(
    (await verifyProviderCatalogReleasePlanV1(adapted)).classification,
    "publish",
  );
  assert.equal(JSON.stringify(adapted).includes("providerId"), false);
  assert.equal(JSON.stringify(adapted).includes("providerReleaseId"), false);
});

test("unchanged reuse preserves the original public identity and epoch", async () => {
  const published = await adaptDistributedProviderReleaseToCatalogV1(
    await localSource(),
  );
  const reused = await adaptDistributedProviderReleaseToCatalogV1(
    await localSource({
      classification: "reuse",
      selectedThroughChangeSequence: 21n,
    }),
  );

  assert.equal(reused.classification, "reuse");
  assert.equal(reused.publicProviderReleaseId, published.publicProviderReleaseId);
  assert.deepEqual(
    reused.sharedConfigurationEpoch,
    published.sharedConfigurationEpoch,
  );
  assert.equal(reused.providerCheckpoint.settledSequence, "21");
  assert.deepEqual(reused.batches, []);
  await verifyProviderCatalogReleasePlanV1(reused);
});

test("different catalog pins produce independently valid per-provider epochs", async () => {
  const first = await adaptDistributedProviderReleaseToCatalogV1(
    await localSource(),
  );
  const second = await adaptDistributedProviderReleaseToCatalogV1(
    await localSource({
      catalogVersionId: "40000000-0000-4000-8000-000000000002",
      catalogContentHash: HASH_D,
      throughChangeSequence: "30",
    }),
  );

  assert.notDeepEqual(
    first.sharedConfigurationEpoch,
    second.sharedConfigurationEpoch,
  );
  assert.notEqual(first.publicProviderReleaseId, second.publicProviderReleaseId);
  await Promise.all([
    verifyProviderCatalogReleasePlanV1(first),
    verifyProviderCatalogReleasePlanV1(second),
  ]);
});

test("adapter fails closed when full referenced collectible bytes are absent", async () => {
  const source = await localSource({ includeCollectibles: false });
  await assert.rejects(
    () => adaptDistributedProviderReleaseToCatalogV1(source),
    (error: unknown) =>
      error instanceof DistributedProviderReleaseAdapterError
      && error.code === "PROVIDER_RELEASE_ADAPTER_REFERENCE_INVALID",
  );
});
