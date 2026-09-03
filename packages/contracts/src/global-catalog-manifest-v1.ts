import { z } from "zod";
import {
  canonicalJson,
  canonicalJsonByteCount,
  sha256CanonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  MAX_REPACK_SEARCH_SHARDS,
} from "./data-release-v2-search.ts";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_SEARCH_VERSION,
  canonicalArraySchema,
  isStrictlySortedUnique,
  publicHttpsOriginSchema,
  sha256Schema,
} from "./data-release-v2-values.ts";
import {
  MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
  providerCatalogPlatformKeyV1Schema,
  providerCatalogReleaseCountsV1Schema,
  providerCatalogReleaseEntityHashesV1Schema,
  providerCatalogReleaseGoverningHashesV1Schema,
  providerCatalogSharedConfigurationEpochV1Schema,
  publicProviderReleaseIdV1Schema,
  PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_DOMAIN,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  type ProviderCatalogReleaseCountsV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseGoverningHashesV1,
  type ProviderCatalogSharedConfigurationEpochV1,
} from "./provider-catalog-release-v1.ts";

export const GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION =
  "global_catalog_manifest_v1" as const;
// This is a transaction/manifest-size safety ceiling, not a configured roster.
// The active provider set is discovered dynamically and is also bounded by the
// stricter manifest byte and aggregate-document limits below.
export const MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES = 64;
export const MAX_GLOBAL_CATALOG_MANIFEST_BYTES = 64 * 1_024;
// Public composition loads each provider's complete category copy to validate
// shared identity bytes. Bound the sum of those copies, not only the deduped
// union, so a valid manifest stays below Convex's per-transaction read limit.
export const MAX_GLOBAL_CATALOG_CATEGORY_DOCUMENTS = 4_096;

export const GLOBAL_CATALOG_MANIFEST_ID_NAMESPACE =
  "641b49f8-972a-5b6f-8d07-b9ebadf28621" as const;
export const GLOBAL_CATALOG_PROVIDER_REFERENCE_SET_HASH_DOMAIN =
  "packscout.global-catalog-manifest.provider-reference-set.v1" as const;
export const GLOBAL_CATALOG_PROVIDER_CONFIGURATION_HASH_DOMAIN =
  "packscout.global-catalog-manifest.provider-configurations.v1" as const;
export const GLOBAL_CATALOG_SHARED_CATEGORIES_HASH_DOMAIN =
  "packscout.global-catalog-manifest.shared-categories.v1" as const;
export const GLOBAL_CATALOG_IDENTITY_MAPPINGS_HASH_DOMAIN =
  "packscout.global-catalog-manifest.identity-mappings.v1" as const;
export const GLOBAL_CATALOG_MANIFEST_ORIGIN_SET_HASH_DOMAIN =
  PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_DOMAIN;
export const GLOBAL_CATALOG_COMPOSITION_PROOF_HASH_DOMAIN =
  "packscout.global-catalog-manifest.composition-proof.v1" as const;
export const GLOBAL_CATALOG_MANIFEST_ENTITY_HASH_DOMAIN =
  "packscout.global-catalog-manifest.entity-set.v1" as const;
export const GLOBAL_CATALOG_MANIFEST_CONTENT_HASH_DOMAIN =
  "packscout.global-catalog-manifest.content.v1" as const;
export const GLOBAL_CATALOG_MANIFEST_SEARCH_INDEX_HASH_DOMAIN =
  "packscout.global-catalog-manifest.search-index.v1" as const;
export const GLOBAL_CATALOG_MANIFEST_FINGERPRINT_HASH_DOMAIN =
  "packscout.global-catalog-manifest.fingerprint.v1" as const;

const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

export const globalCatalogManifestCountsV1Schema = z.object({
  vendors: positiveSafeIntegerSchema.max(
    MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  ),
  categories: nonNegativeSafeIntegerSchema.max(
    MAX_GLOBAL_CATALOG_CATEGORY_DOCUMENTS,
  ),
  collectibles: nonNegativeSafeIntegerSchema.max(
    MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
  ),
  repacks: nonNegativeSafeIntegerSchema.max(
    MAX_PUBLIC_REPACKS_PER_RELEASE,
  ),
  repackChases: nonNegativeSafeIntegerSchema.max(250_000),
  searchShards: nonNegativeSafeIntegerSchema.max(MAX_REPACK_SEARCH_SHARDS),
}).strict();

