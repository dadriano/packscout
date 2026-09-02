import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./data-release-v2-canonical.ts";

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

function catalogIdentityDigest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`packscout.provider-catalog-${domain}.v1\u0000`)
    .update(canonicalJson(value))
    .digest("hex");
}

/** Hashes the exact normalized source scope and provider identity; raw IDs never leave the worker. */
export function providerCatalogSourceIdentityDigest(input: Readonly<{
  recordIdScopeKey: "catalog-card-v1" | "catalog-pack-v1";
  providerRecordId: string;
}>): string {
  const providerRecordId = input.providerRecordId.trim();
  if (providerRecordId.length < 1 || providerRecordId.length > 4_096) {
    throw new TypeError("Catalog source identity is invalid.");
  }
  return catalogIdentityDigest("source-identity", [
    input.recordIdScopeKey,
    providerRecordId,
  ]);
}

/** Order-independent digest of one bounded identity multiset, including duplicates. */
export function providerCatalogIdentityMultisetDigest(
  identityDigests: readonly string[],
): string {
  const parsed = identityDigests.map((value) => sha256Schema.parse(value)).sort();
  return catalogIdentityDigest("identity-multiset", parsed);
}

/** Final cumulative multiset digest. Sorting happens once at head and retains only unique keys. */
export function providerCatalogIdentityCountMapDigest(
  identityCounts: ReadonlyMap<string, number>,
): string {
  const keys = [...identityCounts.keys()].map((value) => sha256Schema.parse(value)).sort();
  const digest = createHash("sha256")
    .update("packscout.provider-catalog-identity-count-map.v1\u0000")
    .update(`${keys.length}\n`);
  for (const key of keys) {
    const count = identityCounts.get(key);
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
      throw new TypeError("Catalog identity occurrence count is invalid.");
    }
    digest.update(canonicalJson([key, count])).update("\n");
  }
  return digest.digest("hex");
}

/** Ordered chain binding each translated response to its page identity multiset. */
export function providerCatalogIdentityChainDigest(input: Readonly<{
  previousChainDigest: string | null;
  pageNumber: number;
  pageResponseDigest: string;
  pageIdentityMultisetDigest: string;
}>): string {
  if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new TypeError("Catalog census page number is invalid.");
  }
  return catalogIdentityDigest("identity-page-chain", {
    previousChainDigest: input.previousChainDigest === null
      ? null
      : sha256Schema.parse(input.previousChainDigest),
    pageNumber: input.pageNumber,
    pageResponseDigest: sha256Schema.parse(input.pageResponseDigest),
    pageIdentityMultisetDigest: sha256Schema.parse(input.pageIdentityMultisetDigest),
  });
}

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
