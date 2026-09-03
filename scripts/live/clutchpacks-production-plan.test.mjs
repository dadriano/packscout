import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { contentCatalogFixture, CONTENT_PACK_ID, CONTENT_CARD_ID, CONTENT_PROVIDER_ID } from "../local/distributed-clutchpacks-content.test-support.mjs";
const { providerPackContentSnapshotDigest } = await tsImport("@packscout/database", import.meta.url);
const { buildClutchpacksProductionConfiguration, buildClutchpacksProductionPlan,
  verifyClutchpacksProductionIdentityNamespace } = await tsImport("./clutchpacks-production-plan.mts", import.meta.url);
const { uuidV5, clutchpacksCategoryConfiguration } = await tsImport("../local/generate-clutchpacks-v3-public-catalog-candidate.mts", import.meta.url);

const namespace = "90000000-0000-5000-8000-000000000001";
const readAt = "2026-08-29T21:40:00.000Z";
function fixture() {
  const packKey = `pack:${CONTENT_PACK_ID}`;
  const cardKey = `card:${CONTENT_CARD_ID}`;
  const catalog = contentCatalogFixture(packKey);
  catalog.collectibles[0].collectibleKey = cardKey;
  catalog.snapshots[0].normalizedSnapshot.items[0].collectibleKey = cardKey;
  catalog.snapshots[0].snapshotDigest = providerPackContentSnapshotDigest(catalog.snapshots[0].normalizedSnapshot);
  const category = clutchpacksCategoryConfiguration(namespace, [{ externalId: CONTENT_PACK_ID, content: { category: "Pokemon" } }]);
  const publicPackId = uuidV5(namespace, `repack\0clutchpacks\0${CONTENT_PACK_ID}`);
  const publicCardId = uuidV5(namespace, `collectible\0clutchpacks\0${CONTENT_CARD_ID}`);
  const baseline = {
    schemaVersion: "approved_public_catalog_v1", configurationKey: "test-clutch-v1", revision: 2, approvedAt: "2026-08-27T12:00:00.000Z",
    staleAfterSeconds: 3600, confidencePolicy: { version: "test-v1", completeScoreBasisPoints: 9000,
      partialScoreBasisPoints: 6000, unknownScoreBasisPoints: 3000, limitationPenaltyBasisPoints: 500 },
    publicAssetOrigins: ["https://cdn.example.test"], verifiedUsdStablecoins: [], categories: category.categories,
    platforms: [{ platformKey: "clutchpacks", vendor: { publicVendorId: uuidV5(namespace, "vendor\0clutchpacks"),
      vendorKey: "clutchpacks", displayName: "ClutchPacks", logoUrl: null, websiteUrl: "https://clutchpacks.io/",
      listingHosts: ["clutchpacks.io"], imageOrigins: ["https://cdn.example.test"], referralParameters: [], publicPromo: null },
      format: "repack", defaultPublicCategoryIds: [], categoryMappings: category.categoryMappings, collectibleTypeMappings: [] }],
    repacks: [{ platformKey: "clutchpacks", packExternalId: CONTENT_PACK_ID, publicRepackId: publicPackId,
      listingUrl: `https://clutchpacks.io/checkout/${CONTENT_PACK_ID}/` }],
    collectibles: [{ platformKey: "clutchpacks", externalId: CONTENT_CARD_ID, publicCollectibleId: publicCardId,
      aliases: [], collectibleType: "card", publicCategoryIds: category.publicCategoryIdsForSourceValue("Pokemon"),
      year: null, brand: null, setOrSeries: null, cardNumber: null, referenceNumber: null, subject: null,
      grade: null, grader: null, probabilityBucketId: null, matchConfidenceBasisPoints: 10000, chaseEvidenceKinds: ["packscout_resolved"] }],
  };
  const pack = { id: CONTENT_PACK_ID, rowVersion: 1n, packKey, displayName: "Pokemon Pack", description: null,
    packFormat: "repack", availability: "available", contentEvidence: "partial", priceAmount: "100",
    priceCurrency: "USD", priceUsdAmount: "100", buybackRate: "0.8", buybackSourceKind: "provider_statement",
    vendorEvAmount: null, vendorEvCurrency: null, vendorEvObservedAt: null,
    packscoutEvModelVersion: "packscout-buyback-adjusted-ev-v1",
    packscoutEvConfidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    primaryImageUrl: "https://cdn.example.test/pack.png", primaryImageAlt: null, listingUrl: null,
    sourceUpdatedAt: new Date("2026-08-29T21:35:00.000Z") };
  const snapshot = { facts: { organizationId: "30000000-0000-5000-8000-000000000001", providerId: CONTENT_PROVIDER_ID,
    providerKey: "clutchpacks", promotionSequence: 100n, staleAfterSeconds: 3600, packs: [pack], contentCatalog: catalog,
    latestSourceHeadFinishedAt: new Date("2026-08-29T21:37:36.800Z"),
    catalogSettledAt: new Date("2026-08-29T21:37:36.800Z"), approvedPublicAssetOrigins: ["https://cdn.example.test"] } };
  const categoryEvidence = { packs: new Map([[packKey, "Pokemon"]]), collectibles: new Map([[cardKey, "Pokemon"]]) };
  return { baseline, snapshot, categoryEvidence, namespaceUuid: namespace, approvedAt: readAt, publicPackId, publicCardId };
}

