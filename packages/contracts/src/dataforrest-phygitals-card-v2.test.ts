import assert from "node:assert/strict";
import test from "node:test";
import { phygitalsCardProviderFactsV1 } from "./dataforrest-phygitals-card-v1.ts";
import { phygitalsCardProviderFactsV2 } from "./dataforrest-phygitals-card-v2.ts";
import {
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  normalizeDataforrestEventRecordForAdapter,
} from "./dataforrest-events-v1.ts";

test("Phygitals V2 preserves every original chase/asset selection, including malformed input", () => {
  for (const value of [
    { chase: { name: "Chase", image: "https://example.test/chase.png" } },
    { asset: { name: "Asset" }, nft: { name: "Different NFT" } },
    { chase: { name: "Chase" }, inventory: { title: "Different inventory" } },
    { chase: { name: "Chase" }, asset: { name: "Asset" } },
    { chase: null, inventory: { title: "Do not fallback" } },
    { asset: { name: 42 }, nft: { name: "Do not fallback" } },
  ]) assert.deepEqual(phygitalsCardProviderFactsV2(value), phygitalsCardProviderFactsV1(value));
});

test("inventory title wins over a differing NFT name without borrowing the NFT image", () => {
  const facts = phygitalsCardProviderFactsV2({
    inventory: { title: "Inventory label", fmv: "500", price: "500", currency: "USD",
      image: "https://example.test/unreviewed-inventory.png", data: { image: "unreviewed" } },
    nft: { name: "Different NFT label", image: "https://example.test/nft.png", owner: "protected" },
  });
  assert.deepEqual(facts.displayName, { state: "present", value: "Inventory label" });
  assert.deepEqual(facts.imageReferences, { state: "absent" });
  assert.deepEqual(facts.estimatedValue, { state: "absent" });
  assert.deepEqual(facts.valueSource, { state: "absent" });
  assert.equal(JSON.stringify(facts).includes("protected"), false);
});

test("NFT-only records use the exact name and image contract and keep envelope identity", () => {
  const record = {
    stream: "catalog" as const, entity: "card" as const, platform: "phygitals" as const,
    record_id: "envelope-record", occurred_at: "2026-08-30T01:00:00Z",
    collected_at: "2026-08-30T01:00:01Z", first_seen_at: "2026-08-30T01:00:00Z", available: true,
    data: { nft: { id: "unrelated-native-id", name: "NFT label", image: "https://example.test/nft.png",
      altFmv: "500", price: null, currency: null, owner: "protected" } },
  };
  const current = normalizeDataforrestEventRecordForAdapter(record, "phygitals", "fixture:record",
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION);
  const old = normalizeDataforrestEventRecordForAdapter(record, "phygitals", "fixture:record",
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION);
  assert.equal(current.providerRecordIdentity.providerRecordId, "envelope-record");
  assert.deepEqual(current.providerFacts.displayName, { state: "present", value: "NFT label" });
  assert.deepEqual(current.providerFacts.imageReferences, { state: "present", value: ["https://example.test/nft.png"] });
  assert.deepEqual(old.providerFacts.displayName, { state: "absent" });
  assert.equal(JSON.stringify(current).includes("unrelated-native-id"), false);
});

test("malformed selected inventory never falls through to NFT, and unsafe NFT image is omitted", () => {
  for (const inventory of [null, [], { title: 42 }, { title: " " }]) {
    const facts = phygitalsCardProviderFactsV2({ inventory, nft: { name: "Fallback prohibited" } });
    assert.deepEqual(facts.displayName, { state: "malformed" });
  }
  const malformedImage = phygitalsCardProviderFactsV2({ nft: { name: "Valid", image: "javascript:unsafe" } });
  assert.deepEqual(malformedImage.imageReferences, { state: "malformed" });
  assert.deepEqual(phygitalsCardProviderFactsV2({ unreviewed: { title: "No inference" } }).displayName,
    { state: "absent" });
});
