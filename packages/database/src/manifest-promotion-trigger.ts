import { canonicalJson } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { manifestCheckpointProjectionDigest } from
  "./manifest-promotion-repository-validation.ts";
import {
  loadManifestEligibilitySnapshotInTransaction,
  loadProviderCausalReadinessInTransaction,
} from "./public-change-settlement-repository.provider-read.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";

export type ManifestPromotionEvaluationTrigger = Readonly<{
  cause: "lifecycle_settled" | "configuration_settled" |
    "observation_succeeded";
  causeIdentity: string;
}>;

export async function loadManifestPromotionEvaluationTrigger(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<ManifestPromotionEvaluationTrigger | null> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    const eligibility = await loadManifestEligibilitySnapshotInTransaction(
      transaction, { organizationId },
    );
    if (!eligibility) return null;
    const readiness = await loadProviderCausalReadinessInTransaction(
      transaction,
      {
        organizationId,
        checkpoints: eligibility.checkpoints,
        lifecycleDecisionSequence: eligibility.lifecycleDecisionSequence,
      },
    );
    const body = canonicalJson({
      sharedConfigurationEpoch: {
        ...eligibility.sharedConfigurationEpoch,
        publicChangeSequence: String(
          eligibility.sharedConfigurationEpoch.publicChangeSequence,
        ),
      },
      confidencePolicyVersion: eligibility.confidencePolicyVersion,
      staleAfterSeconds: eligibility.staleAfterSeconds,
      configuredPlatformKeys: eligibility.configuredPlatformKeys,
      enabledPlatformKeys: eligibility.enabledPlatformKeys,
      lifecycleDecisionSequence: String(eligibility.lifecycleDecisionSequence),
      providers: eligibility.checkpoints.map((checkpoint, index) => ({
        platformKey: checkpoint.platformKey,
        checkpointDigest: manifestCheckpointProjectionDigest(checkpoint),
        completedBackfillAt:
          readiness[index]?.completedBackfillAt?.toISOString() ?? null,
        lastSuccessfulObservationAt:
          readiness[index]?.lastSuccessfulObservationAt?.toISOString() ?? null,
      })),
    });
    return {
      cause: "observation_succeeded",
      causeIdentity: promotionV2Sha256(body),
    };
  }, {
    ...PACKSCOUT_TRANSACTION_OPTIONS,
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}
