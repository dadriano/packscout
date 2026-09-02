import {
  activeCatalogManifestStateV1Schema,
  approvedPublicCatalogConfigurationV1Schema,
  canonicalJson,
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
  recomputeProviderCatalogReleaseGoverningHashV1,
  sha256CanonicalJson,
  verifyGlobalCatalogManifestV1,
  type ActiveCatalogManifestStateV1,
  type ApprovedPublicCatalogConfigurationV1,
  type GlobalCatalogManifestV1,
} from "@packscout/contracts";
import {
  PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
  PrismaManifestActivationRepository,
  PrismaManifestGateIntentRepository,
  PrismaProviderCompletionPublishPlanRepository,
  ProviderCompletionPublishPlanCapacityError,
  PromotionJobPersistenceError,
  providerCompletionPlanHydrationByteCount,
  type CachedProviderCompletionPublishPlan,
  type CentralPrismaClient,
  type ManifestActivationMirror,
  type ManifestGateClaim,
} from "@packscout/database";
import {
  CatalogManifestCompositionError,
  composeGlobalCatalogManifest,
  type IndependentProviderManifestGateOperation,
  type VerifiedManifestGateProofSource,
  type VerifiedManifestGateTargetResolution,
  type VerifiedManifestStateResolution,
} from "@packscout/services";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type ClaimStore = Pick<
  PrismaManifestGateIntentRepository,
  "verifyActiveClaim"
>;

type PlanStore = Pick<
  PrismaProviderCompletionPublishPlanRepository,
  "loadByEvidence" | "loadExplicitTarget" | "loadForManifestReferences"
>;

type ActivationStore = Pick<PrismaManifestActivationRepository, "loadMirror">;

export interface CentralApprovedManifestConfigurationRecord {
  readonly organizationId: string;
  readonly catalogVersionId: string;
  readonly configuration: ApprovedPublicCatalogConfigurationV1;
  readonly configurationHash: string;
  readonly publicChangeSequence: bigint;
}

/**
 * Future central bootstrap seam. Normal reconciliation deliberately carries
 * the already-signed active manifest's exact policy version forward. A truly
 * empty deployment may use this seam only after central persists a catalog-
 * bound approved configuration; the default production source fails closed.
 */
export interface CentralApprovedManifestConfigurationSource {
  loadForInitialManifest(input: Readonly<{
    organizationId: string;
    providerId: string;
    providerKey: string;
    catalogVersionId: string;
    deadlineAt?: number;
    signal?: AbortSignal;
  }>): Promise<CentralApprovedManifestConfigurationRecord | null>;
}

export class UnavailableCentralApprovedManifestConfigurationSource
implements CentralApprovedManifestConfigurationSource {
  async loadForInitialManifest(): Promise<null> {
    return null;
  }
}

function resolution(
  state: "no_change" | "deferred" | "blocked",
  failureCode: string | null,
): VerifiedManifestGateTargetResolution {
  return { state, failureCode };
}

function manifestIdentity(manifest: GlobalCatalogManifestV1) {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  };
}

function currentStateMatchesManifest(
  manifest: GlobalCatalogManifestV1 | null,
  state: ActiveCatalogManifestStateV1,
): boolean {
  if (manifest === null) {
    return state.generation === 0 && state.activeManifest === null &&
      state.previousManifest === null && state.observation === null &&
      state.terminalReceiptSha256 === null;
  }
  if (
    state.activeManifest === null || state.observation === null ||
    canonicalJson(manifestIdentity(manifest)) !== canonicalJson({
      publicReleaseId: state.activeManifest.publicReleaseId,
      manifestFingerprint: state.activeManifest.manifestFingerprint,
      sharedConfigurationEpoch: state.activeManifest.sharedConfigurationEpoch,
      providerReferenceSetHash: state.activeManifest.providerReferenceSetHash,
    }) ||
    state.observation.publicReleaseId !== manifest.publicReleaseId ||
    state.observation.providerReferenceSetHash !==
      manifest.providerReferenceSetHash ||
    state.observation.providerSelections.length !==
      manifest.providerReferences.length
  ) return false;
  return manifest.providerReferences.every((reference, index) => {
    const selected = state.observation?.providerSelections[index];
    return selected?.platformKey === reference.platformKey &&
      selected.publicProviderReleaseId === reference.publicProviderReleaseId;
  });
}

