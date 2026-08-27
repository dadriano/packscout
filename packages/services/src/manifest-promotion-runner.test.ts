import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestReceiptDigest,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type CatalogManifestReceipt,
  type CatalogManifestStatusNotFoundReceipt,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import { composeGlobalCatalogManifest } from "./catalog-manifest-composer.ts";
import { PublicationClientError } from "./convex-publication-http-client.ts";
import { buildProviderCatalogReleasePublishPlan } from "./provider-catalog-release-artifacts.ts";
import { projectProviderCatalogRelease } from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import {
  MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY,
  prepareManifestPromotionOperation,
} from "./manifest-promotion-operations.ts";
import { ManifestPromotionRunner } from "./manifest-promotion-runner.ts";
import type {
  CatalogManifestPublicationResult,
  ManifestPromotionClaim,
  ManifestPromotionEvaluationSnapshot,
  ManifestPromotionLanePort,
  ManifestPromotionOperationRecord,
  ManifestPromotionPreparedOperation,
  ManifestPromotionPreparedSummary,
  ManifestPromotionTransport,
  ManifestProviderPlanResolver,
} from "./manifest-promotion-types.ts";
import type { ProviderPromotionCompletedHead } from
  "./provider-promotion-types.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function providerPlan(platformKey: "alpha" | "beta") {
  const checkpoint = providerFixtureCheckpoint({ platformKey });
  const configuration = providerFixtureApprovedConfiguration({ platformKey });
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

function emptyState(): ActiveCatalogManifestStateV1 {
  return {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
}

async function activationFixture() {
  const plans = await Promise.all([providerPlan("alpha"), providerPlan("beta")]);
  const manifest = await composeGlobalCatalogManifest({
    enabledPlatformKeys: ["alpha", "beta"],
    providerPlans: plans,
    approvedConfiguration: {
      sharedConfigurationEpoch: plans[0]!.sharedConfigurationEpoch,
      confidencePolicyVersion: "confidence-v1",
    },
  });
  const providerSelections = plans.map((plan, index) => ({
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    terminalOperationKind: "finalize" as const,
    terminalOperationId: `finalize:${plan.publicProviderReleaseId}`,
    terminalReceiptSha256: (index === 0 ? "a" : "b").repeat(64),
    selectedProviderCheckpoint: plan.providerCheckpoint,
    selectedDataAsOf: plan.dataAsOf,
    latestAffectedSettledSequence: plan.providerCheckpoint.settledSequence,
    latestAffectedSourceHeadSequence: plan.providerCheckpoint.settledSequence,
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: "fresh" as const,
    lastSuccessfulObservationAt: plan.observation.lastSuccessfulObservationAt,
    staleAt: plan.observation.staleAt,
  }));
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: 1,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections,
  });
  const operationId = "manifest:1:activateManifest";
  const request: CatalogManifestActivateRequest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    manifest,
    observation,
    expectedActiveState: emptyState(),
  };
  const prepared = prepareManifestPromotionOperation("activateManifest", request);
  const summary: ManifestPromotionPreparedSummary = {
    operationKind: "activateManifest",
    expectedActiveState: request.expectedActiveState,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    enabledPlatformKeys: manifest.enabledPlatformKeys,
    providerSelections: plans.map((plan, index) => ({
      platformKey: plan.platformKey,
      source: "completed_head",
      proofDigest: (index === 0 ? "c" : "d").repeat(64),
      publicProviderReleaseId: plan.publicProviderReleaseId,
      providerReleaseFingerprint: plan.providerReleaseFingerprint,
      selectedCheckpoint: plan.providerCheckpoint.settledSequence,
      terminalReceiptSha256: providerSelections[index]!.terminalReceiptSha256,
    })),
    evaluationSnapshotSha256: "e".repeat(64),
    manifestIdentity: {
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
    },
  };
  return { request, prepared, summary, plans };
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

