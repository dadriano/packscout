import {
  canonicalJson,
  canonicalJsonByteCount,
  sha256CanonicalJson,
} from "./data-release-v2-canonical.ts";
import { REPACK_SEARCH_VERSION } from "./data-release-v2-values.ts";

export const PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION =
  "provider_catalog_release_v1" as const;

export const PROVIDER_CATALOG_RELEASE_ID_NAMESPACE =
  "331b5213-1c5b-5f0a-a176-bdc2912dc1e9" as const;

export const PROVIDER_CATALOG_RELEASE_CONTENT_HASH_DOMAIN =
  "packscout.provider-catalog-release.content.v1" as const;
export const PROVIDER_CATALOG_RELEASE_ENTITY_HASH_DOMAIN =
  "packscout.provider-catalog-release.entity-set.v1" as const;
export const PROVIDER_CATALOG_RELEASE_GOVERNING_HASH_DOMAIN =
  "packscout.provider-catalog-release.governing-input.v1" as const;
export const PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_DOMAIN =
  "packscout.provider-catalog-release.origin-set.v1" as const;
export const PROVIDER_CATALOG_RELEASE_FINGERPRINT_HASH_DOMAIN =
  "packscout.provider-catalog-release.fingerprint.v1" as const;
export const PROVIDER_CATALOG_RELEASE_BATCH_HASH_DOMAIN =
  "packscout.provider-catalog-release.batch.v1" as const;
export const PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH_DOMAIN =
  "packscout.provider-catalog-release.batch-chain.v1" as const;
export const PROVIDER_CATALOG_RELEASE_SEARCH_SHARD_HASH_DOMAIN =
  "packscout.provider-catalog-release.search-shard.v1" as const;
export const PROVIDER_CATALOG_RELEASE_SEARCH_INDEX_HASH_DOMAIN =
  "packscout.provider-catalog-release.search-index.v1" as const;

export const EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH =
  "0".repeat(64);

export const PROVIDER_CATALOG_RELEASE_BATCH_KINDS = [
  "vendors",
  "categories",
  "collectibles",
  "repacks",
  "repack_chases",
  "search_shards",
] as const;

export type ProviderCatalogReleaseBatchKindV1 =
  (typeof PROVIDER_CATALOG_RELEASE_BATCH_KINDS)[number];

export const PROVIDER_CATALOG_RELEASE_GOVERNING_HASH_KINDS = [
  "provider_configuration",
  "shared_categories",
  "identity_mappings",
  "origin_set",
  "confidence_policy",
] as const;

export type ProviderCatalogReleaseGoverningHashKindV1 =
  (typeof PROVIDER_CATALOG_RELEASE_GOVERNING_HASH_KINDS)[number];

export interface ProviderCatalogSharedConfigurationEpochV1 {
  readonly configurationKey: string;
  readonly revision: number;
  readonly publicChangeSequence: string;
  readonly configurationHash: string;
}

export interface ProviderCatalogReleaseGoverningHashesV1 {
  readonly providerConfigurationHash: string;
  readonly sharedCategoriesHash: string;
  readonly identityMappingsHash: string;
  readonly originSetHash: string;
  readonly confidencePolicyHash: string;
}

export type ProviderCatalogReleaseEntityHashesV1 = Readonly<
  Record<ProviderCatalogReleaseBatchKindV1, string>
>;

export interface ProviderCatalogReleaseEntityBatchDescriptorV1 {
  readonly kind: ProviderCatalogReleaseBatchKindV1;
  readonly batchHash: string;
  readonly recordCount: number;
  readonly byteCount: number;
}

export interface ProviderCatalogReleaseCountsV1 {
  readonly vendors: 1;
  readonly categories: number;
  readonly collectibles: number;
  readonly repacks: number;
  readonly repackChases: number;
  readonly searchShards: number;
}

export interface ProviderCatalogReleaseIdentityInputV1 {
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: ProviderCatalogSharedConfigurationEpochV1;
  readonly dataAsOf: string;
  readonly contentHash: string;
  readonly publicAssetOrigins: readonly string[];
  readonly governingHashes: ProviderCatalogReleaseGoverningHashesV1;
  readonly entityHashes: ProviderCatalogReleaseEntityHashesV1;
  readonly counts: ProviderCatalogReleaseCountsV1;
  readonly searchAlgorithmVersion: typeof REPACK_SEARCH_VERSION;
  readonly providerSearchIndexHash: string;
  readonly batchCount: number;
  readonly batchChainHash: string;
}

export interface ProviderCatalogReleaseSearchShardDescriptorV1 {
  readonly shardNumber: number;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly contentHash: string;
}

export function buildProviderCatalogSourceWatermarkV1(
  platformKey: string,
  settledSequence: string,
): string {
  return `provider-catalog:${platformKey}:${settledSequence}`;
}

export function providerCatalogReleaseIdentityBodyV1(
  input: ProviderCatalogReleaseIdentityInputV1,
): unknown {
  return {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    platformKey: input.platformKey,
    sharedConfigurationEpoch: input.sharedConfigurationEpoch,
    dataAsOf: input.dataAsOf,
    contentHash: input.contentHash,
    publicAssetOrigins: input.publicAssetOrigins,
    governingHashes: input.governingHashes,
    entityHashes: input.entityHashes,
    counts: input.counts,
    searchAlgorithmVersion: input.searchAlgorithmVersion,
    providerSearchIndexHash: input.providerSearchIndexHash,
    batchCount: input.batchCount,
    batchChainHash: input.batchChainHash,
  };
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "");
  const pairs = compact.match(/.{2}/gu);
  if (pairs === null || pairs.length !== 16) {
    throw new TypeError("Provider release UUID namespace is invalid.");
  }
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

