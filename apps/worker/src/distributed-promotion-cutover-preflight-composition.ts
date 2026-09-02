import { canonicalJson, type GlobalCatalogManifestV1 } from
  "@packscout/contracts";
import {
  PrismaManifestActivationRepository,
  PrismaPromotionJobLivenessRepository,
  PrismaProviderCompletionPublishPlanRepository,
  type CentralPrismaClient,
  type ManifestActivationMirror,
} from "@packscout/database";
import type {
  DistributedPromotionCutoverPreflightEvidenceSource,
  DistributedPromotionManifestPlanCacheCoverage,
} from "./distributed-promotion-cutover-preflight.ts";

type ActivationStore = Pick<PrismaManifestActivationRepository, "loadMirror">;
type PlanStore = Pick<
  PrismaProviderCompletionPublishPlanRepository,
  "loadForManifestReferences"
>;

function references(manifest: GlobalCatalogManifestV1) {
  return manifest.providerReferences.map((reference) => ({
    providerKey: reference.platformKey,
    publicProviderReleaseId: reference.publicProviderReleaseId,
    providerReleaseFingerprint: reference.providerReleaseFingerprint,
  }));
}

function mirrorIdentity(mirror: ManifestActivationMirror): string {
  return canonicalJson({
    generation: mirror.generation.toString(),
    rowVersion: mirror.rowVersion.toString(),
    lastReceiptId: mirror.lastReceiptId,
    updatedAt: mirror.updatedAt.toISOString(),
    activeState: mirror.activeState,
    activeManifestFingerprint:
      mirror.activeManifest?.manifestFingerprint ?? null,
    previousManifestFingerprint:
      mirror.previousManifest?.manifestFingerprint ?? null,
  });
}

/**
 * Reads cache coverage between two exact mirror reads. A manifest change during
 * the read is reported as unstable and therefore cannot pass preflight.
 */
export async function readDistributedPromotionManifestPlanCacheCoverage(
  dependencies: Readonly<{
    activations: ActivationStore;
    plans: PlanStore;
  }>,
): Promise<DistributedPromotionManifestPlanCacheCoverage> {
  const before = await dependencies.activations.loadMirror();
  const activeReferences = before.activeManifest === null
    ? []
    : references(before.activeManifest);
  const previousReferences = before.previousManifest === null
    ? []
    : references(before.previousManifest);
  const [activePlans, previousPlans] = await Promise.all([
    activeReferences.length === 0
      ? Promise.resolve(null)
      : dependencies.plans.loadForManifestReferences(activeReferences),
    previousReferences.length === 0
      ? Promise.resolve([])
      : dependencies.plans.loadForManifestReferences(previousReferences),
  ]);
  const after = await dependencies.activations.loadMirror();
  return Object.freeze({
    mirrorStable: mirrorIdentity(before) === mirrorIdentity(after),
    mirrorGeneration: before.generation,
    activeManifestFingerprint:
      before.activeManifest?.manifestFingerprint ?? null,
    previousManifestFingerprint:
      before.previousManifest?.manifestFingerprint ?? null,
    activeReferenceCount: activeReferences.length,
    cachedActiveReferenceCount: activePlans?.length ?? 0,
    previousReferenceCount: previousReferences.length,
    cachedPreviousReferenceCount: previousPlans?.length ?? 0,
  });
}

export function createDistributedPromotionCutoverPreflightEvidenceSource(
  central: CentralPrismaClient,
): DistributedPromotionCutoverPreflightEvidenceSource {
  const liveness = new PrismaPromotionJobLivenessRepository(central);
  const activations = new PrismaManifestActivationRepository(central);
  const plans = new PrismaProviderCompletionPublishPlanRepository(central);
  return Object.freeze({
    readWatchdogEvidence: () => liveness.readWatchdogEvidence(),
    readEvaluatorState: () => liveness.readEvaluatorState(),
    readManifestPlanCacheCoverage: () =>
      readDistributedPromotionManifestPlanCacheCoverage({
        activations,
        plans,
      }),
  });
}
