import { sha256CanonicalJson } from "./data-release-v2-canonical.ts";
import { MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES } from
  "./provider-catalog-release-v1.ts";

export const PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION =
  "provider-promotion-bootstrap-v1" as const;
export const PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE =
  "application/x-ndjson" as const;
export const PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES =
  1 * 1_024 * 1_024;
// The worker retains, validates, and hashes the decoded arrays. The constrained
// 256 MiB V8 old-space consumer proof covers the maximum accepted graph,
// including the 100k collectible catalog and correlation sections, within
// this aggregate wire bound.
export const PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES =
  128 * 1_024 * 1_024;
export const PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME = 250;
export const PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES = 65_536;
// Reserve the remainder of the 128 MiB stream for the maximum fixed-width
// correlation sections, header, and completion frame. Catalog values are
// variable-width, so their serialized page frames need this independent cap.
export const PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES =
  100 * 1_024 * 1_024;
export const PROVIDER_PROMOTION_BOOTSTRAP_FINGERPRINT_DOMAIN =
  "packscout.provider-promotion-bootstrap.v1" as const;

export const PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS = Object.freeze([
  "catalogCategories",
  "catalogCollectibles",
  "catalogAliases",
  "categoryCorrelations",
  "collectibleCorrelations",
] as const);

export type ProviderPromotionBootstrapSection =
  typeof PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS[number];

export const PROVIDER_PROMOTION_BOOTSTRAP_CATALOG_SECTIONS = Object.freeze([
  "catalogCategories",
  "catalogCollectibles",
  "catalogAliases",
] as const);

export type ProviderPromotionBootstrapCatalogSection =
  typeof PROVIDER_PROMOTION_BOOTSTRAP_CATALOG_SECTIONS[number];

export type ProviderPromotionBootstrapCatalogSectionRecords = Readonly<
  Record<ProviderPromotionBootstrapCatalogSection, readonly unknown[]>
>;

export interface ProviderPromotionBootstrapCounts {
  readonly catalogCategories: number;
  readonly catalogCollectibles: number;
  readonly catalogAliases: number;
  readonly categoryCorrelations: number;
  readonly collectibleCorrelations: number;
}

export const PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS = Object.freeze({
  catalogCategories: 50_000,
  catalogCollectibles: MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
  catalogAliases: 50_000,
  categoryCorrelations: 50_000,
  collectibleCorrelations: MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
} satisfies ProviderPromotionBootstrapCounts);

const bootstrapTextEncoder = new TextEncoder();

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : bootstrapTextEncoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

/**
 * Measures catalog page frames exactly as the bootstrap producer emits them.
 * Returns false for an unserializable value, an oversized record, or once the
 * shared variable-width catalog budget is exceeded.
 */
export function providerPromotionBootstrapCatalogSectionsWithinByteBudget(
  input: ProviderPromotionBootstrapCatalogSectionRecords,
): boolean {
  let aggregateBytes = 0;
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_CATALOG_SECTIONS) {
    const source = input[section];
    let offset = 0;
    let recordCount = 0;
    const initialFrameBytes = serializedByteLength({
      kind: "page",
      section,
      offset,
      records: [],
    });
    if (initialFrameBytes === null) return false;
    let frameBytes = initialFrameBytes;

    const flush = (): boolean => {
      if (recordCount === 0) return true;
      if (frameBytes > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES) {
        return false;
      }
      aggregateBytes += frameBytes + 1;
      if (
        aggregateBytes >
          PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES
      ) return false;
      offset += recordCount;
      recordCount = 0;
      const nextFrameBytes = serializedByteLength({
        kind: "page",
        section,
        offset,
        records: [],
      });
      if (nextFrameBytes === null) return false;
      frameBytes = nextFrameBytes;
      return true;
    };

    for (const value of source) {
      const valueBytes = serializedByteLength(value);
      if (valueBytes === null) return false;
      let additionalBytes = valueBytes + (recordCount === 0 ? 0 : 1);
      if (
        recordCount > 0 &&
        (recordCount ===
            PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME ||
          frameBytes + additionalBytes >
            PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES)
      ) {
        if (!flush()) return false;
        additionalBytes = valueBytes;
      }
      if (
        frameBytes + additionalBytes >
        PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES
      ) return false;
      frameBytes += additionalBytes;
      recordCount += 1;
      if (
        recordCount ===
          PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME &&
        !flush()
      ) return false;
    }
    if (!flush()) return false;
  }
  return true;
}

export function providerPromotionBootstrapSnapshotFingerprint(input: {
  readonly pin: unknown;
  readonly counts: ProviderPromotionBootstrapCounts;
}): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_PROMOTION_BOOTSTRAP_FINGERPRINT_DOMAIN,
    {
      version: PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
      pin: input.pin,
      counts: input.counts,
    },
  );
}
