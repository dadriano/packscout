import { createHash } from "node:crypto";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  globalCatalogProviderActiveObservationV1Schema,
  verifyProviderCatalogReleasePlanV1,
  type GlobalCatalogManifestIdentityV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogSharedConfigurationEpochV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import {
  CatalogManifestCompositionError,
  composeGlobalCatalogManifest,
} from "./catalog-manifest-composer.ts";
import {
  manifestPromotionOperationId,
  prepareManifestPromotionOperation,
} from "./manifest-promotion-operations.ts";
import type {
  ManifestPromotionActiveSelection,
  ManifestPromotionEvaluationSnapshot,
  ManifestPromotionPreparedOperation,
  ManifestPromotionPreparedSummary,
  ManifestProviderPlanResolver,
} from "./manifest-promotion-types.ts";
import type {
  ProviderPromotionCompletedHead,
} from "./provider-promotion-types.ts";

export type ManifestPromotionPlanningErrorCode =
  | "MANIFEST_SNAPSHOT_INVALID"
  | "MANIFEST_PLATFORM_SET_INVALID"
  | "MANIFEST_PROVIDER_RELEASE_UNAVAILABLE"
  | "MANIFEST_PROVIDER_RELEASE_INVALID"
  | "MANIFEST_CONFIGURATION_EPOCH_BARRIER"
  | "MANIFEST_BACKFILL_INCOMPLETE"
  | "MANIFEST_OBSERVATION_INVALID"
  | "MANIFEST_EVALUATION_SEQUENCE_INVALID"
  | CatalogManifestCompositionError["code"];

export class ManifestPromotionPlanningError extends Error {
  constructor(readonly code: ManifestPromotionPlanningErrorCode) {
    super("Manifest promotion evaluation failed safely.");
    this.name = "ManifestPromotionPlanningError";
  }
}

export interface PreparedManifestPromotion {
  readonly outcome: "activate" | "refresh" | "clear" | "no_change";
  readonly summary: ManifestPromotionPreparedSummary;
  readonly operation: ManifestPromotionPreparedOperation | null;
  readonly selectedPlans: readonly ProviderCatalogReleasePublishPlanV1[];
}

function fail(code: ManifestPromotionPlanningErrorCode): never {
  throw new ManifestPromotionPlanningError(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalKeys(
  values: readonly string[],
  requireNonempty: boolean,
): boolean {
  return (!requireNonempty || values.length > 0) &&
    values.length <= 8 && values.every(
    (value, index) => value.length > 0 &&
      (index === 0 || compareText(values[index - 1]!, value) < 0),
  );
}

function wireEpoch(epoch: Readonly<{
  configurationKey: string;
  revision: number;
  publicChangeSequence: bigint;
  configurationHash: string;
}>): ProviderCatalogSharedConfigurationEpochV1 {
  return {
    configurationKey: epoch.configurationKey,
    revision: epoch.revision,
    publicChangeSequence: String(epoch.publicChangeSequence),
    configurationHash: epoch.configurationHash,
  };
}

function sameEpoch(
  left: ProviderCatalogSharedConfigurationEpochV1,
  right: ProviderCatalogSharedConfigurationEpochV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
    dataAsOf: plan.dataAsOf,
  };
}

function manifestIdentity(
  manifest: Readonly<{
    publicReleaseId: string;
    manifestFingerprint: string;
    sharedConfigurationEpoch: ProviderCatalogSharedConfigurationEpochV1;
    providerReferenceSetHash: string;
  }>,
): GlobalCatalogManifestIdentityV1 {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  };
}

function safeObservationSequence(value: bigint): number {
  const sequence = Number(value);
  if (value <= 0n || !Number.isSafeInteger(sequence) || BigInt(sequence) !== value) {
    fail("MANIFEST_EVALUATION_SEQUENCE_INVALID");
  }
  return sequence;
}