export const globalCatalogManifestEntityHashesV1Schema =
  providerCatalogReleaseEntityHashesV1Schema;

export const globalCatalogManifestGoverningHashesV1Schema = z.object({
  providerConfigurationsHash: sha256Schema,
  sharedCategoriesHash: sha256Schema,
  identityMappingsHash: sha256Schema,
  originSetHash: sha256Schema,
  confidencePolicyHash: sha256Schema,
}).strict();

export const globalCatalogCompositionProofV1Schema = z.object({
  sharedCategoryIdentityBytesHash: sha256Schema,
  sharedCollectibleIdentityBytesHash: sha256Schema,
  uniqueVendorOwnershipHash: sha256Schema,
  uniqueRepackOwnershipHash: sha256Schema,
  crossReferenceGraphHash: sha256Schema,
}).strict();

export const globalCatalogProviderReferenceV1Schema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  sharedConfigurationEpoch: providerCatalogSharedConfigurationEpochV1Schema,
  providerReleaseFingerprint: sha256Schema,
  contentHash: sha256Schema,
  publicAssetOrigins: canonicalArraySchema(publicHttpsOriginSchema, 64),
  governingHashes: providerCatalogReleaseGoverningHashesV1Schema,
  entityHashes: providerCatalogReleaseEntityHashesV1Schema,
  counts: providerCatalogReleaseCountsV1Schema,
  searchAlgorithmVersion: z.literal(REPACK_SEARCH_VERSION),
  providerSearchIndexHash: sha256Schema,
  batchCount: positiveSafeIntegerSchema.max(4_096),
  batchChainHash: sha256Schema,
  dataAsOf: z.iso.datetime({ offset: true }),
}).strict();

export type GlobalCatalogProviderReferenceV1 = z.infer<
  typeof globalCatalogProviderReferenceV1Schema
>;

export interface GlobalCatalogProviderReferenceIdentityInputV1 {
  readonly platformKey: string;
  readonly publicProviderReleaseId: string;
  readonly sharedConfigurationEpoch: ProviderCatalogSharedConfigurationEpochV1;
  readonly providerReleaseFingerprint: string;
  readonly contentHash: string;
  readonly publicAssetOrigins: readonly string[];
  readonly governingHashes: ProviderCatalogReleaseGoverningHashesV1;
  readonly entityHashes: GlobalCatalogManifestEntityHashesV1;
  readonly counts: ProviderCatalogReleaseCountsV1;
  readonly searchAlgorithmVersion: typeof REPACK_SEARCH_VERSION;
  readonly providerSearchIndexHash: string;
  readonly batchCount: number;
  readonly batchChainHash: string;
  readonly dataAsOf: string;
}

/** Contains only immutable provider proof; selection evidence lives in active state. */
export function globalCatalogProviderReferenceIdentityBodyV1(
  reference: GlobalCatalogProviderReferenceIdentityInputV1,
): unknown {
  return {
    platformKey: reference.platformKey,
    publicProviderReleaseId: reference.publicProviderReleaseId,
    sharedConfigurationEpoch: reference.sharedConfigurationEpoch,
    providerReleaseFingerprint: reference.providerReleaseFingerprint,
    contentHash: reference.contentHash,
    publicAssetOrigins: reference.publicAssetOrigins,
    governingHashes: reference.governingHashes,
    entityHashes: reference.entityHashes,
    counts: reference.counts,
    searchAlgorithmVersion: reference.searchAlgorithmVersion,
    providerSearchIndexHash: reference.providerSearchIndexHash,
    batchCount: reference.batchCount,
    batchChainHash: reference.batchChainHash,
    dataAsOf: reference.dataAsOf,
  };
}

