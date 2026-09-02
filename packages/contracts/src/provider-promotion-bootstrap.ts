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
