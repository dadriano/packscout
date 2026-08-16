import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyntheticDataReleaseV2 } from "./__fixtures__/data-release-v2.fixture.ts";
import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  MAX_PROVIDER_CATALOG_RELEASE_HTTP_BODY_BYTES,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  containsProtectedProviderCatalogReleaseField,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  providerCatalogReleaseIdentityBodyV1,
  providerCatalogNonNegativeSequenceV1Schema,
  providerCatalogReleasePlanV1Schema,
  providerCatalogSequenceV1Schema,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseEntityHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleaseBatchRecordMapV1,
  type ProviderCatalogReleaseGoverningHashesV1,
  type ProviderCatalogReleasePlanV1,
  type ProviderCatalogReleasePublishPlanV1,
} from "./provider-catalog-release-v1.ts";
import {
  REPACK_SEARCH_VERSION,
  repackSearchRowFromDetail,
} from "./data-release-v2.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_E = "e".repeat(64);

function governingHashes(
  originSetHash: string,
): ProviderCatalogReleaseGoverningHashesV1 {
  return {
    providerConfigurationHash: HASH_A,
    sharedCategoriesHash: HASH_B,
    identityMappingsHash: HASH_C,
    originSetHash,
    confidencePolicyHash: HASH_E,
  };
}

async function buildPublishPlan(
  changes: Partial<Pick<ProviderCatalogReleasePublishPlanV1,
    "providerCheckpoint" | "sourceWatermark" | "dataAsOf" | "observation">> = {},
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const release = buildSyntheticDataReleaseV2();
  const rows = release.repacks.map(repackSearchRowFromDetail);
  const searchShard = {
    shardNumber: 0,
    rowCount: rows.length,
    byteCount: providerCatalogReleaseBatchByteCount(rows),
    contentHash: await recomputeProviderCatalogSearchShardHashV1(rows),
    rows,
  };
  const records: {
    [K in ProviderCatalogReleaseBatchKindV1]:
      readonly ProviderCatalogReleaseBatchRecordMapV1[K][];
  } = {
    vendors: release.vendors,
    categories: [...release.categories].sort(
      (left, right) =>
        left.depth - right.depth ||
        (left.publicCategoryId < right.publicCategoryId ? -1 : 1),
    ),
    collectibles: release.collectibles,
    repacks: release.repacks,
    repack_chases: release.repackChases,
    search_shards: [searchShard],
  };
  const batches: ProviderCatalogReleasePublishPlanV1["batches"][number][] = [];
  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    const kindRecords = records[kind];
    if (kindRecords.length === 0) continue;
    const batchIndex = batches.length;
    const batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
      kind,
      records: kindRecords,
    });
    const byteCount = providerCatalogReleaseBatchByteCount(kindRecords);
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex,
      kind,
      batchHash,
      recordCount: kindRecords.length,
      byteCount,
    });
    batches.push({
      batchIndex,
      kind,
      batchHash,
      byteCount,
      records: [...kindRecords],
    } as ProviderCatalogReleaseBatchV1);
  }
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await recomputeProviderCatalogReleaseEntityHashV1({
      kind,
      batches: batches
        .filter((batch) => batch.kind === kind)
        .map((batch) => ({
          kind: batch.kind,
          batchHash: batch.batchHash,
          recordCount: batch.records.length,
          byteCount: batch.byteCount,
        })),
    });
  }
  const counts = {
    vendors: 1 as const,
    categories: release.categories.length,
    collectibles: release.collectibles.length,
    repacks: release.repacks.length,
    repackChases: release.repackChases.length,
    searchShards: 1,
  };
  const providerSearchIndexHash = await recomputeProviderCatalogSearchIndexHashV1(
    [searchShard],
  );
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const publicAssetOrigins = ["https://assets.vendor.example"];
  const dataAsOf = changes.dataAsOf ?? "2026-08-14T23:59:00.000Z";
  const identity = {
    platformKey: "alpha",
    sharedConfigurationEpoch: {
      configurationKey: "catalog.v1",
      revision: 7,
      publicChangeSequence: "20",
      configurationHash: "1".repeat(64),
    },
    dataAsOf,
    contentHash,
    publicAssetOrigins,
    governingHashes: governingHashes(
      await recomputeProviderCatalogReleaseOriginSetHashV1(publicAssetOrigins),
    ),
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash,
    batchCount: batches.length,
    batchChainHash,
  } as const;
  const providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(identity);
  const publicProviderReleaseId = await derivePublicProviderReleaseIdV1(identity);
  const providerCheckpoint = changes.providerCheckpoint ?? {
    settledSequence: "20",
    settledAt: "2026-08-15T00:00:00.000Z",
  };
  const observation = changes.observation ?? {
    sourceHeadSequence: "20",
    lastSuccessfulObservationAt: "2026-08-15T00:00:00.000Z",
    staleAt: "2026-08-15T00:15:00.000Z",
    freshness: "fresh" as const,
  };
  return {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    platformKey: identity.platformKey,
    sharedConfigurationEpoch: identity.sharedConfigurationEpoch,
    providerCheckpoint,
    sourceWatermark: changes.sourceWatermark ??
      buildProviderCatalogSourceWatermarkV1(
        identity.platformKey,
        providerCheckpoint.settledSequence,
      ),
    publicProviderReleaseId,
    providerReleaseFingerprint,
    contentHash,
    publicAssetOrigins,
    governingHashes: identity.governingHashes,
    entityHashes,
    counts,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash,
    batchCount: batches.length,
    batchChainHash,
    batches,
    dataAsOf,
    observation,
  };
}

