import assert from "node:assert/strict";
import test from "node:test";
import { provisionalCollectiblePublicId, publicRepackDetailSchema } from "@packscout/contracts";
import { projectProvisionalProviderPackContentsV1 } from "./distributed-provider-pack-contents.ts";
import { DistributedProviderPackContentsError, type DistributedProviderCollectibleRow } from "./distributed-provider-pack-contents-types.ts";

const providerId = "10000000-0000-5000-8000-000000000001";
const packId = "20000000-0000-5000-8000-000000000001";
const cardId = "30000000-0000-5000-8000-000000000001";
const observedAt = new Date("2026-08-30T12:00:00.000Z");

function card(overrides: Partial<DistributedProviderCollectibleRow> = {}): DistributedProviderCollectibleRow {
  return {
    id: cardId, rowVersion: 3n, collectibleKey: "card:one", collectibleType: "card",
    displayName: "Charizard PSA 10", aliases: [], year: 2020, brand: "Pokemon",
    setOrSeries: null, cardNumber: "25", referenceNumber: null, subject: "Charizard",
    grade: "10", grader: "PSA", primaryImageUrl: "https://images.example.test/card.png",
    primaryImageAlt: null, valuationAmount: "123.455", valuationCurrency: "USD",
    valuationUsdAmount: "123.455", valuationUnavailableReason: null,
    valuationType: "vendor_reported", valuationObservedAt: new Date("2026-08-30T12:01:00.000Z"),
    dataAsOf: new Date("2026-08-30T12:02:00.000Z"), ...overrides,
  };
}

function input(): Parameters<typeof projectProvisionalProviderPackContentsV1>[0] {
  const detail = publicRepackDetailSchema.parse({
    publicRepackId: packId, publicVendorId: providerId, vendorKey: "clutchpacks", vendorDisplayName: "ClutchPacks",
    vendorLogoUrl: null, name: "Test pack", format: "repack", contentMode: "unknown", categories: [], collectibleTypes: [],
    availability: "available", price: { displayMoney: { minorUnits: 10000, currency: "USD" },
      usdComparison: { status: "available", value: { minorUnits: 10000, currency: "USD" } } },
    buyback: { status: "unavailable", value: null, reason: "BUYBACK_UNAVAILABLE" }, primaryImage: null,
    evEstimates: { vendorReported: { status: "unavailable", displayMoney: null, metrics: null, observedAt: null, reason: "NOT_REPORTED" },
      packScout: { status: "unavailable", metrics: null, confidence: null, modelVersion: "test-v1", confidencePolicyVersion: "test-v1",
        dataAsOf: null, calculatedAt: null, reason: "ESTIMATE_INPUT_INCOMPLETE" } },
    topChase: null, contentSummary: { knownCollectibleCount: 0, chaseCount: 0, categoryCount: 0, collectibleTypeCount: 0,
      evidenceCompleteness: "unknown", probabilityCoverageBasisPoints: null }, actionAvailability: { promo: false, repackLink: false },
    sourceUpdatedAt: "2026-08-30T11:00:00.000Z", description: null, actions: {},
  });
  return {
    identityPolicy: "provider_provisional_v1", providerId, platformKey: "clutchpacks",
    snapshotAt: new Date("2026-08-30T12:05:00.000Z"), publicAssetOrigins: ["https://images.example.test"],
    packs: [{ id: packId, rowVersion: 8n, packKey: "pack:one", evidenceCompleteness: "partial", detail: {
      ...detail, categories: [], collectibleTypes: [], topChase: null,
      contentSummary: { knownCollectibleCount: 0, chaseCount: 0, categoryCount: 0, collectibleTypeCount: 0,
        evidenceCompleteness: "unknown", probabilityCoverageBasisPoints: null },
    } }],
    collectibles: [card()], instances: [], memberships: [{
      id: "40000000-0000-5000-8000-000000000001", rowVersion: 2n, packId, collectibleId: cardId,
      collectibleInstanceId: null, totalQuantity: null, availableQuantity: null, contentRole: "possible_outcome",
      probability: null, statedValueAmount: null, statedValueCurrency: null,
      evidenceKinds: ["vendor_inventory"], matchConfidenceBasisPoints: 10_000, matchConfidenceBand: "high",
      observedAt, displayOrder: 0,
    }],
  };
}