function safeTimestamp(date: Date | null): string {
  if (date === null || !Number.isFinite(date.getTime())) {
    fail("MANIFEST_OBSERVATION_INVALID");
  }
  return date.toISOString();
}

function staleAt(observedAt: Date, staleAfterSeconds: number): string {
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 60) {
    fail("MANIFEST_SNAPSHOT_INVALID");
  }
  const value = new Date(observedAt.getTime() + staleAfterSeconds * 1_000);
  if (!Number.isFinite(value.getTime())) fail("MANIFEST_OBSERVATION_INVALID");
  return value.toISOString();
}

function validateActiveState(snapshot: ManifestPromotionEvaluationSnapshot): void {
  const active = snapshot.activeState;
  if (active === null) fail("MANIFEST_SNAPSHOT_INVALID");
  const parsed = activeCatalogManifestStateV1Schema.safeParse(active.state);
  if (!parsed.success || canonicalJson(parsed.data) !== active.canonicalStateBody) {
    fail("MANIFEST_SNAPSHOT_INVALID");
  }
  const expectedSelections = parsed.data.observation?.providerSelections ?? [];
  if (
    active.activeSelections.length !== expectedSelections.length ||
    active.activeSelections.some((selection, index) =>
      canonicalJson(selection.selection) !== selection.selectionBody ||
      sha256(selection.selectionBody) !== selection.selectionSha256 ||
      selection.platformKey !== expectedSelections[index]?.platformKey ||
      selection.manifestPublicReleaseId !==
        parsed.data.activeManifest?.publicReleaseId ||
      selection.activeGeneration !== BigInt(parsed.data.generation) ||
      canonicalJson(selection.selection) !==
        canonicalJson(expectedSelections[index]))
  ) fail("MANIFEST_SNAPSHOT_INVALID");
}

function validateSnapshotShape(snapshot: ManifestPromotionEvaluationSnapshot): void {
  validateActiveState(snapshot);
  const { eligibility, providerFacts } = snapshot;
  if (
    !/^[0-9a-f]{64}$/u.test(snapshot.snapshotSha256) ||
    !canonicalKeys(eligibility.enabledPlatformKeys, false) ||
    !canonicalKeys(eligibility.configuredPlatformKeys, true) ||
    !eligibility.enabledPlatformKeys.every((key) =>
      eligibility.configuredPlatformKeys.includes(key)) ||
    providerFacts.length !== eligibility.enabledPlatformKeys.length ||
    eligibility.checkpoints.length !== eligibility.enabledPlatformKeys.length ||
    !eligibility.enabledPlatformKeys.every((key, index) =>
      providerFacts[index]?.platformKey === key &&
      providerFacts[index]?.checkpoint.platformKey === key &&
      eligibility.checkpoints[index]?.platformKey === key) ||
    eligibility.confidencePolicyVersion.trim() !==
      eligibility.confidencePolicyVersion ||
    eligibility.confidencePolicyVersion.length < 1 ||
    eligibility.confidencePolicyVersion.length > 128 ||
    providerFacts.some(({ minimumEligibleCheckpoint }) =>
      minimumEligibleCheckpoint <= 0n ||
      minimumEligibleCheckpoint > eligibility.lifecycleDecisionSequence)
  ) fail("MANIFEST_PLATFORM_SET_INVALID");
  const epoch = wireEpoch(eligibility.sharedConfigurationEpoch);
  if (providerFacts.some((fact) =>
    !sameEpoch(wireEpoch(fact.checkpoint.sharedConfigurationEpoch), epoch))) {
    fail("MANIFEST_SNAPSHOT_INVALID");
  }
}

type SelectedProvider = Readonly<{
  platformKey: string;
  plan: ProviderCatalogReleasePublishPlanV1;
  completedHead: ProviderPromotionCompletedHead | null;
  fallback: ManifestPromotionActiveSelection | null;
}>;