async function rehashPublishPlan(
  plan: ProviderCatalogReleasePublishPlanV1,
  options: { readonly rebuildSearchProjection?: boolean } = {},
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const repacks = plan.batches.flatMap((batch) =>
    batch.kind === "repacks" ? batch.records : []
  );
  const searchShards = plan.batches.flatMap((batch) =>
    batch.kind === "search_shards" ? batch.records : []
  );
  if (options.rebuildSearchProjection !== false) {
    assert.equal(searchShards.length, 1);
    searchShards[0]!.rows = repacks.map(repackSearchRowFromDetail);
  }
  for (const [shardNumber, searchShard] of searchShards.entries()) {
    searchShard.shardNumber = shardNumber;
    searchShard.rowCount = searchShard.rows.length;
    searchShard.byteCount = providerCatalogReleaseBatchByteCount(
      searchShard.rows,
    );
    searchShard.contentHash =
      await recomputeProviderCatalogSearchShardHashV1(searchShard.rows);
  }

  plan.providerSearchIndexHash =
    await recomputeProviderCatalogSearchIndexHashV1(searchShards);

  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  for (const [batchIndex, batch] of plan.batches.entries()) {
    batch.batchIndex = batchIndex;
    batch.byteCount = providerCatalogReleaseBatchByteCount(batch.records);
    batch.batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
      kind: batch.kind,
      records: batch.records,
    });
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex,
      kind: batch.kind,
      batchHash: batch.batchHash,
      recordCount: batch.records.length,
      byteCount: batch.byteCount,
    });
  }
  plan.batchCount = plan.batches.length;
  plan.batchChainHash = batchChainHash;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    plan.entityHashes[kind] =
      await recomputeProviderCatalogReleaseEntityHashV1({
        kind,
        batches: plan.batches
          .filter((batch) => batch.kind === kind)
          .map((batch) => ({
            kind: batch.kind,
            batchHash: batch.batchHash,
            recordCount: batch.records.length,
            byteCount: batch.byteCount,
          })),
      });
  }
  plan.contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes: plan.entityHashes,
  });
  plan.providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(plan);
  plan.publicProviderReleaseId = await derivePublicProviderReleaseIdV1(plan);
  return plan;
}

function rejectionMessages(input: unknown): readonly string[] {
  const result = providerCatalogReleasePlanV1Schema.safeParse(input);
  assert.equal(result.success, false);
  return result.success ? [] : result.error.issues.map(({ message }) => message);
}