async function uuidV5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const source = new Uint8Array(namespaceBytes.length + nameBytes.length);
  source.set(namespaceBytes);
  source.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", source));
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

export function derivePublicProviderReleaseIdV1(
  input: ProviderCatalogReleaseIdentityInputV1,
): Promise<string> {
  return uuidV5(
    PROVIDER_CATALOG_RELEASE_ID_NAMESPACE,
    canonicalJson(providerCatalogReleaseIdentityBodyV1(input)),
  );
}

export function recomputeProviderCatalogReleaseFingerprintV1(
  input: ProviderCatalogReleaseIdentityInputV1,
): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_CATALOG_RELEASE_FINGERPRINT_HASH_DOMAIN,
    providerCatalogReleaseIdentityBodyV1(input),
  );
}

export function recomputeProviderCatalogReleaseContentHashV1(input: {
  readonly entityHashes: ProviderCatalogReleaseEntityHashesV1;
}): Promise<string> {
  return sha256CanonicalJson(PROVIDER_CATALOG_RELEASE_CONTENT_HASH_DOMAIN, {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    entityHashes: input.entityHashes,
  });
}

/** The final proof for a kind with no batches. */
export function initializeProviderCatalogReleaseEntityHashV1(
  kind: ProviderCatalogReleaseBatchKindV1,
): Promise<string> {
  return sha256CanonicalJson(PROVIDER_CATALOG_RELEASE_ENTITY_HASH_DOMAIN, {
    kind,
    stage: "empty",
  });
}

/** Advances one kind proof using only an already-accepted batch descriptor. */
export function extendProviderCatalogReleaseEntityHashV1(input: {
  readonly previousHash: string;
  readonly kind: ProviderCatalogReleaseBatchKindV1;
  readonly batchHash: string;
  readonly recordCount: number;
  readonly byteCount: number;
}): Promise<string> {
  return sha256CanonicalJson(PROVIDER_CATALOG_RELEASE_ENTITY_HASH_DOMAIN, {
    kind: input.kind,
    stage: "batch",
    previousHash: input.previousHash,
    batchHash: input.batchHash,
    recordCount: input.recordCount,
    byteCount: input.byteCount,
  });
}

/** Rebuilds one kind proof without loading or hashing the kind's records. */
export async function recomputeProviderCatalogReleaseEntityHashV1(input: {
  readonly kind: ProviderCatalogReleaseBatchKindV1;
  readonly batches: readonly ProviderCatalogReleaseEntityBatchDescriptorV1[];
}): Promise<string> {
  let result = await initializeProviderCatalogReleaseEntityHashV1(input.kind);
  for (const batch of input.batches) {
    if (batch.kind !== input.kind) {
      throw new TypeError(
        "Provider release entity proof cannot cross batch kinds.",
      );
    }
    result = await extendProviderCatalogReleaseEntityHashV1({
      previousHash: result,
      kind: input.kind,
      batchHash: batch.batchHash,
      recordCount: batch.recordCount,
      byteCount: batch.byteCount,
    });
  }
  return result;
}

export function recomputeProviderCatalogReleaseGoverningHashV1(input: {
  readonly kind: ProviderCatalogReleaseGoverningHashKindV1;
  readonly value: unknown;
}): Promise<string> {
  return sha256CanonicalJson(PROVIDER_CATALOG_RELEASE_GOVERNING_HASH_DOMAIN, {
    kind: input.kind,
    value: input.value,
  });
}

export function recomputeProviderCatalogReleaseOriginSetHashV1(
  origins: readonly string[],
): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_DOMAIN,
    origins,
  );
}

export function recomputeProviderCatalogReleaseBatchHashV1(input: {
  readonly kind: ProviderCatalogReleaseBatchKindV1;
  readonly records: readonly unknown[];
}): Promise<string> {
  return sha256CanonicalJson(PROVIDER_CATALOG_RELEASE_BATCH_HASH_DOMAIN, {
    kind: input.kind,
    records: input.records,
  });
}

export function extendProviderCatalogReleaseBatchChainV1(input: {
  readonly previousHash: string;
  readonly batchIndex: number;
  readonly kind: ProviderCatalogReleaseBatchKindV1;
  readonly batchHash: string;
  readonly recordCount: number;
  readonly byteCount: number;
}): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH_DOMAIN,
    input,
  );
}

export function recomputeProviderCatalogSearchShardHashV1(
  rows: readonly unknown[],
): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_CATALOG_RELEASE_SEARCH_SHARD_HASH_DOMAIN,
    rows,
  );
}

export function recomputeProviderCatalogSearchIndexHashV1(
  shards: readonly ProviderCatalogReleaseSearchShardDescriptorV1[],
): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_CATALOG_RELEASE_SEARCH_INDEX_HASH_DOMAIN,
    shards.map(({ shardNumber, rowCount, byteCount, contentHash }) => ({
      shardNumber,
      rowCount,
      byteCount,
      contentHash,
    })),
  );
}

export function providerCatalogReleaseBatchByteCount(
  records: readonly unknown[],
): number {
  return canonicalJsonByteCount(records);
}
