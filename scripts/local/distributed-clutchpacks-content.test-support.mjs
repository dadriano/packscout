import { tsImport } from "tsx/esm/api";
const { providerPackContentSnapshotDigest } = await tsImport("@packscout/database", import.meta.url);
export const CONTENT_PROVIDER_ID = "10000000-0000-5000-8000-000000000001";
export const CONTENT_PACK_ID = "20000000-0000-5000-8000-000000000001";
export const CONTENT_CARD_ID = "60000000-0000-5000-8000-000000000001";
export function contentCatalogFixture(packKey = "pokemon-mystery-pack") {
  const observedAt = new Date("2026-08-29T21:35:30.000Z");
  const snapshotId = "70000000-0000-5000-8000-000000000001";
  const item = { collectibleKey: "card:one", collectibleInstanceKey: null, status: "present", totalQuantity: null,
    availableQuantity: null, contentRole: "possible_outcome", probability: null, statedValueAmount: null,
    statedValueCurrency: null, evidenceKinds: ["vendor_inventory"], matchConfidenceBasisPoints: 10000, displayOrder: 0 };
  const body = { schemaVersion: "provider_pack_content_snapshot_v1", providerId: CONTENT_PROVIDER_ID,
    packKey, sourceKey: "public-preview", sourceAdapterVersion: "preview-v1", mapperVersion: "preview-v1",
    effectiveAt: observedAt.toISOString(), effectiveAtBasis: "response_observed_at", collectedAt: observedAt.toISOString(),
    completeness: "partial", items: [item] };
  return {
    memberships: [{ id: "80000000-0000-5000-8000-000000000001", rowVersion: 1n, packId: CONTENT_PACK_ID,
      collectibleId: CONTENT_CARD_ID, collectibleInstanceId: null, sourceSnapshotId: snapshotId,
      totalQuantity: null, availableQuantity: null, contentRole: item.contentRole, probability: null,
      statedValueAmount: null, statedValueCurrency: null, evidenceKinds: item.evidenceKinds,
      matchConfidenceBasisPoints: 10000, matchConfidenceBand: "high", observedAt, displayOrder: 0 }],
    collectibles: [{ id: CONTENT_CARD_ID, rowVersion: 2n, collectibleKey: "card:one", collectibleType: "card",
      displayName: "Charizard PSA 10", aliases: [], year: 2020, brand: "Pokemon", setOrSeries: "Base",
      cardNumber: "25", referenceNumber: null, subject: "Charizard", grade: "10", grader: "PSA",
      primaryImageUrl: "https://cdn.example.test/cards/charizard.png", primaryImageAlt: null,
      valuationAmount: "123.45", valuationCurrency: "USD", valuationUsdAmount: "123.45", valuationUnavailableReason: null,
      valuationType: "vendor_reported", valuationObservedAt: new Date("2026-08-29T20:00:00.000Z"),
      dataAsOf: new Date("2026-08-29T21:30:00.000Z") }],
    instances: [], aliasRows: [], snapshots: [{ id: snapshotId, packId: CONTENT_PACK_ID, sourceKey: body.sourceKey,
      effectiveAt: observedAt,
      effectiveAtBasis: body.effectiveAtBasis, collectedAt: observedAt, snapshotDigest: providerPackContentSnapshotDigest(body),
      completeness: body.completeness, normalizedSnapshot: body, createdAt: new Date("2026-08-29T21:36:00.000Z") }],
  };
}