test("current membership produces truthful chase, card search, and summary without changing pack economics", () => {
  const source = input();
  const result = projectProvisionalProviderPackContentsV1(source);
  const chase = result.repackChases[0]!;
  assert.equal(chase.publicCollectibleId, provisionalCollectiblePublicId({ providerId, localCollectibleId: cardId }));
  assert.equal(chase.observedAt, observedAt.toISOString());
  assert.equal(chase.probabilityBasisPoints, null);
  assert.deepEqual(chase.evidenceKinds, ["vendor_inventory"]);
  assert.equal(chase.collectible.valuation?.displayMoney?.minorUnits, 12_346);
  assert.match(result.collectibles[0]!.searchText, /charizard.*psa/);
  assert.equal(result.collectibles[0]!.grade, "10");
  assert.equal(result.repacks[0]!.topChase?.publicCollectibleId, chase.publicCollectibleId);
  assert.deepEqual(result.repacks[0]!.contentSummary, {
    knownCollectibleCount: 1, chaseCount: 1, categoryCount: 0, collectibleTypeCount: 1,
    evidenceCompleteness: "partial", probabilityCoverageBasisPoints: null,
  });
  for (const field of ["publicRepackId", "price", "buyback", "evEstimates", "sourceUpdatedAt"] as const) {
    assert.deepEqual(result.repacks[0]![field], source.packs[0]!.detail[field]);
  }
});

test("last known card valuation ranks inventory with stable identity while relation observation stays original", () => {
  const source = input();
  const second = card({ id: "30000000-0000-5000-8000-000000000002", collectibleKey: "card:two", valuationAmount: "500", valuationUsdAmount: "500" });
  const result = projectProvisionalProviderPackContentsV1({ ...source, collectibles: [second, ...source.collectibles],
    memberships: [...source.memberships, { ...source.memberships[0]!, id: "40000000-0000-5000-8000-000000000002", collectibleId: second.id, displayOrder: 1 }] });
  assert.equal(result.repacks[0]!.topChase?.collectible.valuation?.displayMoney?.minorUnits, 50_000);
  assert.equal(result.repacks[0]!.contentSummary.knownCollectibleCount, 2);
  const later = projectProvisionalProviderPackContentsV1({ ...source, snapshotAt: new Date("2026-09-01T12:00:00.000Z") });
  assert.equal(later.repackChases[0]!.observedAt, observedAt.toISOString());
  assert.deepEqual(later.collectibles, projectProvisionalProviderPackContentsV1(source).collectibles);
});

test("a card without valuation remains searchable and has unknown item odds", () => {
  const source = input();
  const result = projectProvisionalProviderPackContentsV1({ ...source, collectibles: [card({ valuationAmount: null,
    valuationCurrency: null, valuationUsdAmount: null, valuationType: null, valuationObservedAt: null,
    valuationUnavailableReason: "VALUATION_UNAVAILABLE" })] });
  assert.equal(result.collectibles[0]!.valuation, null);
  assert.equal(result.repackChases[0]!.probabilityBasisPoints, null);
});

for (const [name, mutate] of [
  ["cross-pack membership", (value: ReturnType<typeof input>) => ({ ...value, memberships: [{ ...value.memberships[0]!, packId: "20000000-0000-5000-8000-000000000099" }] })],
  ["unapproved image origin", (value: ReturnType<typeof input>) => ({ ...value, publicAssetOrigins: [] })],
  ["duplicate public card identity", (value: ReturnType<typeof input>) => ({ ...value, memberships: [...value.memberships, { ...value.memberships[0]!, id: "40000000-0000-5000-8000-000000000002" }] })],
  ["historical pull inference", (value: ReturnType<typeof input>) => ({ ...value, memberships: [{ ...value.memberships[0]!, evidenceKinds: ["historical_pull_inference"] }] })],
  ["odds without direct vendor evidence", (value: ReturnType<typeof input>) => ({ ...value, memberships: [{ ...value.memberships[0]!, probability: "0.25" }] })],
  ["future membership", (value: ReturnType<typeof input>) => ({ ...value, memberships: [{ ...value.memberships[0]!, observedAt: new Date("2026-09-01T00:00:00.000Z") }] })],
  ["mismatched instance", (value: ReturnType<typeof input>) => ({ ...value,
    instances: [{ id: "50000000-0000-5000-8000-000000000001", rowVersion: 1n, collectibleId: packId,
      instanceKey: "instance:one", certifier: "PSA", certificationNumber: "123" }],
    memberships: [{ ...value.memberships[0]!, collectibleInstanceId: "50000000-0000-5000-8000-000000000001" }] })],
] as const) {
  test(`inventory projection refuses ${name}`, () => {
    assert.throws(() => projectProvisionalProviderPackContentsV1(mutate(input())), DistributedProviderPackContentsError);
  });
}

test("explicit per-item probabilities pass through without inferring probability coverage", () => {
  const source = input();
  const result = projectProvisionalProviderPackContentsV1({ ...source, memberships: [{ ...source.memberships[0]!,
    probability: "0.125", evidenceKinds: ["vendor_inventory", "vendor_odds"] }] });
  assert.equal(result.repackChases[0]!.probabilityBasisPoints, 1_250);
  assert.equal(result.repacks[0]!.contentSummary.probabilityCoverageBasisPoints, null);
});
