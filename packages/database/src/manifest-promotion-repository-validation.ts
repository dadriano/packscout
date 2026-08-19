import {
  canonicalJson,
  catalogManifestErrorEnvelopeSchema,
  catalogManifestActivateRequestSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogManifestReceiptSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  globalCatalogProviderActiveObservationV1Schema,
  parseCatalogManifestPublicationJson,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  type CatalogManifestReceipt,
  type GlobalCatalogProviderActiveObservationV1,
} from "@packscout/contracts";
import type { ProviderCatalogCheckpointRecord } from
  "./public-change-settlement-repository.provider-read.ts";
import {
  PROMOTION_V2_MAX_MANIFEST_RECEIPT_BYTES,
  PROMOTION_V2_MAX_REQUEST_BYTES,
  PROMOTION_V2_MAX_RESPONSE_BYTES,
  PROMOTION_V2_MAX_SUMMARY_BYTES,
  PromotionV2PersistenceError,
  promotionV2CanonicalJson,
  promotionV2Sha256,
  type ExactPromotionOperationInput,
  type ExactPromotionOperationRecord,
  type ExactPromotionReceiptEvidence,
  type ManifestPromotionActiveSelection,
  type ManifestPromotionClaim,
  type ManifestPromotionEvaluationSnapshot,
  type ManifestPromotionHealth,
  type ManifestPromotionPreparedSummary,
  type ManifestPromotionSelectedProviderProof,
} from "./promotion-v2-types.ts";

export interface ManifestPromotionLaneRow {
  bootstrapState: ManifestPromotionHealth["bootstrapState"];
  bootstrapProviderSetBody: string | null;
  bootstrapProviderSetSha256: string | null;
  currentBootstrapProofRevision: bigint | null;
  requestedEvaluationSequence: bigint;
  confirmedEvaluationSequence: bigint;
  activeGeneration: bigint;
  activeStateBody: string | null;
  activeStateSha256: string | null;
  activeStateReceiptBody: string | null;
  activeStateReceiptSha256: string | null;
  activeStateResponseBody: string | null;
  activeStateResponseSha256: string | null;
}

export interface ManifestPromotionAttemptRow {
  id: string;
  evaluationSequence: bigint;
  bootstrapProofRevision: bigint;
  bootstrapProviderSetSha256: string;
  state: ManifestPromotionClaim["state"] |
    "activated" | "refreshed" | "rolled_back" | "cleared" | "blocked" |
    "no_change" | "cas_lost" | "failed";
  preparedSummaryBody: string | null;
  preparedSummarySha256: string | null;
  preparedOperationKind: ManifestPromotionPreparedSummary["operationKind"] | null;
  evaluationSnapshotBody: string | null;
  evaluationSnapshotSha256: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  claimCount: number;
  retryCount: number;
  failureCode: string | null;
  casErrorBody: string | null;
}

