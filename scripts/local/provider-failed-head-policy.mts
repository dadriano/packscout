import { providerFailedHeadOperationIds } from "@packscout/database";
import { z } from "zod";
import { backfillDigest, backfillPinsSchema } from "./provider-backfill-supervisor-policy.mts";
import { PausedHeadError, pausedHeadReviewSchema } from "./provider-paused-head-policy.mts";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(v => BigInt(v) < 9_223_372_036_854_775_807n);
const evidence = z.object({ sequence: integer, digest: hash }).strict();
const commandEvidence = z.object({ id: z.string().uuid(), digest: hash }).strict();
const initialReviewObject = z.object({
  version: z.literal(1), authorization: z.literal("operator_requested_zero_commit_head_continuation"),
  pins: backfillPinsSchema, sourceCommit: pausedHeadReviewSchema.shape.sourceCommit,
  central: pausedHeadReviewSchema.shape.central, provider: pausedHeadReviewSchema.shape.provider,
  migrationProofPath: pausedHeadReviewSchema.shape.migrationProofPath, migrationProofDigest: hash, authorityDigest: hash,
  priorOperationId: z.string().uuid(), priorHeadRunId: z.string().uuid(), priorHeadRunDigest: hash, priorHeadProofDigest: hash,
  provenance: z.object({ adoption: evidence, adoptionCompleted: evidence, operation: evidence, cycle: evidence,
    adoptionResume: commandEvidence }).strict(),
  configNumber: integer, generation: integer, runtimeRowVersion: integer, importFence: integer,
  checkpointHash: hash, parentDigest: hash, parentCommandDigest: hash, failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), finishedAt: z.string().datetime(),
}).strict();
export const failedHeadInitialReviewSchema = initialReviewObject.superRefine((r, context) => {
  if (r.pins.operationId === r.priorOperationId || r.pins.initialRunId === r.priorHeadRunId ||
    r.central.databaseName !== "packscout" || r.provider.databaseName !== `packscout_${r.pins.providerKey}` ||
    new Set([r.provenance.adoption, r.provenance.adoptionCompleted, r.provenance.operation, r.provenance.cycle].map(row => row.sequence)).size !== 4) {
    context.addIssue({ code: "custom", message: "Independent operation, failed parent and exact provenance are required." });
  }
});
export type FailedHeadInitialReview = z.infer<typeof failedHeadInitialReviewSchema>;
const chainEvidenceSchema = z.object({ receipt: evidence, completed: evidence, leaseClaim: evidence,
  resumeGuard: evidence, requested: evidence, resume: commandEvidence }).strict();
export const failedHeadChainReviewSchema = initialReviewObject.extend({ version: z.literal(2),
  authorization: z.literal("operator_requested_two_failure_head_continuation"),
  previousReview: failedHeadInitialReviewSchema, chain: chainEvidenceSchema,
}).strict().superRefine((r, context) => {
  const old = r.previousReview, p = r.pins, priorPins = { ...p, operationId: old.pins.operationId, initialRunId: old.pins.initialRunId };
  if (new Set([p.operationId, old.pins.operationId, r.priorOperationId]).size !== 3 ||
    new Set([p.initialRunId, old.pins.initialRunId, r.priorHeadRunId]).size !== 3 ||
    p.initialRunId !== failedHeadIds(old).run || backfillDigest(priorPins) !== backfillDigest(old.pins) ||
    ["authorityDigest", "migrationProofDigest", "configNumber", "checkpointHash", "priorOperationId", "priorHeadRunId",
      "priorHeadRunDigest", "priorHeadProofDigest", "provenance", "central", "provider"].some(key =>
      backfillDigest(r[key as keyof typeof r]) !== backfillDigest(old[key as keyof typeof old])) ||
    BigInt(r.generation) !== BigInt(old.generation) + 3n || BigInt(r.runtimeRowVersion) !== BigInt(old.runtimeRowVersion) + 3n ||
    BigInt(r.importFence) <= BigInt(old.importFence) || new Date(r.finishedAt) <= new Date(old.finishedAt) ||
    new Set([r.chain.receipt, r.chain.completed, r.chain.leaseClaim, r.chain.resumeGuard, r.chain.requested,
      r.provenance.adoption, r.provenance.adoptionCompleted, r.provenance.operation, r.provenance.cycle].map(row => row.sequence)).size !== 9) {
    context.addIssue({ code: "custom", message: "Exactly one audited continuation of the original zero-commit failure is required." });
  }
});
export const failedHeadReviewSchema = z.union([failedHeadInitialReviewSchema, failedHeadChainReviewSchema]);
export type FailedHeadReview = z.infer<typeof failedHeadReviewSchema>;
export const failedHeadAction = "provider.failed_head.continuation";
export const failedHeadDigest = backfillDigest;
export class FailedHeadError extends PausedHeadError { constructor(code: string) { super(code); this.name = "FailedHeadError"; } }
export function refuseFailedHead(code: string): never { throw new FailedHeadError(code); }
export function failedHeadIds(r: FailedHeadReview) {
  return providerFailedHeadOperationIds(r.pins.operationId);
}
export const failedHeadReceiptSchema = z.object({ version: z.literal(1), review: failedHeadReviewSchema,
  historyDigest: hash, sourceRequestsPerformed: z.literal(false), automaticRetryPolicyChanged: z.literal(false) }).strict();
export type FailedHeadReceipt = z.infer<typeof failedHeadReceiptSchema>;
export function failedHeadAuditPins(r: FailedHeadReview) {
  return [{ ...r.provenance.adoption, action: "provider.paused_head.adoption" },
    { ...r.provenance.adoptionCompleted, action: "provider.paused_head.adoption.completed" },
    { ...r.provenance.operation, action: "local.provider_continuous.operation" },
    { ...r.provenance.cycle, action: "local.provider_continuous.cycle" }];
}
