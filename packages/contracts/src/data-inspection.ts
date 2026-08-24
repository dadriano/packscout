import { z } from "zod";

/**
 * Shared vocabulary for the admin's read-only data-inspection surfaces.
 *
 * PostgreSQL is authoritative for every canonical record. The product backend
 * receives only the subset that the public catalog serves, so a comparison
 * between the two stores is meaningful for some canonical kinds and meaningless
 * for the rest. That boundary is declared here, once, because the parity
 * verdict, the published browser, and the comparison surface all depend on
 * agreeing about it. Reporting a pipeline-only kind as missing downstream would
 * be false, not a finding.
 */

/** Every canonical record kind PostgreSQL stores. Mirrors the database enum. */
export const canonicalRecordKinds = [
  "platform",
  "pack",
  "catalog_asset",
  "ev_input",
  "pull",
  "sale",
  "estimated_ev",
] as const;

export type CanonicalRecordKind = (typeof canonicalRecordKinds)[number];

/** Entity kinds the product backend stores inside a provider catalog release. */
export const publishedEntityKinds = [
  "vendors",
  "categories",
  "repacks",
  "collectibles",
  "repack_chases",
] as const;

export type PublishedEntityKind = (typeof publishedEntityKinds)[number];

/**
 * Canonical kinds that reach the product backend, with the published entity
 * kind each one becomes. A canonical kind absent from this map is pipeline-only
 * and has no published counterpart to compare against.
 */
export const canonicalKindPublishedCounterpart: Readonly<
  Partial<Record<CanonicalRecordKind, PublishedEntityKind>>
> = Object.freeze({
  platform: "vendors",
  pack: "repacks",
  catalog_asset: "collectibles",
});

/**
 * Canonical kinds with no published counterpart, and why. These are reported as
 * out of comparison scope wherever a parity result is shown.
 */
export const outOfComparisonScopeKinds: Readonly<
  Partial<Record<CanonicalRecordKind, string>>
> = Object.freeze({
  ev_input:
    "Estimated-EV inputs are proprietary calculation evidence and are never published.",
  pull: "Pull histories stay in the pipeline; the product serves aggregates, not raw pulls.",
  sale: "Market-event histories stay in the pipeline; the product serves aggregates, not raw sales.",
  estimated_ev:
    "Estimated EV is published as a field on a repack, not as its own published record.",
});

/** True when a canonical kind can be compared against the product backend. */
export function isComparableCanonicalKind(
  kind: CanonicalRecordKind,
): boolean {
  return kind in canonicalKindPublishedCounterpart;
}

/**
 * The published entity kind a canonical kind becomes, or null when the kind is
 * pipeline-only. Callers must treat null as "out of scope", never as "missing".
 */
export function publishedCounterpartFor(
  kind: CanonicalRecordKind,
): PublishedEntityKind | null {
  return canonicalKindPublishedCounterpart[kind] ?? null;
}

export const comparisonScopeEntrySchema = z.object({
  canonicalKind: z.enum(canonicalRecordKinds),
  publishedKind: z.enum(publishedEntityKinds).nullable(),
  comparable: z.boolean(),
  /** Present only when the kind is out of scope. */
  reason: z.string().nullable(),
});

export type ComparisonScopeEntry = z.infer<typeof comparisonScopeEntrySchema>;

export const comparisonScopeSchema = z.object({
  entries: z.array(comparisonScopeEntrySchema),
});

export type ComparisonScope = z.infer<typeof comparisonScopeSchema>;

/** The comparison scope as a whole, ordered by the canonical kind vocabulary. */
export function comparisonScope(): ComparisonScope {
  return {
    entries: canonicalRecordKinds.map((canonicalKind) => {
      const publishedKind = publishedCounterpartFor(canonicalKind);
      return {
        canonicalKind,
        publishedKind,
        comparable: publishedKind !== null,
        reason: outOfComparisonScopeKinds[canonicalKind] ?? null,
      };
    }),
  };
}