test("provider release identity excludes source and observation facts", async () => {
  const original = await buildPublishPlan();
  const laterObservation = await buildPublishPlan({
    providerCheckpoint: {
      settledSequence: "21",
      settledAt: "2026-08-15T00:10:00.000Z",
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "21"),
    observation: {
      sourceHeadSequence: "21",
      lastSuccessfulObservationAt: "2026-08-15T00:10:00.000Z",
      staleAt: "2026-08-15T00:25:00.000Z",
      freshness: "delayed",
    },
  });
  const unrelatedProviderAndAttemptFacts = {
    ...laterObservation,
    attemptId: "attempt-999",
    pollStartedAt: "2099-01-01T00:00:00.000Z",
    unrelatedProviders: [{ platformKey: "beta", contentHash: HASH_A }],
  };

  assert.match(
    original.publicProviderReleaseId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(
    original.publicProviderReleaseId,
    laterObservation.publicProviderReleaseId,
  );
  assert.deepEqual(
    providerCatalogReleaseIdentityBodyV1(original),
    providerCatalogReleaseIdentityBodyV1(unrelatedProviderAndAttemptFacts),
  );
  assert.equal(
    await derivePublicProviderReleaseIdV1(unrelatedProviderAndAttemptFacts),
    original.publicProviderReleaseId,
  );
  assert.notEqual(
    await derivePublicProviderReleaseIdV1({
      ...original,
      dataAsOf: "2026-08-15T00:05:00.000Z",
    }),
    original.publicProviderReleaseId,
  );
  await verifyProviderCatalogReleasePlanV1(original);
  await verifyProviderCatalogReleasePlanV1(laterObservation);
});

test("provider release identity has a fixed canonical hash and UUIDv5 vector", async () => {
  const entityHashes = {
    vendors: "1".repeat(64),
    categories: "2".repeat(64),
    collectibles: "3".repeat(64),
    repacks: "4".repeat(64),
    repack_chases: "5".repeat(64),
    search_shards: "6".repeat(64),
  };
  const contentHash =
    "bddb241258516db2225c529c9f18f7b287696f59595ae59549cf5bea85a972f5";
  const originSetHash =
    "1118653e8f74ba9b8720087e1f642477508d02865bcdf2be6e773b96cf5d2c61";
  assert.equal(
    await recomputeProviderCatalogReleaseContentHashV1({ entityHashes }),
    contentHash,
  );
  assert.equal(
    await recomputeProviderCatalogReleaseOriginSetHashV1([
      "https://assets.vendor.example",
    ]),
    originSetHash,
  );
  const identity = {
    platformKey: "alpha",
    sharedConfigurationEpoch: {
      configurationKey: "catalog.v1",
      revision: 7,
      publicChangeSequence: "20",
      configurationHash: "0".repeat(64),
    },
    dataAsOf: "2026-08-14T23:59:00.000Z",
    contentHash,
    publicAssetOrigins: ["https://assets.vendor.example"],
    governingHashes: {
      providerConfigurationHash: "a".repeat(64),
      sharedCategoriesHash: "b".repeat(64),
      identityMappingsHash: "c".repeat(64),
      originSetHash,
      confidencePolicyHash: "e".repeat(64),
    },
    entityHashes,
    counts: {
      vendors: 1 as const,
      categories: 3,
      collectibles: 2,
      repacks: 2,
      repackChases: 3,
      searchShards: 1,
    },
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash: "7".repeat(64),
    batchCount: 6,
    batchChainHash: "8".repeat(64),
  };
  assert.equal(
    await recomputeProviderCatalogReleaseFingerprintV1(identity),
    "79ce750076c777e5c34a74c95475d2fbf28e5772804f0fbaca80c7b2bd99ca6f",
  );
  assert.equal(
    await derivePublicProviderReleaseIdV1(identity),
    "3e750cd6-6ac9-5c7d-b306-562f35aeef93",
  );
});

test("provider entity proofs have fixed incremental and empty-kind vectors", async () => {
  const first = {
    kind: "collectibles" as const,
    batchHash: HASH_A,
    recordCount: 2,
    byteCount: 345,
  };
  const second = {
    kind: "collectibles" as const,
    batchHash: HASH_B,
    recordCount: 3,
    byteCount: 678,
  };
  const empty = await initializeProviderCatalogReleaseEntityHashV1(
    "collectibles",
  );
  assert.equal(
    empty,
    "0f6ed7f25a5c363e78eebca267dab705afa6d367318dddefafe78e5eb90d7c3d",
  );
  assert.equal(
    await initializeProviderCatalogReleaseEntityHashV1("repacks"),
    "34abaeb5c33548ac509473428a4f0371798c9420025e88950ca9cbb9f511d9d3",
  );
  const afterFirst = await extendProviderCatalogReleaseEntityHashV1({
    previousHash: empty,
    ...first,
  });
  assert.equal(
    afterFirst,
    "d44af311abcfe50806c19cf18f4af6b2392b9841f249d72e9d9c62ef2bbf8609",
  );
  const expected =
    "366aeeaadaae0ca9a091c103bb1b4ac802b681cf890233904b3f75360164c65a";
  assert.equal(
    await extendProviderCatalogReleaseEntityHashV1({
      previousHash: afterFirst,
      ...second,
    }),
    expected,
  );
  assert.equal(
    await recomputeProviderCatalogReleaseEntityHashV1({
      kind: "collectibles",
      batches: [first, second],
    }),
    expected,
  );
  assert.notEqual(
    await recomputeProviderCatalogReleaseEntityHashV1({
      kind: "collectibles",
      batches: [second, first],
    }),
    expected,
  );
  await assert.rejects(
    recomputeProviderCatalogReleaseEntityHashV1({
      kind: "repacks",
      batches: [first],
    }),
    /cannot cross batch kinds/u,
  );
});

test("same-epoch complete content reuses without batches and another epoch cannot reuse", async () => {
  const published = await buildPublishPlan();
  const reuseProof = {
    state: "complete" as const,
    platformKey: published.platformKey,
    sharedConfigurationEpoch: published.sharedConfigurationEpoch,
    dataAsOf: published.dataAsOf,
    publicProviderReleaseId: published.publicProviderReleaseId,
    providerReleaseFingerprint: published.providerReleaseFingerprint,
    contentHash: published.contentHash,
    publicAssetOrigins: published.publicAssetOrigins,
    governingHashes: published.governingHashes,
    entityHashes: published.entityHashes,
    counts: published.counts,
    searchAlgorithmVersion: published.searchAlgorithmVersion,
    providerSearchIndexHash: published.providerSearchIndexHash,
    batchCount: published.batchCount,
    batchChainHash: published.batchChainHash,
  };
  const reused: ProviderCatalogReleasePlanV1 = {
    ...published,
    classification: "reuse",
    batches: [],
    reuseProof,
  };
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(reused).success, true);
  assert.equal(reused.batches.length, 0);
  assert.equal(reused.batchCount, published.batches.length);
  await verifyProviderCatalogReleasePlanV1(reused);

  assert.equal(providerCatalogReleasePlanV1Schema.safeParse({
    ...reused,
    reuseProof: { ...reuseProof, contentHash: HASH_A },
  }).success, false);
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse({
    ...reused,
    dataAsOf: "2026-08-15T00:05:00.000Z",
  }).success, false);

  const nextEpoch = {
    ...reused,
    sharedConfigurationEpoch: {
      ...reused.sharedConfigurationEpoch,
      revision: reused.sharedConfigurationEpoch.revision + 1,
      publicChangeSequence: "30",
      configurationHash: "2".repeat(64),
    },
  };
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(nextEpoch).success, false);
  assert.notEqual(
    await derivePublicProviderReleaseIdV1({
      ...published,
      sharedConfigurationEpoch: nextEpoch.sharedConfigurationEpoch,
    }),
    published.publicProviderReleaseId,
  );
});

