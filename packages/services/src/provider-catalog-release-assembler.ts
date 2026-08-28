import {
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  approvedPublicCatalogConfigurationV1Schema,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  containsProtectedProviderCatalogReleaseField,
  providerCatalogCompletedReleaseProofV1Schema,
  providerCatalogReleaseBlockedPlanV1Schema,
  verifyProviderCatalogReleasePlanV1,
  type ApprovedPublicCatalogConfigurationV1,
  type ProviderCatalogCompletedReleaseProofV1,
  type ProviderCatalogReleaseBlockedPlanV1,
  type ProviderCatalogReleaseBlockReasonV1,
  type ProviderCatalogReleasePlanV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseReusePlanV1,
  type ProviderCatalogSharedConfigurationEpochV1,
} from "@packscout/contracts";
import {
  buildProviderCatalogReleasePublishPlan,
  ProviderCatalogReleaseArtifactError,
} from "./provider-catalog-release-artifacts.ts";
import {
  projectProviderCatalogRelease,
  ProviderCatalogProjectionAssemblyError,
} from "./provider-catalog-release-public-projection.ts";
import {
  sameSharedPublicConfigurationEpoch,
  type ProviderCatalogCheckpoint,
} from "./provider-catalog-settlement-service.ts";
import type {
  AssembleProviderCatalogReleaseInput,
  ProviderCatalogReleaseBaselinePort,
  ProviderCatalogReleaseCheckpointPort,
  ProviderCatalogReleaseSourcePort,
  ProviderCatalogReleaseSourceSnapshot,
} from "./provider-catalog-release-types.ts";

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

type SettledProviderCatalogCheckpoint = ProviderCatalogCheckpoint &
  Readonly<{ settledAt: Date }>;

type SourceErrorCode =
  | "PROVIDER_RELEASE_SCOPE_MISMATCH"
  | "PROVIDER_RELEASE_CHECKPOINT_UNSETTLED"
  | "PROVIDER_RELEASE_CHECKPOINT_REGRESSED"
  | "PROVIDER_RELEASE_EPOCH_MISMATCH"
  | "PROVIDER_RELEASE_LIFECYCLE_INELIGIBLE"
  | "PROVIDER_RELEASE_BACKFILL_INCOMPLETE"
  | "PROVIDER_RELEASE_SOURCE_INVALID"
  | "PROVIDER_RELEASE_PROTECTED_FIELD";

const sourceErrorReasons: Readonly<Record<
  SourceErrorCode,
  ProviderCatalogReleaseBlockReasonV1
>> = {
  PROVIDER_RELEASE_SCOPE_MISMATCH: "PROVIDER_SCOPE_MISMATCH",
  PROVIDER_RELEASE_CHECKPOINT_UNSETTLED: "PROVIDER_CHECKPOINT_UNSETTLED",
  PROVIDER_RELEASE_CHECKPOINT_REGRESSED: "PROVIDER_CHECKPOINT_REGRESSED",
  PROVIDER_RELEASE_EPOCH_MISMATCH: "PROVIDER_CHECKPOINT_EPOCH_MISMATCH",
  PROVIDER_RELEASE_LIFECYCLE_INELIGIBLE: "INITIAL_BACKFILL_INCOMPLETE",
  PROVIDER_RELEASE_BACKFILL_INCOMPLETE: "INITIAL_BACKFILL_INCOMPLETE",
  PROVIDER_RELEASE_SOURCE_INVALID: "PROVIDER_SOURCE_INVALID",
  PROVIDER_RELEASE_PROTECTED_FIELD: "PROTECTED_PUBLICATION_FIELD",
};

function finiteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function hasSettledTimestamp(
  checkpoint: ProviderCatalogCheckpoint,
): checkpoint is SettledProviderCatalogCheckpoint {
  return finiteDate(checkpoint.settledAt);
}

function sameDate(left: Date, right: Date): boolean {
  return finiteDate(left) && finiteDate(right) &&
    left.getTime() === right.getTime();
}