function planningHead(
  plan: ProviderCatalogReleasePublishPlanV1,
  index: number,
): ProviderPromotionCompletedHead {
  const completedHead = {
    platformKey: plan.platformKey,
    release: immutableProof(plan),
    providerCheckpoint: plan.providerCheckpoint,
    observation: plan.observation,
  };
  const completedHeadBody = canonicalJson(completedHead);
  const canonicalReceiptBody = canonicalJson({
    kind: "finalize",
    publicProviderReleaseId: plan.publicProviderReleaseId,
  });
  return {
    platformKey: plan.platformKey,
    targetCheckpoint: BigInt(plan.providerCheckpoint.settledSequence),
    publicProviderReleaseId: plan.publicProviderReleaseId,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    completedHead,
    completedHeadBody,
    completedHeadSha256: sha256(completedHeadBody),
    terminalOperationKind: "finalize",
    terminalOperationId: `finalize:${plan.publicProviderReleaseId}`,
    terminalReceiptSha256: sha256(canonicalReceiptBody),
    canonicalReceiptBody,
    exactResponseBody: null,
    responseSha256: null,
    completedAt: new Date("2026-08-15T03:00:00.000Z"),
    publishArtifactAttemptId: `publish-${index}`,
  };
}

function planningSnapshot(
  plans: readonly ProviderCatalogReleasePublishPlanV1[],
): ManifestPromotionEvaluationSnapshot {
  const epoch = plans[0]!.sharedConfigurationEpoch;
  const providerFacts = plans.map((plan, index) => {
    const observedAt = new Date(plan.observation.lastSuccessfulObservationAt);
    return {
      platformKey: plan.platformKey,
      checkpoint: {
        platformKey: plan.platformKey,
        sharedConfigurationEpoch: {
          configurationKey: epoch.configurationKey,
          revision: epoch.revision,
          publicChangeSequence: BigInt(epoch.publicChangeSequence),
          configurationHash: epoch.configurationHash,
        },
        settledSequence: BigInt(plan.providerCheckpoint.settledSequence),
        sourceHeadSequence: BigInt(plan.providerCheckpoint.settledSequence),
        settledAt: plan.providerCheckpoint.settledAt === null
          ? null : new Date(plan.providerCheckpoint.settledAt),
        sourceHeadAt: observedAt,
        blockedState: { kind: "ready" as const },
      },
      minimumEligibleCheckpoint: 1n,
      initialBackfillComplete: true,
      completedBackfillAt: observedAt,
      lastSuccessfulObservationAt: observedAt,
      completedHead: planningHead(plan, index),
      activeSelection: null,
    };
  });
  const state = emptyState();
  return {
    evaluationSequence: 1n,
    snapshotSha256: "e".repeat(64),
    eligibility: {
      organizationId: "54000000-0000-4000-8000-000000000001",
      sharedConfigurationEpoch:
        providerFacts[0]!.checkpoint.sharedConfigurationEpoch,
      confidencePolicyVersion: "confidence-v1",
      staleAfterSeconds: 900,
      configuredPlatformKeys: plans.map(({ platformKey }) => platformKey),
      enabledPlatformKeys: plans.map(({ platformKey }) => platformKey),
      lifecycleDecisionSequence: 1n,
      checkpoints: providerFacts.map(({ checkpoint }) => checkpoint),
    },
    providerFacts,
    activeState: {
      state,
      canonicalStateBody: canonicalJson(state),
      stateSha256: sha256(canonicalJson(state)),
      canonicalActiveStateReceiptBody: canonicalJson({ state }),
      activeStateReceiptSha256: sha256(canonicalJson({ state })),
      exactResponseBody: null,
      responseSha256: null,
      activeSelections: [],
    },
  };
}

