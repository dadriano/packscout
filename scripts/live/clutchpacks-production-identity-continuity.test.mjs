import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { assertClutchpacksProductionIdentityContinuity, assertClutchpacksProductionInventoryContinuity } = await tsImport("./clutchpacks-production-identity-continuity.mts", import.meta.url);
const { PACKSCOUT_BUYBACK_EV_METHOD_VERSION, PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 } = await tsImport("@packscout/contracts", import.meta.url);
const { productionPublicationSha256 } = await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const { uuidV5 } = await tsImport("../local/generate-clutchpacks-v3-public-catalog-candidate.mts", import.meta.url);
function fixture() {
  const namespaceUuid = "90000000-0000-5000-8000-000000000001";
  const sourceExternalId = "20000000-0000-5000-8000-000000000001";
  const publicRepackId = uuidV5(namespaceUuid, `repack\0clutchpacks\0${sourceExternalId}`);
  const cardId = "30000000-0000-5000-8000-000000000001";
  const listingUrl = `https://clutchpacks.io/checkout/${sourceExternalId}/`;
  const baseline = { retainedIdentityAuthority: "test" };
  const category = { publicCategoryId: "40000000-0000-5000-8000-000000000001", parentPublicCategoryId: null,
    categoryKey: "sports", name: "Sports", kind: "vertical", depth: 0,
    pathPublicCategoryIds: ["40000000-0000-5000-8000-000000000001"], displayOrder: 0 };
  const proof = { schemaVersion: "packscout.clutchpacks-production-identity-proof.v1", readOnlySources: true, namespaceUuid,
    baseline: { rawSha256: "a".repeat(64), canonicalSha256: productionPublicationSha256(baseline) },
    production: { deployment: "shiny-newt-310", url: "https://shiny-newt-310.convex.cloud", generation: 2,
      publicReleaseId: "50000000-0000-5000-8000-000000000001", releaseFingerprint: "b".repeat(64) },
    packProof: [{ publicRepackId, sourceExternalId, listingUrl, matchesNamespace: true, matchesBaseline: true }],
    categoryProof: [{ detail: category, matchesNamespace: true, matchesBaseline: true }],
    productionCollectibleInventory: { count: 1, publicCollectibleIds: [cardId], sortedIdsCanonicalSha256: productionPublicationSha256([cardId]) },
    neonContinuity: { missingProductionCount: 0 } };
  return { proof, namespaceUuid, baseline, configuration: {
    repacks: [{ publicRepackId, packExternalId: `pack:${sourceExternalId}`, listingUrl }],
    collectibles: [{ publicCollectibleId: cardId }], categories: [category],
  } };
}
test("continuity admits additive collectibles and exact retained identities", () => {
  const input = fixture();
  input.configuration.collectibles.push({ publicCollectibleId: "30000000-0000-5000-8000-000000000002" });
  assert.doesNotThrow(() => assertClutchpacksProductionIdentityContinuity(input));
});
for (const [name, mutate] of [
  ["collectible removal", x => { x.configuration.collectibles = []; }],
  ["duplicate ID", x => { x.configuration.collectibles.push(x.configuration.collectibles[0]); }],
  ["changed pack storage identity", x => { x.configuration.repacks[0].packExternalId = "pack:30000000-0000-5000-8000-000000000001"; }],
  ["unapproved checkout", x => { x.configuration.repacks[0].listingUrl = "https://other.example.test/"; }],
  ["category removal", x => { x.configuration.categories = []; }],
  ["baseline tamper", x => { x.baseline.retainedIdentityAuthority = "changed"; }],
  ["inventory tamper", x => { x.proof.productionCollectibleInventory.sortedIdsCanonicalSha256 = "c".repeat(64); }],
]) test(`continuity refuses ${name}`, () => {
  const input = fixture(); mutate(input);
  assert.throws(() => assertClutchpacksProductionIdentityContinuity(input));
});

