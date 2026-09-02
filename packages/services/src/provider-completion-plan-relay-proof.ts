import {
  globalCatalogProviderActiveObservationV1Schema,
  providerReleaseCompletedHeadV1Schema,
} from "@packscout/contracts";
import {
  verifyProviderCompletedPublishPlanRelayProof,
  type ProviderCompletedPublishPlanSource,
  type ProviderCompletedPublishPlanRelayProof,
} from "@packscout/database";
import { adaptDistributedProviderReleaseToCatalogV1 } from
  "./distributed-provider-release-v1-adapter.ts";

/**
 * Reconstructs the full immutable publish plan inside one already-authorized
 * provider database boundary, then binds it to that completion's exact
 * terminal receipt. Nothing here addresses central storage or credentials.
 */
export async function buildProviderCompletedPublishPlanRelayProof(
  source: ProviderCompletedPublishPlanSource,
): Promise<ProviderCompletedPublishPlanRelayProof> {
  const descriptorSequence = BigInt(
    source.publicationSource.descriptor.throughChangeSequence,
  );
  const plan = await adaptDistributedProviderReleaseToCatalogV1({
    descriptor: source.publicationSource.descriptor,
    batches: source.publicationSource.batches,
    selectedThroughChangeSequence: descriptorSequence,
    classification: "publish",
  });
  if (plan.classification !== "publish") {
    throw new Error("Provider completion plan reconstruction failed safely.");
  }
  const completedHead = providerReleaseCompletedHeadV1Schema.parse({
    platformKey: source.providerKey,
    release: source.receipt.details.release,
    providerCheckpoint: source.receipt.providerCheckpoint,
    observation: source.receipt.details.observation,
    terminalReceiptSha256: source.terminalReceiptSha256,
  });
  const activeObservation =
    globalCatalogProviderActiveObservationV1Schema.parse({
      platformKey: source.providerKey,
      publicProviderReleaseId: source.publicProviderReleaseId,
      terminalOperationKind: source.terminalOperationKind,
      terminalOperationId: source.terminalOperationId,
      terminalReceiptSha256: source.terminalReceiptSha256,
      selectedProviderCheckpoint: source.receipt.providerCheckpoint,
      selectedDataAsOf: source.receipt.details.release.dataAsOf,
      latestAffectedSettledSequence:
        source.completedThroughChangeSequence.toString(),
      latestAffectedSourceHeadSequence:
        source.receipt.details.observation.sourceHeadSequence,
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: source.receipt.details.observation.freshness,
      lastSuccessfulObservationAt:
        source.receipt.details.observation.lastSuccessfulObservationAt,
      staleAt: source.receipt.details.observation.staleAt,
    });
  const proof: ProviderCompletedPublishPlanRelayProof = {
    providerId: source.providerId,
    providerKey: source.providerKey,
    providerReleaseId: source.providerReleaseId,
    publicProviderReleaseId: source.publicProviderReleaseId,
    providerReleaseFingerprint: source.providerReleaseFingerprint,
    catalogVersionId: source.catalogVersionId,
    catalogContentHash: source.catalogContentHash,
    providerReleaseContentHash: source.providerReleaseContentHash,
    completedThroughChangeSequence:
      source.completedThroughChangeSequence,
    artifactAttemptId: source.artifactAttemptId,
    terminalOperationKind: source.terminalOperationKind,
    terminalOperationId: source.terminalOperationId,
    terminalReceiptSha256: source.terminalReceiptSha256,
    plan,
    completedHead,
    activeObservation,
  };
  await verifyProviderCompletedPublishPlanRelayProof(proof);
  return proof;
}