test("publish plans use canonical bounded batches and existing public V2 entities", async () => {
  const plan = await buildPublishPlan();
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(plan).success, true);
  assert.deepEqual(plan.batches.map(({ kind }) => kind), [
    "vendors",
    "categories",
    "collectibles",
    "repacks",
    "repack_chases",
    "search_shards",
  ]);
  for (const batch of plan.batches) {
    assert.ok(batch.records.length <= MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS);
    assert.ok(batch.byteCount <= MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES);
    assert.equal(batch.byteCount, providerCatalogReleaseBatchByteCount(batch.records));
  }
  assert.equal(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS, 100);
  assert.equal(MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES, 48 * 1_024);
  assert.equal(MAX_PROVIDER_CATALOG_RELEASE_HTTP_BODY_BYTES, 128 * 1_024);
  assert.equal(MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT, 4_096);
  assert.equal(
    providerCatalogSequenceV1Schema.safeParse("9223372036854775807").success,
    true,
  );
  assert.equal(
    providerCatalogNonNegativeSequenceV1Schema.safeParse("0").success,
    true,
  );
  for (const invalidSequence of [
    "0",
    "01",
    "9223372036854775808",
    "18446744073709551615",
  ]) {
    assert.equal(
      providerCatalogSequenceV1Schema.safeParse(invalidSequence).success,
      false,
    );
  }

  const invalidEntity = structuredClone(plan);
  const vendorBatch = invalidEntity.batches.find(({ kind }) => kind === "vendors")!;
  (vendorBatch.records[0] as Record<string, unknown>).rawPayload = { secret: true };
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(invalidEntity).success, false);
  assert.equal(containsProtectedProviderCatalogReleaseField(invalidEntity), true);

  const wrongOrder = structuredClone(plan);
  [wrongOrder.batches[0], wrongOrder.batches[1]] = [
    wrongOrder.batches[1]!,
    wrongOrder.batches[0]!,
  ];
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(wrongOrder).success, false);
  await assert.rejects(verifyProviderCatalogReleasePlanV1(wrongOrder));

  const wrongBytes = structuredClone(plan);
  wrongBytes.batches[0]!.byteCount += 1;
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(wrongBytes).success, false);

  const unapprovedOrigin = structuredClone(plan);
  unapprovedOrigin.publicAssetOrigins = ["https://unapproved.example"];
  assert.equal(
    providerCatalogReleasePlanV1Schema.safeParse(unapprovedOrigin).success,
    false,
  );

  const missingProviderVendor = structuredClone(plan);
  missingProviderVendor.counts.vendors = 0 as 1;
  assert.equal(
    providerCatalogReleasePlanV1Schema.safeParse(missingProviderVendor).success,
    false,
  );
});

