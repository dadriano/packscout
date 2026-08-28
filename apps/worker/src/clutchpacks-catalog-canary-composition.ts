import { randomUUID } from "node:crypto";
import {
  PrismaAdminNotificationPublisher,
  PrismaManifestPromotionRepository,
  PrismaProviderCatalogSettlementRepository,
  PrismaProviderPromotionRepository,
  type PackscoutPrismaClient,
  type SourceRelationshipConfirmationBackfillCoverage,
} from "@packscout/database";
import {
  ManifestEligibilityService,
  OperationalEventService,
  type ManifestEligibilitySnapshot,
} from "@packscout/services";
import { createPromotionV2WorkerRuntime } from
  "./promotion-v2-worker-composition.ts";
import type { PromotionV2WorkerConfiguration } from
  "./promotion-v2-worker-config.ts";
import type {
  PromotionV2ManifestReconciliationCycle,
  PromotionV2ProviderReconciliationCycle,
  PromotionV2WorkerLogger,
} from "./promotion-v2-worker-runtime.ts";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";
import { createSourceRelationshipConfirmationBackfillRunner } from
  "./source-relationship-confirmation-backfill-composition.ts";

const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks";

export function clutchpacksCatalogCanaryProviderIsComplete(input: Readonly<{
  checkpoint: Readonly<{ settledSequence: bigint }> | null;
  completedHead: Readonly<{
    targetCheckpoint: bigint;
    publicProviderReleaseId: string;
  }> | null;
  health: Readonly<{
    requestedEvaluationSequence: bigint;
    confirmedEvaluationSequence: bigint;
    completedCheckpoint: bigint;
    completedPublicProviderReleaseId: string | null;
    activeAttemptId: string | null;
  }>;
}>): boolean {
  return input.checkpoint !== null
    && input.completedHead !== null
    && input.health.confirmedEvaluationSequence >=
      input.health.requestedEvaluationSequence
    && input.completedHead.targetCheckpoint ===
      input.checkpoint.settledSequence
    && input.health.completedCheckpoint === input.checkpoint.settledSequence
    && input.health.completedPublicProviderReleaseId ===
      input.completedHead.publicProviderReleaseId
    && input.health.activeAttemptId === null;
}

export type ClutchpacksCatalogCanaryState = Readonly<{
  snapshot: ManifestEligibilitySnapshot;
  providerComplete: boolean;
  manifestComplete: boolean;
}>;

export interface ClutchpacksCatalogCanaryRuntime {
  runRelationshipConfirmationRepair(
    signal?: AbortSignal,
  ): Promise<SourceRelationshipConfirmationBackfillCoverage>;
  loadState(): Promise<ClutchpacksCatalogCanaryState>;
  runProviderCycle(
    signal?: AbortSignal,
  ): Promise<PromotionV2ProviderReconciliationCycle>;
  runManifestCycle(
    signal?: AbortSignal,
  ): Promise<PromotionV2ManifestReconciliationCycle>;
}

/** Builds only the repair and provider/manifest lanes used by the canary. */
export function createClutchpacksCatalogCanaryRuntime(input: Readonly<{
  provider: Pick<
    ProviderWorkerConfiguration,
    "actorPseudonymKey" | "publicOrganizationId" | "workerId"
  >;
  promotion: PromotionV2WorkerConfiguration;
  database: PackscoutPrismaClient;
  logger: PromotionV2WorkerLogger;
  clock?: Readonly<{ now(): Date }>;
  fetch?: typeof fetch;
}>): ClutchpacksCatalogCanaryRuntime {
  const clock = input.clock ?? { now: () => new Date() };
  const settlement = new PrismaProviderCatalogSettlementRepository(
    input.database,
  );
  const eligibility = new ManifestEligibilityService(settlement, {
    organizationId: input.provider.publicOrganizationId,
  });
  const providerPromotion = new PrismaProviderPromotionRepository(
    input.database,
    {
      organizationId: input.provider.publicOrganizationId,
      deploymentKey: input.promotion.deploymentKey,
      platformKey: CLUTCHPACKS_PLATFORM_KEY,
    },
  );
  const manifestPromotion = new PrismaManifestPromotionRepository(
    input.database,
    {
      organizationId: input.provider.publicOrganizationId,
      deploymentKey: input.promotion.deploymentKey,
    },
  );
  const runtime = createPromotionV2WorkerRuntime({
    configuration: input.promotion,
    organizationId: input.provider.publicOrganizationId,
    workerId: input.provider.workerId,
    database: input.database,
    logger: input.logger,
    operationalEvents: new OperationalEventService(
      new PrismaAdminNotificationPublisher(input.database),
      { id: randomUUID },
      clock,
    ),
    clock,
    fetch: input.fetch,
  });
  const confirmationRepair =
    createSourceRelationshipConfirmationBackfillRunner({
      database: input.database,
      organizationId: input.provider.publicOrganizationId,
      actorPseudonymKey: input.provider.actorPseudonymKey,
      clock,
      // Canary-only exception: bound historical repair to the sole approved
      // ClutchPacks platform. Remove this entrypoint after the preproduction
      // canary; ordinary production startup intentionally remains org-wide.
      platformKeys: [CLUTCHPACKS_PLATFORM_KEY],
    });

  return {
    async runRelationshipConfirmationRepair(signal) {
      await confirmationRepair.runToCompletion({ signal });
      return confirmationRepair.loadCoverage();
    },
    async loadState() {
      const snapshot = await eligibility.getSnapshot();
      const checkpoint = await settlement.loadProviderCatalogCheckpoint({
        organizationId: input.provider.publicOrganizationId,
        platformKey: CLUTCHPACKS_PLATFORM_KEY,
      });
      const [completedHead, providerHealth, manifestHealth] = await Promise.all([
        providerPromotion.loadCompletedHead(),
        providerPromotion.loadHealth({ now: clock.now() }),
        manifestPromotion.loadHealth({ now: clock.now() }),
      ]);
      const providerComplete = clutchpacksCatalogCanaryProviderIsComplete({
        checkpoint,
        completedHead,
        health: providerHealth,
      });
      const manifestComplete = providerComplete
        && checkpoint !== null
        && completedHead !== null
        && manifestHealth.activePublicReleaseId !== null
        && manifestHealth.activeConfigurationEpochSequence ===
          snapshot.sharedConfigurationEpoch.publicChangeSequence
        && manifestHealth.confirmedEvaluationSequence >=
          manifestHealth.requestedEvaluationSequence
        && manifestHealth.activeAttemptId === null
        && providerHealth.activeCheckpoint === checkpoint.settledSequence
        && providerHealth.activePublicProviderReleaseId ===
          completedHead.publicProviderReleaseId
        && providerHealth.activeManifestPublicReleaseId ===
          manifestHealth.activePublicReleaseId;
      return { snapshot, providerComplete, manifestComplete };
    },
    runProviderCycle: (signal) =>
      runtime.runProviderReconciliationCycle(signal),
    runManifestCycle: (signal) =>
      runtime.runManifestReconciliationCycle(signal),
  };
}
