import {
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  type ActiveCatalogManifestStateV1,
  type GlobalCatalogAggregateObservationV1,
  type GlobalCatalogProviderActiveObservationV1,
} from "../catalog-manifest-publication-v1.ts";
import {
  derivePublicCatalogReleaseIdV1,
  recomputeGlobalCatalogCompositionProofHashV1,
  recomputeGlobalCatalogIdentityMappingsHashV1,
  recomputeGlobalCatalogManifestContentHashV1,
  recomputeGlobalCatalogManifestEntityHashesV1,
  recomputeGlobalCatalogManifestFingerprintV1,
  recomputeGlobalCatalogManifestOriginSetHashV1,
  recomputeGlobalCatalogManifestSearchIndexHashV1,
  recomputeGlobalCatalogProviderConfigurationsHashV1,
  recomputeGlobalCatalogProviderReferenceSetHashV1,
  recomputeGlobalCatalogSharedCategoriesHashV1,
  verifyGlobalCatalogManifestV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderReferenceV1,
} from "../global-catalog-manifest-v1.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

export const GLOBAL_MANIFEST_FIXTURE_SERVER_TIME =
  "2026-08-15T00:05:00.000Z";

export function buildEmptyActiveCatalogManifestStateV1():
  ActiveCatalogManifestStateV1 {
  return {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
}

function epoch() {
  return {
    configurationKey: "public-catalog",
    revision: 10,
    publicChangeSequence: "10",
    configurationHash: HASH_A,
  } as const;
}

interface GlobalCatalogManifestFixtureOptions {
  readonly mixedProviderEpochs?: boolean;
  readonly distinctProviderOrigins?: boolean;
}

async function references(options: GlobalCatalogManifestFixtureOptions): Promise<readonly [
  GlobalCatalogProviderReferenceV1,
  GlobalCatalogProviderReferenceV1,
]> {
  const alphaOrigins = ["https://cdn.packscout.test"];
  const betaOrigins = options.distinctProviderOrigins
    ? ["https://other.packscout.test"]
    : alphaOrigins;
  const [alphaOriginSetHash, betaOriginSetHash] = await Promise.all([
    recomputeGlobalCatalogManifestOriginSetHashV1(alphaOrigins),
    recomputeGlobalCatalogManifestOriginSetHashV1(betaOrigins),
  ]);
  const common = {
    sharedConfigurationEpoch: epoch(),
    searchAlgorithmVersion: "repack_search_v2" as const,
    batchCount: 1,
    batchChainHash: HASH_F,
  };
  return [
    {
      ...common,
      platformKey: "alpha",
      publicProviderReleaseId:
        "11111111-1111-5111-8111-111111111111",
      providerReleaseFingerprint: HASH_A,
      contentHash: HASH_B,
      publicAssetOrigins: alphaOrigins,
      governingHashes: {
        providerConfigurationHash: HASH_A,
        sharedCategoriesHash: HASH_B,
        identityMappingsHash: HASH_C,
        originSetHash: alphaOriginSetHash,
        confidencePolicyHash: HASH_D,
      },
      entityHashes: {
        vendors: HASH_A,
        categories: HASH_B,
        collectibles: HASH_C,
        repacks: HASH_D,
        repack_chases: HASH_E,
        search_shards: HASH_F,
      },
      counts: {
        vendors: 1,
        categories: 2,
        collectibles: 2,
        repacks: 1,
        repackChases: 2,
        searchShards: 1,
      },
      providerSearchIndexHash: HASH_E,
      dataAsOf: "2026-08-15T00:00:00.000Z",
    },
    {
      ...common,
      platformKey: "beta",
      publicProviderReleaseId:
        "22222222-2222-5222-8222-222222222222",
      providerReleaseFingerprint: HASH_B,
      contentHash: HASH_C,
      sharedConfigurationEpoch: options.mixedProviderEpochs ? {
        configurationKey: "catalog-version:beta",
        revision: 1,
        publicChangeSequence: "11",
        configurationHash: HASH_B,
      } : epoch(),
      publicAssetOrigins: betaOrigins,
      governingHashes: {
        providerConfigurationHash: HASH_B,
        sharedCategoriesHash: HASH_C,
        identityMappingsHash: HASH_D,
        originSetHash: betaOriginSetHash,
        confidencePolicyHash: HASH_D,
      },
      entityHashes: {
        vendors: HASH_B,
        categories: HASH_C,
        collectibles: HASH_D,
        repacks: HASH_E,
        repack_chases: HASH_F,
        search_shards: HASH_A,
      },
      counts: {
        vendors: 1,
        categories: 2,
        collectibles: 2,
        repacks: 1,
        repackChases: 1,
        searchShards: 1,
      },
      providerSearchIndexHash: HASH_F,
      dataAsOf: "2026-08-15T00:01:00.000Z",
    },
  ];
}

export async function buildGlobalCatalogManifestFixtureV1(
  dataSource: "canonical" | "mock" = "canonical",
  options: GlobalCatalogManifestFixtureOptions = {},
): Promise<GlobalCatalogManifestV1> {
  const providerReferences = await references(options);
  const publicAssetOrigins = [...new Set(
    providerReferences.flatMap((reference) => reference.publicAssetOrigins),
  )].sort();
  const [
    providerReferenceSetHash,
    providerConfigurationsHash,
    sharedCategoriesHash,
    identityMappingsHash,
    originSetHash,
    entityHashes,
    repackSearchIndexHash,
    sharedCategoryIdentityBytesHash,
    sharedCollectibleIdentityBytesHash,
    uniqueVendorOwnershipHash,
    uniqueRepackOwnershipHash,
    crossReferenceGraphHash,
  ] = await Promise.all([
    recomputeGlobalCatalogProviderReferenceSetHashV1(providerReferences),
    recomputeGlobalCatalogProviderConfigurationsHashV1(providerReferences),
    recomputeGlobalCatalogSharedCategoriesHashV1(providerReferences),
    recomputeGlobalCatalogIdentityMappingsHashV1(providerReferences),
    recomputeGlobalCatalogManifestOriginSetHashV1(publicAssetOrigins),
    recomputeGlobalCatalogManifestEntityHashesV1(providerReferences),
    recomputeGlobalCatalogManifestSearchIndexHashV1(providerReferences),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_category_identity_bytes",
      canonicalProof: ["category-a", "category-shared"],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_collectible_identity_bytes",
      canonicalProof: ["collectible-a", "collectible-shared"],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_vendor_ownership",
      canonicalProof: ["alpha:vendor-a", "beta:vendor-b"],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_repack_ownership",
      canonicalProof: ["alpha:repack-a", "beta:repack-b"],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "cross_reference_graph",
      canonicalProof: ["repack-a:collectible-shared"],
    }),
  ]);
  const contentHash = await recomputeGlobalCatalogManifestContentHashV1({
    entityHashes,
  });
  const identity = {
    schemaVersion: "global_catalog_manifest_v1" as const,
    dataSource,
    sharedConfigurationEpoch: epoch(),
    enabledPlatformKeys: ["alpha", "beta"],
    providerReferenceSetHash,
    providerReferences,
    governingHashes: {
      providerConfigurationsHash,
      sharedCategoriesHash,
      identityMappingsHash,
      originSetHash,
      confidencePolicyHash: HASH_D,
    },
    compositionProof: {
      sharedCategoryIdentityBytesHash,
      sharedCollectibleIdentityBytesHash,
      uniqueVendorOwnershipHash,
      uniqueRepackOwnershipHash,
      crossReferenceGraphHash,
    },
    entityHashes,
    counts: {
      vendors: 2,
      categories: 3,
      collectibles: 3,
      repacks: 2,
      repackChases: 3,
      searchShards: 2,
    },
    contentHash,
    publicAssetOrigins,
    searchAlgorithmVersion: "repack_search_v2" as const,
    repackSearchIndexHash,
    confidencePolicyVersion: "confidence-v1",
  };
  const [publicReleaseId, manifestFingerprint] = await Promise.all([
    derivePublicCatalogReleaseIdV1(identity),
    recomputeGlobalCatalogManifestFingerprintV1(identity),
  ]);
  return verifyGlobalCatalogManifestV1({
    ...identity,
    publicReleaseId,
    manifestFingerprint,
  });
}

