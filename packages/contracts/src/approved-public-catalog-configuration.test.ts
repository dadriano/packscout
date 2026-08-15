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
