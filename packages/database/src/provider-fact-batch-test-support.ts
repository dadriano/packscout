import type { CanonicalJsonObject } from "./provider-canonical-contract.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";
import { collectibleBatchState } from "./provider-collectible-batch-test-support.ts";

export type FactRecordInput = Omit<ProviderMixedPageRecord, "providerId" | "position">;
export function pullRecord(key: string, changes: CanonicalJsonObject = {}): FactRecordInput {
  return { kind: "pull", candidate: {
    pullKey: key, factDigest: "a".repeat(64), packKey: "unresolved-pack", providerAccountKey: null,
    occurredAt: "2026-08-29T12:00:00.000Z", paidAmount: "20.125", paidCurrency: "USD",
    items: [{ collectibleKey: "card-0", collectibleInstanceKey: null, quantity: "2",
      statedValueAmount: "10.125", statedValueCurrency: "USD" }], ...changes,
  } };
}
export function eventRecord(key: string, changes: CanonicalJsonObject = {}): FactRecordInput {
  return { kind: "market_event", candidate: {
    eventKey: key, factDigest: "b".repeat(64), eventGroupId: null, eventType: "sale",
    packKey: "unresolved-pack", collectibleKey: "card-0", collectibleInstanceKey: null,
    fromProviderAccountKey: null, toProviderAccountKey: null, quantity: "2",
    occurredAt: "2026-08-29T12:00:00.000Z", amount: "10.125", currency: "USD",
    details: { synthetic: true, evidence: [1, "fixed"] }, ...changes,
  } };
}
export function factProfilePackRecord(key: string): FactRecordInput {
  return { kind: "catalog", entityType: "pack", operation: "upsert", candidate: {
    packKey: key, categoryKey: "category:batch", familyKey: null, displayName: `Synthetic ${key}`,
    description: null, packFormat: "repack", availability: "available", contentEvidence: "unknown",
    totalInventory: null, remainingInventory: null, priceAmount: "20", priceCurrency: "USD", priceUsdAmount: "20",
    priceUnavailableReason: null, buybackRate: null, buybackSourceKind: null,
    vendorEvAmount: null, vendorEvCurrency: null, vendorEvObservedAt: null, vendorEvUnavailableReason: "unavailable",
    packscoutEvAmount: null, packscoutEvCurrency: null, packscoutEvModelVersion: "synthetic-v1",
    packscoutEvConfidencePolicyVersion: "synthetic-v1", packscoutEvConfidence: null,
    packscoutEvDataAsOf: null, packscoutEvCalculatedAt: null, packscoutEvUnavailableReason: "unavailable",
    primaryImageUrl: null, primaryImageAlt: null, listingUrl: null, attributes: {},
    sourceUpdatedAt: "2026-08-29T12:00:00.000Z",
  } };
}
export async function factBatchState(client: ProviderPrismaClient, runId: string) {
  return { ...await collectibleBatchState(client, runId),
    pulls: await client.pulls.findMany({ orderBy: { pull_key: "asc" } }),
    items: await client.pull_items.findMany({ orderBy: [{ pull_id: "asc" }, { ordinal: "asc" }] }),
    events: await client.market_events.findMany({ orderBy: { event_key: "asc" } }),
  };
}
