import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedPublicCatalogConfigurationV1Schema } from "./approved-public-catalog-configuration.ts";

const categoryId = "11111111-1111-5111-8111-111111111111";
const vendorId = "21111111-1111-5111-8111-111111111111";
const repackId = "31111111-1111-5111-8111-111111111111";

function configuration() {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "catalog-r1",
    revision: 1,
    approvedAt: "2026-08-15T00:00:00.000Z",
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: ["https://vendor.example"],
    verifiedUsdStablecoins: [],
    categories: [{
      publicCategoryId: categoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [categoryId],
      displayOrder: 0,
    }],
    platforms: [{
      platformKey: "vendor",
      vendor: {
        publicVendorId: vendorId,
        vendorKey: "vendor",
        displayName: "Vendor",
        logoUrl: null,
        websiteUrl: "https://vendor.example",
        listingHosts: ["vendor.example"],
        imageOrigins: ["https://vendor.example"],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [categoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: [{
      platformKey: "vendor",
      packExternalId: "pack-1",
      publicRepackId: repackId,
    }],
    collectibles: [],
  };
}

test("approved public configuration requires canonical governed identities", () => {
  const parsed = approvedPublicCatalogConfigurationV1Schema.parse(configuration());
  assert.equal(parsed.repacks[0]?.publicRepackId, repackId);
  const missingMappings = configuration() as Record<string, unknown>;
  delete missingMappings.repacks;
  assert.equal(approvedPublicCatalogConfigurationV1Schema.safeParse(missingMappings).success, false);
  const conflicting = configuration();
  conflicting.repacks.push({ ...conflicting.repacks[0]!, packExternalId: "pack-2" });
  assert.equal(approvedPublicCatalogConfigurationV1Schema.safeParse(conflicting).success, false);
});

test("approved public configuration requires a canonical stablecoin policy", () => {
  const configured = {
    ...configuration(),
    verifiedUsdStablecoins: ["USDC"],
  };
  assert.deepEqual(
    approvedPublicCatalogConfigurationV1Schema.parse(configured)
      .verifiedUsdStablecoins,
    ["USDC"],
  );
  for (const verifiedUsdStablecoins of [
    ["USD"],
    ["usdc"],
    ["USDT", "USDC"],
    ["USDC", "USDC"],
  ]) {
    assert.equal(
      approvedPublicCatalogConfigurationV1Schema.safeParse({
        ...configuration(),
        verifiedUsdStablecoins,
      }).success,
      false,
    );
  }
  const missing = configuration() as Record<string, unknown>;
  delete missing.verifiedUsdStablecoins;
  assert.equal(
    approvedPublicCatalogConfigurationV1Schema.safeParse(missing).success,
    false,
  );
});

test("approved public configuration governs per-repack listing hosts", () => {
  const input = configuration();
  const configured = {
    ...input,
    repacks: [{
      ...input.repacks[0]!,
      listingUrl: "https://vendor.example/checkout/pack-1/",
    }],
  };
  assert.equal(
    approvedPublicCatalogConfigurationV1Schema.safeParse(configured).success,
    true,
  );
  assert.equal(
    approvedPublicCatalogConfigurationV1Schema.safeParse({
      ...configured,
      repacks: [{
        ...configured.repacks[0]!,
        listingUrl: "https://unapproved.example/checkout/pack-1/",
      }],
    }).success,
    false,
  );
});

test("approved public configuration rejects a ninth launch platform with a stable error", () => {
  const input = configuration();
  input.platforms = Array.from({ length: 9 }, (_, index) => ({
    ...structuredClone(input.platforms[0]!),
    platformKey: index === 0 ? "vendor" : `vendor-${index + 1}`,
    vendor: {
      ...structuredClone(input.platforms[0]!.vendor),
      publicVendorId: `21111111-1111-5111-8111-11111111111${index + 1}`,
      vendorKey: `vendor_${index + 1}`,
    },
  }));

  assert.equal(
    approvedPublicCatalogConfigurationV1Schema.safeParse({
      ...input,
      platforms: input.platforms.slice(0, 8),
    }).success,
    true,
  );

  const result = approvedPublicCatalogConfigurationV1Schema.safeParse(input);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(
    result.error.issues.some(
      ({ message }) => message === "public_config.platform_limit_exceeded",
    ),
    true,
  );
});