test("publish plans reject rehashed provider-local graph tampering", async () => {
  const cases: readonly {
    readonly expected: string;
    readonly mutate: (plan: ProviderCatalogReleasePublishPlanV1) => void;
  }[] = [
    {
      expected: "data_release.category_hierarchy_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "categories");
        assert.ok(batch?.kind === "categories");
        const child = batch.records.find(
          ({ parentPublicCategoryId }) => parentPublicCategoryId !== null,
        );
        assert.ok(child);
        const missingParent = "ffffffff-ffff-5fff-bfff-ffffffffffff";
        child.parentPublicCategoryId = missingParent;
        child.pathPublicCategoryIds = [missingParent, child.publicCategoryId];
      },
    },
    {
      expected: "data_release.repack_reference_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.publicVendorId =
          "ffffffff-ffff-5fff-bfff-ffffffffffff";
      },
    },
    {
      expected: "data_release.repack_promo_not_approved",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.actions.promo = {
          code: "OTHER",
          label: "Use OTHER",
        };
      },
    },
    {
      expected: "data_release.repack_reference_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.categories[0]!.label = "Tampered category";
      },
    },
    {
      expected: "data_release.chase_collectible_projection_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repack_chases");
        assert.ok(batch?.kind === "repack_chases");
        batch.records[0]!.collectible.name = "Tampered collectible";
      },
    },
    {
      expected: "data_release.top_chase_projection_mismatch",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.topChase = null;
      },
    },
    {
      expected: "data_release.chase_count_mismatch",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.contentSummary.chaseCount += 1;
      },
    },
    {
      expected: "data_release.vendor_ev_timing_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.evEstimates.vendorReported.observedAt =
          "2026-08-16T00:00:00.000Z";
      },
    },
    {
      expected: "data_release.packscout_timing_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        const estimate = batch.records[0]!.evEstimates.packScout;
        assert.equal(estimate.status, "available");
        if (estimate.status === "available") {
          estimate.calculatedAt = "2026-08-15T00:01:00.000Z";
        }
      },
    },
    {
      expected: "data_release.collectible_timing_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "collectibles");
        assert.ok(batch?.kind === "collectibles");
        batch.records[0]!.dataAsOf = "2026-08-16T00:00:00.000Z";
      },
    },
    {
      expected: "data_release.collectible_timing_invalid",
      mutate: (plan) => {
        const collectibleBatch = plan.batches.find(
          ({ kind }) => kind === "collectibles",
        );
        const chaseBatch = plan.batches.find(
          ({ kind }) => kind === "repack_chases",
        );
        const repackBatch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(collectibleBatch?.kind === "collectibles");
        assert.ok(chaseBatch?.kind === "repack_chases");
        assert.ok(repackBatch?.kind === "repacks");
        const collectible = collectibleBatch.records[0]!;
        assert.ok(collectible.valuation);
        collectible.valuation.observedAt = "2026-08-11T08:30:03.000Z";
        chaseBatch.records
          .filter(({ publicCollectibleId }) =>
            publicCollectibleId === collectible.publicCollectibleId
          )
          .forEach((chase) => {
            assert.ok(chase.collectible.valuation);
            chase.collectible.valuation.observedAt =
              "2026-08-11T08:30:03.000Z";
          });
        repackBatch.records.forEach((repack) => {
          if (
            repack.topChase?.publicCollectibleId ===
              collectible.publicCollectibleId &&
            repack.topChase.collectible.valuation !== null
          ) {
            repack.topChase.collectible.valuation.observedAt =
              "2026-08-11T08:30:03.000Z";
          }
        });
      },
    },
    {
      expected: "data_release.repack_timing_invalid",
      mutate: (plan) => {
        const batch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(batch?.kind === "repacks");
        batch.records[0]!.sourceUpdatedAt = "2026-08-16T00:00:00.000Z";
      },
    },
    {
      expected: "data_release.chase_timing_invalid",
      mutate: (plan) => {
        const chaseBatch = plan.batches.find(
          ({ kind }) => kind === "repack_chases",
        );
        const repackBatch = plan.batches.find(({ kind }) => kind === "repacks");
        assert.ok(chaseBatch?.kind === "repack_chases");
        assert.ok(repackBatch?.kind === "repacks");
        const chase = chaseBatch.records[0]!;
        chase.observedAt = "2026-08-16T00:00:00.000Z";
        const repack = repackBatch.records.find(
          ({ publicRepackId }) => publicRepackId === chase.publicRepackId,
        );
        assert.ok(repack?.topChase);
        repack.topChase.observedAt = chase.observedAt;
      },
    },
  ];

  for (const { expected, mutate } of cases) {
    const plan = await buildPublishPlan();
    mutate(plan);
    await rehashPublishPlan(plan);
    const messages = rejectionMessages(plan);
    assert.ok(messages.includes(expected), messages.join(", "));
  }
});

