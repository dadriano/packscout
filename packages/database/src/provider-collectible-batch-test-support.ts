import type { ProviderPrismaClient } from "./provider-database.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";
import { batchState } from "./provider-quarantine-batch-integration-support.ts";

export function cardRecord(key: string, day = 1, changes: Record<string, unknown> = {}) {
  return { kind: "catalog", entityType: "collectible", operation: "upsert", candidate: {
    collectibleKey: key, categoryKey: "category:batch", collectibleType: "card",
    displayName: `Synthetic ${key}`, normalizedName: `synthetic ${key}`, year: 2026,
    brand: "Synthetic", setOrSeries: "Synthetic series", cardNumber: "1", referenceNumber: null,
    subject: null, grade: null, grader: null, primaryImageUrl: "https://example.test/image.png",
    primaryImageAlt: "Synthetic image", valuationAmount: "10.125", valuationCurrency: "USD",
    valuationUsdAmount: "10.125", valuationUnavailableReason: null, valuationType: "provider_statement",
    valuationObservedAt: "2026-08-01T00:00:00.000Z", dataAsOf: `2026-08-${day.toString().padStart(2, "0")}T00:00:00.000Z`,
    attributes: { synthetic: true, evidence: ["fixed", 1] }, expectedRowVersion: null, ...changes,
  } } as Omit<ProviderMixedPageRecord, "position" | "providerId">;
}

export function categoryRecord(displayName = "Synthetic category") {
  return { kind: "catalog", entityType: "category", operation: "upsert", candidate: {
    categoryKey: "category:batch", parentCategoryKey: null, displayName,
  } } as const;
}

export async function collectibleBatchState(client: ProviderPrismaClient, runId: string) {
  return { ...await batchState(client, runId),
    collectibles: await client.collectibles.findMany({ orderBy: { collectible_key: "asc" } }) };
}