async function clearFixture() {
  const activation = await activationFixture();
  const active: ActiveCatalogManifestStateV1 = {
    generation: 1,
    activeManifest: {
      publicReleaseId: activation.request.manifest.publicReleaseId,
      manifestFingerprint: activation.request.manifest.manifestFingerprint,
      sharedConfigurationEpoch:
        activation.request.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash:
        activation.request.manifest.providerReferenceSetHash,
      createdAt: "2026-08-15T03:00:01.000Z",
      completedAt: "2026-08-15T03:00:01.000Z",
    },
    previousManifest: null,
    observation: activation.request.observation,
    terminalReceiptSha256: "f".repeat(64),
  };
  const operationId = "manifest:2:rollback";
  const prepared = prepareManifestPromotionOperation("rollback", {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    rollbackKind: "clear",
    clearAuthorization: "clear_catalog_manifest_v1",
    expectedActiveState: active,
  });
  const summary: ManifestPromotionPreparedSummary = {
    operationKind: "rollback",
    expectedActiveState: active,
    sharedConfigurationEpoch:
      activation.request.manifest.sharedConfigurationEpoch,
    enabledPlatformKeys: [],
    providerSelections: [],
    evaluationSnapshotSha256: "e".repeat(64),
    manifestIdentity: null,
  };
  return { prepared, summary };
}

function operationRecord(
  prepared: ReturnType<typeof prepareManifestPromotionOperation>,
): ManifestPromotionOperationRecord {
  return {
    ...prepared,
    state: "pending",
    sendCount: 0,
    lastSentAt: null,
    acknowledgedAt: null,
    canonicalReceiptBody: null,
    receiptSha256: null,
    exactResponseBody: null,
    responseSha256: null,
  };
}

class MemoryManifestLane implements ManifestPromotionLanePort {
  claimCount = 0;
  evaluationSequence = 1n;
  retryCount = 0;
  retryExhaustionResults: Array<"status_required" | "requeued"> = [];
  completeOutcome: string | null = null;
  operation: ManifestPromotionOperationRecord | null;
  retryDue = false;
  terminal = false;
  pendingCasLoss: ManifestPromotionClaim["pendingCasLoss"] = null;
  triggerIdentities: string[] = [];
  casEvidence: Parameters<ManifestPromotionLanePort["recordCasLoss"]>[0] | null =
    null;

  constructor(
    public summary: ManifestPromotionPreparedSummary | null,
    operation: ManifestPromotionOperationRecord | null,
    public snapshot: ManifestPromotionEvaluationSnapshot | null = null,
  ) {
    this.operation = operation;
  }

  enqueueEvaluation(input: { causeIdentity: string }) {
    const created = !this.triggerIdentities.includes(input.causeIdentity);
    this.triggerIdentities.push(input.causeIdentity);
    return Promise.resolve({
      evaluationSequence: this.evaluationSequence,
      result: created ? "created" as const : "coalesced" as const,
    });
  }

  claim(input: { leaseExpiresAt: Date }) {
    if (this.terminal || (this.claimCount > 0 && !this.retryDue)) {
      return Promise.resolve(null);
    }
    this.claimCount += 1;
    this.retryDue = false;
    return Promise.resolve({
      attemptId: "manifest-attempt",
      claimToken: `manifest-claim-${this.claimCount}`,
      claimExpiresAt: input.leaseExpiresAt,
      claimCount: this.claimCount,
      retryCount: this.retryCount,
      recovered: this.claimCount > 1,
      evaluationSequence: this.evaluationSequence,
      state: "in_progress" as const,
      preparedSummary: this.summary,
      pendingCasLoss: this.pendingCasLoss,
    } satisfies ManifestPromotionClaim);
  }

  heartbeat() { return Promise.resolve(true); }
  loadEvaluationSnapshot() { return Promise.resolve(this.snapshot); }
  persistPreparedOperation(input: {
    summary: ManifestPromotionPreparedSummary;
    operation: ManifestPromotionPreparedOperation | null;
  }) {
    this.summary = input.summary;
    this.operation = input.operation === null
      ? null : operationRecord(input.operation);
    return Promise.resolve(this.operation);
  }
  listOperations() {
    return Promise.resolve(this.operation === null ? [] : [this.operation]);
  }

  markOperationSent(input: { sentAt: Date }) {
    if (this.operation === null) return Promise.resolve(false);
    Object.assign(this.operation, {
      state: "sent",
      sendCount: this.operation.sendCount + 1,
      lastSentAt: input.sentAt,
    });
    return Promise.resolve(true);
  }