test("provider plans reject duplicate category identity across hierarchy depths", async () => {
  const plan = await buildPublishPlan();
  const categoryBatch = plan.batches.find(({ kind }) => kind === "categories");
  assert.ok(categoryBatch?.kind === "categories");
  const cards = categoryBatch.records.find(
    ({ categoryKey }) => categoryKey === "cards",
  );
  const watches = categoryBatch.records.find(
    ({ categoryKey }) => categoryKey === "watches",
  );
  assert.ok(cards);
  assert.ok(watches);

  categoryBatch.records.push({
    ...structuredClone(watches),
    parentPublicCategoryId: cards.publicCategoryId,
    categoryKey: "nested_watches",
    depth: 1,
    pathPublicCategoryIds: [cards.publicCategoryId, watches.publicCategoryId],
    displayOrder: 3,
  });
  categoryBatch.records.sort(
    (left, right) =>
      left.depth - right.depth ||
      (left.publicCategoryId < right.publicCategoryId ? -1 : 1),
  );
  plan.counts.categories += 1;
  await rehashPublishPlan(plan);

  assert.ok(
    rejectionMessages(plan).includes("data_release.category_id_not_unique"),
  );
});

test("provider category batches remain dependency ordered when child UUID sorts first", async () => {
  const parentId = "00000000-0000-5000-8000-000000000101";
  const childId = "00000000-0000-5000-8000-000000000102";
  const swapped = (value: unknown): unknown => {
    if (value === parentId) return childId;
    if (value === childId) return parentId;
    if (Array.isArray(value)) return value.map(swapped);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, swapped(nested)]),
    );
  };
  const plan = swapped(
    structuredClone(await buildPublishPlan()),
  ) as ProviderCatalogReleasePublishPlanV1;

  for (const batch of plan.batches) {
    if (batch.kind === "collectibles") {
      batch.records.forEach((collectible) =>
        collectible.publicCategoryIds.sort()
      );
    }
    if (batch.kind === "repacks") {
      batch.records.forEach((repack) => {
        repack.categories.sort((left, right) =>
          left.publicCategoryId < right.publicCategoryId ? -1 : 1
        );
        repack.topChase?.collectible.publicCategoryIds.sort();
      });
    }
    if (batch.kind === "repack_chases") {
      batch.records.forEach((chase) =>
        chase.collectible.publicCategoryIds.sort()
      );
    }
  }
  await rehashPublishPlan(plan);

  const categoryBatch = plan.batches.find(({ kind }) => kind === "categories");
  assert.ok(categoryBatch?.kind === "categories");
  const parent = categoryBatch.records.find(({ depth }) => depth === 0)!;
  const child = categoryBatch.records.find(({ depth }) => depth === 1)!;
  assert.ok(child.publicCategoryId < parent.publicCategoryId);
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(plan).success, true);
});

