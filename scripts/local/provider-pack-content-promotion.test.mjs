import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { packscoutPublicIdentityUuid, provisionalCollectiblePublicId, PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION } = await tsImport("@packscout/contracts", import.meta.url);
import { repackDetailFromPack } from "./promote-provider-data-release-v3-plan.mjs";
const { mergePromotedCollectibles, projectProviderPackContents, readProviderPackContents } =
  await tsImport("./provider-pack-content-promotion.mts", import.meta.url);

const providerId = "10000000-0000-5000-8000-000000000001";
const packId = "20000000-0000-5000-8000-000000000001";
const cardId = "30000000-0000-5000-8000-000000000001";
const readAt = "2026-09-04T00:10:00.000Z";
const observedAt = new Date("2026-09-04T00:09:05.000Z");
const identity = packscoutPublicIdentityUuid;
const pack = { id: packId, pack_key: "pack:pokemon_1000", row_version: "1", display_name: "Grail Pokémon",
  pack_format: "gacha", availability: "available", content_evidence: "unknown", source_updated_at: observedAt,
  price_amount: "1000", price_currency: "USD", price_usd_amount: "1000", buyback_rate: "0.93",
  vendor_ev_amount: "1020", vendor_ev_currency: "USD", vendor_ev_observed_at: observedAt };
const detail = repackDetailFromPack({ pack, platform: { platformKey: "collector_crypt", publicVendorId: providerId,
  displayName: "Collector Crypt", logoUrl: null }, readAt, identity, categoryChain: [], collectibleTypes: ["card"],
  versions: { methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION, confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION } });
const contents = {
  evidence: new Map([[packId, "partial"]]), instances: [],
  collectibles: [{ id: cardId, rowVersion: 1n, collectibleKey: "card:mint", collectibleType: "card",
    displayName: "Shining Mewtwo", aliases: [], year: null, brand: null, setOrSeries: null, cardNumber: null,
    referenceNumber: null, subject: null, grade: null, grader: null, primaryImageUrl: null, primaryImageAlt: null,
    valuationAmount: "45000", valuationCurrency: "USDC", valuationUsdAmount: null,
    valuationUnavailableReason: "CURRENCY_UNSUPPORTED", valuationType: "vendor_reported", valuationObservedAt: observedAt, dataAsOf: observedAt }],
  memberships: [{ id: "40000000-0000-5000-8000-000000000001", rowVersion: 1n, packId, collectibleId: cardId,
    collectibleInstanceId: null, totalQuantity: null, availableQuantity: null, contentRole: "featured_chase",
    probability: null, statedValueAmount: "45000", statedValueCurrency: "USDC", evidenceKinds: ["vendor_featured_chase"],
    matchConfidenceBasisPoints: 10000, matchConfidenceBand: "high", observedAt, displayOrder: 0 }],
};

test("promotion connects only canonical members to V3 packs and preserves EV", () => {
  const result = projectProviderPackContents({ providerId, platformKey: "collector_crypt", readAt,
    publicAssetOrigins: [], packs: [pack], repacks: [detail], identity, contents });
  assert.equal(result.repacks[0].topChase?.collectible.name, "Shining Mewtwo");
  assert.deepEqual(result.repacks[0].evEstimates, detail.evEstimates);
  assert.equal(result.repacks[0].contentSummary.evidenceCompleteness, "partial");
  assert.equal(result.repacks[0].contentSummary.probabilityCoverageBasisPoints, null);
  assert.equal(result.repackChases[0].collectible.valuation?.usdComparison.status, "unavailable");
  const unrelated = { ...result.collectibles[0], publicCollectibleId: "30000000-0000-5000-8000-000000000099" };
  const old = { ...result.collectibles[0], name: "old" };
  const merged = mergePromotedCollectibles([unrelated, old], result.collectibles);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], unrelated);
  assert.equal(merged[1].name, "Shining Mewtwo");
});

test("no membership leaves packs without fabricated chases", () => {
  const result = projectProviderPackContents({ providerId, platformKey: "collector_crypt", readAt,
    publicAssetOrigins: [], packs: [pack], repacks: [detail], identity, contents: { ...contents, memberships: [] } });
  assert.equal(result.repacks[0].topChase, null);
  assert.deepEqual(result.collectibles, []);
});

test("V3 chooses the higher USDC insured value even alongside unvalued members", () => {
  const idFor = localCollectibleId => provisionalCollectiblePublicId({ providerId, localCollectibleId });
  const lowerId = Array.from({ length: 99 }, (_, index) => `30000000-0000-5000-8000-${String(index + 2).padStart(12, "0")}`)
    .find(id => idFor(id) < idFor(cardId));
  assert.ok(lowerId, "lower identity must precede the high-value card so identity ordering cannot pass this test");
  const low = { ...contents.collectibles[0], id: lowerId, collectibleKey: "card:low", valuationAmount: "42200" };
  const lowMembership = { ...contents.memberships[0], id: "40000000-0000-5000-8000-000000000002",
    collectibleId: lowerId, statedValueAmount: "42200", displayOrder: 1 };
  const unknown = { ...contents.collectibles[0], id: "30000000-0000-5000-8000-000000000100", collectibleKey: "card:unknown",
    valuationAmount: null, valuationCurrency: null, valuationUsdAmount: null, valuationType: null,
    valuationObservedAt: null, valuationUnavailableReason: "VALUATION_UNAVAILABLE" };
  const unknownMembership = { ...contents.memberships[0], id: "40000000-0000-5000-8000-000000000003",
    collectibleId: unknown.id, statedValueAmount: null, statedValueCurrency: null, displayOrder: 2 };
  const result = projectProviderPackContents({ providerId, platformKey: "collector_crypt", readAt,
    publicAssetOrigins: [], packs: [pack], repacks: [detail], identity,
    contents: { ...contents, collectibles: [unknown, low, ...contents.collectibles], memberships: [unknownMembership, lowMembership, ...contents.memberships] } });
  assert.equal(result.repacks[0].topChase.publicCollectibleId, idFor(cardId));
  assert.deepEqual(result.repacks[0].topChase.collectible.valuation.displayMoney, { minorUnits: 4500000, currency: "USDC" });
  assert.deepEqual(result.repacks[0].topChase.collectible.valuation.usdComparison,
    { status: "unavailable", value: null, reason: "CURRENCY_UNSUPPORTED" });
});

test("membership without its retained snapshot refuses promotion", async () => {
  const client = { query: async () => ({ rows: [{ snapshotId: null }] }) };
  await assert.rejects(readProviderPackContents(client, [packId]),
    /PROVIDER_CONTENT_SNAPSHOT_INVALID/u);
});

test("USDC source values do not replace an available USD-only comparison", () => {
  const usdOnly = { ...contents.collectibles[0], id: "30000000-0000-5000-8000-000000000099", collectibleKey: "card:usd",
    valuationAmount: null, valuationCurrency: null, valuationUsdAmount: "100", valuationUnavailableReason: null };
  const member = { ...contents.memberships[0], id: "40000000-0000-5000-8000-000000000099",
    collectibleId: usdOnly.id, statedValueAmount: null, statedValueCurrency: null, displayOrder: 1 };
  const result = projectProviderPackContents({ providerId, platformKey: "collector_crypt", readAt,
    publicAssetOrigins: [], packs: [pack], repacks: [detail], identity,
    contents: { ...contents, collectibles: [...contents.collectibles, usdOnly], memberships: [...contents.memberships, member] } });
  assert.equal(result.repacks[0].topChase.publicCollectibleId, provisionalCollectiblePublicId({ providerId, localCollectibleId: usdOnly.id }));
});