  acknowledgeOperation(input: {
    acknowledgedAt: Date;
    evidence: { canonicalReceiptBody: string; exactResponseBody?: string | null };
  }) {
    if (this.operation === null) return Promise.resolve(false);
    Object.assign(this.operation, {
      state: "acknowledged",
      acknowledgedAt: input.acknowledgedAt,
      canonicalReceiptBody: input.evidence.canonicalReceiptBody,
      receiptSha256: sha256(input.evidence.canonicalReceiptBody),
      exactResponseBody: input.evidence.exactResponseBody ?? null,
      responseSha256: input.evidence.exactResponseBody === undefined
        ? null
        : sha256(input.evidence.exactResponseBody ?? ""),
    });
    return Promise.resolve(true);
  }

  scheduleRetry() {
    this.retryCount += 1;
    this.retryDue = true;
    return Promise.resolve(true);
  }

  recordRetryExhaustion() {
    if (this.operation !== null && this.operation.sendCount > 0) {
      this.retryCount += 1;
      this.retryDue = true;
      this.retryExhaustionResults.push("status_required");
      return Promise.resolve({
        result: "status_required" as const,
        evaluationSequence: this.evaluationSequence,
      });
    }
    this.completeOutcome = "failed";
    this.evaluationSequence += 1n;
    this.retryCount = 0;
    this.summary = null;
    this.operation = null;
    if (this.snapshot !== null) {
      this.snapshot = {
        ...this.snapshot,
        evaluationSequence: this.evaluationSequence,
        snapshotSha256: sha256(`snapshot:${this.evaluationSequence}`),
      };
    }
    this.retryDue = true;
    this.retryExhaustionResults.push("requeued");
    return Promise.resolve({
      result: "requeued" as const,
      evaluationSequence: this.evaluationSequence,
    });
  }

  deferCasLoss(input: Parameters<ManifestPromotionLanePort["deferCasLoss"]>[0]) {
    const parsed = JSON.parse(input.canonicalErrorBody) as {
      code:
        | "CATALOG_MANIFEST_PREDECESSOR_CONFLICT"
        | "CATALOG_MANIFEST_STATE_CONFLICT";
    };
    this.pendingCasLoss = {
      failureCode: parsed.code,
      canonicalErrorBody: input.canonicalErrorBody,
    };
    this.retryDue = true;
    return Promise.resolve(true);
  }

  complete(input: { outcome: string }) {
    this.completeOutcome = input.outcome;
    this.terminal = true;
    return Promise.resolve(true);
  }

  recordCasLoss(input: Parameters<ManifestPromotionLanePort["recordCasLoss"]>[0]) {
    this.casEvidence = input;
    this.pendingCasLoss = null;
    this.terminal = true;
    return Promise.resolve({ evaluationSequence: 2n });
  }

  loadHealth() {
    return Promise.resolve({
      bootstrapState: "verified_empty" as const,
      requestedEvaluationSequence: 1n,
      confirmedEvaluationSequence: this.terminal ? 1n : 0n,
      activeGeneration: 0n,
      activePublicReleaseId: null,
      activeConfigurationEpochSequence: null,
      delayedProviderCount: 0,
      activeAttemptId: this.terminal ? null : "manifest-attempt",
      activeAttemptState: this.terminal ? null : "in_progress",
      activeAttemptStartedAt: this.terminal
        ? null : new Date("2026-08-16T12:00:00.000Z"),
      retryAt: null,
      lastActivatedAt: null,
      lastReconciledAt: null,
    });
  }
}

class MemoryManifestTransport implements ManifestPromotionTransport {
  receipt: CatalogManifestPublicationResult | null = null;
  sends = 0;
  statuses = 0;
  loseAfterStore = false;
  loseBeforeStore = false;
  statusFailures = 0;
  casLoss = false;
  activeStateCalls = 0;
  activeStateFailures = 0;