test("provider batches and search shards require canonical greedy partitions", async () => {
  const earlySplit = await buildPublishPlan();
  const originalContentHash = earlySplit.contentHash;
  const originalReleaseId = earlySplit.publicProviderReleaseId;
  const categoryBatchIndex = earlySplit.batches.findIndex(
    ({ kind }) => kind === "categories",
  );
  const categoryBatch = earlySplit.batches[categoryBatchIndex]!;
  assert.equal(categoryBatch.kind, "categories");
  if (categoryBatch.kind === "categories") {
    const [first, ...remaining] = categoryBatch.records;
    assert.ok(first);
    assert.ok(remaining.length > 0);
    earlySplit.batches.splice(
      categoryBatchIndex,
      1,
      { ...categoryBatch, records: [first] },
      { ...categoryBatch, records: remaining },
    );
  }
  await rehashPublishPlan(earlySplit);
  assert.notEqual(earlySplit.contentHash, originalContentHash);
  assert.notEqual(earlySplit.publicProviderReleaseId, originalReleaseId);
  assert.ok(
    rejectionMessages(earlySplit).includes(
      "provider_catalog_release.batch_partition_not_canonical",
    ),
  );

  const splitSearch = await buildPublishPlan();
  const searchBatch = splitSearch.batches.find(
    ({ kind }) => kind === "search_shards",
  );
  assert.ok(searchBatch?.kind === "search_shards");
  const originalShard = searchBatch.records[0]!;
  assert.equal(originalShard.rows.length, 2);
  searchBatch.records = [
    { ...originalShard, rows: [originalShard.rows[0]!] },
    { ...originalShard, shardNumber: 1, rows: [originalShard.rows[1]!] },
  ];
  splitSearch.counts.searchShards = 2;
  await rehashPublishPlan(splitSearch, { rebuildSearchProjection: false });
  assert.ok(
    rejectionMessages(splitSearch).includes(
      "provider_catalog_release.search_shard_partition_not_canonical",
    ),
  );
});