function epochWire(
  checkpoint: ProviderCatalogCheckpoint,
): ProviderCatalogSharedConfigurationEpochV1 {
  return {
    configurationKey: checkpoint.sharedConfigurationEpoch.configurationKey,
    revision: checkpoint.sharedConfigurationEpoch.revision,
    publicChangeSequence: String(
      checkpoint.sharedConfigurationEpoch.publicChangeSequence,
    ),
    configurationHash: checkpoint.sharedConfigurationEpoch.configurationHash,
  };
}

function blocked(
  checkpoint: ProviderCatalogCheckpoint,
  reason: ProviderCatalogReleaseBlockReasonV1,
): ProviderCatalogReleaseBlockedPlanV1 {
  return providerCatalogReleaseBlockedPlanV1Schema.parse({
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "blocked",
    platformKey: checkpoint.platformKey,
    sharedConfigurationEpoch: epochWire(checkpoint),
    providerCheckpoint: {
      settledSequence: String(checkpoint.settledSequence),
      settledAt: checkpoint.settledAt?.toISOString() ?? null,
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      checkpoint.platformKey,
      String(checkpoint.settledSequence),
    ),
    publicProviderReleaseId: null,
    dataAsOf: null,
    observation: null,
    reason,
  });
}

function checkpointBlockReason(
  checkpoint: ProviderCatalogCheckpoint,
): ProviderCatalogReleaseBlockReasonV1 | null {
  const settledTimestampInvalid = checkpoint.settledSequence === 0n
    ? checkpoint.settledAt !== null
    : !finiteDate(checkpoint.settledAt);
  const commonInvalid = checkpoint.settledSequence < 0n ||
    checkpoint.settledSequence > MAX_SIGNED_INT64 ||
    checkpoint.sourceHeadSequence < checkpoint.settledSequence ||
    checkpoint.sourceHeadSequence > MAX_SIGNED_INT64 ||
    checkpoint.sharedConfigurationEpoch.publicChangeSequence <= 0n ||
    checkpoint.sharedConfigurationEpoch.publicChangeSequence >
      checkpoint.sourceHeadSequence ||
    settledTimestampInvalid ||
    !finiteDate(checkpoint.sourceHeadAt);
  if (commonInvalid) return "PROVIDER_SOURCE_INVALID";
  if (checkpoint.blockedState.kind === "blocked") {
    if (
      checkpoint.blockedState.causeSequence <= checkpoint.settledSequence ||
      checkpoint.blockedState.causeSequence > checkpoint.sourceHeadSequence
    ) return "PROVIDER_SOURCE_INVALID";
    return checkpoint.blockedState.reason === "pending_derivation"
      ? "SETTLED_DERIVATION_INCOMPLETE"
      : "PROVIDER_SOURCE_TECHNICAL_FAILURE";
  }
  if (
    checkpoint.settledSequence <= 0n ||
    checkpoint.sharedConfigurationEpoch.publicChangeSequence >
      checkpoint.settledSequence
  ) return "PROVIDER_SOURCE_INVALID";
  if (checkpoint.sourceHeadSequence !== checkpoint.settledSequence) {
    return "PROVIDER_CHECKPOINT_UNSETTLED";
  }
  return null;
}

function sourceErrorReason(error: unknown): ProviderCatalogReleaseBlockReasonV1 {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code in sourceErrorReasons
  ) return sourceErrorReasons[error.code as SourceErrorCode];
  return "PROVIDER_SOURCE_TECHNICAL_FAILURE";
}

