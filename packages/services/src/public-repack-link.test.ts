import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredPublicRepackLink } from "./public-repack-link.ts";

const platform = {
  platformKey: "clutchpacks",
  vendor: {
    publicVendorId: "21111111-1111-5111-8111-111111111111",
    vendorKey: "clutchpacks",
    displayName: "ClutchPacks",
    logoUrl: null,
    websiteUrl: "https://clutchpacks.io/",
    listingHosts: ["clutchpacks.io"],
    imageOrigins: [],
    referralParameters: [],
    publicPromo: null,
  },
  format: "repack" as const,
  defaultPublicCategoryIds: [],
  categoryMappings: [],
  collectibleTypeMappings: [],
};

const identity = {
  platformKey: "clutchpacks",
  packExternalId: "e5f7565e-664c-416f-87b4-26dba7efde2b",
  publicRepackId: "31111111-1111-5111-8111-111111111111",
  listingUrl:
    "https://clutchpacks.io/checkout/e5f7565e-664c-416f-87b4-26dba7efde2b/",
};

test("configured repack links are exposed only for available packs", () => {
  assert.deepEqual(
    configuredPublicRepackLink({ identity, platform, available: true }),
    {
      listingUrl: identity.listingUrl,
      listingHost: "clutchpacks.io",
      referralParameters: [],
    },
  );
  assert.equal(
    configuredPublicRepackLink({ identity, platform, available: false }),
    null,
  );
  assert.equal(
    configuredPublicRepackLink({
      identity: { ...identity, listingUrl: null },
      platform,
      available: true,
    }),
    null,
  );
});

test("configured repack links reject hosts outside vendor governance", () => {
  assert.throws(
    () => configuredPublicRepackLink({
      identity: {
        ...identity,
        listingUrl:
          "https://unapproved.example/checkout/e5f7565e-664c-416f-87b4-26dba7efde2b/",
      },
      platform,
      available: true,
    }),
    /public_config\.listing_host_not_approved/u,
  );
});