  async mutationReceipt(
    kind: "activateManifest" | "refreshActiveState" | "rollback",
    canonicalRequestBody: string,
  ) {
    const parsed = JSON.parse(canonicalRequestBody) as Record<string, unknown>;
    if (kind === "rollback") {
      const request = parsed as unknown as {
        operationId: string;
        idempotencyKey: string;
        expectedActiveState: ActiveCatalogManifestStateV1;
      };
      const withoutDigest = {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationKind: "rollback" as const,
        rollbackKind: "clear" as const,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        publicReleaseId: null,
        manifestFingerprint: null,
        terminalState: "cleared" as const,
        result: "cleared" as const,
        serverTime: "2026-08-15T03:00:01.000Z",
        requestDigest: sha256(canonicalRequestBody),
        details: {
          expectedActiveState: request.expectedActiveState,
          activeState: {
            generation: request.expectedActiveState.generation + 1,
            activeManifest: null,
            previousManifest: null,
            observation: null,
          },
        },
      };
      const receipt = {
        ...withoutDigest,
        receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
      } satisfies CatalogManifestReceipt;
      const canonicalReceiptBody = canonicalJson(receipt);
      return {
        receipt,
        canonicalReceiptBody,
        receiptSha256: sha256(canonicalReceiptBody),
        exactResponseBody: canonicalJson({ ok: true, receipt }),
        exactResponseSha256: sha256(canonicalJson({ ok: true, receipt })),
      };
    }
    const request = parsed as unknown as CatalogManifestActivateRequest;
    const withoutDigest = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "activateManifest" as const,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      terminalState: "complete" as const,
      result: "activated" as const,
      serverTime: "2026-08-15T03:00:01.000Z",
      requestDigest: sha256(canonicalRequestBody),
      details: {
        expectedActiveState: request.expectedActiveState,
        activeState: {
          generation: request.expectedActiveState.generation + 1,
          activeManifest: {
            publicReleaseId: request.manifest.publicReleaseId,
            manifestFingerprint: request.manifest.manifestFingerprint,
            sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
            providerReferenceSetHash: request.manifest.providerReferenceSetHash,
            createdAt: "2026-08-15T03:00:01.000Z",
            completedAt: "2026-08-15T03:00:01.000Z",
          },
          previousManifest: request.expectedActiveState.activeManifest,
          observation: request.observation,
        },
      },
    };
    const receipt = {
      ...withoutDigest,
      receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
    } satisfies CatalogManifestReceipt;
    const canonicalReceiptBody = canonicalJson(receipt);
    return {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
      exactResponseBody: canonicalJson({ ok: true, receipt }),
      exactResponseSha256: sha256(canonicalJson({ ok: true, receipt })),
    };
  }

  async sendExact(input: {
    kind: "activateManifest" | "refreshActiveState" | "rollback";
    canonicalRequestBody: string;
  }) {
    assert.ok(input.kind === "activateManifest" || input.kind === "rollback");
    this.sends += 1;
    if (this.casLoss) {
      throw new PublicationClientError(
        "CATALOG_MANIFEST_PREDECESSOR_CONFLICT",
        "terminal",
        false,
        null,
        canonicalJson({
          error: "Catalog manifest predecessor does not match.",
          code: "CATALOG_MANIFEST_PREDECESSOR_CONFLICT",
        }),
      );
    }
    if (this.loseBeforeStore) {
      this.loseBeforeStore = false;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    const publication = await this.mutationReceipt(
      input.kind,
      input.canonicalRequestBody,
    );
    this.receipt = publication;
    if (this.loseAfterStore) {
      this.loseAfterStore = false;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    return publication;
  }

  status(request: Parameters<ManifestPromotionTransport["status"]>[0]) {
    this.statuses += 1;
    if (this.statusFailures > 0) {
      this.statusFailures -= 1;
      return Promise.reject(new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      ));
    }
    if (this.receipt !== null) return Promise.resolve(this.receipt);
    const receipt: CatalogManifestStatusNotFoundReceipt = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      target: request.target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: "2026-08-15T03:00:02.000Z",
      requestDigest: request.target.requestDigest,
      details: {},
      receiptDigest: null,
    };
    const canonicalReceiptBody = canonicalJson(receipt);
    return Promise.resolve({
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
      exactResponseBody: canonicalJson({ ok: true, receipt }),
      exactResponseSha256: sha256(canonicalJson({ ok: true, receipt })),
    });
  }

  async activeState() {
    this.activeStateCalls += 1;
    if (this.activeStateFailures > 0) {
      this.activeStateFailures -= 1;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR",
        "retryable",
        true,
      );
    }
    const state = emptyState();
    const withoutDigest = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "activeState" as const,
      operationId: "catalog-manifest-active-state",
      terminalState: "observed" as const,
      result: "active_state" as const,
      serverTime: "2026-08-15T03:00:03.000Z",
      requestDigest: sha256(MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY),
      details: { activeState: state },
    };
    const receipt = {
      ...withoutDigest,
      receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
    };
    const canonicalReceiptBody = canonicalJson(receipt);
    return {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
      exactResponseBody: canonicalJson({ ok: true, receipt }),
      exactResponseSha256: sha256(canonicalJson({ ok: true, receipt })),
    };
  }
}