export function recomputeGlobalCatalogProviderReferenceSetHashV1(
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
): Promise<string> {
  return sha256CanonicalJson(
    GLOBAL_CATALOG_PROVIDER_REFERENCE_SET_HASH_DOMAIN,
    references.map(globalCatalogProviderReferenceIdentityBodyV1),
  );
}

export function recomputeGlobalCatalogProviderConfigurationsHashV1(
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
): Promise<string> {
  return sha256CanonicalJson(
    GLOBAL_CATALOG_PROVIDER_CONFIGURATION_HASH_DOMAIN,
    references.map((reference) => ({
      platformKey: reference.platformKey,
      providerConfigurationHash:
        reference.governingHashes.providerConfigurationHash,
    })),
  );
}

function recomputeGlobalCatalogComposedGoverningHashV1(
  domain: string,
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
  select: (hashes: ProviderCatalogReleaseGoverningHashesV1) => string,
): Promise<string> {
  return sha256CanonicalJson(
    domain,
    references.map((reference) => ({
      platformKey: reference.platformKey,
      publicProviderReleaseId: reference.publicProviderReleaseId,
      hash: select(reference.governingHashes),
    })),
  );
}

export function recomputeGlobalCatalogSharedCategoriesHashV1(
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
): Promise<string> {
  return recomputeGlobalCatalogComposedGoverningHashV1(
    GLOBAL_CATALOG_SHARED_CATEGORIES_HASH_DOMAIN,
    references,
    ({ sharedCategoriesHash }) => sharedCategoriesHash,
  );
}

export function recomputeGlobalCatalogIdentityMappingsHashV1(
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
): Promise<string> {
  return recomputeGlobalCatalogComposedGoverningHashV1(
    GLOBAL_CATALOG_IDENTITY_MAPPINGS_HASH_DOMAIN,
    references,
    ({ identityMappingsHash }) => identityMappingsHash,
  );
}

export function recomputeGlobalCatalogManifestOriginSetHashV1(
  publicAssetOrigins: readonly string[],
): Promise<string> {
  return recomputeProviderCatalogReleaseOriginSetHashV1(publicAssetOrigins);
}

export const GLOBAL_CATALOG_COMPOSITION_PROOF_KINDS = [
  "shared_category_identity_bytes",
  "shared_collectible_identity_bytes",
  "unique_vendor_ownership",
  "unique_repack_ownership",
  "cross_reference_graph",
] as const;

export type GlobalCatalogCompositionProofKindV1 =
  (typeof GLOBAL_CATALOG_COMPOSITION_PROOF_KINDS)[number];

export function recomputeGlobalCatalogCompositionProofHashV1(input: {
  readonly kind: GlobalCatalogCompositionProofKindV1;
  readonly canonicalProof: unknown;
}): Promise<string> {
  return sha256CanonicalJson(GLOBAL_CATALOG_COMPOSITION_PROOF_HASH_DOMAIN, {
    kind: input.kind,
    canonicalProof: input.canonicalProof,
  });
}

export function recomputeGlobalCatalogManifestContentHashV1(input: {
  readonly entityHashes: GlobalCatalogManifestEntityHashesV1;
}): Promise<string> {
  return sha256CanonicalJson(GLOBAL_CATALOG_MANIFEST_CONTENT_HASH_DOMAIN, {
    schemaVersion: GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION,
    entityHashes: input.entityHashes,
  });
}

export function recomputeGlobalCatalogManifestEntityHashV1(input: {
  readonly kind: ProviderCatalogReleaseBatchKindV1;
  readonly references:
    readonly GlobalCatalogProviderReferenceIdentityInputV1[];
}): Promise<string> {
  const countKey = input.kind === "repack_chases"
    ? "repackChases"
    : input.kind === "search_shards"
    ? "searchShards"
    : input.kind;
  return sha256CanonicalJson(GLOBAL_CATALOG_MANIFEST_ENTITY_HASH_DOMAIN, {
    kind: input.kind,
    providers: input.references.map((reference) => ({
      platformKey: reference.platformKey,
      publicProviderReleaseId: reference.publicProviderReleaseId,
      providerEntityHash: reference.entityHashes[input.kind],
      count: reference.counts[countKey],
    })),
  });
}

