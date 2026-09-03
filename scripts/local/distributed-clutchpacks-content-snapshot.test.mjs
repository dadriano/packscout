import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { contentCatalogFixture, CONTENT_PACK_ID, CONTENT_PROVIDER_ID } from "./distributed-clutchpacks-content.test-support.mjs";
const { validateClutchpacksContentCatalog, clutchpacksPublicValuationFields } = await tsImport("./distributed-clutchpacks-content-snapshot.mts", import.meta.url);
const { providerPackContentSnapshotDigest } = await tsImport("@packscout/database", import.meta.url);
const validate = (catalog) => validateClutchpacksContentCatalog({ providerId: CONTENT_PROVIDER_ID,
  settledAt: new Date("2026-08-29T21:37:36.800Z"), packs: [{ id: CONTENT_PACK_ID, packKey: "pokemon-mystery-pack" }], catalog });
test("membership rows require their exact retained same-pack snapshot", () => {
  assert.equal(validate(contentCatalogFixture()).get(CONTENT_PACK_ID), "partial");
});
test("adapter and mapper provenance is required and digest-bound exclusively inside the normalized snapshot", () => {
  const catalog = contentCatalogFixture();
  const snapshot = catalog.snapshots[0];
  for (const key of ["sourceAdapterVersion", "mapperVersion"]) {
    assert.equal(Object.hasOwn(snapshot, key), false);
    assert.equal(snapshot.normalizedSnapshot[key], "preview-v1");
    const missing = structuredClone(catalog);
    delete missing.snapshots[0].normalizedSnapshot[key];
    assert.throws(() => validate(missing));
    const changed = structuredClone(catalog);
    changed.snapshots[0].normalizedSnapshot[key] = "preview-v2";
    assert.throws(() => validate(changed));
    changed.snapshots[0].snapshotDigest = providerPackContentSnapshotDigest(changed.snapshots[0].normalizedSnapshot);
    assert.equal(validate(changed).get(CONTENT_PACK_ID), "partial");
  }
});
for (const [name, change] of [
  ["missing source receipt", (x) => { x.memberships[0].sourceSnapshotId = null; }],
  ["renewed observation", (x) => { x.memberships[0].observedAt = new Date("2026-08-29T21:36:00.000Z"); }],
  ["changed source role", (x) => { x.memberships[0].contentRole = "featured_chase"; }],
  ["invented item odds", (x) => { x.memberships[0].probability = "0.1"; }],
  ["foreign snapshot provider", (x) => { x.snapshots[0].normalizedSnapshot.providerId = "10000000-0000-5000-8000-000000000099"; }],
  ["corrupted source body", (x) => { x.snapshots[0].normalizedSnapshot.completeness = "complete"; }],
  ["future retained snapshot", (x) => { x.snapshots[0].createdAt = new Date("2026-08-29T22:00:00.000Z"); }],
]) test(`membership proof refuses ${name}`, () => {
  const catalog = contentCatalogFixture(); change(catalog);
  assert.throws(() => validate(catalog));
});
test("a newer partial snapshot preserves an older explicit membership while a complete empty snapshot removes it", () => {
  const catalog = contentCatalogFixture();
  const old = catalog.snapshots[0];
  const at = new Date("2026-08-29T21:36:10.000Z");
  const body = { ...old.normalizedSnapshot, effectiveAt: at.toISOString(), collectedAt: at.toISOString(), items: [] };
  const newer = { ...old, id: "70000000-0000-5000-8000-000000000002", effectiveAt: at, collectedAt: at,
    createdAt: at, normalizedSnapshot: body, snapshotDigest: providerPackContentSnapshotDigest(body) };
  catalog.snapshots.push(newer);
  assert.equal(validate(catalog).get(CONTENT_PACK_ID), "partial");
  newer.completeness = "complete"; newer.normalizedSnapshot.completeness = "complete";
  newer.snapshotDigest = providerPackContentSnapshotDigest(newer.normalizedSnapshot);
  assert.throws(() => validate(catalog));
  catalog.memberships = []; catalog.collectibles = [];
  assert.equal(validate(catalog).get(CONTENT_PACK_ID), "complete");
});