function runner(
  lane: MemoryManifestLane,
  transport: MemoryManifestTransport,
  healthThrows = false,
  providerPlans: ManifestProviderPlanResolver = {
    loadPublishPlan: () => Promise.resolve(null),
  },
  options: Readonly<{ maximumRetries?: number; alerts?: string[] }> = {},
) {
  return new ManifestPromotionRunner({
    workerId: "manifest-worker",
    lane,
    triggers: {
      loadEvaluationTrigger: () => Promise.resolve({
        cause: "observation_succeeded",
        causeIdentity: "f".repeat(64),
      }),
    },
    providerPlans,
    transport,
    clearTransport: transport,
    clock: { now: () => new Date("2026-08-15T03:00:00.000Z") },
    random: { fraction: () => 0 },
    alerts: { notify: ({ failureCode }) => {
      options.alerts?.push(failureCode);
      return Promise.resolve();
    } },
    maximumRetries: options.maximumRetries,
    health: healthThrows ? { report() { throw new Error("sink"); } } : undefined,
  });
}

test("manifest lane activates once and isolates health fan-out failure", async () => {
  const fixture = await activationFixture();
  const lane = new MemoryManifestLane(
    fixture.summary,
    operationRecord(fixture.prepared),
  );
  const transport = new MemoryManifestTransport();

  const cycle = await runner(lane, transport, true).runCycle();

  assert.equal(cycle.outcome, "activated");
  assert.equal(lane.completeOutcome, "activated");
  assert.equal(transport.sends, 1);
  assert.deepEqual(lane.triggerIdentities, ["f".repeat(64)]);
});

test("transient artifact resolution retries the same evaluation then activates", async () => {
  const fixture = await activationFixture();
  const lane = new MemoryManifestLane(
    null,
    null,
    planningSnapshot(fixture.plans),
  );
  const transport = new MemoryManifestTransport();
  const plans = new Map(fixture.plans.map((plan) => [
    `${plan.platformKey}:${plan.publicProviderReleaseId}`,
    plan,
  ]));
  let failedOnce = false;
  const providerPlans: ManifestProviderPlanResolver = {
    loadPublishPlan(input) {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("temporary artifact database failure");
      }
      return Promise.resolve(
        plans.get(`${input.platformKey}:${input.publicProviderReleaseId}`) ??
          null,
      );
    },
  };
  const target = runner(lane, transport, false, providerPlans);

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  assert.equal(lane.completeOutcome, null);
  assert.equal((await target.runCycle()).outcome, "activated");
  assert.equal(lane.claimCount, 2);
  assert.equal(transport.sends, 1);
});