export async function recomputeGlobalCatalogManifestEntityHashesV1(
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
): Promise<GlobalCatalogManifestEntityHashesV1> {
  const [
    vendors,
    categories,
    collectibles,
    repacks,
    repackChases,
    searchShards,
  ] = await Promise.all([
    recomputeGlobalCatalogManifestEntityHashV1({
      kind: "vendors", references,
    }),
    recomputeGlobalCatalogManifestEntityHashV1({
      kind: "categories", references,
    }),
    recomputeGlobalCatalogManifestEntityHashV1({
      kind: "collectibles", references,
    }),
    recomputeGlobalCatalogManifestEntityHashV1({
      kind: "repacks", references,
    }),
    recomputeGlobalCatalogManifestEntityHashV1({
      kind: "repack_chases", references,
    }),
    recomputeGlobalCatalogManifestEntityHashV1({
      kind: "search_shards", references,
    }),
  ]);
  return {
    vendors,
    categories,
    collectibles,
    repacks,
    repack_chases: repackChases,
    search_shards: searchShards,
  };
}

export function recomputeGlobalCatalogManifestSearchIndexHashV1(
  references: readonly GlobalCatalogProviderReferenceIdentityInputV1[],
): Promise<string> {
  return sha256CanonicalJson(
    GLOBAL_CATALOG_MANIFEST_SEARCH_INDEX_HASH_DOMAIN,
    references.map((reference) => ({
      platformKey: reference.platformKey,
      publicProviderReleaseId: reference.publicProviderReleaseId,
      providerSearchIndexHash: reference.providerSearchIndexHash,
      searchShardCount: reference.counts.searchShards,
    })),
  );
}

const manifestShape = {
  schemaVersion: z.literal(GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION),
  dataSource: z.enum(["canonical", "mock"]),
  publicReleaseId: publicProviderReleaseIdV1Schema,
  manifestFingerprint: sha256Schema,
  sharedConfigurationEpoch: providerCatalogSharedConfigurationEpochV1Schema,
  enabledPlatformKeys: z.array(providerCatalogPlatformKeyV1Schema)
    .min(1)
    .max(MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES),
  providerReferenceSetHash: sha256Schema,
  providerReferences: z.array(globalCatalogProviderReferenceV1Schema)
    .min(1)
    .max(MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES),
  governingHashes: globalCatalogManifestGoverningHashesV1Schema,
  compositionProof: globalCatalogCompositionProofV1Schema,
  entityHashes: globalCatalogManifestEntityHashesV1Schema,
  counts: globalCatalogManifestCountsV1Schema,
  contentHash: sha256Schema,
  publicAssetOrigins: canonicalArraySchema(publicHttpsOriginSchema, 64),
  searchAlgorithmVersion: z.literal(REPACK_SEARCH_VERSION),
  repackSearchIndexHash: sha256Schema,
  confidencePolicyVersion: z.string().trim().min(1).max(128),
} as const;