function validateSnapshotEcho(
  checkpoint: SettledProviderCatalogCheckpoint,
  snapshot: ProviderCatalogReleaseSourceSnapshot,
): ProviderCatalogReleaseBlockReasonV1 | null {
  if (
    snapshot.checkpoint.platformKey !== checkpoint.platformKey ||
    snapshot.configuration.platform.platformKey !== checkpoint.platformKey ||
    snapshot.revisions.some(
      ({ platformKey }) => platformKey !== checkpoint.platformKey,
    ) ||
    snapshot.assetPackAssociations.some(
      ({ platformKey }) => platformKey !== checkpoint.platformKey,
    ) ||
    snapshot.repackIdentities.some(
      ({ platformKey }) => platformKey !== checkpoint.platformKey,
    )
  ) return "PROVIDER_SCOPE_MISMATCH";
  if (!sameSharedPublicConfigurationEpoch(
    snapshot.checkpoint.sharedConfigurationEpoch,
    checkpoint.sharedConfigurationEpoch,
  )) return "PROVIDER_CHECKPOINT_EPOCH_MISMATCH";
  if (
    snapshot.checkpoint.settledSequence !== checkpoint.settledSequence ||
    snapshot.checkpoint.sourceHeadSequence !== checkpoint.sourceHeadSequence ||
    !sameDate(snapshot.checkpoint.settledAt, checkpoint.settledAt) ||
    !sameDate(snapshot.checkpoint.sourceHeadAt, checkpoint.sourceHeadAt)
  ) return "PROVIDER_CHECKPOINT_REGRESSED";
  return null;
}

function publicConfiguration(
  checkpoint: SettledProviderCatalogCheckpoint,
  snapshot: ProviderCatalogReleaseSourceSnapshot,
): Readonly<{
  configuration: ApprovedPublicCatalogConfigurationV1 | null;
  reason: ProviderCatalogReleaseBlockReasonV1 | null;
}> {
  const candidate = {
    schemaVersion: snapshot.configuration.schemaVersion,
    configurationKey: snapshot.configuration.configurationKey,
    revision: snapshot.configuration.revision,
    approvedAt: snapshot.configuration.approvedAt,
    staleAfterSeconds: snapshot.configuration.staleAfterSeconds,
    confidencePolicy: snapshot.configuration.confidencePolicy,
    publicAssetOrigins: [...snapshot.configuration.publicAssetOrigins],
    verifiedUsdStablecoins: [
      ...snapshot.configuration.verifiedUsdStablecoins,
    ],
    categories: [...snapshot.configuration.categories],
    platforms: [snapshot.configuration.platform],
    repacks: [...snapshot.configuration.repacks],
    collectibles: [...snapshot.configuration.collectibles],
  };
  const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(candidate);
  if (!parsed.success) {
    const messages = parsed.error.issues.map(({ message }) => message);
    if (messages.some((message) => message.includes("origin"))) {
      return { configuration: null, reason: "PUBLIC_ORIGIN_UNAPPROVED" };
    }
    if (parsed.error.issues.some(({ path }) =>
      path.some((entry) => entry === "publicPromo" ||
        entry === "referralParameters"))) {
      return { configuration: null, reason: "PUBLIC_ACTION_UNAPPROVED" };
    }
    return { configuration: null, reason: "PUBLIC_CONFIGURATION_INVALID" };
  }
  if (
    snapshot.configuration.configurationKey !==
      checkpoint.sharedConfigurationEpoch.configurationKey ||
    snapshot.configuration.revision !==
      checkpoint.sharedConfigurationEpoch.revision ||
    snapshot.configuration.publicChangeSequence !==
      checkpoint.sharedConfigurationEpoch.publicChangeSequence ||
    snapshot.configuration.configurationHash !==
      checkpoint.sharedConfigurationEpoch.configurationHash ||
    Date.parse(snapshot.configuration.approvedAt) > checkpoint.settledAt.getTime()
  ) return { configuration: null, reason: "PROVIDER_CHECKPOINT_EPOCH_MISMATCH" };
  return { configuration: parsed.data, reason: null };
}