async function selectProvider(input: Readonly<{
  fact: ManifestPromotionEvaluationSnapshot["providerFacts"][number];
  currentEpoch: ProviderCatalogSharedConfigurationEpochV1;
  activeEpoch: ProviderCatalogSharedConfigurationEpochV1 | null;
  resolver: ManifestProviderPlanResolver;
}>): Promise<SelectedProvider> {
  const { fact, currentEpoch, activeEpoch, resolver } = input;
  if (!fact.initialBackfillComplete) fail("MANIFEST_BACKFILL_INCOMPLETE");
  const head = fact.completedHead;
  const headCheckpoint = head === null
    ? null : BigInt(head.completedHead.providerCheckpoint.settledSequence);
  const headEligible = head !== null &&
    head.platformKey === fact.platformKey &&
    headCheckpoint === head.targetCheckpoint &&
    headCheckpoint >= fact.minimumEligibleCheckpoint &&
    sameEpoch(head.completedHead.release.sharedConfigurationEpoch, currentEpoch);
  const active = fact.activeSelection;
  const activeCheckpoint = active === null
    ? null : BigInt(active.selection.selectedProviderCheckpoint.settledSequence);
  const activeEligible = active !== null && activeEpoch !== null &&
    activeCheckpoint === active.selectedCheckpoint &&
    sameEpoch(activeEpoch, currentEpoch);
  // A same-epoch completed head is always stronger than the older active
  // proof, including confirmReuse of the same immutable release. Later source
  // facts only affect freshness; they never erase a proven newer checkpoint.
  const useFallback = activeEligible && !headEligible;
  const useHead = headEligible && !useFallback;
  const fallback = useFallback ? active : null;
  if (
    !useHead && fallback === null
  ) fail("MANIFEST_CONFIGURATION_EPOCH_BARRIER");
  const publicProviderReleaseId = useHead
    ? head.publicProviderReleaseId
    : fallback!.providerPublicReleaseId;
  const providerReleaseFingerprint = useHead
    ? head.providerReleaseFingerprint
    : fallback!.providerReleaseFingerprint;
  const publishArtifactAttemptId = useHead
    ? head.publishArtifactAttemptId
    : fallback!.publishArtifactAttemptId;
  const candidate = await resolver.loadPublishPlan({
    platformKey: fact.platformKey,
    publicProviderReleaseId,
    providerReleaseFingerprint,
    publishArtifactAttemptId,
  });
  if (candidate === null) fail("MANIFEST_PROVIDER_RELEASE_UNAVAILABLE");
  let plan;
  try {
    plan = await verifyProviderCatalogReleasePlanV1(candidate);
  } catch {
    fail("MANIFEST_PROVIDER_RELEASE_INVALID");
  }
  if (
    plan.classification !== "publish" ||
    plan.platformKey !== fact.platformKey ||
    plan.publicProviderReleaseId !== publicProviderReleaseId ||
    plan.providerReleaseFingerprint !== providerReleaseFingerprint ||
    !sameEpoch(plan.sharedConfigurationEpoch, currentEpoch)
  ) fail("MANIFEST_PROVIDER_RELEASE_INVALID");
  if (useHead) {
    if (
      canonicalJson(head.completedHead) !== head.completedHeadBody ||
      sha256(head.completedHeadBody) !== head.completedHeadSha256 ||
      sha256(head.canonicalReceiptBody) !== head.terminalReceiptSha256 ||
      canonicalJson(immutableProof(plan)) !==
        canonicalJson(head.completedHead.release)
    ) fail("MANIFEST_PROVIDER_RELEASE_INVALID");
  } else if (
    fallback!.selection.publicProviderReleaseId !== plan.publicProviderReleaseId ||
    fallback!.selection.selectedDataAsOf !== plan.dataAsOf ||
    fallback!.providerTerminalOperationId !==
      fallback!.selection.terminalOperationId ||
    fallback!.providerTerminalReceiptSha256 !==
      fallback!.selection.terminalReceiptSha256
  ) fail("MANIFEST_PROVIDER_RELEASE_INVALID");
  return { platformKey: fact.platformKey, plan, completedHead: useHead ? head : null,
    fallback: useHead ? null : fallback };
}

