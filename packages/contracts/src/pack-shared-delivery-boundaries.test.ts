import assert from "node:assert/strict";
import { test } from "node:test";
import { packCatalogSequenceSchema } from "./pack-catalog-v1.ts";
import { sharedProviderChangeDeliverySchema } from "./pack-publication.ts";

const id = "a1000000-0000-4000-8000-000000000001";
const delivery = { organizationId: id, providerId: id, centralChangeIdentity: "change:1",
  providerChangeSequence: "1", sharedDependencies: [], payloadSha256: "a".repeat(64),
  leaseIdentity: id, acknowledgmentIdentity: null };

test("UUID-resolved shared dependencies reject text identities and normalize native UUIDs", () => {
  for (const kind of ["category", "collectible_profile", "valuation"] as const) {
    const candidate = { ...delivery, sharedDependencies: [{ kind, identity: "not-a-native-id", contentSha256: "b".repeat(64) }] };
    assert.equal(sharedProviderChangeDeliverySchema.safeParse(candidate).success, false, kind);
    candidate.sharedDependencies[0]!.identity = id.toUpperCase();
    assert.equal(sharedProviderChangeDeliverySchema.parse(candidate).sharedDependencies[0]!.identity, id);
  }
  for (const kind of ["provider_profile", "ev_policy"] as const) {
    assert.equal(sharedProviderChangeDeliverySchema.parse({ ...delivery,
      sharedDependencies: [{ kind, identity: "named-policy-or-profile", contentSha256: "b".repeat(64) }],
    }).sharedDependencies[0]!.identity, "named-policy-or-profile");
  }
});

test("shared delivery sequences fit signed PostgreSQL bigint without narrowing other V1 sequences", () => {
  for (const providerChangeSequence of ["1", "9223372036854775807"]) {
    assert.equal(sharedProviderChangeDeliverySchema.parse({ ...delivery, providerChangeSequence }).providerChangeSequence, providerChangeSequence);
  }
  for (const providerChangeSequence of ["9223372036854775808", "9".repeat(30)]) {
    assert.equal(packCatalogSequenceSchema.safeParse(providerChangeSequence).success, true);
    assert.equal(sharedProviderChangeDeliverySchema.safeParse({ ...delivery, providerChangeSequence }).success, false);
  }
  for (const providerChangeSequence of ["0", "-1", "x", "1e3", "1.5"]) {
    assert.equal(sharedProviderChangeDeliverySchema.safeParse({ ...delivery, providerChangeSequence }).success, false);
  }
});