export function buildGlobalCatalogProviderSelectionsFixtureV1(
  manifest: GlobalCatalogManifestV1,
): readonly GlobalCatalogProviderActiveObservationV1[] {
  return manifest.providerReferences.map((reference, index) => ({
    platformKey: reference.platformKey,
    publicProviderReleaseId: reference.publicProviderReleaseId,
    terminalOperationKind: "finalize" as const,
    terminalOperationId: `provider:finalize:${reference.platformKey}:20`,
    terminalReceiptSha256: index === 0 ? HASH_A : HASH_B,
    selectedProviderCheckpoint: {
      settledSequence: String(20 + index),
      settledAt: `2026-08-15T00:0${2 + index}:00.000Z`,
    },
    selectedDataAsOf: reference.dataAsOf,
    latestAffectedSettledSequence: String(20 + index),
    latestAffectedSourceHeadSequence: String(20 + index),
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: "fresh" as const,
    lastSuccessfulObservationAt:
      `2026-08-15T00:0${2 + index}:00.000Z`,
    staleAt: `2026-08-15T00:1${2 + index}:00.000Z`,
  }));
}

export function buildGlobalCatalogObservationFixtureV1(
  manifest: GlobalCatalogManifestV1,
  observationSequence = 1,
  providerSelections = buildGlobalCatalogProviderSelectionsFixtureV1(manifest),
): GlobalCatalogAggregateObservationV1 {
  return buildGlobalCatalogAggregateObservationV1({
    observationSequence,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections,
  });
}

export function buildActiveCatalogManifestStateFixtureV1(
  manifest: GlobalCatalogManifestV1,
  observation = buildGlobalCatalogObservationFixtureV1(manifest),
): ActiveCatalogManifestStateV1 {
  return activeCatalogManifestStateV1Schema.parse({
    generation: 1,
    activeManifest: {
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
      createdAt: "2026-08-15T00:04:00.000Z",
      completedAt: GLOBAL_MANIFEST_FIXTURE_SERVER_TIME,
    },
    previousManifest: null,
    observation,
    terminalReceiptSha256: HASH_C,
  });
}
