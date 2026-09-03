import { z } from "zod";
import { canonicalRecordKinds } from "./data-inspection.ts";

/**
 * Read shapes for canonical provider data held in PostgreSQL.
 *
 * These are inspection reads: they describe what the pipeline landed, so an
 * operator can judge a feed without a database client. Nothing here mutates,
 * and nothing here accepts a query, filter, or sort expression from a caller —
 * every filter is one of the enumerated values below.
 */

export const canonicalProviderRowSchema = z.object({
  platformKey: z.string(),
  displayName: z.string(),
  state: z.string(),
});

export type CanonicalProviderRow = z.infer<typeof canonicalProviderRowSchema>;

/**
 * How a count was produced.
 *
 * `exact` is a real count. `at_least` means counting stopped at a bound rather
 * than scanning a table that can hold millions of rows per provider — the value
 * is a floor, not an estimate, and must be presented as one. An operator
 * judging whether a feed is complete is misled by a number that looks exact and
 * is not, so the distinction travels with the number instead of being inferred.
 */
export const countPrecisions = ["exact", "at_least"] as const;
export type CountPrecision = (typeof countPrecisions)[number];

export const canonicalKindSummarySchema = z.object({
  recordKind: z.enum(canonicalRecordKinds),
  count: z.number().int().nonnegative(),
  precision: z.enum(countPrecisions),
  /** Null when the provider holds no record of this kind. */
  oldestCollectedAt: z.string().nullable(),
  newestCollectedAt: z.string().nullable(),
  oldestAcceptedAt: z.string().nullable(),
  newestAcceptedAt: z.string().nullable(),
  /**
   * False when the bucket was too large to aggregate collection times, so the
   * two collected values are unavailable rather than absent. "We did not
   * compute this" and "there is nothing here" are different facts, and a
   * surface that shows them the same way misleads.
   */
  collectedExtremaComplete: z.boolean(),
});

export type CanonicalKindSummary = z.infer<typeof canonicalKindSummarySchema>;

export const canonicalProviderSummarySchema = z.object({
  platformKey: z.string(),
  kinds: z.array(canonicalKindSummarySchema),
});

export type CanonicalProviderSummary = z.infer<
  typeof canonicalProviderSummarySchema
>;

export const canonicalEntityRowSchema = z.object({
  entityId: z.string(),
  platformKey: z.string(),
  recordKind: z.enum(canonicalRecordKinds),
  externalId: z.string(),
  revisionNumber: z.number().int().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  sourceCollectedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});

export type CanonicalEntityRow = z.infer<typeof canonicalEntityRowSchema>;

export const canonicalSortDirections = ["asc", "desc"] as const;
export type CanonicalSortDirection = (typeof canonicalSortDirections)[number];

export const canonicalEntityPageSchema = z.object({
  items: z.array(canonicalEntityRowSchema),
  /** One-based, echoed so the index highlights the page actually returned. */
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
  /**
   * True when the requested page sat beyond the depth the server will scan.
   * The response then holds the deepest reachable page rather than an empty
   * result that would read as "no records".
   */
  depthCapped: z.boolean(),
  /** Echoed so the grid marks the sorted column without tracking it itself. */
  direction: z.enum(canonicalSortDirections),
});

export type CanonicalEntityPage = z.infer<typeof canonicalEntityPageSchema>;

export const canonicalRelationshipEdgeSchema = z.object({
  relationshipKind: z.string(),
  targetPlatformKey: z.string(),
  targetRecordKind: z.enum(canonicalRecordKinds),
  targetExternalId: z.string().nullable(),
  resolved: z.boolean(),
});

export type CanonicalRelationshipEdge = z.infer<
  typeof canonicalRelationshipEdgeSchema
>;

/**
 * Where a revision came from, summarized. The originating source record, import
 * run, and mapper identity are enough to trace a record back to the page that
 * produced it. Provider payload envelopes, request headers, and anything
 * credential-shaped are removed before this leaves the server.
 */
export const canonicalProvenanceSummarySchema = z.object({
  sourceRecordId: z.string().nullable(),
  importRunId: z.string().nullable(),
  mapperKey: z.string().nullable(),
  mapperVersion: z.string().nullable(),
  adapterKey: z.string().nullable(),
  /** Provenance fields that survived redaction, already sanitized. */
  additional: z.record(z.string(), z.unknown()),
});

export type CanonicalProvenanceSummary = z.infer<
  typeof canonicalProvenanceSummarySchema
>;

export const canonicalEntityDetailSchema = canonicalEntityRowSchema.extend({
  content: z.unknown(),
  contentHash: z.string().nullable(),
  provenanceHash: z.string().nullable(),
  provenance: canonicalProvenanceSummarySchema.nullable(),
  relationships: z.array(canonicalRelationshipEdgeSchema),
});

export type CanonicalEntityDetail = z.infer<typeof canonicalEntityDetailSchema>;

/** Stable failure codes. No driver message or query text is ever surfaced. */
export const canonicalInspectionErrorCodes = [
  "CANONICAL_PROVIDER_UNKNOWN",
  "CANONICAL_ENTITY_UNKNOWN",
  "CANONICAL_RECORD_KIND_INVALID",
  "CANONICAL_PAGE_INVALID",
  "CANONICAL_SEARCH_INVALID",
  "CANONICAL_PAGE_SIZE_INVALID",
  "CANONICAL_STORE_UNAVAILABLE",
] as const;

export type CanonicalInspectionErrorCode =
  (typeof canonicalInspectionErrorCodes)[number];

/** Bounds enforced server-side regardless of what a caller asks for. */
export const CANONICAL_PAGE_SIZE_DEFAULT = 25;
export const CANONICAL_PAGE_SIZE_MAX = 100;
export const CANONICAL_EXTERNAL_ID_MAX_LENGTH = 512;
/**
 * Counting stops here. Chosen so the bounded scan stays well inside a request
 * budget on a provider holding millions of records, while still reporting an
 * exact count for the many (provider, kind) buckets that are smaller than this.
 */
export const CANONICAL_COUNT_BOUND = 50_000;
/**
 * Deepest offset the listing will scan. An offset walks the index to reach its
 * position, so an unbounded one lets a caller ask for work proportional to the
 * whole table. Measured on a real provider bucket, reaching offset 16,000 costs
 * well under a tenth of a second; this bound keeps the worst case in that
 * neighbourhood and asks the operator to filter instead of scrolling further.
 */
export const CANONICAL_MAX_OFFSET = 100_000;