function providerObservation(input: Readonly<{
  selected: SelectedProvider;
  fact: ManifestPromotionEvaluationSnapshot["providerFacts"][number];
  staleAfterSeconds: number;
}>): GlobalCatalogProviderActiveObservationV1 {
  const { selected, fact } = input;
  const lastObservedAt = fact.lastSuccessfulObservationAt;
  const observedAt = safeTimestamp(lastObservedAt);
  const selectedCheckpoint = selected.completedHead === null
    ? selected.fallback!.selection.selectedProviderCheckpoint
    : selected.completedHead.completedHead.providerCheckpoint;
  const terminalOperationKind = selected.completedHead === null
    ? selected.fallback!.selection.terminalOperationKind
    : selected.completedHead.terminalOperationKind;
  const terminalOperationId = selected.completedHead === null
    ? selected.fallback!.providerTerminalOperationId
    : selected.completedHead.terminalOperationId;
  const terminalReceiptSha256 = selected.completedHead === null
    ? selected.fallback!.providerTerminalReceiptSha256
    : selected.completedHead.terminalReceiptSha256;
  const settled = fact.checkpoint.settledSequence;
  const source = fact.checkpoint.sourceHeadSequence;
  if (
    BigInt(selectedCheckpoint.settledSequence) > settled ||
    settled > source ||
    Date.parse(selected.plan.dataAsOf) > Date.parse(observedAt)
  ) fail("MANIFEST_OBSERVATION_INVALID");
  return globalCatalogProviderActiveObservationV1Schema.parse({
    platformKey: fact.platformKey,
    publicProviderReleaseId: selected.plan.publicProviderReleaseId,
    terminalOperationKind,
    terminalOperationId,
    terminalReceiptSha256,
    selectedProviderCheckpoint: selectedCheckpoint,
    selectedDataAsOf: selected.plan.dataAsOf,
    latestAffectedSettledSequence: String(settled),
    latestAffectedSourceHeadSequence: String(source),
    initialBackfillComplete: fact.initialBackfillComplete,
    affectedDerivationsSettled: fact.checkpoint.blockedState.kind === "ready",
    settledSourceFreshness:
      fact.checkpoint.blockedState.kind === "ready" && settled === source
        ? "fresh"
        : "delayed",
    lastSuccessfulObservationAt: observedAt,
    staleAt: staleAt(lastObservedAt!, input.staleAfterSeconds),
  });
}

/**
 * Creates the sole exact mutation for one serialized manifest evaluation.
 * All policy/configuration fields come from the same atomic DB snapshot.
 */