function validateReadinessAndRows(
  checkpoint: SettledProviderCatalogCheckpoint,
  snapshot: ProviderCatalogReleaseSourceSnapshot,
): ProviderCatalogReleaseBlockReasonV1 | null {
  if (
    snapshot.readiness.lifecycleState !== "active" ||
    typeof snapshot.readiness.sourceRevisionId !== "string" ||
    snapshot.readiness.sourceRevisionId.length === 0 ||
    snapshot.readiness.lifecycleSequence <= 0n ||
    snapshot.readiness.lifecycleSequence > checkpoint.settledSequence ||
    !finiteDate(snapshot.readiness.completedBackfillAt)
  ) return "INITIAL_BACKFILL_INCOMPLETE";
  if (!finiteDate(snapshot.observation.lastSuccessfulObservationAt)) {
    return "PROVIDER_SOURCE_INVALID";
  }
  const revisionKeys = new Set<string>();
  for (const revision of snapshot.revisions) {
    const revisionKey = `${revision.recordKind}\u0000${revision.externalId}`;
    if (
      revisionKeys.has(revisionKey) ||
      typeof revision.entityId !== "string" ||
      revision.entityId.length === 0 ||
      typeof revision.externalId !== "string" ||
      revision.externalId.length === 0 ||
      revision.publicChangeSequence <= 0n ||
      revision.publicChangeSequence > checkpoint.settledSequence ||
      !finiteDate(revision.sourceUpdatedAt) ||
      !finiteDate(revision.sourceCollectedAt) ||
      !finiteDate(revision.acceptedAt) ||
      revision.acceptedAt.getTime() > checkpoint.settledAt.getTime()
    ) return "PROVIDER_SOURCE_INVALID";
    revisionKeys.add(revisionKey);
  }
  const associationSources = new Set<string>();
  for (const association of snapshot.assetPackAssociations) {
    if (
      associationSources.has(association.sourceEntityId) ||
      association.sourceEntityId.length === 0 ||
      association.assetExternalId.length === 0 ||
      association.packExternalId.length === 0 ||
      association.publicChangeSequence <= 0n ||
      association.publicChangeSequence > checkpoint.settledSequence ||
      !finiteDate(association.associatedAt) ||
      association.associatedAt.getTime() > checkpoint.settledAt.getTime()
    ) return "PROVIDER_SOURCE_INVALID";
    associationSources.add(association.sourceEntityId);
  }
  const identityKeys = new Set<string>();
  for (const identity of snapshot.repackIdentities) {
    const identityKey = `${identity.platformKey}\u0000${identity.packExternalId}`;
    if (
      identityKeys.has(identityKey) ||
      identity.packExternalId.length === 0 ||
      identity.publicChangeSequence <= 0n ||
      identity.publicChangeSequence > checkpoint.settledSequence ||
      !finiteDate(identity.approvedAt) ||
      identity.approvedAt.getTime() > checkpoint.settledAt.getTime()
    ) return "PROVIDER_SOURCE_INVALID";
    identityKeys.add(identityKey);
  }
  return null;
}

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderCatalogCompletedReleaseProofV1 {
  return {
    state: "complete",
    platformKey: plan.platformKey,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    dataAsOf: plan.dataAsOf,
    publicProviderReleaseId: plan.publicProviderReleaseId,
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
  };
}

/**
 * All scope-bearing dependencies are bound at construction. Assembly callers can
 * choose a trigger only; they cannot select a tenant, provider, or watermark.
 */
export class ProviderCatalogReleaseAssembler {
  constructor(
    private readonly checkpoints: ProviderCatalogReleaseCheckpointPort,
    private readonly source: ProviderCatalogReleaseSourcePort,
    private readonly baselines: ProviderCatalogReleaseBaselinePort,
  ) {}