test("actual Clutch card normalization and worker drafts map provider valuation provenance at the owning boundary", async () => {
  const { normalizeDataforrestEventRecordForAdapter, dataforrestClutchpacksDistributedSourceAdapterManifest } = await tsImport("@packscout/contracts", import.meta.url);
  const { createLaunchProviderObservationMapper, launchSourceMapperDescriptors, projectProvisionalProviderPackContentsV1 } = await tsImport("@packscout/services", import.meta.url);
  const { collectibleDraft } = await tsImport("../../apps/worker/src/provider-observation-mixed-page-drafts.ts", import.meta.url);
  const descriptor = launchSourceMapperDescriptors.find(({ provider }) => provider === "clutchpacks");
  for (const formattedPrice of ["$1,234.56", null]) {
    const observation = normalizeDataforrestEventRecordForAdapter({ stream: "catalog", platform: "clutchpacks", entity: "card",
      record_id: "one", occurred_at: "2026-08-29T21:30:00.000Z", collected_at: "2026-08-29T21:30:00.000Z",
      first_seen_at: "2026-08-29T21:00:00.000Z", available: true,
      data: { asset: { title: "Charizard PSA 10", formatted_current_price: formattedPrice,
        front_image_url: "https://cdn.example.test/cards/charizard.png" } },
    }, "clutchpacks", "protected-card-proof", dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion);
    const mapped = createLaunchProviderObservationMapper(descriptor).map({ ...descriptor,
      organizationId: "90000000-0000-5000-8000-000000000001", providerId: CONTENT_PROVIDER_ID, observation });
    assert.equal(mapped.status, "mapped");
    const draft = collectibleDraft(mapped.candidate).candidate;
    assert.equal(draft.valuationType, formattedPrice === null ? null : "clutchpacks_formatted_current_price");
    assert.equal(draft.valuationUnavailableReason, formattedPrice === null ? "source_unavailable" : null);
    const fields = clutchpacksPublicValuationFields(draft);
    assert.equal(fields.valuationType, formattedPrice === null ? null : "vendor_reported");
    assert.equal(fields.valuationUnavailableReason, formattedPrice === null ? "VALUATION_UNAVAILABLE" : null);
    // This exact normalized worker valuation, not a hand-written public value,
    // reaches the shared projector without leaking provider-specific enums.
    const catalog = contentCatalogFixture();
    const projected = { ...catalog.collectibles[0], ...draft, ...fields, id: catalog.collectibles[0].id,
      rowVersion: 1n, aliases: [], valuationObservedAt: draft.valuationObservedAt === null ? null : new Date(draft.valuationObservedAt),
      dataAsOf: new Date(draft.dataAsOf) };
    const { publicRepackDetailSchema } = await tsImport("@packscout/contracts", import.meta.url);
    const detail = publicRepackDetailSchema.parse({ publicRepackId: CONTENT_PACK_ID, publicVendorId: CONTENT_PROVIDER_ID,
      vendorKey: "clutchpacks", vendorDisplayName: "ClutchPacks", vendorLogoUrl: null, name: "Pack", format: "repack",
      contentMode: "unknown", categories: [], collectibleTypes: [], availability: "available",
      price: { displayMoney: { minorUnits: 100, currency: "USD" }, usdComparison: { status: "available", value: { minorUnits: 100, currency: "USD" } } },
      buyback: { status: "unavailable", value: null, reason: "BUYBACK_UNAVAILABLE" }, primaryImage: null,
      evEstimates: { vendorReported: { status: "unavailable", displayMoney: null, metrics: null, observedAt: null, reason: "NOT_REPORTED" },
        packScout: { status: "unavailable", metrics: null, confidence: null, modelVersion: "test-v1", confidencePolicyVersion: "test-v1", dataAsOf: null, calculatedAt: null, reason: "ESTIMATE_INPUT_INCOMPLETE" } },
      topChase: null, contentSummary: { knownCollectibleCount: 0, chaseCount: 0, categoryCount: 0, collectibleTypeCount: 0, evidenceCompleteness: "unknown", probabilityCoverageBasisPoints: null },
      actionAvailability: { promo: false, repackLink: false }, sourceUpdatedAt: "2026-08-29T21:00:00.000Z", description: null, actions: {} });
    const result = projectProvisionalProviderPackContentsV1({ identityPolicy: "provider_provisional_v1", providerId: CONTENT_PROVIDER_ID,
      platformKey: "clutchpacks", snapshotAt: new Date("2026-08-29T21:37:36.800Z"), publicAssetOrigins: ["https://cdn.example.test"],
      packs: [{ id: CONTENT_PACK_ID, rowVersion: 1n, packKey: "pokemon-mystery-pack", detail, evidenceCompleteness: "partial" }],
      collectibles: [projected], instances: [], memberships: catalog.memberships });
    assert.equal(result.collectibles[0].valuation?.displayMoney?.minorUnits ?? null, formattedPrice === null ? null : 123456);
  }
});