test("production plan preserves public identities while storage keys change and only current membership is projected", async () => {
  const input = fixture();
  const configuration = buildClutchpacksProductionConfiguration(input);
  assert.equal(configuration.repacks[0].publicRepackId, input.publicPackId);
  assert.equal(configuration.collectibles[0].publicCollectibleId, input.publicCardId);
  assert.notEqual(configuration.repacks[0].packExternalId, input.baseline.repacks[0].packExternalId);
  const plan = await buildClutchpacksProductionPlan({ ...input, configuration, readAt });
  assert.deepEqual(plan.manifest.counts, { categories: 2, collectibles: 1, repacks: 1, chases: 1, searchShards: 1 });
  const pack = plan.batches.find(batch => batch.kind === "repacks").records[0];
  assert.equal(pack.publicRepackId, input.publicPackId);
  assert.equal(pack.topChase.publicCollectibleId, input.publicCardId);
  assert.equal(pack.actions.repackLink.listingUrl, input.baseline.repacks[0].listingUrl);
  assert.equal(pack.evEstimates.packScout.status, "unavailable");
});

test("namespace verification rejects any retained identity drift", () => {
  for (const kind of ["repacks", "collectibles", "categories"]) {
    const input = fixture();
    const field = { repacks: "publicRepackId", collectibles: "publicCollectibleId", categories: "publicCategoryId" }[kind];
    input.baseline[kind] = input.baseline[kind].map((row, index) => index === 0
      ? { ...row, [field]: "10000000-0000-5000-8000-000000000099" } : row);
    assert.throws(() => verifyClutchpacksProductionIdentityNamespace(input.baseline, namespace));
  }
});

test("production configuration refuses unknown categories and broadened publication origins", () => {
  const input = fixture();
  input.categoryEvidence.packs.set(input.snapshot.facts.packs[0].packKey, "Unreviewed category");
  assert.throws(() => buildClutchpacksProductionConfiguration(input));
  const origin = fixture();
  origin.snapshot.facts.approvedPublicAssetOrigins.push("https://unreviewed.example.test");
  assert.throws(() => buildClutchpacksProductionConfiguration(origin));
});

test("approved complete catalog keeps unassociated collectibles without inventing pack membership", async () => {
  const input = fixture();
  const secondId = "60000000-0000-5000-8000-000000000002";
  const secondKey = `card:${secondId}`;
  input.snapshot.facts.contentCatalog.collectibles.push({ ...input.snapshot.facts.contentCatalog.collectibles[0],
    id: secondId, collectibleKey: secondKey, displayName: "Unassociated card" });
  input.categoryEvidence.collectibles.set(secondKey, null);
  const configuration = buildClutchpacksProductionConfiguration(input);
  const plan = await buildClutchpacksProductionPlan({ ...input, configuration, readAt });
  assert.equal(plan.manifest.counts.collectibles, 2);
  assert.equal(plan.manifest.counts.chases, 1);
  const unrelatedPublicId = uuidV5(namespace, `collectible\0clutchpacks\0${secondId}`);
  assert.ok(plan.batches.find(batch => batch.kind === "collectibles").records.some(row => row.publicCollectibleId === unrelatedPublicId));
  assert.ok(plan.batches.filter(batch => batch.kind === "chases").every(batch => batch.records.every(row => row.publicCollectibleId !== unrelatedPublicId)));
});

test("source row ordering does not change the canonical approved identity configuration", () => {
  const input = fixture();
  const original = input.snapshot.facts.contentCatalog.collectibles[0];
  const secondId = "60000000-0000-5000-8000-000000000099";
  const secondKey = `card:${secondId}`;
  input.snapshot.facts.contentCatalog.collectibles.push({ ...original, id: secondId, collectibleKey: secondKey,
    aliases: ["Zulu", "Alpha"] });
  input.categoryEvidence.collectibles.set(secondKey, null);
  const first = buildClutchpacksProductionConfiguration(input);
  input.snapshot.facts.contentCatalog.collectibles.reverse();
  const reordered = buildClutchpacksProductionConfiguration(input);
  assert.deepEqual(reordered, first);
  assert.deepEqual(reordered.collectibles.find(row => row.externalId === secondKey).aliases, ["Alpha", "Zulu"]);
});