export const globalCatalogManifestV1Schema = z.object(manifestShape).strict()
  .superRefine((manifest, context) => {
    const referenceKeys = manifest.providerReferences.map(
      ({ platformKey }) => platformKey,
    );
    if (
      !isStrictlySortedUnique(referenceKeys, String) ||
      !isStrictlySortedUnique(manifest.enabledPlatformKeys, String) ||
      canonicalJson(referenceKeys) !== canonicalJson(manifest.enabledPlatformKeys)
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerReferences"],
        message: "global_catalog_manifest.provider_set_not_canonical",
      });
    }

    const composedOrigins = [...new Set(
      manifest.providerReferences.flatMap((reference) =>
        reference.publicAssetOrigins
      ),
    )].sort();
    if (
      canonicalJson(composedOrigins) !== canonicalJson(manifest.publicAssetOrigins)
    ) {
      context.addIssue({
        code: "custom",
        path: ["publicAssetOrigins"],
        message: "global_catalog_manifest.origin_union_mismatch",
      });
    }
    for (const [index, reference] of manifest.providerReferences.entries()) {
      const sharedHashes = reference.governingHashes;
      if (
        sharedHashes.confidencePolicyHash !==
          manifest.governingHashes.confidencePolicyHash
      ) {
        context.addIssue({
          code: "custom",
          path: ["providerReferences", index, "governingHashes"],
          message: "global_catalog_manifest.governing_hash_mismatch",
        });
      }
    }

    const sum = <K extends keyof ProviderCatalogReleaseCountsV1>(key: K) =>
      manifest.providerReferences.reduce(
        (total, reference) => total + reference.counts[key],
        0,
      );
    const maximum = <K extends keyof ProviderCatalogReleaseCountsV1>(key: K) =>
      Math.max(...manifest.providerReferences.map(
        (reference) => reference.counts[key],
      ));

    if (
      manifest.counts.vendors !== manifest.providerReferences.length ||
      manifest.counts.repacks !== sum("repacks") ||
      manifest.counts.repackChases !== sum("repackChases") ||
      manifest.counts.searchShards !== sum("searchShards") ||
      sum("categories") > MAX_GLOBAL_CATALOG_CATEGORY_DOCUMENTS ||
      manifest.counts.categories < maximum("categories") ||
      manifest.counts.categories > sum("categories") ||
      manifest.counts.collectibles < maximum("collectibles") ||
      manifest.counts.collectibles > sum("collectibles")
    ) {
      context.addIssue({
        code: "custom",
        path: ["counts"],
        message: "global_catalog_manifest.aggregate_count_mismatch",
      });
    }

    if (globalCatalogManifestCanonicalByteCount(manifest) >
      MAX_GLOBAL_CATALOG_MANIFEST_BYTES) {
      context.addIssue({
        code: "custom",
        message: "global_catalog_manifest.byte_limit_exceeded",
      });
    }
  });

export type GlobalCatalogManifestCountsV1 = z.infer<
  typeof globalCatalogManifestCountsV1Schema
>;
export type GlobalCatalogManifestEntityHashesV1 = z.infer<
  typeof globalCatalogManifestEntityHashesV1Schema
>;
export type GlobalCatalogManifestGoverningHashesV1 = z.infer<
  typeof globalCatalogManifestGoverningHashesV1Schema
>;
export type GlobalCatalogCompositionProofV1 = z.infer<
  typeof globalCatalogCompositionProofV1Schema
>;
export type GlobalCatalogManifestV1 = z.infer<
  typeof globalCatalogManifestV1Schema
>;

export interface GlobalCatalogManifestIdentityInputV1 {
  readonly dataSource: "canonical" | "mock";
  readonly sharedConfigurationEpoch: ProviderCatalogSharedConfigurationEpochV1;
  readonly enabledPlatformKeys: readonly string[];
  readonly providerReferenceSetHash: string;
  readonly providerReferences:
    readonly GlobalCatalogProviderReferenceIdentityInputV1[];
  readonly governingHashes: GlobalCatalogManifestGoverningHashesV1;
  readonly compositionProof: GlobalCatalogCompositionProofV1;
  readonly entityHashes: GlobalCatalogManifestEntityHashesV1;
  readonly counts: GlobalCatalogManifestCountsV1;
  readonly contentHash: string;
  readonly publicAssetOrigins: readonly string[];
  readonly searchAlgorithmVersion: typeof REPACK_SEARCH_VERSION;
  readonly repackSearchIndexHash: string;
  readonly confidencePolicyVersion: string;
}

export function globalCatalogManifestIdentityBodyV1(
  manifest: GlobalCatalogManifestIdentityInputV1,
): unknown {
  return {
    schemaVersion: GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION,
    dataSource: manifest.dataSource,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    enabledPlatformKeys: manifest.enabledPlatformKeys,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerReferences: manifest.providerReferences.map(
      globalCatalogProviderReferenceIdentityBodyV1,
    ),
    governingHashes: manifest.governingHashes,
    compositionProof: manifest.compositionProof,
    entityHashes: manifest.entityHashes,
    counts: manifest.counts,
    contentHash: manifest.contentHash,
    publicAssetOrigins: manifest.publicAssetOrigins,
    searchAlgorithmVersion: manifest.searchAlgorithmVersion,
    repackSearchIndexHash: manifest.repackSearchIndexHash,
    confidencePolicyVersion: manifest.confidencePolicyVersion,
  };
}

