import type { RefinementCtx } from "zod";
import {
  GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  REPACK_SEARCH_VERSION,
  canonicalJson,
  derivePublicCatalogReleaseIdV1,
  globalCatalogProviderReferenceV1Schema,
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
  repackSearchRowFromDetail,
  validateDataReleaseV2EntityGraph,
  verifyGlobalCatalogManifestV1,
  verifyProviderCatalogReleasePlanV1,
  type GlobalCatalogManifestV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogSharedConfigurationEpochV1,
  type ProviderReleaseImmutableProofV1,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
  type RepackSearchRow,
} from "@packscout/contracts";

export type CatalogManifestCompositionErrorCode =
  | "MANIFEST_PLATFORM_SET_INVALID"
  | "MANIFEST_PROVIDER_RELEASE_INVALID"
  | "MANIFEST_CONFIGURATION_EPOCH_INVALID"
  | "MANIFEST_AGGREGATE_LIMIT_EXCEEDED"
  | "MANIFEST_CONTENT_INVALID"
  | "MANIFEST_SEARCH_INVALID"
  | "MANIFEST_REFERENCE_INVALID"
  | "MANIFEST_OWNERSHIP_INVALID";

export class CatalogManifestCompositionError extends Error {
  constructor(readonly code: CatalogManifestCompositionErrorCode) {
    super("Catalog manifest composition failed safely.");
    this.name = "CatalogManifestCompositionError";
  }
}

function fail(code: CatalogManifestCompositionErrorCode): never {
  throw new CatalogManifestCompositionError(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalKeys(values: readonly string[]): boolean {
  return values.length > 0 &&
    values.length <= MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES &&
    values.every((value, index) =>
      index === 0 || compareText(values[index - 1]!, value) < 0);
}

function recordsForKind<T>(
  plan: ProviderCatalogReleasePublishPlanV1,
  kind: ProviderCatalogReleaseBatchKindV1,
): readonly T[] {
  return plan.batches
    .filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records as unknown as readonly T[]);
}

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
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
    dataAsOf: plan.dataAsOf,
  };
}

function canonicalUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  duplicates: "byte_identical" | "forbidden",
): readonly T[] {
  const valuesByIdentity = new Map<string, T>();
  for (const value of values) {
    const key = identity(value);
    const existing = valuesByIdentity.get(key);
    if (
      existing !== undefined &&
      (duplicates === "forbidden" ||
        canonicalJson(existing) !== canonicalJson(value))
    ) fail("MANIFEST_OWNERSHIP_INVALID");
    valuesByIdentity.set(key, value);
  }
  return [...valuesByIdentity.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function graphIssues(input: Readonly<{
  publicAssetOrigins: readonly string[];
  vendors: readonly PublicVendor[];
  categories: readonly PublicCategory[];
  collectibles: readonly PublicCollectible[];
  repacks: readonly PublicRepackDetail[];
  repackChases: readonly PublicRepackChase[];
}>): readonly unknown[] {
  const issues: unknown[] = [];
  validateDataReleaseV2EntityGraph(input, {
    addIssue(issue) {
      issues.push(issue);
    },
  } as RefinementCtx);
  return issues;
}

function canonicalChases(
  values: readonly PublicRepackChase[],
): readonly PublicRepackChase[] {
  return [...values].sort((left, right) =>
    compareText(left.publicRepackId, right.publicRepackId) ||
    left.displayOrder - right.displayOrder ||
    compareText(left.publicCollectibleId, right.publicCollectibleId));
}

function validateSearchProjection(
  plan: ProviderCatalogReleasePublishPlanV1,
  repacks: readonly PublicRepackDetail[],
): void {
  const actual = [...recordsForKind<{
    shardNumber: number;
    rows: readonly RepackSearchRow[];
  }>(plan, "search_shards")]
    .sort((left, right) => left.shardNumber - right.shardNumber)
    .flatMap(({ rows }) => rows);
  const expected = [...repacks]
    .sort((left, right) => compareText(left.publicRepackId, right.publicRepackId))
    .map(repackSearchRowFromDetail);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("MANIFEST_SEARCH_INVALID");
  }
}

function validateProviderGraph(plan: ProviderCatalogReleasePublishPlanV1): void {
  const vendors = recordsForKind<PublicVendor>(plan, "vendors");
  const categories = [...recordsForKind<PublicCategory>(plan, "categories")]
    .sort((left, right) => compareText(
      left.publicCategoryId,
      right.publicCategoryId,
    ));
  const collectibles = recordsForKind<PublicCollectible>(plan, "collectibles");
  const repacks = recordsForKind<PublicRepackDetail>(plan, "repacks");
  const repackChases = recordsForKind<PublicRepackChase>(
    plan,
    "repack_chases",
  );
  if (
    vendors.length !== 1 ||
    graphIssues({
      publicAssetOrigins: plan.publicAssetOrigins,
      vendors,
      categories,
      collectibles,
      repacks,
      repackChases,
    }).length > 0
  ) fail("MANIFEST_REFERENCE_INVALID");
  validateSearchProjection(plan, repacks);
}

function sameEpoch(
  left: ProviderCatalogSharedConfigurationEpochV1,
  right: ProviderCatalogSharedConfigurationEpochV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Authoritative PostgreSQL-side composition boundary. The caller supplies the
 * exact enabled-platform snapshot and retained, fully reconstructed publish
 * artifacts selected by the serialized manifest lane. Nothing is sent until
 * this function has exhaustively checked the global entity graph and proofs.
 */
export async function composeGlobalCatalogManifest(input: Readonly<{
  enabledPlatformKeys: readonly string[];
  providerPlans: readonly ProviderCatalogReleasePublishPlanV1[];
  /** Values extracted together from the exact approved DB configuration. */
  approvedConfiguration: Readonly<{
    sharedConfigurationEpoch: ProviderCatalogSharedConfigurationEpochV1;
    confidencePolicyVersion: string;
  }>;
}>): Promise<GlobalCatalogManifestV1> {
  if (!canonicalKeys(input.enabledPlatformKeys) ||
      input.providerPlans.length !== input.enabledPlatformKeys.length) {
    fail("MANIFEST_PLATFORM_SET_INVALID");
  }

  const plans: ProviderCatalogReleasePublishPlanV1[] = [];
  for (const candidate of input.providerPlans) {
    let verified;
    try {
      verified = await verifyProviderCatalogReleasePlanV1(candidate);
    } catch {
      fail("MANIFEST_PROVIDER_RELEASE_INVALID");
    }
    if (verified.classification !== "publish") {
      fail("MANIFEST_PROVIDER_RELEASE_INVALID");
    }
    plans.push(verified);
  }
  plans.sort((left, right) => compareText(left.platformKey, right.platformKey));
  if (
    canonicalJson(plans.map(({ platformKey }) => platformKey)) !==
      canonicalJson(input.enabledPlatformKeys)
  ) fail("MANIFEST_PLATFORM_SET_INVALID");
  if (plans.some((plan) => !sameEpoch(
    plan.sharedConfigurationEpoch,
    input.approvedConfiguration.sharedConfigurationEpoch,
  ))) {
    fail("MANIFEST_CONFIGURATION_EPOCH_INVALID");
  }

  for (const plan of plans) validateProviderGraph(plan);

  const providerReferences = plans.map((plan) =>
    globalCatalogProviderReferenceV1Schema.parse(immutableProof(plan)));
  const vendors = canonicalUnique(
    plans.flatMap((plan) => recordsForKind<PublicVendor>(plan, "vendors")),
    ({ publicVendorId }) => publicVendorId,
    "forbidden",
  );
  const categories = canonicalUnique(
    plans.flatMap((plan) => recordsForKind<PublicCategory>(plan, "categories")),
    ({ publicCategoryId }) => publicCategoryId,
    "byte_identical",
  );
  const collectibles = canonicalUnique(
    plans.flatMap((plan) =>
      recordsForKind<PublicCollectible>(plan, "collectibles")),
    ({ publicCollectibleId }) => publicCollectibleId,
    "byte_identical",
  );
  const repacks = canonicalUnique(
    plans.flatMap((plan) => recordsForKind<PublicRepackDetail>(plan, "repacks")),
    ({ publicRepackId }) => publicRepackId,
    "forbidden",
  );
  const repackChases = canonicalChases(plans.flatMap((plan) =>
    recordsForKind<PublicRepackChase>(plan, "repack_chases")));

  if (graphIssues({
    publicAssetOrigins: providerReferences[0]!.publicAssetOrigins,
    vendors,
    categories,
    collectibles,
    repacks,
    repackChases,
  }).length > 0) fail("MANIFEST_REFERENCE_INVALID");

  const publicAssetOrigins = providerReferences[0]!.publicAssetOrigins;
  if (
    providerReferences.some((reference) =>
      canonicalJson(reference.publicAssetOrigins) !==
        canonicalJson(publicAssetOrigins)) ||
    providerReferences.some((reference) =>
      reference.governingHashes.confidencePolicyHash !==
        providerReferences[0]!.governingHashes.confidencePolicyHash)
  ) fail("MANIFEST_CONTENT_INVALID");

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
      canonicalProof: categories,
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_collectible_identity_bytes",
      canonicalProof: collectibles,
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_vendor_ownership",
      canonicalProof: plans.flatMap((plan) =>
        recordsForKind<PublicVendor>(plan, "vendors").map((vendor) => ({
          platformKey: plan.platformKey,
          publicVendorId: vendor.publicVendorId,
        }))),
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_repack_ownership",
      canonicalProof: plans.flatMap((plan) =>
        recordsForKind<PublicRepackDetail>(plan, "repacks").map((repack) => ({
          platformKey: plan.platformKey,
          publicRepackId: repack.publicRepackId,
        }))),
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "cross_reference_graph",
      canonicalProof: plans.map((plan) => ({
        platformKey: plan.platformKey,
        categories: recordsForKind<PublicCategory>(plan, "categories").map(
          ({ publicCategoryId, parentPublicCategoryId }) => ({
            publicCategoryId,
            parentPublicCategoryId,
          }),
        ),
        repacks: recordsForKind<PublicRepackDetail>(plan, "repacks").map(
          ({ publicRepackId, publicVendorId, categories: projections }) => ({
            publicRepackId,
            publicVendorId,
            publicCategoryIds: projections.map(
              ({ publicCategoryId }) => publicCategoryId,
            ),
          }),
        ),
        chases: recordsForKind<PublicRepackChase>(plan, "repack_chases").map(
          ({ publicRepackId, publicCollectibleId }) => ({
            publicRepackId,
            publicCollectibleId,
          }),
        ),
      })),
    }),
  ]);
  const contentHash = await recomputeGlobalCatalogManifestContentHashV1({
    entityHashes,
  });
  const identity = {
    schemaVersion: GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION,
    dataSource: "canonical" as const,
    sharedConfigurationEpoch:
      input.approvedConfiguration.sharedConfigurationEpoch,
    enabledPlatformKeys: [...input.enabledPlatformKeys],
    providerReferenceSetHash,
    providerReferences,
    governingHashes: {
      providerConfigurationsHash,
      sharedCategoriesHash,
      identityMappingsHash,
      originSetHash,
      confidencePolicyHash:
        providerReferences[0]!.governingHashes.confidencePolicyHash,
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
      vendors: vendors.length,
      categories: categories.length,
      collectibles: collectibles.length,
      repacks: repacks.length,
      repackChases: repackChases.length,
      searchShards: plans.reduce(
        (total, plan) => total + plan.counts.searchShards,
        0,
      ),
    },
    contentHash,
    publicAssetOrigins,
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    repackSearchIndexHash,
    confidencePolicyVersion:
      input.approvedConfiguration.confidencePolicyVersion,
  };
  let publicReleaseId: string;
  let manifestFingerprint: string;
  try {
    [publicReleaseId, manifestFingerprint] = await Promise.all([
      derivePublicCatalogReleaseIdV1(identity),
      recomputeGlobalCatalogManifestFingerprintV1(identity),
    ]);
    return await verifyGlobalCatalogManifestV1({
      ...identity,
      publicReleaseId,
      manifestFingerprint,
    });
  } catch (error) {
    if (error instanceof CatalogManifestCompositionError) throw error;
    fail("MANIFEST_CONTENT_INVALID");
  }
}
