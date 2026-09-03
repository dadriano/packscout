import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });

/**
 * Reasons that can leave every measurement unavailable at once, so they are
 * the only ones a whole-provider unavailable result may be built from.
 */
const sharedUnavailableReasons = [
  "not_configured", "unsupported", "database_unreachable", "query_failed",
] as const;

export const providerMeasurementUnavailableSchema = z.object({
  state: z.literal("unavailable"),
  reason: z.enum(sharedUnavailableReasons),
}).strict();

/**
 * Storage alone can also be left uncounted because counting every canonical
 * row would cost more than its measurement budget. That reason describes one
 * measurement and obliges an estimate, so it is not a shared reason and
 * cannot be used to make every measurement unavailable.
 */
const storageUnavailableSchema = z.object({
  state: z.literal("unavailable"),
  reason: z.enum([...sharedUnavailableReasons, "count_exceeds_budget"]),
}).strict();

const canonicalCountsSchema = z.object({
  total: count,
  categories: count,
  packs: count,
  collectibles: count,
  aliases: count,
  instances: count,
  packContents: count,
  accounts: count,
  pulls: count,
  pullItems: count,
  marketEvents: count,
}).strict().refine(({ total, ...kinds }) =>
  Object.values(kinds).reduce((sum, value) => sum + value, 0) === total,
{ message: "Stored rows must equal the sum of the canonical table counts." });

/**
 * An available storage measurement is always an exact count of canonical rows.
 * That meaning is fixed, so a client reading this field without knowing about
 * estimates can never mistake one for a count.
 */
const storageSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    measuredAt: instant,
    counts: canonicalCountsSchema,
  }).strict(),
  storageUnavailableSchema,
]);

export const canonicalEntityKeys = [
  "categories", "packs", "collectibles", "aliases", "instances",
  "packContents", "accounts", "pulls", "pullItems", "marketEvents",
] as const;

/**
 * Carried beside the exact count rather than inside it so it can never be read
 * as one. The key is absent unless an estimate was actually taken, never null:
 * readers enumerate the measurements they know about, and a null would be
 * enumerated as one of them.
 *
 * Counting is decided per table, because table sizes differ by orders of
 * magnitude within one provider. `counts` therefore mixes counted and
 * estimated entities, and `estimatedEntities` names exactly which of them are
 * estimates so each can be presented for what it is. It is never empty: with
 * nothing estimated the exact measurement above is reported instead.
 */
const storageEstimateSchema = z.object({
  measuredAt: instant,
  counts: canonicalCountsSchema,
  estimatedEntities: z.array(z.enum(canonicalEntityKeys)).min(1)
    .refine((keys) => new Set(keys).size === keys.length,
      { message: "Estimated entities must not repeat." }),
}).strict().optional();

const recordsSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    measuredAt: instant,
    processed: count,
    accepted: count,
  }).strict().refine(({ accepted, processed }) => accepted <= processed,
    { message: "Accepted records cannot exceed processed records." }),
  providerMeasurementUnavailableSchema,
]);

const leaseSchema = z.object({
  state: z.enum(["active", "expired", "unowned"]),
  heartbeatAt: instant.nullable(),
  expiresAt: instant.nullable(),
}).strict();

const activitySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    measuredAt: instant,
    historyMeasuredAt: instant,
    lastCommittedPageAt: instant.nullable(),
    importLease: leaseSchema,
    promotionLease: leaseSchema,
    quarantine: z.object({
      open: count,
      resolved: count,
      expired: count,
      retained: count,
    }).strict().refine(({ open, resolved, expired, retained }) =>
      open + resolved + expired === retained,
    { message: "Retained quarantines must include every stored state." }),
  }).strict(),
  providerMeasurementUnavailableSchema,
]);

/** Exact snapshots are distinct from missing evidence and from live run counters. */
// Storage counts and retained-run totals are read by separate statements so
// that the cost of counting stored rows cannot withhold the retained-run
// totals. They therefore observe separate snapshots and carry separate
// measurement times, which callers must display rather than conflate.
export const providerSourceMeasurementsSchema = z.object({
  storage: storageSchema,
  storageEstimate: storageEstimateSchema,
  records: recordsSchema,
  activity: activitySchema,
}).strict().superRefine((measurements, context) => {
  // Exactly one storage answer is reported, so no reader has to choose.
  if (measurements.storage.state === "available" && measurements.storageEstimate !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["storageEstimate"],
      message: "An exact storage count must not be accompanied by an estimate.",
    });
  }
  if (measurements.storage.state === "unavailable"
    && measurements.storage.reason === "count_exceeds_budget"
    && measurements.storageEstimate === undefined) {
    context.addIssue({
      code: "custom",
      path: ["storageEstimate"],
      message: "Rows left uncounted for budget must report an estimate.",
    });
  }
});

export type ProviderSourceMeasurements = z.infer<typeof providerSourceMeasurementsSchema>;
export type ProviderStorageEstimate = z.infer<typeof storageEstimateSchema>;
export type ProviderCanonicalEntityKey = (typeof canonicalEntityKeys)[number];
export type ProviderMeasurementUnavailableReason = z.infer<
  typeof providerMeasurementUnavailableSchema
>["reason"];
/** Includes the storage-only reason, which obliges a reported estimate. */
export type ProviderStorageUnavailableReason = z.infer<
  typeof storageUnavailableSchema
>["reason"];

export function unavailableProviderSourceMeasurements(
  reason: ProviderMeasurementUnavailableReason,
): ProviderSourceMeasurements {
  return {
    storage: { state: "unavailable", reason },
    records: { state: "unavailable", reason },
    activity: { state: "unavailable", reason },
  };
}