function semanticOperation(
  claim: ManifestGateClaim,
): IndependentProviderManifestGateOperation {
  if (claim.requestedOperation !== null) return claim.requestedOperation;
  return "advance";
}

function exactSelectedRelease(
  currentManifest: GlobalCatalogManifestV1 | null,
  target: CachedProviderCompletionPublishPlan,
): boolean {
  const selected = currentManifest?.providerReferences.find(
    ({ platformKey }) => platformKey === target.providerKey,
  );
  return selected?.publicProviderReleaseId === target.publicProviderReleaseId &&
    selected.providerReleaseFingerprint === target.providerReleaseFingerprint;
}

function operationAlreadyApplied(input: Readonly<{
  operation: IndependentProviderManifestGateOperation;
  currentManifest: GlobalCatalogManifestV1 | null;
  providerKey: string;
  target: CachedProviderCompletionPublishPlan | null;
}>): boolean {
  const selected = input.currentManifest?.providerReferences.some(
    ({ platformKey }) => platformKey === input.providerKey,
  ) === true;
  if (input.operation === "remove") return !selected;
  return input.target !== null && exactSelectedRelease(
    input.currentManifest,
    input.target,
  );
}

function operationShapeValid(input: Readonly<{
  operation: IndependentProviderManifestGateOperation;
  currentManifest: GlobalCatalogManifestV1 | null;
  providerKey: string;
}>): boolean {
  const selected = input.currentManifest?.providerReferences.some(
    ({ platformKey }) => platformKey === input.providerKey,
  ) === true;
  if (input.operation === "add") return !selected;
  return selected;
}

async function verifiedInitialConfidencePolicy(input: Readonly<{
  source: CentralApprovedManifestConfigurationSource;
  claim: ManifestGateClaim;
  target: CachedProviderCompletionPublishPlan;
  deadlineAt?: number;
  signal?: AbortSignal;
}>): Promise<
  | Readonly<{ state: "ready"; confidencePolicyVersion: string }>
  | Readonly<{ state: "deferred" | "blocked"; failureCode: string }>