export interface ManifestPromotionSnapshotProjection {
  readonly schemaVersion: 1;
  readonly evaluationSequence: string;
  readonly eligibility: Readonly<{
    readonly organizationId: string;
    readonly sharedConfigurationEpoch: Readonly<{
      readonly configurationKey: string;
      readonly revision: number;
      readonly publicChangeSequence: string;
      readonly configurationHash: string;
    }>;
    readonly confidencePolicyVersion: string;
    readonly staleAfterSeconds: number;
    readonly configuredPlatformKeys: readonly string[];
    readonly enabledPlatformKeys: readonly string[];
    readonly lifecycleDecisionSequence: string;
    readonly checkpointDigests: readonly Readonly<{
      readonly platformKey: string;
      readonly settledSequence: string;
      readonly sourceHeadSequence: string;
      readonly checkpointDigest: string;
    }>[];
  }>;
  readonly providerFacts: readonly Readonly<{
    readonly platformKey: string;
    readonly minimumEligibleCheckpoint: string;
    readonly initialBackfillComplete: boolean;
    readonly completedBackfillAt: string | null;
    readonly lastSuccessfulObservationAt: string | null;
    readonly staleAt: string | null;
    readonly latestAffectedSettledSequence: string;
    readonly latestAffectedSourceHeadSequence: string;
    readonly affectedDerivationsSettled: boolean;
    readonly settledSourceFreshness: "fresh" | "delayed";
    readonly completedHead: Readonly<{
      readonly publicProviderReleaseId: string;
      readonly providerReleaseFingerprint: string;
      readonly selectedCheckpoint: string;
      readonly proofDigest: string;
      readonly terminalReceiptSha256: string;
      readonly publishArtifactAttemptId: string;
      readonly terminalOperationKind: "finalize" | "confirmReuse";
      readonly terminalOperationId: string;
      readonly selectedProviderCheckpoint:
        GlobalCatalogProviderActiveObservationV1["selectedProviderCheckpoint"];
      readonly selectedDataAsOf: string;
    }> | null;
    readonly activeFallback: Readonly<{
      readonly publicProviderReleaseId: string;
      readonly providerReleaseFingerprint: string;
      readonly selectedCheckpoint: string;
      readonly proofDigest: string;
      readonly terminalReceiptSha256: string;
      readonly publishArtifactAttemptId: string;
      readonly terminalOperationKind: "finalize" | "confirmReuse";
      readonly terminalOperationId: string;
      readonly selectedProviderCheckpoint:
        GlobalCatalogProviderActiveObservationV1["selectedProviderCheckpoint"];
      readonly selectedDataAsOf: string;
    }> | null;
  }>[];
  readonly activeStateBody: string | null;
  readonly activeStateSha256: string | null;
}

export interface ManifestPromotionOperationRow {
  operationIndex: number;
  operationId: string;
  operationKind: string;
  requestPath: string;
  canonicalRequestBody: string;
  requestSha256: string;
  state: "pending" | "sent" | "acknowledged";
  sendCount: number;
  lastSentAt: Date | null;
  acknowledgedAt: Date | null;
  canonicalReceiptBody: string | null;
  receiptSha256: string | null;
  exactResponseBody: string | null;
  responseSha256: string | null;
}

export interface ManifestPromotionSelectionRow {
  platformKey: string;
  activeGeneration: bigint;
  manifestPublicReleaseId: string;
  providerPublicReleaseId: string;
  providerReleaseFingerprint: string;
  selectedCheckpoint: bigint;
  selectionBody: string;
  selectionSha256: string;
  providerTerminalOperationId: string;
  providerTerminalReceiptSha256: string;
  publishArtifactAttemptId: string;
  activatedAt: Date;
}

export interface ManifestPromotionCompletedHeadRow {
  platformKey: string;
  targetCheckpoint: bigint;
  publicProviderReleaseId: string;
  providerReleaseFingerprint: string;
  completedHeadBody: string;
  completedHeadSha256: string;
  terminalOperationKind: "finalize" | "confirmReuse";
  terminalOperationId: string;
  terminalReceiptSha256: string;
  canonicalReceiptBody: string;
  exactResponseBody: string | null;
  responseSha256: string | null;
  completedAt: Date;
  publishArtifactAttemptId: string;
}

export interface ManifestActiveStateReceiptEvidence
  extends ExactPromotionReceiptEvidence {
  readonly requestBody: string;
}

