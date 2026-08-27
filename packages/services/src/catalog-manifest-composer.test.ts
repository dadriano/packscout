import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  type ProviderCatalogReleasePublishPlanV1,
  type PublicCollectibleDisplay,
} from "@packscout/contracts";
import {
  CatalogManifestCompositionError,
  composeGlobalCatalogManifest,
} from "./catalog-manifest-composer.ts";
import { buildProviderCatalogReleasePublishPlan } from "./provider-catalog-release-artifacts.ts";
import {
  projectProviderCatalogRelease,
  type ProviderCatalogPublicProjection,
} from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";

async function providerPlan(
  platformKey: "alpha" | "beta",
  transform?: (
    projection: ProviderCatalogPublicProjection,
  ) => ProviderCatalogPublicProjection,
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const checkpoint = providerFixtureCheckpoint({ platformKey });
  const configuration = providerFixtureApprovedConfiguration({ platformKey });
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection: transform?.(projection) ?? projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

async function plans(): Promise<readonly ProviderCatalogReleasePublishPlanV1[]> {
  return await Promise.all([providerPlan("alpha"), providerPlan("beta")]);
}

function epoch(plan: ProviderCatalogReleasePublishPlanV1) {
  return plan.sharedConfigurationEpoch;
}

async function compose(
  providerPlans: readonly ProviderCatalogReleasePublishPlanV1[],
) {
  return await composeGlobalCatalogManifest({
    enabledPlatformKeys: ["alpha", "beta"],
    providerPlans,
    approvedConfiguration: {
      sharedConfigurationEpoch: epoch(providerPlans[0]!),
      confidencePolicyVersion: "confidence-v1",
    },
  });
}

function rejectsWith(code: CatalogManifestCompositionError["code"]) {
  return (error: unknown) =>
    error instanceof CatalogManifestCompositionError && error.code === code;
}

function swapProjectionCategoryIds(
  projection: ProviderCatalogPublicProjection,
): ProviderCatalogPublicProjection {
  const parentId = projection.categories.find(({ depth }) => depth === 0)
    ?.publicCategoryId;
  const childId = projection.categories.find(({ depth }) => depth === 1)
    ?.publicCategoryId;
  assert.ok(parentId);
  assert.ok(childId);
  const swap = (publicCategoryId: string) =>
    publicCategoryId === parentId
      ? childId
      : publicCategoryId === childId
        ? parentId
        : publicCategoryId;
  const canonicalIds = (values: readonly string[]) =>
    values.map(swap).sort();
  const collectibleDisplay = (
    collectible: PublicCollectibleDisplay,
  ): PublicCollectibleDisplay => ({
    ...collectible,
    publicCategoryIds: canonicalIds(collectible.publicCategoryIds),
  });
  return {
    ...projection,
    categories: projection.categories.map((category) => ({
      ...category,
      publicCategoryId: swap(category.publicCategoryId),
      parentPublicCategoryId: category.parentPublicCategoryId === null
        ? null
        : swap(category.parentPublicCategoryId),
      pathPublicCategoryIds: category.pathPublicCategoryIds.map(swap),
    })),
    collectibles: projection.collectibles.map((collectible) => ({
      ...collectible,
      publicCategoryIds: canonicalIds(collectible.publicCategoryIds),
    })),
    repacks: projection.repacks.map((repack) => ({
      ...repack,
      categories: repack.categories.map((category) => ({
        ...category,
        publicCategoryId: swap(category.publicCategoryId),
      })).sort((left, right) =>
        left.publicCategoryId < right.publicCategoryId ? -1 : 1),
      topChase: repack.topChase === null
        ? null
        : {
            ...repack.topChase,
            collectible: collectibleDisplay(repack.topChase.collectible),
          },
    })),
    repackChases: projection.repackChases.map((chase) => ({
      ...chase,
      collectible: collectibleDisplay(chase.collectible),
    })),
  };
}

test("composes two verified providers and byte-deduplicates shared records", async () => {
  const providerPlans = await plans();
  const manifest = await compose(providerPlans);

  assert.deepEqual(manifest.enabledPlatformKeys, ["alpha", "beta"]);
  assert.equal(manifest.providerReferences.length, 2);
  assert.equal(manifest.counts.vendors, 2);
  assert.equal(
    manifest.counts.categories,
    providerPlans[0]!.counts.categories,
  );
  assert.equal(
    manifest.counts.collectibles,
    providerPlans[0]!.counts.collectibles +
      providerPlans[1]!.counts.collectibles,
  );
  assert.equal(manifest.dataSource, "canonical");
});

test("validates dependency-ordered provider categories through a canonical graph view", async () => {
  const plan = await providerPlan("alpha", swapProjectionCategoryIds);
  const transportCategories = plan.batches.flatMap((batch) =>
    batch.kind === "categories" ? batch.records : []);
  const parent = transportCategories.find(({ depth }) => depth === 0);
  const child = transportCategories.find(({ depth }) => depth === 1);
  assert.ok(parent);
  assert.ok(child);
  assert.ok(child.publicCategoryId < parent.publicCategoryId);
  assert.ok(transportCategories.indexOf(parent) < transportCategories.indexOf(child));
  const transportBeforeComposition = canonicalJson(plan.batches);

  const manifest = await composeGlobalCatalogManifest({
    enabledPlatformKeys: ["alpha"],
    providerPlans: [plan],
    approvedConfiguration: {
      sharedConfigurationEpoch: epoch(plan),
      confidencePolicyVersion: "confidence-v1",
    },
  });

  assert.equal(manifest.counts.categories, transportCategories.length);
  assert.equal(canonicalJson(plan.batches), transportBeforeComposition);
});

test("rejects omitted enabled providers, included disabled providers, and mixed epochs", async () => {
  const providerPlans = await plans();
  await assert.rejects(
    () => composeGlobalCatalogManifest({
      enabledPlatformKeys: ["alpha", "beta"],
      providerPlans: [providerPlans[0]!],
      approvedConfiguration: {
        sharedConfigurationEpoch: epoch(providerPlans[0]!),
        confidencePolicyVersion: "confidence-v1",
      },
    }),
    rejectsWith("MANIFEST_PLATFORM_SET_INVALID"),
  );
  await assert.rejects(
    () => composeGlobalCatalogManifest({
      enabledPlatformKeys: ["alpha"],
      providerPlans,
      approvedConfiguration: {
        sharedConfigurationEpoch: epoch(providerPlans[0]!),
        confidencePolicyVersion: "confidence-v1",
      },
    }),
    rejectsWith("MANIFEST_PLATFORM_SET_INVALID"),
  );
  await assert.rejects(
    () => composeGlobalCatalogManifest({
      enabledPlatformKeys: ["alpha", "beta"],
      approvedConfiguration: {
        sharedConfigurationEpoch: {
          ...epoch(providerPlans[0]!),
          revision: epoch(providerPlans[0]!).revision + 1,
        },
        confidencePolicyVersion: "confidence-v1",
      },
      providerPlans,
    }),
    rejectsWith("MANIFEST_CONFIGURATION_EPOCH_INVALID"),
  );
});

test("rejects conflicting shared category bytes before transport", async () => {
  const alpha = await providerPlan("alpha");
  const beta = await providerPlan("beta", (projection) => ({
    ...projection,
    categories: projection.categories.map((category) =>
      category.depth === 0 ? { ...category, name: "Conflicting Cards" } : category),
    repacks: projection.repacks.map((repack) => ({
      ...repack,
      categories: repack.categories.map((category) =>
        category.publicCategoryId === projection.categories[0]!.publicCategoryId
          ? { ...category, label: "Conflicting Cards" }
          : category),
    })),
  }));

  await assert.rejects(
    () => compose([alpha, beta]),
    rejectsWith("MANIFEST_OWNERSHIP_INVALID"),
  );
});

test("rejects duplicate provider-owned repack identity before transport", async () => {
  const alpha = await providerPlan("alpha");
  const alphaRepackId = alpha.batches
    .flatMap((batch) => batch.kind === "repacks" ? batch.records : [])[0]!
    .publicRepackId;
  const beta = await providerPlan("beta", (projection) => {
    const priorId = projection.repacks[0]!.publicRepackId;
    return {
      ...projection,
      repacks: projection.repacks.map((repack) => ({
        ...repack,
        publicRepackId: alphaRepackId,
        topChase: repack.topChase === null
          ? null
          : { ...repack.topChase, publicRepackId: alphaRepackId },
      })),
      repackChases: projection.repackChases.map((chase) => ({
        ...chase,
        publicRepackId:
          chase.publicRepackId === priorId ? alphaRepackId : chase.publicRepackId,
      })),
    };
  });

  await assert.rejects(
    () => compose([alpha, beta]),
    rejectsWith("MANIFEST_OWNERSHIP_INVALID"),
  );
});

test("re-verifies the retained provider graph before composition", async () => {
  const providerPlans = await plans();
  const beta = structuredClone(providerPlans[1]!);
  const collectibles = beta.batches.find(
    (batch) => batch.kind === "collectibles",
  );
  assert.ok(collectibles?.kind === "collectibles");
  collectibles.records[0]!.publicCategoryIds = [
    "19999999-9999-5999-8999-999999999999",
  ];
  assert.notEqual(canonicalJson(providerPlans[1]), canonicalJson(beta));

  await assert.rejects(
    () => compose([providerPlans[0]!, beta]),
    rejectsWith("MANIFEST_PROVIDER_RELEASE_INVALID"),
  );
});

test("rejects a caller-corrupted provider aggregate proof", async () => {
  const providerPlans = await plans();
  const corrupted = {
    ...providerPlans[1]!,
    counts: {
      ...providerPlans[1]!.counts,
      repacks: providerPlans[1]!.counts.repacks + 1,
    },
  } as ProviderCatalogReleasePublishPlanV1;
  await assert.rejects(
    () => compose([providerPlans[0]!, corrupted]),
    rejectsWith("MANIFEST_PROVIDER_RELEASE_INVALID"),
  );
});

test("binds confidence policy version to the approved configuration snapshot", async () => {
  const providerPlans = await plans();
  const manifest = await composeGlobalCatalogManifest({
    enabledPlatformKeys: ["alpha", "beta"],
    providerPlans,
    approvedConfiguration: {
      sharedConfigurationEpoch: epoch(providerPlans[0]!),
      confidencePolicyVersion: "approved-confidence-v7",
    },
  });

  assert.equal(manifest.confidencePolicyVersion, "approved-confidence-v7");
  assert.equal(
    manifest.sharedConfigurationEpoch.configurationHash,
    epoch(providerPlans[0]!).configurationHash,
  );
});
