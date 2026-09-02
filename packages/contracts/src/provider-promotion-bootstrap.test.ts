import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
  providerCatalogReleaseCountsV1Schema,
} from "./provider-catalog-release-v1.ts";
import { globalCatalogManifestCountsV1Schema } from
  "./global-catalog-manifest-v1.ts";
import { publicCatalogCollectibleSchema } from "./provider-release.ts";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  providerPromotionBootstrapCatalogSectionsWithinByteBudget,
} from "./provider-promotion-bootstrap.ts";

const MAXIMUM_COLLECTIBLE_CORRELATION_RECORD = {
  localCollectibleId: "57000000-0000-4000-8000-000000000001",
  localEntityVersion: "9999999999999999999",
  publicCollectibleId: "56000000-0000-4000-8000-000000000001",
} as const;

const MAXIMUM_CATEGORY_CORRELATION_RECORD = {
  localCategoryId: "57000000-0000-4000-8000-000000000001",
  localEntityVersion: "9999999999999999999",
  publicCategoryId: "56000000-0000-4000-8000-000000000001",
} as const;

const MAXIMUM_CATALOG_ALIAS_RECORD = {
  aliasPublicCollectibleId: "56000000-0000-5000-8000-000000000001",
  canonicalPublicCollectibleId: "56000000-0000-5000-8000-000000000002",
} as const;

function sectionBytes(input: Readonly<{
  section: "catalogAliases" | "categoryCorrelations" |
    "collectibleCorrelations";
  record: Readonly<Record<string, string>>;
  count: number;
}>): Readonly<{ bytes: number; frames: number; maximumFrameBytes: number }> {
  const recordBytes = Buffer.byteLength(JSON.stringify(input.record), "utf8");
  let bytes = 0;
  let frames = 0;
  let maximumFrameBytes = 0;
  for (
    let offset = 0;
    offset < input.count;
    offset += PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME
  ) {
    const recordCount = Math.min(
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME,
      input.count - offset,
    );
    const emptyPageBytes = Buffer.byteLength(`${JSON.stringify({
      kind: "page",
      section: input.section,
      offset,
      records: [],
    })}\n`, "utf8");
    const frameBytes =
      emptyPageBytes + recordCount * recordBytes + recordCount - 1;
    bytes += frameBytes;
    frames += 1;
    maximumFrameBytes = Math.max(maximumFrameBytes, frameBytes);
  }
  return { bytes, frames, maximumFrameBytes };
}

test("bootstrap catalog and fixed-width sections fit the stream budget", () => {
  assert.deepEqual(PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS, {
    catalogCategories: 50_000,
    catalogCollectibles: 100_000,
    catalogAliases: 50_000,
    categoryCorrelations: 50_000,
    collectibleCorrelations: 100_000,
  });
  const catalogAliases = sectionBytes({
    section: "catalogAliases",
    record: MAXIMUM_CATALOG_ALIAS_RECORD,
    count: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogAliases,
  });
  const correlationSections = [
    sectionBytes({
      section: "categoryCorrelations",
      record: MAXIMUM_CATEGORY_CORRELATION_RECORD,
      count: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.categoryCorrelations,
    }),
    sectionBytes({
      section: "collectibleCorrelations",
      record: MAXIMUM_COLLECTIBLE_CORRELATION_RECORD,
      count: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.collectibleCorrelations,
    }),
  ];
  assert.ok([catalogAliases, ...correlationSections].every(({ maximumFrameBytes }) =>
    maximumFrameBytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES));
  assert.equal(
    correlationSections.reduce((total, section) => total + section.bytes, 0),
    24_646_708,
  );
  const completionBytes = Buffer.byteLength(`${JSON.stringify({
    kind: "complete",
    snapshotFingerprint: "f".repeat(64),
  })}\n`, "utf8");
  assert.equal(completionBytes, 109);
  assert.ok(
    PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES +
      correlationSections.reduce((total, section) => total + section.bytes, 0) +
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES + completionBytes <
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  );
  assert.ok(
    [catalogAliases, ...correlationSections]
      .reduce((total, section) => total + section.frames, 2) <=
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  );
});

function collectible(nameAliases: readonly string[] = []) {
  return {
    publicCollectibleId: "56000000-0000-5000-8000-000000000001",
    identityState: "canonical" as const,
    collectibleType: "card" as const,
    displayName: "Card",
    normalizedName: "card",
    nameAliases,
    normalizedNameAliases: nameAliases.map((alias) => alias.toLowerCase()),
    publicCategoryIds: [],
    year: null,
    brand: null,
    setOrSeries: null,
    cardNumber: null,
    referenceNumber: null,
    subject: null,
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: null,
    valuationCurrency: null,
    valuationUsdAmount: null,
    valuationUnavailableReason: null,
    valuationType: null,
    valuationObservedAt: null,
    dataAsOf: "2026-09-01T12:00:00.000Z",
  };
}

test("bootstrap admits a compact catalog at the 100k collectible count", () => {
  const compact = collectible();
  assert.equal(publicCatalogCollectibleSchema.safeParse(compact).success, true);
  assert.equal(providerPromotionBootstrapCatalogSectionsWithinByteBudget({
    catalogCategories: [],
    catalogCollectibles: Array(
      PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCollectibles,
    ).fill(compact),
    catalogAliases: [],
  }), true);
});

test("bootstrap rejects a schema-valid wide-alias catalog above its byte budget", () => {
  const aliases = Array.from({ length: 32 }, (_, index) =>
    `Alias ${String(index).padStart(2, "0")} ${"x".repeat(231)}`);
  const wide = collectible(aliases);
  assert.equal(publicCatalogCollectibleSchema.safeParse(wide).success, true);
  const recordBytes = Buffer.byteLength(JSON.stringify(wide), "utf8");
  const recordCount = Math.ceil(
    PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES / recordBytes,
  ) + 1;
  assert.ok(
    recordCount < PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCollectibles,
  );
  assert.equal(providerPromotionBootstrapCatalogSectionsWithinByteBudget({
    catalogCategories: [],
    catalogCollectibles: Array(recordCount).fill(wide),
    catalogAliases: [],
  }), false);
});

test("bootstrap admits the full collectible count accepted by catalog contracts", () => {
  const providerCounts = {
    vendors: 1,
    categories: 0,
    collectibles: MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
    repacks: 0,
    repackChases: 0,
    searchShards: 0,
  } as const;
  const globalCounts = { ...providerCounts, vendors: 1 };

  assert.equal(
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCollectibles,
    MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
  );
  assert.equal(
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.collectibleCorrelations,
    MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
  );
  assert.equal(
    providerCatalogReleaseCountsV1Schema.safeParse(providerCounts).success,
    true,
  );
  assert.equal(
    globalCatalogManifestCountsV1Schema.safeParse(globalCounts).success,
    true,
  );

  const overflow = {
    ...providerCounts,
    collectibles: MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES + 1,
  };
  assert.equal(
    providerCatalogReleaseCountsV1Schema.safeParse(overflow).success,
    false,
  );
  assert.equal(
    globalCatalogManifestCountsV1Schema.safeParse(overflow).success,
    false,
  );
});