function uuidBytes(value: string): Uint8Array {
  const pairs = value.replaceAll("-", "").match(/.{2}/gu);
  if (pairs === null || pairs.length !== 16) {
    throw new TypeError("Global catalog manifest UUID namespace is invalid.");
  }
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

async function uuidV5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hexadecimal = [...digest.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

export function derivePublicCatalogReleaseIdV1(
  manifest: GlobalCatalogManifestIdentityInputV1,
): Promise<string> {
  return uuidV5(
    GLOBAL_CATALOG_MANIFEST_ID_NAMESPACE,
    canonicalJson(globalCatalogManifestIdentityBodyV1(manifest)),
  );
}

export function recomputeGlobalCatalogManifestFingerprintV1(
  manifest: GlobalCatalogManifestIdentityInputV1,
): Promise<string> {
  return sha256CanonicalJson(
    GLOBAL_CATALOG_MANIFEST_FINGERPRINT_HASH_DOMAIN,
    globalCatalogManifestIdentityBodyV1(manifest),
  );
}

export function globalCatalogProviderReferencesCanonicalByteCount(
  references: readonly GlobalCatalogProviderReferenceV1[],
): number {
  return canonicalJsonByteCount(references);
}

export function globalCatalogManifestCanonicalByteCount(
  manifest: unknown,
): number {
  return canonicalJsonByteCount(manifest);
}

export async function verifyGlobalCatalogManifestV1(
  input: unknown,
): Promise<GlobalCatalogManifestV1> {
  const manifest = globalCatalogManifestV1Schema.parse(input);
  const checks = await Promise.all([
    recomputeGlobalCatalogProviderReferenceSetHashV1(
      manifest.providerReferences,
    ),
    recomputeGlobalCatalogProviderConfigurationsHashV1(
      manifest.providerReferences,
    ),
    recomputeGlobalCatalogSharedCategoriesHashV1(
      manifest.providerReferences,
    ),
    recomputeGlobalCatalogIdentityMappingsHashV1(
      manifest.providerReferences,
    ),
    recomputeGlobalCatalogManifestOriginSetHashV1(
      manifest.publicAssetOrigins,
    ),
    recomputeGlobalCatalogManifestEntityHashesV1(
      manifest.providerReferences,
    ),
    recomputeGlobalCatalogManifestContentHashV1(manifest),
    recomputeGlobalCatalogManifestSearchIndexHashV1(
      manifest.providerReferences,
    ),
    recomputeGlobalCatalogManifestFingerprintV1(manifest),
    derivePublicCatalogReleaseIdV1(manifest),
  ]);
  const [
    providerReferenceSetHash,
    providerConfigurationsHash,
    sharedCategoriesHash,
    identityMappingsHash,
    originSetHash,
    entityHashes,
    contentHash,
    repackSearchIndexHash,
    manifestFingerprint,
    publicReleaseId,
  ] = checks;
  if (
    manifest.providerReferenceSetHash !== providerReferenceSetHash ||
    manifest.governingHashes.providerConfigurationsHash !==
      providerConfigurationsHash ||
    manifest.governingHashes.sharedCategoriesHash !== sharedCategoriesHash ||
    manifest.governingHashes.identityMappingsHash !== identityMappingsHash ||
    manifest.governingHashes.originSetHash !== originSetHash ||
    canonicalJson(manifest.entityHashes) !== canonicalJson(entityHashes) ||
    manifest.contentHash !== contentHash ||
    manifest.repackSearchIndexHash !== repackSearchIndexHash ||
    manifest.manifestFingerprint !== manifestFingerprint ||
    manifest.publicReleaseId !== publicReleaseId
  ) {
    throw new TypeError("Global catalog manifest proof does not reconcile.");
  }
  return manifest;
}