test("hash verification fails closed on tampered records, hashes, and source scope", async () => {
  const plan = await buildPublishPlan();
  const tamperedBatchHash = structuredClone(plan);
  tamperedBatchHash.batches[0]!.batchHash = HASH_A;
  await assert.rejects(
    verifyProviderCatalogReleasePlanV1(tamperedBatchHash),
    /PROVIDER_CATALOG_RELEASE_BATCH_HASH_MISMATCH/u,
  );

  const tamperedOriginHash = structuredClone(plan);
  tamperedOriginHash.governingHashes.originSetHash = HASH_A;
  await assert.rejects(
    verifyProviderCatalogReleasePlanV1(tamperedOriginHash),
    /PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_MISMATCH/u,
  );

  const tamperedEntityHash = structuredClone(plan);
  tamperedEntityHash.entityHashes.categories = HASH_A;
  await assert.rejects(
    verifyProviderCatalogReleasePlanV1(tamperedEntityHash),
    /PROVIDER_CATALOG_RELEASE_ENTITY_HASH_MISMATCH/u,
  );

  const wrongSource = {
    ...plan,
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("beta", "20"),
  };
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(wrongSource).success, false);

  const wrongIdentity = { ...plan, publicProviderReleaseId:
    "00000000-0000-5000-8000-000000000001" };
  await assert.rejects(
    verifyProviderCatalogReleasePlanV1(wrongIdentity),
    /PROVIDER_CATALOG_RELEASE_IDENTITY_MISMATCH/u,
  );
});

test("blocked plans expose only stable safe facts", () => {
  const blocked = {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "blocked",
    platformKey: "alpha",
    sharedConfigurationEpoch: {
      configurationKey: "catalog.v1",
      revision: 7,
      publicChangeSequence: "20",
      configurationHash: HASH_A,
    },
    providerCheckpoint: {
      settledSequence: "0",
      settledAt: null,
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "0"),
    publicProviderReleaseId: null,
    dataAsOf: null,
    observation: null,
    reason: "SETTLED_DERIVATION_INCOMPLETE",
  };
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse(blocked).success, true);
  assert.equal(containsProtectedProviderCatalogReleaseField(blocked), false);
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse({
    ...blocked,
    providerCheckpoint: {
      settledSequence: "0",
      settledAt: "2026-08-15T00:00:00.000Z",
    },
  }).success, false);
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse({
    ...blocked,
    providerCheckpoint: {
      settledSequence: "1",
      settledAt: null,
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "1"),
  }).success, false);
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse({
    ...blocked,
    quarantineDetail: { rawPayload: "credential" },
  }).success, false);
  assert.equal(containsProtectedProviderCatalogReleaseField({
    ...blocked,
    quarantineDetail: { rawPayload: "credential" },
  }), true);
  assert.equal(providerCatalogReleasePlanV1Schema.safeParse({
    ...blocked,
    platformKey: " alpha ",
  }).success, false);
});

test("protected provider keys reject separator and casing bypasses", async () => {
  const plan = await buildPublishPlan();
  assert.equal(containsProtectedProviderCatalogReleaseField(plan), false);
  assert.equal(containsProtectedProviderCatalogReleaseField({
    publicProviderReleaseId: plan.publicProviderReleaseId,
    providerConfigurationHash: plan.governingHashes.providerConfigurationHash,
    sourceWatermark: plan.sourceWatermark,
    publicAssetOrigins: plan.publicAssetOrigins,
  }), false);

  for (const key of [
    "raw_payload",
    "SoUrCe-ReSpOnSe",
    "provider.payload",
    "claim_token",
    "access-token",
    "password_hash",
    "raw_provider_payload",
    "createdByActorKey",
    "source_actor_id",
    "actor_identifier",
    "TENANT_ID",
    "Org-Id",
    "API_KEY",
    "CrEdEnTiAl",
    "ToKeN",
    "pass_word",
    "quarantine_detail",
  ]) {
    const sourceObject = { safe: { [key]: "redacted" } };
    assert.equal(
      containsProtectedProviderCatalogReleaseField(sourceObject),
      true,
      key,
    );
  }

  const snakeCasePlan = {
    ...plan,
    raw_payload: { value: "redacted" },
  };
  assert.equal(
    containsProtectedProviderCatalogReleaseField(snakeCasePlan),
    true,
  );
  assert.equal(
    providerCatalogReleasePlanV1Schema.safeParse(snakeCasePlan).success,
    false,
  );
});