function inventoryFixture() {
  const original = fixture();
  const configuration = original.configuration;
  const publicVendorId = uuidV5(original.namespaceUuid, "vendor\0clutchpacks");
  configuration.platforms = [{ platformKey: "clutchpacks", vendor: { publicVendorId, vendorKey: "clutchpacks" } }];
  configuration.repacks[0].platformKey = "clutchpacks";
  // This ID was added after the original recovery proof. Only a fresh inventory
  // can prove that the next release does not silently drop it.
  const laterCardId = "30000000-0000-5000-8000-000000000002";
  configuration.collectibles.push({ publicCollectibleId: laterCardId });
  const predecessor = { generation: 3, publicReleaseId: "50000000-0000-5000-8000-000000000002",
    releaseFingerprint: "d".repeat(64) };
  const body = { schemaVersion: "clutchpacks-production-identity-inventory-v1",
    activeState: { generation: predecessor.generation, activeRelease: {
      publicReleaseId: predecessor.publicReleaseId, releaseFingerprint: predecessor.releaseFingerprint,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
      dataAsOf: "2026-08-31T17:40:00.000Z", completedAt: "2026-08-31T17:42:00.000Z",
      counts: { repacks: 1, collectibles: 2, categories: 1, chases: 1, searchShards: 1 } } },
    publicRepackIds: configuration.repacks.map(row => row.publicRepackId),
    publicCollectibleIds: configuration.collectibles.map(row => row.publicCollectibleId),
    categories: structuredClone(configuration.categories),
    repacks: [{ publicRepackId: configuration.repacks[0].publicRepackId, publicVendorId,
      vendorKey: "clutchpacks", listingUrl: configuration.repacks[0].listingUrl }] };
  return { configuration, predecessor, inventory: { ...body, digest: productionPublicationSha256(body) } };
}
function reseal(input) {
  const { digest: _, ...body } = input.inventory;
  input.inventory.digest = productionPublicationSha256(body);
}
test("fresh inventory admits an additive successor bound to the exact current release", () => {
  const input = inventoryFixture();
  input.configuration.collectibles.push({ publicCollectibleId: "30000000-0000-5000-8000-000000000003" });
  assert.doesNotThrow(() => assertClutchpacksProductionInventoryContinuity(input));
});
test("a non-actionable predecessor pack can regain its approved checkout URL", () => {
  const input = inventoryFixture(); input.inventory.repacks[0].listingUrl = null; reseal(input);
  assert.doesNotThrow(() => assertClutchpacksProductionInventoryContinuity(input));
});
for (const [name, mutate, seal] of [
  ["a card added after the original proof being dropped", x => { x.configuration.collectibles.pop(); }, false],
  ["a predecessor generation mismatch", x => { x.predecessor.generation++; }, false],
  ["a predecessor release mismatch", x => { x.predecessor.publicReleaseId = "50000000-0000-5000-8000-000000000003"; }, false],
  ["a predecessor fingerprint mismatch", x => { x.predecessor.releaseFingerprint = "e".repeat(64); }, false],
  ["an unsealed inventory edit", x => { x.inventory.repacks[0].listingUrl = null; }, false],
  ["an unrecognized inventory version", x => { x.inventory.schemaVersion = "future"; }, true],
  ["a resealed truncated card inventory", x => { x.inventory.publicCollectibleIds.pop(); x.configuration.collectibles.pop(); }, true],
  ["a resealed truncated pack inventory", x => { x.inventory.publicRepackIds = []; x.inventory.repacks = []; x.configuration.repacks = []; }, true],
  ["a resealed truncated category inventory", x => { x.inventory.categories = []; x.configuration.categories = []; }, true],
  ["missing pack reference evidence", x => { x.inventory.repacks = []; }, true],
  ["duplicate pack reference evidence", x => { x.inventory.repacks.push(x.inventory.repacks[0]); }, true],
  ["a pack reference outside the inventory", x => { x.inventory.repacks[0].publicRepackId = "20000000-0000-5000-8000-000000000099"; }, true],
  ["a changed vendor identity", x => { x.inventory.repacks[0].publicVendorId = "20000000-0000-5000-8000-000000000099"; }, true],
  ["a changed checkout URL", x => { x.configuration.repacks[0].listingUrl = "https://clutchpacks.io/checkout/other/"; }, false],
  ["a changed public category", x => { x.configuration.categories[0].name = "Other"; }, false],
  ["a duplicate configured category", x => { x.configuration.categories.push(x.configuration.categories[0]); }, false],
]) test(`fresh inventory refuses ${name}`, () => {
  const input = inventoryFixture(); mutate(input); if (seal) reseal(input);
  assert.throws(() => assertClutchpacksProductionInventoryContinuity(input), /CLUTCHPACKS_PRODUCTION_IDENTITY_CONTINUITY_FAILED/u);
});
