import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });

export const providerMeasurementUnavailableSchema = z.object({
  state: z.literal("unavailable"),
  reason: z.enum([
    "not_configured", "unsupported", "database_unreachable", "query_failed",
  ]),
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

const storageSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    measuredAt: instant,
    counts: canonicalCountsSchema,
  }).strict(),
  providerMeasurementUnavailableSchema,
]);

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
export const providerSourceMeasurementsSchema = z.object({
  storage: storageSchema,
  records: recordsSchema,
  activity: activitySchema,
}).strict().superRefine((measurements, context) => {
  if (measurements.storage.state === "available" &&
    measurements.records.state === "available" &&
    measurements.storage.measuredAt !== measurements.records.measuredAt) {
    context.addIssue({
      code: "custom",
      path: ["records", "measuredAt"],
      message: "Storage and retained-run totals must share their snapshot time.",
    });
  }
});

export type ProviderSourceMeasurements = z.infer<typeof providerSourceMeasurementsSchema>;
export type ProviderMeasurementUnavailableReason = z.infer<
  typeof providerMeasurementUnavailableSchema
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
