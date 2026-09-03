import { randomUUID } from "node:crypto";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { ProviderCanonicalImmutableFactConflictError, ProviderCanonicalInputError,
  ProviderCanonicalWriteConflictError } from "./provider-canonical-contract.ts";
import { normalizeProviderPullWrite, providerPullCreateData, normalizeProviderMarketEventWrite,
  providerMarketEventCreateData } from "./provider-canonical-fact-write.ts";
import { appendPromotionRange } from "./provider-canonical-repository.ts";
import { pullCandidate, marketEventCandidate } from "./provider-mixed-page-candidates.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";
import { readProviderFactBatchReferences } from "./provider-fact-batch-references.ts";

export const PROVIDER_FACT_BATCH_SIZE = 100;

export function isProviderFactRecord(record: ProviderMixedPageRecord): boolean {
  return (record.kind === "pull" || record.kind === "market_event") && record.disposition === undefined;
}

export type ProviderFactBatchOutcome = boolean | { readonly error: ProviderCanonicalImmutableFactConflictError };

function changed(current: { fact_digest: string } | undefined, digest: string,
  factType: "pull" | "market_event", stableKey: string): ProviderFactBatchOutcome {
  if (!current) return true;
  if (current.fact_digest !== digest) return { error: new ProviderCanonicalImmutableFactConflictError({ factType, stableKey }) };
  return false;
}

function requireCreated(count: number, expected: number) {
  if (count !== expected) throw new ProviderCanonicalWriteConflictError();
}

/** Only a caller-owned, fenced page transaction and chunk savepoint may invoke this batch. */
export async function applyProviderFactBatch(transaction: ProviderTransactionClient,
  records: readonly ProviderMixedPageRecord[]): Promise<readonly ProviderFactBatchOutcome[] | null> {
  if (records.length === 0 || records.length > PROVIDER_FACT_BATCH_SIZE
    || records.some(record => !isProviderFactRecord(record) || record.kind !== records[0]!.kind)) {
    throw new ProviderCanonicalInputError("The fact batch is outside its bounded contract.");
  }
  const references = await readProviderFactBatchReferences(transaction, records);
  if (references === null) return null;
  if (records[0]!.kind === "pull") {
    const prepared = [];
    for (const record of records) {
      const input = await pullCandidate(transaction, record.candidate, references);
      prepared.push({ input, normalized: normalizeProviderPullWrite(input) });
    }
    const keys = prepared.map(row => row.normalized.pullKey);
    // Repeated source identities retain original record ordering and per-record conflict isolation.
    if (new Set(keys).size !== keys.length) return null;
    const existing = await transaction.pulls.findMany({ where: { pull_key: { in: keys } },
      select: { pull_key: true, fact_digest: true }, take: keys.length });
    const byKey = new Map(existing.map(row => [row.pull_key, row]));
    const creates: ReturnType<typeof providerPullCreateData>[] = [];
    const outcomes = prepared.map(({ input, normalized }) => {
      const outcome = changed(byKey.get(normalized.pullKey), normalized.factDigest, "pull", normalized.pullKey);
      if (outcome !== true) return outcome;
      creates.push(providerPullCreateData(input, normalized, randomUUID(), input.items.map(() => randomUUID())));
      return true;
    });
    if (creates.length > 0) {
      const pulls = creates.map(row => row.pull), items = creates.flatMap(row => row.items);
      requireCreated((await transaction.pulls.createMany({ data: pulls })).count, pulls.length);
      requireCreated((await transaction.pull_items.createMany({ data: items })).count, items.length);
      await appendPromotionRange(transaction, creates.flatMap(row => [
        { entityType: "pull" as const, entityId: row.pull.id, entityVersion: 1n, operation: "upsert" as const },
        ...row.items.map(item => ({ entityType: "pull_item" as const, entityId: item.id,
          entityVersion: 1n, operation: "upsert" as const })),
      ]));
    }
    return outcomes;
  }
  const prepared = [];
  for (const record of records) {
    const input = await marketEventCandidate(transaction, record.candidate, references);
    prepared.push({ input, normalized: normalizeProviderMarketEventWrite(input) });
  }
  const keys = prepared.map(row => row.normalized.eventKey);
  if (new Set(keys).size !== keys.length) return null;
  const existing = await transaction.market_events.findMany({ where: { event_key: { in: keys } },
    select: { event_key: true, fact_digest: true }, take: keys.length });
  const byKey = new Map(existing.map(row => [row.event_key, row]));
  const creates: ReturnType<typeof providerMarketEventCreateData>[] = [];
  const outcomes = prepared.map(({ input, normalized }) => {
    const outcome = changed(byKey.get(normalized.eventKey), normalized.factDigest, "market_event", normalized.eventKey);
    if (outcome !== true) return outcome;
    creates.push(providerMarketEventCreateData(input, normalized, randomUUID()));
    return true;
  });
  if (creates.length > 0) {
    requireCreated((await transaction.market_events.createMany({ data: creates })).count, creates.length);
    await appendPromotionRange(transaction, creates.map(row => ({ entityType: "market_event",
      entityId: row.id, entityVersion: 1n, operation: "upsert" })));
  }
  return outcomes;
}