export function manifestPromotionByteCount(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function parseManifestCasErrorBody(body: string):
  | "CATALOG_MANIFEST_PREDECESSOR_CONFLICT"
  | "CATALOG_MANIFEST_STATE_CONFLICT" {
  if (manifestPromotionByteCount(body) > PROMOTION_V2_MAX_SUMMARY_BYTES) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  const parsed = catalogManifestErrorEnvelopeSchema.safeParse(json);
  if (!parsed.success || canonicalJson(parsed.data) !== body ||
    !["CATALOG_MANIFEST_PREDECESSOR_CONFLICT", "CATALOG_MANIFEST_STATE_CONFLICT"]
      .includes(parsed.data.code)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  return parsed.data.code as
    | "CATALOG_MANIFEST_PREDECESSOR_CONFLICT"
    | "CATALOG_MANIFEST_STATE_CONFLICT";
}

export function mapManifestPromotionOperation(
  row: ManifestPromotionOperationRow,
): ExactPromotionOperationRecord {
  return { ...row };
}

export function manifestPromotionPreparedSummaryBody(
  summary: ManifestPromotionPreparedSummary,
): string {
  return promotionV2CanonicalJson(summary);
}

export function parseManifestPromotionPreparedSummary(
  body: string,
): ManifestPromotionPreparedSummary {
  let parsed: ManifestPromotionPreparedSummary;
  try {
    parsed = JSON.parse(body) as ManifestPromotionPreparedSummary;
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  if (manifestPromotionPreparedSummaryBody(parsed) !== body ||
    !/^[0-9a-f]{64}$/u.test(parsed.evaluationSnapshotSha256)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  return parsed;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPlatformKeys(values: readonly string[]): boolean {
  return values.length <= 8 && values.every((value, index) =>
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(value) &&
      value.length <= 128 &&
      (index === 0 || codeUnitCompare(values[index - 1]!, value) < 0));
}

export function manifestCheckpointProjectionDigest(
  checkpoint: ProviderCatalogCheckpointRecord,
): string {
  return promotionV2Sha256(canonicalJson({
    platformKey: checkpoint.platformKey,
    sharedConfigurationEpoch: {
      ...checkpoint.sharedConfigurationEpoch,
      publicChangeSequence: String(
        checkpoint.sharedConfigurationEpoch.publicChangeSequence,
      ),
    },
    settledSequence: String(checkpoint.settledSequence),
    sourceHeadSequence: String(checkpoint.sourceHeadSequence),
    settledAt: checkpoint.settledAt?.toISOString() ?? null,
    sourceHeadAt: checkpoint.sourceHeadAt.toISOString(),
    blockedState: checkpoint.blockedState.kind === "ready"
      ? { kind: "ready" }
      : {
          ...checkpoint.blockedState,
          causeSequence: String(checkpoint.blockedState.causeSequence),
        },
  }));
}

export function manifestSnapshotProjection(
  snapshot: Omit<ManifestPromotionEvaluationSnapshot, "snapshotSha256">,
): ManifestPromotionSnapshotProjection {
  return {
    schemaVersion: 1,
    evaluationSequence: String(snapshot.evaluationSequence),
    eligibility: {
      organizationId: snapshot.eligibility.organizationId,
      sharedConfigurationEpoch: {
        ...snapshot.eligibility.sharedConfigurationEpoch,
        publicChangeSequence: String(
          snapshot.eligibility.sharedConfigurationEpoch.publicChangeSequence,
        ),
      },
      confidencePolicyVersion: snapshot.eligibility.confidencePolicyVersion,
      staleAfterSeconds: snapshot.eligibility.staleAfterSeconds,
      configuredPlatformKeys: [...snapshot.eligibility.configuredPlatformKeys],
      enabledPlatformKeys: [...snapshot.eligibility.enabledPlatformKeys],
      lifecycleDecisionSequence: String(
        snapshot.eligibility.lifecycleDecisionSequence,
      ),
      checkpointDigests: snapshot.eligibility.checkpoints.map((checkpoint) => ({
        platformKey: checkpoint.platformKey,
        settledSequence: String(checkpoint.settledSequence),
        sourceHeadSequence: String(checkpoint.sourceHeadSequence),
        checkpointDigest: manifestCheckpointProjectionDigest(checkpoint),
      })),
    },
    providerFacts: snapshot.providerFacts.map((fact) => {
      const lastSuccessfulObservationAt =
        fact.lastSuccessfulObservationAt?.toISOString() ?? null;
      const staleAt = fact.lastSuccessfulObservationAt === null
        ? null
        : new Date(
            fact.lastSuccessfulObservationAt.getTime() +
              snapshot.eligibility.staleAfterSeconds * 1_000,
          ).toISOString();
      return {
        platformKey: fact.platformKey,
        minimumEligibleCheckpoint: String(fact.minimumEligibleCheckpoint),
        initialBackfillComplete: fact.initialBackfillComplete,
        completedBackfillAt: fact.completedBackfillAt?.toISOString() ?? null,
        lastSuccessfulObservationAt,
        staleAt,
        latestAffectedSettledSequence: String(fact.checkpoint.settledSequence),
        latestAffectedSourceHeadSequence:
          String(fact.checkpoint.sourceHeadSequence),
        affectedDerivationsSettled:
          fact.checkpoint.blockedState.kind === "ready",
        settledSourceFreshness:
          fact.checkpoint.blockedState.kind === "ready" &&
            fact.checkpoint.settledSequence === fact.checkpoint.sourceHeadSequence
            ? "fresh" as const
            : "delayed" as const,
        completedHead: fact.completedHead === null ? null : {
        publicProviderReleaseId: fact.completedHead.publicProviderReleaseId,
        providerReleaseFingerprint:
          fact.completedHead.providerReleaseFingerprint,
        selectedCheckpoint: String(fact.completedHead.targetCheckpoint),
        proofDigest: fact.completedHead.completedHeadSha256,
        terminalReceiptSha256: fact.completedHead.terminalReceiptSha256,
        publishArtifactAttemptId: fact.completedHead.publishArtifactAttemptId,
        terminalOperationKind: fact.completedHead.terminalOperationKind,
        terminalOperationId: fact.completedHead.terminalOperationId,
        selectedProviderCheckpoint:
          fact.completedHead.completedHead.providerCheckpoint,
        selectedDataAsOf: fact.completedHead.completedHead.release.dataAsOf,
      },
        activeFallback: fact.activeSelection === null ? null : {
        publicProviderReleaseId: fact.activeSelection.providerPublicReleaseId,
        providerReleaseFingerprint:
          fact.activeSelection.providerReleaseFingerprint,
        selectedCheckpoint: String(fact.activeSelection.selectedCheckpoint),
        proofDigest: fact.activeSelection.selectionSha256,
        terminalReceiptSha256:
          fact.activeSelection.providerTerminalReceiptSha256,
        publishArtifactAttemptId: fact.activeSelection.publishArtifactAttemptId,
        terminalOperationKind:
          fact.activeSelection.selection.terminalOperationKind,
        terminalOperationId:
          fact.activeSelection.selection.terminalOperationId,
        selectedProviderCheckpoint:
          fact.activeSelection.selection.selectedProviderCheckpoint,
        selectedDataAsOf: fact.activeSelection.selection.selectedDataAsOf,
        },
      };
    }),
    activeStateBody: snapshot.activeState?.canonicalStateBody ?? null,
    activeStateSha256: snapshot.activeState?.stateSha256 ?? null,
  };
}

function observationMatchesProjection(
  observation: GlobalCatalogProviderActiveObservationV1,
  selection: ManifestPromotionSelectedProviderProof,
  fact: ManifestPromotionSnapshotProjection["providerFacts"][number],
): boolean {
  const source = selection.source === "completed_head"
    ? fact.completedHead : fact.activeFallback;
  if (source === null) return false;
  return canonicalJson(observation) === canonicalJson({
    platformKey: fact.platformKey,
    publicProviderReleaseId: source.publicProviderReleaseId,
    terminalOperationKind: source.terminalOperationKind,
    terminalOperationId: source.terminalOperationId,
    terminalReceiptSha256: source.terminalReceiptSha256,
    selectedProviderCheckpoint: source.selectedProviderCheckpoint,
    selectedDataAsOf: source.selectedDataAsOf,
    latestAffectedSettledSequence: fact.latestAffectedSettledSequence,
    latestAffectedSourceHeadSequence: fact.latestAffectedSourceHeadSequence,
    initialBackfillComplete: fact.initialBackfillComplete,
    affectedDerivationsSettled: fact.affectedDerivationsSettled,
    settledSourceFreshness: fact.settledSourceFreshness,
    lastSuccessfulObservationAt: fact.lastSuccessfulObservationAt,
    staleAt: fact.staleAt,
  });
}

function selectionMatchesProjection(
  selection: ManifestPromotionSelectedProviderProof,
  fact: ManifestPromotionSnapshotProjection["providerFacts"][number],
): boolean {
  const source = selection.source === "completed_head"
    ? fact.completedHead : fact.activeFallback;
  let coversCurrentEnablement = true;
  if (selection.source === "completed_head") {
    try {
      coversCurrentEnablement = fact.initialBackfillComplete &&
        /^\d+$/u.test(fact.minimumEligibleCheckpoint) &&
        /^\d+$/u.test(source?.selectedCheckpoint ?? "") &&
        BigInt(source!.selectedCheckpoint) >=
          BigInt(fact.minimumEligibleCheckpoint);
    } catch {
      coversCurrentEnablement = false;
    }
  }
  return source !== null && coversCurrentEnablement &&
    selection.platformKey === fact.platformKey &&
    selection.publicProviderReleaseId === source.publicProviderReleaseId &&
    selection.providerReleaseFingerprint ===
      source.providerReleaseFingerprint &&
    selection.selectedCheckpoint === source.selectedCheckpoint &&
    selection.proofDigest === source.proofDigest &&
    selection.terminalReceiptSha256 === source.terminalReceiptSha256;
}

export function validateManifestSummaryAgainstProjection(
  summary: ManifestPromotionPreparedSummary,
  projectionBody: string,
  projectionSha256: string,
  operation: ExactPromotionOperationInput | null,
): void {
  if (promotionV2Sha256(projectionBody) !== projectionSha256 ||
    summary.evaluationSnapshotSha256 !== projectionSha256) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
  }
  let projection: ManifestPromotionSnapshotProjection;
  try {
    projection = JSON.parse(projectionBody) as ManifestPromotionSnapshotProjection;
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  if (canonicalJson(projection) !== projectionBody ||
    projection.schemaVersion !== 1 ||
    projection.activeStateBody !== canonicalJson(summary.expectedActiveState) ||
    canonicalJson(summary.sharedConfigurationEpoch) !==
      canonicalJson(projection.eligibility.sharedConfigurationEpoch) ||
    canonicalJson(summary.enabledPlatformKeys) !==
      canonicalJson(projection.eligibility.enabledPlatformKeys) ||
    summary.providerSelections.length !== projection.providerFacts.length ||
    summary.providerSelections.some((selection, index) =>
      !selectionMatchesProjection(selection, projection.providerFacts[index]!))) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
  }
  if (operation !== null) {
    const request = parseManifestRequest(operation);
    if (request === null || ("observation" in request &&
      (request.observation.providerSelections.length !==
        projection.providerFacts.length ||
       request.observation.providerSelections.some((observation, index) => {
         const selection = summary.providerSelections[index];
         const fact = projection.providerFacts[index];
         return selection === undefined || fact === undefined ||
           !observationMatchesProjection(observation, selection, fact);
       })))) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
    }
  }
}

function parseManifestRequest(operation: ExactPromotionOperationInput) {
  switch (operation.operationKind) {
    case "activateManifest":
      if (operation.requestPath !==
        PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest) return null;
      return parseCatalogManifestPublicationJson(
        operation.canonicalRequestBody,
        catalogManifestActivateRequestSchema,
      );
    case "refreshActiveState":
      if (operation.requestPath !==
        PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState) return null;
      return parseCatalogManifestPublicationJson(
        operation.canonicalRequestBody,
        catalogManifestRefreshActiveStateRequestSchema,
      );
    case "rollback":
      if (operation.requestPath !== PRODUCTION_CATALOG_MANIFEST_PATHS.rollback) {
        return null;
      }
      return parseCatalogManifestPublicationJson(
        operation.canonicalRequestBody,
        catalogManifestRollbackRequestSchema,
      );
    case "block":
      if (operation.requestPath !== PRODUCTION_CATALOG_MANIFEST_PATHS.block) {
        return null;
      }
      return parseCatalogManifestPublicationJson(
        operation.canonicalRequestBody,
        catalogManifestBlockRequestSchema,
      );
    default:
      return null;
  }
}

export function validateManifestPromotionPrepared(
  summary: ManifestPromotionPreparedSummary,
  operation: ExactPromotionOperationInput | null,
): void {
  const summaryBody = manifestPromotionPreparedSummaryBody(summary);
  if (manifestPromotionByteCount(summaryBody) > PROMOTION_V2_MAX_SUMMARY_BYTES ||
    !canonicalPlatformKeys(summary.enabledPlatformKeys) ||
    summary.providerSelections.length !== summary.enabledPlatformKeys.length ||
    !summary.providerSelections.every((selection, index) =>
      selection.platformKey === summary.enabledPlatformKeys[index] &&
      /^[0-9a-f]{64}$/u.test(selection.proofDigest) &&
      /^[0-9a-f]{64}$/u.test(selection.providerReleaseFingerprint) &&
      /^[0-9a-f]{64}$/u.test(selection.terminalReceiptSha256)) ||
    !/^[0-9a-f]{64}$/u.test(summary.evaluationSnapshotSha256)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  if (summary.operationKind === "no_change") {
    if (operation !== null) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
    }
    return;
  }
  if (operation === null || operation.operationIndex !== 0 ||
    operation.operationKind !== summary.operationKind ||
    manifestPromotionByteCount(operation.canonicalRequestBody) >
      PROMOTION_V2_MAX_REQUEST_BYTES) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
  }
  const request = parseManifestRequest(operation);
  if (request === null || request.operationId !== operation.operationId ||
    ("expectedActiveState" in request &&
      canonicalJson(request.expectedActiveState) !==
        canonicalJson(summary.expectedActiveState)) ||
    ("observation" in request &&
      (request.observation.providerSelections.length !==
        summary.providerSelections.length ||
       request.observation.providerSelections.some((selection, index) => {
         const proof = summary.providerSelections[index];
         return proof === undefined || selection.platformKey !== proof.platformKey ||
           selection.publicProviderReleaseId !== proof.publicProviderReleaseId ||
           selection.selectedProviderCheckpoint.settledSequence !==
             proof.selectedCheckpoint ||
           selection.terminalReceiptSha256 !== proof.terminalReceiptSha256;
       }))) ||
    ("manifest" in request && canonicalJson({
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: request.manifest.providerReferenceSetHash,
    }) !== canonicalJson(summary.manifestIdentity)) ||
    ("manifest" in request && "providerReferences" in request.manifest &&
      Array.isArray(request.manifest.providerReferences) &&
      request.manifest.providerReferences.some((reference: {
        platformKey: string;
        publicProviderReleaseId: string;
        providerReleaseFingerprint: string;
      }, index: number) => {
        const proof = summary.providerSelections[index];
        return proof === undefined || reference.platformKey !== proof.platformKey ||
          reference.publicProviderReleaseId !== proof.publicProviderReleaseId ||
          reference.providerReleaseFingerprint !== proof.providerReleaseFingerprint;
      }))) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
  }
}

export function manifestPointerIdentity(value: Readonly<{
  publicReleaseId: string;
  manifestFingerprint: string;
  sharedConfigurationEpoch: unknown;
  providerReferenceSetHash: string;
}>): unknown {
  return {
    publicReleaseId: value.publicReleaseId,
    manifestFingerprint: value.manifestFingerprint,
    sharedConfigurationEpoch: value.sharedConfigurationEpoch,
    providerReferenceSetHash: value.providerReferenceSetHash,
  };
}

function manifestReceiptMatchesRequest(
  receipt: CatalogManifestReceipt,
  operation: ManifestPromotionOperationRow,
): boolean {
  const request = parseManifestRequest(operation);
  if (request === null || receipt.operationKind !== operation.operationKind ||
    receipt.operationId !== request.operationId ||
    !("idempotencyKey" in receipt) ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.requestDigest !== operation.requestSha256) return false;
  if (receipt.operationKind === "block") {
    return "publicReleaseId" in request &&
      receipt.publicReleaseId === request.publicReleaseId &&
      receipt.manifestFingerprint === request.manifestFingerprint &&
      receipt.details.blockSequence === request.blockSequence &&
      receipt.details.reason === request.reason;
  }
  if (!("expectedActiveState" in request) ||
    !("activeState" in receipt.details) ||
    canonicalJson(receipt.details.expectedActiveState) !==
      canonicalJson(request.expectedActiveState)) return false;
  if (receipt.operationKind === "activateManifest" ||
    receipt.operationKind === "refreshActiveState") {
    if (!("manifest" in request) || !("observation" in request)) return false;
    return receipt.publicReleaseId === request.manifest.publicReleaseId &&
      receipt.manifestFingerprint === request.manifest.manifestFingerprint &&
      receipt.details.activeState.activeManifest !== null &&
      canonicalJson(manifestPointerIdentity(
        receipt.details.activeState.activeManifest,
      )) === canonicalJson(manifestPointerIdentity(request.manifest)) &&
      canonicalJson(receipt.details.activeState.observation) ===
        canonicalJson(request.observation);
  }
  if (receipt.operationKind === "rollback") {
    if (!("rollbackKind" in request) ||
      receipt.rollbackKind !== request.rollbackKind) return false;
    if (request.rollbackKind === "clear") {
      return receipt.rollbackKind === "clear" &&
        receipt.details.activeState.activeManifest === null &&
        receipt.details.activeState.observation === null;
    }
    return receipt.rollbackKind === "manifest" &&
      receipt.publicReleaseId === request.targetManifest.publicReleaseId &&
      receipt.manifestFingerprint === request.targetManifest.manifestFingerprint &&
      receipt.details.activeState.activeManifest !== null &&
      canonicalJson(manifestPointerIdentity(
        receipt.details.activeState.activeManifest,
      )) ===
        canonicalJson(request.targetManifest) &&
      canonicalJson(receipt.details.activeState.observation) ===
        canonicalJson(request.observation);
  }
  return false;
}

export function parseManifestPromotionReceiptEvidence(
  operation: ManifestPromotionOperationRow,
  evidence: ExactPromotionReceiptEvidence,
): Readonly<{
  receipt: CatalogManifestReceipt;
  receiptSha256: string;
  exactResponseBody: string | null;
  responseSha256: string | null;
}> {
  if (manifestPromotionByteCount(evidence.canonicalReceiptBody) >
    PROMOTION_V2_MAX_MANIFEST_RECEIPT_BYTES) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  let json: unknown;
  try {
    json = JSON.parse(evidence.canonicalReceiptBody);
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  const parsed = catalogManifestReceiptSchema.safeParse(json);
  if (!parsed.success ||
    canonicalJson(parsed.data) !== evidence.canonicalReceiptBody ||
    !manifestReceiptMatchesRequest(parsed.data, operation)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  const exactResponseBody = evidence.exactResponseBody ?? null;
  let responseSha256: string | null = null;
  if (exactResponseBody !== null) {
    if (manifestPromotionByteCount(exactResponseBody) >
      PROMOTION_V2_MAX_RESPONSE_BYTES) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    let responseJson: unknown;
    try {
      responseJson = JSON.parse(exactResponseBody);
    } catch {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    const envelope = catalogManifestSignedReceiptEnvelopeSchema.safeParse(
      responseJson,
    );
    if (!envelope.success ||
      canonicalJson(envelope.data.receipt) !== evidence.canonicalReceiptBody) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    responseSha256 = promotionV2Sha256(exactResponseBody);
  }
  return {
    receipt: parsed.data,
    receiptSha256: promotionV2Sha256(evidence.canonicalReceiptBody),
    exactResponseBody,
    responseSha256,
  };
}

export function mapManifestPromotionSelection(
  row: ManifestPromotionSelectionRow,
): ManifestPromotionActiveSelection {
  if (promotionV2Sha256(row.selectionBody) !== row.selectionSha256) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  let selection;
  try {
    selection = globalCatalogProviderActiveObservationV1Schema.parse(
      JSON.parse(row.selectionBody),
    );
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  if (canonicalJson(selection) !== row.selectionBody ||
    selection.platformKey !== row.platformKey ||
    selection.publicProviderReleaseId !== row.providerPublicReleaseId ||
    selection.selectedProviderCheckpoint.settledSequence !==
      String(row.selectedCheckpoint) ||
    selection.terminalOperationId !== row.providerTerminalOperationId ||
    selection.terminalReceiptSha256 !== row.providerTerminalReceiptSha256) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  return { ...row, selection };
}