export async function prepareManifestPromotion(input: Readonly<{
  snapshot: ManifestPromotionEvaluationSnapshot;
  providerPlans: ManifestProviderPlanResolver;
}>): Promise<PreparedManifestPromotion> {
  const { snapshot } = input;
  validateSnapshotShape(snapshot);
  const expectedActiveState = snapshot.activeState!.state;
  const currentEpoch = wireEpoch(snapshot.eligibility.sharedConfigurationEpoch);
  if (snapshot.eligibility.enabledPlatformKeys.length === 0) {
    const commonSummary = {
      expectedActiveState,
      sharedConfigurationEpoch: currentEpoch,
      enabledPlatformKeys: [] as const,
      providerSelections: [] as const,
      evaluationSnapshotSha256: snapshot.snapshotSha256,
      manifestIdentity: null,
    };
    if (expectedActiveState.activeManifest === null) {
      return {
        outcome: "no_change",
        summary: { ...commonSummary, operationKind: "no_change" },
        operation: null,
        selectedPlans: [],
      };
    }
    const operationId = manifestPromotionOperationId(
      snapshot.evaluationSequence,
      "rollback",
    );
    return {
      outcome: "clear",
      summary: { ...commonSummary, operationKind: "rollback" },
      operation: prepareManifestPromotionOperation("rollback", {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationId,
        idempotencyKey: operationId,
        rollbackKind: "clear",
        clearAuthorization: "clear_catalog_manifest_v1",
        expectedActiveState,
      }),
      selectedPlans: [],
    };
  }
  const activeEpoch = expectedActiveState.activeManifest?.sharedConfigurationEpoch ??
    null;
  const selected = await Promise.all(snapshot.providerFacts.map((fact) =>
    selectProvider({
      fact,
      currentEpoch,
      activeEpoch,
      resolver: input.providerPlans,
    })));
  const manifest = await composeGlobalCatalogManifest({
    enabledPlatformKeys: snapshot.eligibility.enabledPlatformKeys,
    providerPlans: selected.map(({ plan }) => plan),
    approvedConfiguration: {
      sharedConfigurationEpoch: currentEpoch,
      // Never source this from worker configuration or provider rows. Empty
      // catalogs are valid, so inference from entity content would be unsafe.
      confidencePolicyVersion: snapshot.eligibility.confidencePolicyVersion,
    },
  }).catch((error: unknown) => {
    if (error instanceof CatalogManifestCompositionError) fail(error.code);
    throw error;
  });
  const providerSelections = selected.map((entry, index) =>
    providerObservation({
      selected: entry,
      fact: snapshot.providerFacts[index]!,
      staleAfterSeconds: snapshot.eligibility.staleAfterSeconds,
    }));
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: safeObservationSequence(snapshot.evaluationSequence),
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections,
  });
  const identity = manifestIdentity(manifest);
  const providerSelectionProofs = selected.map((entry, index) => {
    const observationSelection = providerSelections[index]!;
    return {
      platformKey: entry.platformKey,
      source: entry.completedHead === null
        ? "active_fallback" as const
        : "completed_head" as const,
      proofDigest: entry.completedHead === null
        ? entry.fallback!.selectionSha256
        : entry.completedHead.completedHeadSha256,
      publicProviderReleaseId: entry.plan.publicProviderReleaseId,
      providerReleaseFingerprint: entry.plan.providerReleaseFingerprint,
      selectedCheckpoint:
        observationSelection.selectedProviderCheckpoint.settledSequence,
      terminalReceiptSha256: observationSelection.terminalReceiptSha256,
    };
  });
  const commonSummary = {
    expectedActiveState,
    sharedConfigurationEpoch: currentEpoch,
    enabledPlatformKeys: [...snapshot.eligibility.enabledPlatformKeys],
    providerSelections: providerSelectionProofs,
    evaluationSnapshotSha256: snapshot.snapshotSha256,
    manifestIdentity: identity,
  } as const;
  const activeIdentity = expectedActiveState.activeManifest === null
    ? null : manifestIdentity(expectedActiveState.activeManifest);
  const sameManifest = activeIdentity !== null &&
    canonicalJson(activeIdentity) === canonicalJson(identity);
  const sameProviderFacts = sameManifest &&
    canonicalJson(expectedActiveState.observation!.providerSelections) ===
      canonicalJson(providerSelections);
  if (sameProviderFacts) {
    return {
      outcome: "no_change",
      summary: { ...commonSummary, operationKind: "no_change" },
      operation: null,
      selectedPlans: selected.map(({ plan }) => plan),
    };
  }
  const kind = sameManifest ? "refreshActiveState" : "activateManifest";
  const operationId = manifestPromotionOperationId(
    snapshot.evaluationSequence,
    kind,
  );
  const request = kind === "activateManifest"
    ? {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationId,
        idempotencyKey: operationId,
        manifest,
        observation,
        expectedActiveState,
      }
    : {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationId,
        idempotencyKey: operationId,
        manifest: identity,
        observation,
        expectedActiveState,
      };
  return {
    outcome: sameManifest ? "refresh" : "activate",
    summary: { ...commonSummary, operationKind: kind },
    operation: prepareManifestPromotionOperation(kind, request),
    selectedPlans: selected.map(({ plan }) => plan),
  };
}