> {
  let record: CentralApprovedManifestConfigurationRecord | null;
  try {
    record = await input.source.loadForInitialManifest({
      organizationId: input.claim.organizationId,
      providerId: input.claim.providerId,
      providerKey: input.claim.providerKey,
      catalogVersionId: input.target.catalogVersionId,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return {
      state: "deferred",
      failureCode: "MANIFEST_BOOTSTRAP_CONFIGURATION_READ_FAILED",
    };
  }
  if (record === null) {
    return {
      state: "blocked",
      failureCode: "MANIFEST_BOOTSTRAP_CONFIGURATION_UNAVAILABLE",
    };
  }
  const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(
    record.configuration,
  );
  if (
    !parsed.success || !SHA256_PATTERN.test(record.configurationHash) ||
    record.organizationId.toLowerCase() !==
      input.claim.organizationId.toLowerCase() ||
    record.catalogVersionId.toLowerCase() !==
      input.target.catalogVersionId.toLowerCase() ||
    record.publicChangeSequence < 1n ||
    !parsed.data.platforms.some(
      ({ platformKey }) => platformKey === input.claim.providerKey,
    ) ||
    input.target.plan.publicAssetOrigins.some(
      (origin) => !parsed.data.publicAssetOrigins.includes(origin),
    )
  ) return {
    state: "blocked",
    failureCode: "MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID",
  };
  const [configurationHash, confidencePolicyHash] = await Promise.all([
    sha256CanonicalJson(
      PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
      parsed.data,
    ),
    recomputeProviderCatalogReleaseGoverningHashV1({
      kind: "confidence_policy",
      value: parsed.data.confidencePolicy,
    }),
  ]);
  if (
    configurationHash !== record.configurationHash ||
    confidencePolicyHash !==
      input.target.plan.governingHashes.confidencePolicyHash
  ) return {
    state: "blocked",
    failureCode: "MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID",
  };
  return {
    state: "ready",
    confidencePolicyVersion: parsed.data.confidencePolicy.version,
  };
}

function unrelatedReferencesPreserved(
  providerKey: string,
  current: GlobalCatalogManifestV1 | null,
  candidate: GlobalCatalogManifestV1,
): boolean {
  if (current === null) return true;
  const candidateByKey = new Map(candidate.providerReferences.map(
    (reference) => [reference.platformKey, reference],
  ));
  return current.providerReferences.every((reference) =>
    reference.platformKey === providerKey ||
    canonicalJson(candidateByKey.get(reference.platformKey)) ===
      canonicalJson(reference));
}

/**
 * Verified central-only proof source. Every target comes from the immutable
 * completion relay cache, and every claim is re-read under central truth.
 * No provider locator, database client, or provider credential is accepted.
 */
export class DirectCentralManifestGateProofSource
implements VerifiedManifestGateProofSource {
  readonly #now: () => Date;

  constructor(private readonly dependencies: Readonly<{
    claims: ClaimStore;
    plans: PlanStore;
    activations: ActivationStore;
    initialConfiguration: CentralApprovedManifestConfigurationSource;
    now?: () => Date;
  }>) {
    this.#now = dependencies.now ?? (() => new Date());
  }

  async resolveTarget(input: Readonly<{
    claim: ManifestGateClaim;
    currentManifest: GlobalCatalogManifestV1 | null;
    currentActiveState: ActiveCatalogManifestStateV1;
    deadlineAt?: number;
    signal?: AbortSignal;
  }>): Promise<VerifiedManifestGateTargetResolution> {
    if (input.signal?.aborted === true) {
      return resolution("deferred", "MANIFEST_GATE_PROOF_CANCELLED");
    }
    const deadline = input.deadlineAt === undefined
      ? undefined
      : { deadlineAt: input.deadlineAt };
    let claim: ManifestGateClaim;
    try {
      claim = await this.dependencies.claims.verifyActiveClaim(
        input.claim,
        this.#now(),
        deadline,
      );
    } catch (error) {
      return error instanceof PromotionJobPersistenceError
        ? resolution("blocked", "MANIFEST_GATE_CLAIM_STALE")
        : resolution("deferred", "MANIFEST_GATE_CLAIM_UNAVAILABLE");
    }

    let currentManifest: GlobalCatalogManifestV1 | null;
    const activeState = activeCatalogManifestStateV1Schema.safeParse(
      input.currentActiveState,
    );
    try {
      currentManifest = input.currentManifest === null
        ? null
        : await verifyGlobalCatalogManifestV1(input.currentManifest);
    } catch {
      return resolution(
        "blocked",
        "PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID",
      );
    }
    if (
      !activeState.success ||
      !currentStateMatchesManifest(currentManifest, activeState.data)
    ) return resolution(
      "blocked",
      "PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID",
    );

    const providerAlreadySelected = currentManifest?.providerReferences.some(
      ({ platformKey }) => platformKey === claim.providerKey,
    ) === true;
    if (claim.requestedOperation === null && !providerAlreadySelected) {
      return resolution(
        "blocked",
        "PROVIDER_MANIFEST_GATE_ADD_REQUIRES_AUTHORIZATION",
      );
    }
    const operation = semanticOperation(claim);
    let target: CachedProviderCompletionPublishPlan | null = null;
    if (operation !== "remove") {
      try {
        target = claim.requestedOperation === null
          ? await this.dependencies.plans.loadByEvidence({
              providerId: claim.providerId,
              evidenceDigest: claim.latestEvidenceDigest!,
            }, deadline)
          : await this.dependencies.plans.loadExplicitTarget({
              providerId: claim.providerId,
              providerReleaseId: claim.targetProviderReleaseId!,
              catalogVersionId: claim.targetCatalogVersionId!,
            }, deadline);
      } catch (error) {
        if (error instanceof ProviderCompletionPublishPlanCapacityError) {
          return resolution(
            "blocked",
            "PROVIDER_MANIFEST_GATE_PLAN_CAPACITY_EXCEEDED",
          );
        }
        return resolution(
          "deferred",
          "PROVIDER_MANIFEST_GATE_PLAN_CACHE_UNAVAILABLE",
        );
      }
      if (target === null) return resolution(
        "deferred",
        "PROVIDER_MANIFEST_GATE_PLAN_CACHE_MISSING",
      );
      if (
        target.providerId !== claim.providerId ||
        target.providerKey !== claim.providerKey ||
        (claim.requestedOperation !== null &&
          (target.providerReleaseId !== claim.targetProviderReleaseId ||
            target.catalogVersionId !== claim.targetCatalogVersionId))
      ) return resolution(
        "blocked",
        "PROVIDER_MANIFEST_GATE_TARGET_DRIFT",
      );
    }

    if (operationAlreadyApplied({
      operation,
      currentManifest,
      providerKey: claim.providerKey,
      target,
    })) return resolution("no_change", null);
    if (!operationShapeValid({
      operation,
      currentManifest,
      providerKey: claim.providerKey,
    })) return resolution(
      "blocked",
      "PROVIDER_MANIFEST_GATE_OPERATION_MISMATCH",
    );
    if (
      operation === "remove" &&
      currentManifest?.providerReferences.length === 1
    ) return resolution(
      "blocked",
      "PROVIDER_MANIFEST_GATE_CLEAR_FORBIDDEN",
    );

    const unrelated = currentManifest?.providerReferences.filter(
      ({ platformKey }) => platformKey !== claim.providerKey,
    ) ?? [];
    let retainedPlans: readonly CachedProviderCompletionPublishPlan[] = [];
    if (unrelated.length > 0) {
      try {
        const loaded = await this.dependencies.plans.loadForManifestReferences(
          unrelated.map((reference) => ({
            providerKey: reference.platformKey,
            publicProviderReleaseId: reference.publicProviderReleaseId,
            providerReleaseFingerprint: reference.providerReleaseFingerprint,
          })),
          deadline,
          MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES -
            (target === null
              ? 0
              : providerCompletionPlanHydrationByteCount(target)),
        );
        if (loaded === null) return resolution(
          "deferred",
          "PROVIDER_MANIFEST_GATE_RETAINED_PLAN_MISSING",
        );
        retainedPlans = loaded;
      } catch (error) {
        if (error instanceof ProviderCompletionPublishPlanCapacityError) {
          return resolution(
            "blocked",
            "PROVIDER_MANIFEST_GATE_PLAN_CAPACITY_EXCEEDED",
          );
        }
        return resolution(
          "deferred",
          "PROVIDER_MANIFEST_GATE_RETAINED_PLAN_UNAVAILABLE",
        );
      }
    }

    let confidencePolicyVersion: string;
    let sharedConfigurationEpoch;
    if (currentManifest !== null) {
      confidencePolicyVersion = currentManifest.confidencePolicyVersion;
      sharedConfigurationEpoch = currentManifest.sharedConfigurationEpoch;
    } else {
      if (target === null) return resolution(
        "blocked",
        "MANIFEST_BOOTSTRAP_CONFIGURATION_UNAVAILABLE",
      );
      const configuration = await verifiedInitialConfidencePolicy({
        source: this.dependencies.initialConfiguration,
        claim,
        target,
        ...(input.deadlineAt === undefined
          ? {}
          : { deadlineAt: input.deadlineAt }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (configuration.state !== "ready") {
        return resolution(configuration.state, configuration.failureCode);
      }
      confidencePolicyVersion = configuration.confidencePolicyVersion;
      sharedConfigurationEpoch = target.plan.sharedConfigurationEpoch;
    }

    const selectedPlans = operation === "remove"
      ? retainedPlans.map(({ plan }) => plan)
      : [...retainedPlans.map(({ plan }) => plan), target!.plan];
    const enabledPlatformKeys = selectedPlans.map(({ platformKey }) =>
      platformKey).sort();
    let candidateManifest: GlobalCatalogManifestV1;
    try {
      candidateManifest = await composeGlobalCatalogManifest({
        enabledPlatformKeys,
        providerPlans: selectedPlans,
        approvedConfiguration: {
          sharedConfigurationEpoch,
          confidencePolicyVersion,
        },
      });
    } catch (error) {
      return resolution(
        "blocked",
        error instanceof CatalogManifestCompositionError
          ? error.code
          : "PROVIDER_MANIFEST_GATE_CANDIDATE_INVALID",
      );
    }
    if (!unrelatedReferencesPreserved(
      claim.providerKey,
      currentManifest,
      candidateManifest,
    )) return resolution(
      "blocked",
      "PROVIDER_MANIFEST_GATE_MULTI_PROVIDER_CHANGE",
    );

    if (operation === "remove") {
      return {
        state: "ready",
        target: {
          operation,
          candidateManifest,
          proof: {
            providerId: claim.providerId,
            providerKey: claim.providerKey,
            targetProviderReleaseId: null,
            targetCatalogVersionId: null,
          },
        },
      };
    }
    return {
      state: "ready",
      target: {
        operation,
        candidateManifest,
        proof: {
          providerId: claim.providerId,
          providerKey: claim.providerKey,
          targetProviderReleaseId: target!.providerReleaseId,
          targetCatalogVersionId: target!.catalogVersionId,
          completedHead: target!.completedHead,
          activeObservation: target!.activeObservation,
        },
      },
    };
  }

  async resolveSignedState(input: Readonly<{
    reason: "bootstrap" | "cas_reconciliation";
    activeState: ActiveCatalogManifestStateV1;
    deadlineAt?: number;
    signal?: AbortSignal;
  }>): Promise<VerifiedManifestStateResolution> {
    if (input.signal?.aborted === true) return {
      state: "deferred",
      failureCode: "MANIFEST_SIGNED_STATE_CANCELLED",
    };
    const deadline = input.deadlineAt === undefined
      ? undefined
      : { deadlineAt: input.deadlineAt };
    const parsed = activeCatalogManifestStateV1Schema.safeParse(
      input.activeState,
    );
    if (!parsed.success) return {
      state: "blocked",
      failureCode: "MANIFEST_SIGNED_STATE_INVALID",
    };
    let mirror: ManifestActivationMirror;
    try {
      mirror = await this.dependencies.activations.loadMirror(deadline);
    } catch {
      return {
        state: "deferred",
        failureCode: "MANIFEST_SIGNED_STATE_MIRROR_UNAVAILABLE",
      };
    }
    if (
      mirror.activeManifest === null && mirror.activeState === null &&
      mirror.previousManifest === null && mirror.generation === 0n &&
      parsed.data.generation === 0 && parsed.data.activeManifest === null &&
      parsed.data.previousManifest === null && parsed.data.observation === null &&
      parsed.data.terminalReceiptSha256 === null
    ) return {
      state: "ready",
      activeManifest: null,
      previousManifest: null,
    };
    if (
      mirror.activeManifest === null || mirror.activeState === null ||
      BigInt(parsed.data.generation) !== mirror.generation ||
      canonicalJson(parsed.data) !== canonicalJson(mirror.activeState) ||
      parsed.data.activeManifest === null ||
      canonicalJson(manifestIdentity(mirror.activeManifest)) !==
        canonicalJson({
          publicReleaseId: parsed.data.activeManifest.publicReleaseId,
          manifestFingerprint: parsed.data.activeManifest.manifestFingerprint,
          sharedConfigurationEpoch:
            parsed.data.activeManifest.sharedConfigurationEpoch,
          providerReferenceSetHash:
            parsed.data.activeManifest.providerReferenceSetHash,
        }) ||
      (mirror.previousManifest === null) !==
        (parsed.data.previousManifest === null) ||
      (mirror.previousManifest !== null &&
        canonicalJson(manifestIdentity(mirror.previousManifest)) !==
          canonicalJson({
            publicReleaseId: parsed.data.previousManifest?.publicReleaseId,
            manifestFingerprint:
              parsed.data.previousManifest?.manifestFingerprint,
            sharedConfigurationEpoch:
              parsed.data.previousManifest?.sharedConfigurationEpoch,
            providerReferenceSetHash:
              parsed.data.previousManifest?.providerReferenceSetHash,
          }))
    ) return {
      state: "blocked",
      failureCode: "MANIFEST_SIGNED_STATE_MIRROR_MISMATCH",
    };
    return {
      state: "ready",
      activeManifest: mirror.activeManifest,
      previousManifest: mirror.previousManifest,
    };
  }
}

export function createDirectCentralManifestGateProofSource(input: Readonly<{
  central: CentralPrismaClient;
  initialConfiguration?: CentralApprovedManifestConfigurationSource;
  now?: () => Date;
}>): VerifiedManifestGateProofSource {
  return new DirectCentralManifestGateProofSource({
    claims: new PrismaManifestGateIntentRepository(input.central),
    plans: new PrismaProviderCompletionPublishPlanRepository(input.central),
    activations: new PrismaManifestActivationRepository(input.central),
    initialConfiguration: input.initialConfiguration ??
      new UnavailableCentralApprovedManifestConfigurationSource(),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
