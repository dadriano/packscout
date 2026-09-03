import { z } from "zod";
import { refuseBackfill } from "./provider-backfill-supervisor-policy.mts";

export const continuousSourceMinimumSeconds = 60;
export const continuousCadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("central") }).strict(),
  z.object({ kind: z.literal("operator_interval"), intervalSeconds: z.number().int().min(60).max(86_400) }).strict(),
]);
export type ContinuousCadence = z.infer<typeof continuousCadenceSchema>;
export const defaultContinuousCadence: ContinuousCadence = Object.freeze({ kind: "central" });

export function validatedContinuousCadence(cadence: ContinuousCadence = defaultContinuousCadence): ContinuousCadence {
  const parsed = continuousCadenceSchema.safeParse(cadence);
  if (!parsed.success) refuseBackfill("CONTINUOUS_CADENCE_INVALID");
  return Object.freeze(parsed.data);
}
/** Operator cadence changes only this resident operation, never source identity. */
export function effectiveContinuousIntervalSeconds(scheduleSeconds: number,
  cadence: ContinuousCadence = defaultContinuousCadence): number {
  if (!Number.isSafeInteger(scheduleSeconds) || scheduleSeconds < 1 || scheduleSeconds > 86_400) {
    refuseBackfill("CONTINUOUS_CADENCE_INVALID");
  }
  const policy = validatedContinuousCadence(cadence);
  return Math.max(continuousSourceMinimumSeconds, policy.kind === "central" ? scheduleSeconds : policy.intervalSeconds);
}
