import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  buildPublicCollectibleSearchText,
  initializeProviderCatalogReleaseEntityHashV1,
  normalizePublicSearchText,
  recomputeProviderCatalogReleaseEntityHashV1,
  verifyProviderCatalogReleasePlanV1,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackDetail,
} from "@packscout/contracts";
import {
  buildProviderCatalogReleasePublishPlan,
  ProviderCatalogReleaseArtifactError,
} from "./provider-catalog-release-artifacts.ts";
import {
  projectProviderCatalogRelease,
  type ProviderCatalogPublicProjection,
} from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";

function publicId(index: number): string {
  return `${(0x90000000 + index).toString(16)}-0000-5000-8000-${index
    .toString(16).padStart(12, "0")}`;
}

function fixture() {
  const configuration = providerFixtureApprovedConfiguration();
  const snapshot = providerFixtureSnapshot({ configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: "alpha",
    revisions: snapshot.revisions,
    repackIdentities: snapshot.repackIdentities,
  });
  return { snapshot, projection };
}

async function build(projection: ProviderCatalogPublicProjection) {
  const { snapshot } = fixture();
  return buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

test("provider artifacts split record-count batches and reconcile their chain", async () => {
  const { projection } = fixture();
  const categories: PublicCategory[] = Array.from(
    { length: MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS + 1 },
    (_, index) => {
      const publicCategoryId = publicId(index + 1_000);
      return {
        publicCategoryId,
        parentPublicCategoryId: null,
        categoryKey: `root-${String(index).padStart(3, "0")}`,
        name: `Root ${String(index).padStart(3, "0")}`,
        kind: "vertical",
        depth: 0,
        pathPublicCategoryIds: [publicCategoryId],
        displayOrder: index,
      };
    },
  );
  const plan = await build({
    ...projection,
    categories: [...projection.categories, ...categories],
  });

  const categoryBatches = plan.batches.filter(
    (batch) => batch.kind === "categories",
  );
  assert.equal(categoryBatches.length, 2);
  assert.equal(categoryBatches[0]!.records.length, 100);
  assert.equal(categoryBatches[1]!.records.length, 3);
  assert.equal(
    plan.entityHashes.categories,
    await recomputeProviderCatalogReleaseEntityHashV1({
      kind: "categories",
      batches: categoryBatches.map((batch) => ({
        kind: batch.kind,
        batchHash: batch.batchHash,
        recordCount: batch.records.length,
        byteCount: batch.byteCount,
      })),
    }),
  );
  await verifyProviderCatalogReleasePlanV1(plan);
});

test("provider artifacts split below the byte limit before the record limit", async () => {
  const { projection } = fixture();
  const original = projection.collectibles[0]!;
  const collectibles: PublicCollectible[] = Array.from(
    { length: 60 },
    (_, index) => {
      const name = `Card ${String(index).padStart(3, "0")} ${"n".repeat(200)}`;
      const collectible = {
        ...original,
        publicCollectibleId: publicId(index + 2_000),
        name,
        normalizedName: normalizePublicSearchText(name),
        aliases: [],
        normalizedAliases: [],
        brand: "b".repeat(120),
        setOrSeries: "s".repeat(200),
        subject: "u".repeat(200),
        cardNumber: null,
        referenceNumber: null,
        grade: null,
        grader: null,
      } satisfies PublicCollectible;
      return {
        ...collectible,
        searchText: buildPublicCollectibleSearchText(collectible),
      };
    },
  );
  const plan = await build({
    ...projection,
    collectibles,
    repackChases: [],
    repacks: projection.repacks.map((repack): PublicRepackDetail => ({
      ...repack,
      collectibleTypes: [],
      topChase: null,
      contentMode: "focused",
      contentSummary: {
        ...repack.contentSummary,
        knownCollectibleCount: 0,
        chaseCount: 0,
        collectibleTypeCount: 0,
      },
    })),
  });

  const collectibleBatches = plan.batches.filter(
    (batch) => batch.kind === "collectibles",
  );
  assert.ok(collectibleBatches.length > 1);
  assert.ok(collectibleBatches[0]!.records.length <
    MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS);
  assert.ok(collectibleBatches.every(
    (batch) => batch.byteCount <= MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  ));
  assert.equal(
    plan.entityHashes.repack_chases,
    await initializeProviderCatalogReleaseEntityHashV1("repack_chases"),
  );
  await verifyProviderCatalogReleasePlanV1(plan);
});

test("provider artifacts split search rows at the shard row limit", async () => {
  const { projection } = fixture();
  const original = projection.repacks[0]!;
  const repacks: PublicRepackDetail[] = Array.from(
    { length: MAX_ROWS_PER_REPACK_SEARCH_SHARD + 1 },
    (_, index) => ({
      ...original,
      publicRepackId: publicId(index + 3_000),
      name: `Repack ${String(index).padStart(3, "0")}`,
      collectibleTypes: [],
      topChase: null,
      contentMode: "focused",
      contentSummary: {
        ...original.contentSummary,
        knownCollectibleCount: 0,
        chaseCount: 0,
        collectibleTypeCount: 0,
      },
    }),
  );
  const plan = await build({
    ...projection,
    repacks,
    repackChases: [],
  });
  const searchShards = plan.batches.flatMap((batch) =>
    batch.kind === "search_shards" ? batch.records : []);

  assert.equal(searchShards.length, 2);
  assert.deepEqual(searchShards.map(({ rowCount }) => rowCount), [32, 1]);
  await verifyProviderCatalogReleasePlanV1(plan);
});

test("one oversized provider record fails before publication", async () => {
  const { projection } = fixture();
  const oversized: ProviderCatalogPublicProjection = {
    ...projection,
    repacks: projection.repacks.map((repack) => ({
      ...repack,
      description: "x".repeat(
        MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES + 1,
      ),
    })),
  };

  await assert.rejects(
    () => build(oversized),
    (error: unknown) => error instanceof ProviderCatalogReleaseArtifactError &&
      error.reason === "PUBLICATION_BATCH_TOO_LARGE",
  );
});

test("approved stablecoin policy participates in provider governing identity", async () => {
  const { snapshot, projection } = fixture();
  const baseline = await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
  const governed = await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: {
      ...snapshot.configuration,
      verifiedUsdStablecoins: ["USDC"],
    },
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });

  assert.equal(governed.contentHash, baseline.contentHash);
  assert.notEqual(
    governed.governingHashes.providerConfigurationHash,
    baseline.governingHashes.providerConfigurationHash,
  );
  assert.notEqual(
    governed.publicProviderReleaseId,
    baseline.publicProviderReleaseId,
  );
});
