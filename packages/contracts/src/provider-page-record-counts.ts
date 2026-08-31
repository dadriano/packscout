import { z } from "zod";

export const providerPageRecordCountsSchema = z.object({
  catalogRecordCount: z.number().int().nonnegative().safe(),
  collectibleRecordCount: z.number().int().nonnegative().safe(),
  packContentSnapshotCount: z.number().int().nonnegative().safe(),
  pullRecordCount: z.number().int().nonnegative().safe(),
  marketEventRecordCount: z.number().int().nonnegative().safe(),
  rejectedRecordCount: z.number().int().nonnegative().safe(),
}).strict().refine(value => value.collectibleRecordCount + value.packContentSnapshotCount <= value.catalogRecordCount);
export type ProviderPageRecordCounts = z.infer<typeof providerPageRecordCountsSchema>;

export function validateProviderPageRecordCounts(value: unknown, total: number): ProviderPageRecordCounts {
  const counts = providerPageRecordCountsSchema.parse(value);
  if (!Number.isSafeInteger(total) || total < 0 || counts.catalogRecordCount + counts.pullRecordCount
    + counts.marketEventRecordCount + counts.rejectedRecordCount !== total) {
    throw new TypeError("Provider page record counts do not match the normalized total.");
  }
  return counts;
}

/** Counts only; candidate bodies, source keys and provider identities are never inspected. */
export function countProviderPageRecords(records: readonly {
  readonly kind: "catalog" | "pull" | "market_event";
  readonly entityType?: string;
  readonly disposition?: "quarantine";
}[]): ProviderPageRecordCounts {
  const counts: ProviderPageRecordCounts = { catalogRecordCount: 0, collectibleRecordCount: 0,
    packContentSnapshotCount: 0, pullRecordCount: 0, marketEventRecordCount: 0, rejectedRecordCount: 0 };
  for (const record of records) {
    if (record.disposition === "quarantine") counts.rejectedRecordCount += 1;
    else if (record.kind === "catalog") {
      counts.catalogRecordCount += 1;
      if (record.entityType === "collectible") counts.collectibleRecordCount += 1;
      if (record.entityType === "pack_content_snapshot") counts.packContentSnapshotCount += 1;
    } else if (record.kind === "pull") counts.pullRecordCount += 1;
    else if (record.kind === "market_event") counts.marketEventRecordCount += 1;
    else throw new TypeError("Provider page record kind is invalid.");
  }
  return validateProviderPageRecordCounts(counts, records.length);
}
