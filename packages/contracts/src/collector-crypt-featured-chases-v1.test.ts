import assert from "node:assert/strict";
import test from "node:test";
import { parseCollectorCryptFeaturedChasesV1 } from "./collector-crypt-featured-chases-v1.ts";
import { packMembershipSnapshotV1 } from "./provider-pack-membership-snapshot-v1.ts";

const mint = "6CKQDzygkPZ4yM92gnScHxgyNmqMeUjqzoG6BpSPXArD";
const item = { id: mint, nft_address: mint, name: "Shining Mewtwo", insured_value: 45000,
  image: "https://d1xpxki1g4htqu.cloudfront.net/cards/mewtwo.png" };
const observedAt = "2026-09-04T00:09:05.000Z";
const source = { machineCode: "pokemon_1000", observedAt, response: { nfts: [item], hasMore: true } };

test("current machine featured cards retain exact identities and unconverted insured values", () => {
  const result = parseCollectorCryptFeaturedChasesV1({ ...source,
    response: { ...source.response, nfts: [{ ...item, ownership: { secret: "not admitted" } }] } });
  assert.equal(result.packKey, "pack:pokemon_1000");
  assert.equal(result.cards[0]!.collectibleKey, `card:${mint}`);
  assert.equal(result.cards[0]!.insuredValueAmount, "45000.00");
  assert.equal(result.membership.completeness, "partial");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  const snapshot = packMembershipSnapshotV1({ providerId: "10000000-0000-5000-8000-000000000001",
    providerRecordId: result.machineCode, sourceAdapterVersion: "collector-crypt-featured-v1", mapperVersion: "featured-v1",
    effectiveAt: observedAt, effectiveAtBasis: "response_observed_at", collectedAt: observedAt, membership: result.membership });
  assert.deepEqual(snapshot.items[0]!.evidenceKinds, ["vendor_featured_chase"]);
  for (const field of ["probability", "totalQuantity", "availableQuantity", "statedValueAmount", "statedValueCurrency"] as const) {
    assert.equal(snapshot.items[0]![field], null);
  }
});

test("even a final or empty featured page does not assert full inventory", () => {
  for (const nfts of [[], [item]]) {
    assert.equal(parseCollectorCryptFeaturedChasesV1({ ...source, response: { nfts, hasMore: false } }).membership.completeness, "partial");
  }
});

test("invalid, ambiguous, duplicate and historical-only sources fail closed", () => {
  for (const response of [
    { winners: [item], hasMore: false },
    { nfts: [item, item], hasMore: false },
    ...[{ id: "different" }, { nft_address: "11111111111111111111111111111111" },
      { insured_value: -1 }, { insured_value: 1.001 }, { insured_value: Number.MAX_SAFE_INTEGER },
      { image: "https://unapproved.example/card.png" }].map(change => ({ nfts: [{ ...item, ...change }], hasMore: false })),
  ]) assert.throws(() => parseCollectorCryptFeaturedChasesV1({ ...source, response }));
});