test("predispatch retry exhaustion forces a fresh same-trigger evaluation", async () => {
  const fixture = await activationFixture();
  const lane = new MemoryManifestLane(
    null,
    null,
    planningSnapshot(fixture.plans),
  );
  const transport = new MemoryManifestTransport();
  const plans = new Map(fixture.plans.map((plan) => [
    `${plan.platformKey}:${plan.publicProviderReleaseId}`,
    plan,
  ]));
  let failures = 2;
  const providerPlans: ManifestProviderPlanResolver = {
    loadPublishPlan(input) {
      if (input.platformKey === "alpha" && failures > 0) {
        failures -= 1;
        throw new Error("temporary artifact database failure");
      }
      return Promise.resolve(
        plans.get(`${input.platformKey}:${input.publicProviderReleaseId}`) ??
          null,
      );
    },
  };
  const alerts: string[] = [];
  const target = runner(
    lane,
    transport,
    false,
    providerPlans,
    { maximumRetries: 1, alerts },
  );

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  const exhausted = await target.runCycle();
  const recovered = await target.runCycle();

  assert.equal(exhausted.outcome, "failed");
  assert.equal(exhausted.failureCode, "MANIFEST_RETRY_EXHAUSTED");
  assert.equal(recovered.outcome, "activated");
  assert.equal(recovered.evaluationSequence, 2n);
  assert.deepEqual(lane.retryExhaustionResults, ["requeued"]);
  assert.deepEqual(alerts, ["MANIFEST_RETRY_EXHAUSTED"]);
  assert.equal(transport.sends, 1);
});

test("dispatched retry exhaustion remains status-first on the same manifest op", async () => {
  const fixture = await activationFixture();
  const lane = new MemoryManifestLane(
    fixture.summary,
    operationRecord(fixture.prepared),
  );
  const transport = new MemoryManifestTransport();
  transport.loseBeforeStore = true;
  transport.statusFailures = 1;
  const alerts: string[] = [];
  const target = runner(
    lane,
    transport,
    false,
    undefined,
    { maximumRetries: 1, alerts },
  );

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  const exhausted = await target.runCycle();
  const recovered = await target.runCycle();

  assert.equal(exhausted.outcome, "retry_scheduled");
  assert.equal(exhausted.failureCode, "MANIFEST_RETRY_EXHAUSTED");
  assert.equal(recovered.outcome, "activated");
  assert.equal(recovered.evaluationSequence, 1n);
  assert.deepEqual(lane.retryExhaustionResults, ["status_required"]);
  assert.deepEqual(alerts, ["MANIFEST_RETRY_EXHAUSTED"]);
  assert.equal(transport.statuses, 2);
  assert.equal(transport.sends, 2);
});

test("process restart after lost manifest activation reconciles status-first", async () => {
  const fixture = await activationFixture();
  const lane = new MemoryManifestLane(
    fixture.summary,
    operationRecord(fixture.prepared),
  );
  const transport = new MemoryManifestTransport();
  transport.loseAfterStore = true;
  assert.equal(
    (await runner(lane, transport).runCycle()).outcome,
    "retry_scheduled",
  );
  assert.equal(
    (await runner(lane, transport).runCycle()).outcome,
    "activated",
  );
  assert.equal(transport.sends, 1);
  assert.equal(transport.statuses, 1);
});

test("CAS loss survives probe outage and restart without replaying stale bytes", async () => {
  const fixture = await activationFixture();
  const lane = new MemoryManifestLane(
    fixture.summary,
    operationRecord(fixture.prepared),
  );
  const transport = new MemoryManifestTransport();
  transport.casLoss = true;
  transport.activeStateFailures = 1;

  const conflict = await runner(lane, transport).runCycle();
  const probeOutage = await runner(lane, transport).runCycle();
  const reconciled = await runner(lane, transport).runCycle();

  assert.equal(conflict.outcome, "retry_scheduled");
  assert.equal(probeOutage.outcome, "retry_scheduled");
  assert.equal(reconciled.outcome, "cas_lost");
  assert.equal(transport.sends, 1);
  assert.equal(transport.statuses, 0);
  assert.equal(transport.activeStateCalls, 2);
  assert.equal(
    lane.casEvidence?.activeStateEvidence.requestBody,
    MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY,
  );
  assert.equal(lane.completeOutcome, null);
});

test("last-provider clear uses clear credential and status-first restart recovery", async () => {
  const fixture = await clearFixture();
  const lane = new MemoryManifestLane(
    fixture.summary,
    operationRecord(fixture.prepared),
  );
  const transport = new MemoryManifestTransport();
  transport.loseAfterStore = true;
  const target = runner(lane, transport);

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  assert.equal((await target.runCycle()).outcome, "cleared");
  assert.equal(lane.completeOutcome, "cleared");
  assert.equal(transport.sends, 1);
  assert.equal(transport.statuses, 1);
});
