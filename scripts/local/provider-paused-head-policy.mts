import { z } from "zod";
import { backfillDigest, backfillId, backfillPinsSchema } from "./provider-backfill-supervisor-policy.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const decimal = z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(v => BigInt(v) <= 9_223_372_036_854_775_807n);
const hostname = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
const destination = z.object({ host: hostname, port: z.literal(5432), databaseName: z.string().min(1).max(63),
  sslMode: z.literal("verify-full") }).strict();
export const pausedHeadReviewSchema = z.object({
  version: z.literal(1), authorization: z.literal("operator_requested_paused_head_resume"),
  pins: backfillPinsSchema, previousOperationId: z.string().uuid(), previousOperationReceiptDigest: hash,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u), migrationProofPath: z.string().startsWith("/"), migrationProofDigest: hash,
  central: destination, provider: destination, authorityDigest: hash, configNumber: decimal,
  pauseCommandId: z.string().uuid(), pauseCommandDigest: hash, generation: decimal, runtimeRowVersion: decimal,
  importFence: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(v => BigInt(v) <= 9_223_372_036_854_775_807n),
  checkpointHash: hash, parentDigest: hash, headProofDigest: hash,
}).strict().superRefine((v, context) => {
  if (v.previousOperationId === v.pins.operationId || v.pins.operationId === v.pauseCommandId ||
    BigInt(v.generation) >= 9_223_372_036_854_775_807n || BigInt(v.runtimeRowVersion) >= 9_223_372_036_854_775_807n ||
    BigInt(v.importFence) >= 9_223_372_036_854_775_807n || v.provider.databaseName !== `packscout_${v.pins.providerKey}` || v.central.databaseName !== "packscout") {
    context.addIssue({ code: "custom", message: "New operation and exact database identities are required." });
  }
});
export type PausedHeadReview = z.infer<typeof pausedHeadReviewSchema>;
export const pausedHeadAction = "provider.paused_head.adoption";
export const pausedHeadDigest = backfillDigest;
export class PausedHeadError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PausedHeadError"; }
}
export function refusePausedHead(code: string): never { throw new PausedHeadError(code); }
export function pausedHeadIds(review: PausedHeadReview) {
  const operation = review.pins.operationId;
  return { resume: backfillId(operation, "paused-head/resume"), resumeKey: `paused-head/${operation}/resume`,
    owner: `local:paused-head:${operation}` };
}
export const pausedHeadReceiptSchema = z.object({ version: z.literal(1), review: pausedHeadReviewSchema,
  historyDigest: hash, sourceRequestsPerformed: z.literal(false), queuesCreated: z.literal(false) }).strict();
export type PausedHeadReceipt = z.infer<typeof pausedHeadReceiptSchema>;
