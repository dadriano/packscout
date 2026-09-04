import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { repackDetailFromPack } from "./promote-provider-data-release-v3-plan.mjs";
import { contentCatalogFixture, CONTENT_PACK_ID, CONTENT_PROVIDER_ID } from "./distributed-clutchpacks-content.test-support.mjs";

const { launchProviderKeys, packscoutPublicIdentityUuid } = await tsImport("@packscout/contracts", import.meta.url);
const { packDraft } = await tsImport("../../apps/worker/src/provider-observation-mixed-page-drafts.ts", import.meta.url);
const { projectProviderPromotionContents } = await tsImport("./promote-provider-data-release-v3-contents.mts", import.meta.url);
const readAt = "2026-08-29T21:40:00.000Z";
const versions = {
  methodVersion: "packscout-buyback-adjusted-ev-v1",
  confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
};

function source(platformKey = "clutchpacks") {
  const catalog = contentCatalogFixture("pack:one");
  const draft = packDraft({
    identity: { providerRecordId: "one" }, displayName: "Provider pack",
    category: null, description: null, imageReferences: [],
    price: { amount: 100, currency: "USD" }, providerReportedEv: null,
    availability: "available", buybackPercent: null,
    effectiveAt: "2026-08-29T21:35:00.000Z",
  }).candidate;
  assert.equal(draft.contentEvidence, "unknown");
  const detail = repackDetailFromPack({
    pack: {
      pack_key: draft.packKey, display_name: draft.displayName,
      source_updated_at: draft.sourceUpdatedAt, availability: draft.availability,
      price_amount: draft.priceAmount, price_currency: draft.priceCurrency,
      price_usd_amount: draft.priceUsdAmount, content_evidence: draft.contentEvidence,
    },
    platform: { platformKey, publicVendorId: CONTENT_PROVIDER_ID, displayName: platformKey, logoUrl: null },
    readAt, versions, identity: packscoutPublicIdentityUuid, categoryChain: [], collectibleTypes: ["card"],
  });
  return {
    providerId: CONTENT_PROVIDER_ID, platformKey, snapshotAt: new Date(readAt),
    publicAssetOrigins: ["https://cdn.example.test"],
    packs: [{ id: CONTENT_PACK_ID, rowVersion: 1n, packKey: draft.packKey, detail }],
    latestSnapshots: catalog.snapshots,
    collectibles: catalog.collectibles, instances: catalog.instances, memberships: catalog.memberships,
  };
}

for (const platform of launchProviderKeys) {
  test(`${platform}: imported unknown pack metadata uses retained membership completeness`, () => {
    const input = source(platform);
    const result = projectProviderPromotionContents(input);
    assert.equal(result.repacks[0].contentSummary.evidenceCompleteness, "partial");
    assert.equal(result.repacks[0].contentSummary.knownCollectibleCount, 1);
    assert.ok(result.repacks[0].topChase);
    assert.deepEqual(result.repacks[0].evEstimates, input.packs[0].detail.evEstimates);
  });
}

test("complete empty membership clears contents without requiring image origins", () => {
  const input = source();
  const result = projectProviderPromotionContents({
    ...input, publicAssetOrigins: [], memberships: [], collectibles: [],
    latestSnapshots: [{ ...input.latestSnapshots[0], completeness: "complete" }],
  });
  assert.deepEqual(result.collectibles, []);
  assert.deepEqual(result.repackChases, []);
  assert.equal(result.repacks[0].topChase, null);
  assert.equal(result.repacks[0].contentSummary.evidenceCompleteness, "complete");
  assert.equal(result.repacks[0].contentSummary.knownCollectibleCount, 0);
  assert.deepEqual(result.repacks[0].collectibleTypes, []);
});

test("partial empty update preserves older active members", () => {
  const input = source();
  const result = projectProviderPromotionContents({
    ...input,
    latestSnapshots: [{ ...input.latestSnapshots[0], effectiveAt: new Date("2026-08-29T21:38:00.000Z") }],
  });
  assert.equal(result.repacks[0].contentSummary.knownCollectibleCount, 1);
  assert.equal(result.repacks[0].contentSummary.evidenceCompleteness, "partial");
  assert.equal(result.repacks[0].topChase.observedAt, input.memberships[0].observedAt.toISOString());
});

test("packs without membership evidence retain their explicit unknown state", () => {
  const input = source();
  const result = projectProviderPromotionContents({ ...input, memberships: [], collectibles: [], latestSnapshots: [] });
  assert.deepEqual(result.repacks, input.packs.map(({ detail }) => detail));
});

test("no image allowlist is needed when canonical collectibles have no image", () => {
  const input = source();
  const result = projectProviderPromotionContents({
    ...input, publicAssetOrigins: [],
    collectibles: input.collectibles.map((card) => ({ ...card, primaryImageUrl: null, primaryImageAlt: null })),
  });
  assert.equal(result.collectibles[0].primaryImage, null);
});

test("unknown pack metadata cannot substitute for a missing membership receipt", () => {
  const input = source();
  assert.throws(() => projectProviderPromotionContents({ ...input, latestSnapshots: [] }), /PROVIDER_CONTENT_SNAPSHOT_REQUIRED/);
});

for (const [name, mutate] of [
  ["duplicate latest receipts", (input) => [...input.latestSnapshots, ...input.latestSnapshots]],
  ["unknown completeness", (input) => [{ ...input.latestSnapshots[0], completeness: "unknown" }]],
  ["future receipt", (input) => [{ ...input.latestSnapshots[0], effectiveAt: new Date("2026-08-30T00:00:00.000Z") }]],
]) {
  test(`promotion refuses ${name}`, () => {
    const input = source();
    assert.throws(() => projectProviderPromotionContents({ ...input, latestSnapshots: mutate(input) }), /PROVIDER_CONTENT_SNAPSHOT_INVALID/);
  });
}

test("priceless excluded packs do not leak membership or collectibles into the release", () => {
  const result = projectProviderPromotionContents({ ...source(), packs: [] });
  assert.deepEqual(result.repacks, []);
  assert.deepEqual(result.collectibles, []);
  assert.deepEqual(result.repackChases, []);
});
