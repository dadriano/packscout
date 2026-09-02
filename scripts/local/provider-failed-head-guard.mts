import type { CanonicalJsonValue, ProviderRuntimeResumeGuard } from "@packscout/database";
import { failedHeadAuditPins, failedHeadDigest, type FailedHeadReview } from "./provider-failed-head-policy.mts";
export function failedHeadResumeGuard(review: FailedHeadReview, checkpoint: CanonicalJsonValue,
  expectedImportLease: { owner: string; fence: bigint }, notAfter?: Date): ProviderRuntimeResumeGuard {
  const p = review.pins;
  const common = { providerId: p.providerId, configVersionId: p.configId, configVersionNumber: BigInt(review.configNumber),
    runtimeRowVersion: BigInt(review.runtimeRowVersion), checkpointHash: review.checkpointHash, checkpoint,
    parentCommandDigest: review.parentCommandDigest, failureCode: review.failureCode, finishedAt: review.finishedAt,
    priorHeadRunId: review.priorHeadRunId, priorHeadRunDigest: review.priorHeadRunDigest, priorHeadProofDigest: review.priorHeadProofDigest,
    provenance: failedHeadAuditPins(review), adoptionResumeId: review.provenance.adoptionResume.id,
    adoptionResumeDigest: review.provenance.adoptionResume.digest, latestRunId: p.initialRunId, latestRunDigest: review.parentDigest,
    expectedImportLease, notAfter };
  if (review.version === 1) return { ...common, entry: "failed_zero_commit_from_head" };
  const old = review.previousReview;
  return { ...common, entry: "failed_zero_commit_chain_from_head", chain: { ...review.chain,
    organizationId: p.organizationId, providerKey: p.providerKey, authorityDigest: review.authorityDigest,
    migrationProofDigest: review.migrationProofDigest, rootOperationId: review.priorOperationId, releasedFence: review.importFence,
    previous: { operationId: old.pins.operationId, runId: old.pins.initialRunId, runDigest: old.parentDigest,
      commandDigest: old.parentCommandDigest, failureCode: old.failureCode, finishedAt: old.finishedAt,
      generation: old.generation, runtimeRowVersion: old.runtimeRowVersion, importFence: old.importFence, reviewDigest: failedHeadDigest(old) } } };
}
