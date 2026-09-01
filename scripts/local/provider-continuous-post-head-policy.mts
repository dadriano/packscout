import { z } from "zod";
import { refuseBackfill } from "./provider-backfill-supervisor-policy.mts";

export const continuousPostHeadMaximumMilliseconds = 900_000;
export const continuousPostHeadPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("callback"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    timeoutMilliseconds: z.number().int().min(1).max(continuousPostHeadMaximumMilliseconds) }).strict(),
]);
export type ContinuousPostHeadPolicy = z.infer<typeof continuousPostHeadPolicySchema>;
export const defaultContinuousPostHeadPolicy: ContinuousPostHeadPolicy = Object.freeze({ kind: "none" });

/** Receipt callers must provide the field; only public admission APIs default it. */
export function validatedContinuousPostHeadPolicy(policy: ContinuousPostHeadPolicy): ContinuousPostHeadPolicy {
  const parsed = continuousPostHeadPolicySchema.safeParse(policy);
  if (!parsed.success) refuseBackfill("CONTINUOUS_POST_HEAD_POLICY_INVALID");
  return Object.freeze(parsed.data);
}