  async assemble(
    input: AssembleProviderCatalogReleaseInput,
  ): Promise<ProviderCatalogReleasePlanV1> {
    // Trigger provenance intentionally cannot influence immutable artifacts.
    void input.trigger;
    const checkpoint = await this.checkpoints.getCheckpoint();
    const checkpointReason = checkpointBlockReason(checkpoint);
    if (checkpointReason !== null) return blocked(checkpoint, checkpointReason);
    if (!hasSettledTimestamp(checkpoint)) {
      return blocked(checkpoint, "PROVIDER_SOURCE_INVALID");
    }

    let snapshot: ProviderCatalogReleaseSourceSnapshot;
    try {
      snapshot = await this.source.loadProviderSnapshot({ checkpoint });
    } catch (error) {
      return blocked(checkpoint, sourceErrorReason(error));
    }
    if (containsProtectedProviderCatalogReleaseField(snapshot)) {
      return blocked(checkpoint, "PROTECTED_PUBLICATION_FIELD");
    }
    const echoReason = validateSnapshotEcho(checkpoint, snapshot);
    if (echoReason !== null) return blocked(checkpoint, echoReason);
    const readinessReason = validateReadinessAndRows(checkpoint, snapshot);
    if (readinessReason !== null) return blocked(checkpoint, readinessReason);
    const configured = publicConfiguration(checkpoint, snapshot);
    if (configured.configuration === null) {
      return blocked(
        checkpoint,
        configured.reason ?? "PUBLIC_CONFIGURATION_INVALID",
      );
    }

    let projection;
    try {
      projection = projectProviderCatalogRelease({
        configuration: configured.configuration,
        platformKey: checkpoint.platformKey,
        revisions: snapshot.revisions,
        assetPackAssociations: snapshot.assetPackAssociations,
        repackIdentities: snapshot.repackIdentities,
      });
    } catch (error) {
      if (error instanceof ProviderCatalogProjectionAssemblyError) {
        const reason: ProviderCatalogReleaseBlockReasonV1 =
          error.reason === "EXACT_VALUE_INVALID"
            ? "PUBLIC_ARITHMETIC_INVALID"
            : error.reason;
        return blocked(checkpoint, reason);
      }
      return blocked(checkpoint, "CANONICAL_PROJECTION_INVALID");
    }
    if (
      projection.dataAsOf.getTime() >
      snapshot.observation.lastSuccessfulObservationAt.getTime()
    ) return blocked(checkpoint, "CANONICAL_PROJECTION_INVALID");

    let candidate: ProviderCatalogReleasePublishPlanV1;
    try {
      candidate = await buildProviderCatalogReleasePublishPlan({
        checkpoint: snapshot.checkpoint,
        configuration: snapshot.configuration,
        projection,
        lastSuccessfulObservationAt:
          snapshot.observation.lastSuccessfulObservationAt,
      });
    } catch (error) {
      if (error instanceof ProviderCatalogReleaseArtifactError) {
        return blocked(checkpoint, error.reason);
      }
      return blocked(checkpoint, "PUBLIC_CONTRACT_INVALID");
    }

    let baseline: ProviderCatalogCompletedReleaseProofV1 | null;
    try {
      baseline = await this.baselines.findComplete({
        platformKey: candidate.platformKey,
        sharedConfigurationEpoch: candidate.sharedConfigurationEpoch,
        publicProviderReleaseId: candidate.publicProviderReleaseId,
        providerReleaseFingerprint: candidate.providerReleaseFingerprint,
      });
    } catch {
      return blocked(checkpoint, "PROVIDER_SOURCE_TECHNICAL_FAILURE");
    }
    if (baseline === null) return candidate;
    const parsedBaseline = providerCatalogCompletedReleaseProofV1Schema.safeParse(
      baseline,
    );
    const expectedProof = immutableProof(candidate);
    if (
      !parsedBaseline.success ||
      canonicalJson(parsedBaseline.data) !== canonicalJson(expectedProof)
    ) return blocked(checkpoint, "PROVIDER_SOURCE_INVALID");

    const reuse: ProviderCatalogReleaseReusePlanV1 = {
      ...candidate,
      classification: "reuse",
      dataAsOf: parsedBaseline.data.dataAsOf,
      publicAssetOrigins: parsedBaseline.data.publicAssetOrigins,
      batches: [],
      reuseProof: parsedBaseline.data,
    };
    try {
      return await verifyProviderCatalogReleasePlanV1(reuse);
    } catch {
      return blocked(checkpoint, "PUBLIC_CONTRACT_INVALID");
    }
  }
}
