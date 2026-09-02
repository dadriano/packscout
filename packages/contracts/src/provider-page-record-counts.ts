import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const PROVIDER_CATALOG_IDENTITY_CENSUS_VERSION =
  "provider_catalog_identity_census_v1" as const;

export const providerCatalogIdentityCensusSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CATALOG_IDENTITY_CENSUS_VERSION),
  pageResponseDigest: sha256Schema,
  rawCardObservationCount: z.number().int().nonnegative().safe(),
  rawPackObservationCount: z.number().int().nonnegative().safe(),
  distinctCardIdentityCount: z.number().int().nonnegative().safe(),
  distinctPackIdentityCount: z.number().int().nonnegative().safe(),
  identityChainDigest: sha256Schema,
  pageIdentityMultisetDigest: sha256Schema,
  identityMultisetDigest: sha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.distinctCardIdentityCount > value.rawCardObservationCount) {
    context.addIssue({ code: "custom", path: ["distinctCardIdentityCount"],
      message: "Distinct card identities exceed raw card observations." });
  }
  if (value.distinctPackIdentityCount > value.rawPackObservationCount) {
    context.addIssue({ code: "custom", path: ["distinctPackIdentityCount"],
      message: "Distinct pack identities exceed raw pack observations." });
  }
});
export type ProviderCatalogIdentityCensus = z.infer<
  typeof providerCatalogIdentityCensusSchema
>;

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
