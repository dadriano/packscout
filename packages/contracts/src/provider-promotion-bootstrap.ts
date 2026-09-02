import { sha256CanonicalJson } from "./data-release-v2-canonical.ts";

export const PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION =
  "provider-promotion-bootstrap-v1" as const;
export const PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE =
  "application/x-ndjson" as const;
export const PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES =
  1 * 1_024 * 1_024;
// The governed 100k-collectible plus 100k-correlation fixture is 75.7 MiB.
// This leaves framing headroom while quartering the prior transfer budget.
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
  catalogCategories: 100_000,
  catalogCollectibles: 100_000,
  catalogAliases: 4_000_000,
  categoryCorrelations: 100_000,
  collectibleCorrelations: 1_000_000,
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
