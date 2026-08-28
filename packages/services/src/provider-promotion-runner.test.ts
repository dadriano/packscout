import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  buildPublicCollectibleSearchText,
  canonicalJson,
  catalogManifestReceiptDigest,
  normalizePublicSearchText,
  providerReleaseReceiptDigest,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type CatalogManifestReceipt,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseImmutableProofV1,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusNotFoundReceipt,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import { PublicationClientError } from "./convex-publication-http-client.ts";
import {
  parseManifestPromotionOperation,
} from "./manifest-promotion-operations.ts";
import { prepareManifestPromotion } from "./manifest-promotion-planner.ts";
import { ManifestPromotionRunner } from "./manifest-promotion-runner.ts";
import type {
  CatalogManifestPublicationResult,
  ManifestPromotionActiveSelection,
  ManifestPromotionActiveState,
  ManifestPromotionClaim,
  ManifestPromotionEvaluationSnapshot,
  ManifestPromotionLanePort,
  ManifestPromotionOperationRecord,
  ManifestPromotionPreparedOperation,
  ManifestPromotionPreparedSummary,
  ManifestPromotionProviderFact,
  ManifestPromotionTransport,
  ManifestProviderPlanResolver,
} from "./manifest-promotion-types.ts";
import { buildProviderCatalogReleasePublishPlan } from "./provider-catalog-release-artifacts.ts";
import { projectProviderCatalogRelease } from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import { parseProviderPromotionOperation } from "./provider-promotion-operations.ts";
import { ProviderPromotionRunner } from "./provider-promotion-runner.ts";
import type {
  ProviderPromotionCheckpointIdentity,
  ProviderPromotionClaim,
  ProviderPromotionCompletedHead,
  ProviderPromotionLanePort,
  ProviderPromotionOperationRecord,
  ProviderPromotionPreparedOperation,
  ProviderPromotionPreparedSummary,
  ProviderPromotionTransport,
  ProviderReleasePublicationResult,
} from "./provider-promotion-types.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function plan(platformKey: "alpha" | "beta") {
  const checkpoint = providerFixtureCheckpoint({ platformKey });
  const configuration = providerFixtureApprovedConfiguration({ platformKey });
  return planFrom({ checkpoint, configuration });
}

async function planFrom(input: Readonly<{
  checkpoint: ReturnType<typeof providerFixtureCheckpoint>;
  configuration: ReturnType<typeof providerFixtureApprovedConfiguration>;
  lastSuccessfulObservationAt?: Date;
}>) {
  const { checkpoint, configuration } = input;
  const snapshot = providerFixtureSnapshot({
    checkpoint,
    configuration,
    lastSuccessfulObservationAt: input.lastSuccessfulObservationAt,
  });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: checkpoint.platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return {
    checkpoint,
    plan: await buildProviderCatalogReleasePublishPlan({
      checkpoint: snapshot.checkpoint,
      configuration: snapshot.configuration,
      projection,
      lastSuccessfulObservationAt:
        snapshot.observation.lastSuccessfulObservationAt,
    }),
  };
}

async function representativeVolumePlan() {
  const checkpoint = providerFixtureCheckpoint({ platformKey: "alpha" });
  const configuration = providerFixtureApprovedConfiguration({
    platformKey: "alpha",
  });
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });
  const base = projectProviderCatalogRelease({
    configuration,
    platformKey: "alpha",
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  const seed = base.collectibles[0]!;
  const collectibles = [
    ...base.collectibles,
    ...Array.from({ length: 8_000 - base.collectibles.length }, (_, index) => {
      const name = `${seed.name} volume ${String(index + 1).padStart(5, "0")}`;
      const collectible = {
        ...seed,
        publicCollectibleId:
          `71000000-0000-5000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        name,
        normalizedName: normalizePublicSearchText(name),
      };
      return {
        ...collectible,
        searchText: buildPublicCollectibleSearchText(collectible),
      };
    }),
  ];
  const built = await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection: { ...base, collectibles },
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
  return { checkpoint, plan: built };
}

function immutableProviderProof(
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

function manifestCompletedHead(
  plan: ProviderCatalogReleasePublishPlanV1,
  proofByte: string,
): ProviderPromotionCompletedHead {
  const completedHead = {
    platformKey: plan.platformKey,
    release: immutableProviderProof(plan),
    providerCheckpoint: plan.providerCheckpoint,
    observation: plan.observation,
  };
  const completedHeadBody = canonicalJson(completedHead);
  const canonicalReceiptBody = canonicalJson({
    kind: "finalize",
    publicProviderReleaseId: plan.publicProviderReleaseId,
    proof: proofByte,
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
    publishArtifactAttemptId: `${plan.platformKey}-publish-artifact`,
  };
}

function manifestFact(input: Readonly<{
  plan: ProviderCatalogReleasePublishPlanV1;
  checkpoint: ReturnType<typeof providerFixtureCheckpoint>;
  head: ProviderPromotionCompletedHead | null;
  activeSelection?: ManifestPromotionActiveSelection | null;
}>): ManifestPromotionProviderFact {
  return {
    platformKey: input.plan.platformKey,
    checkpoint: input.checkpoint,
    minimumEligibleCheckpoint: 1n,
    initialBackfillComplete: true,
    completedBackfillAt: new Date("2026-08-15T02:00:00.000Z"),
    lastSuccessfulObservationAt:
      new Date(input.checkpoint.lastSuccessfulObservationAt),
    completedHead: input.head,
    activeSelection: input.activeSelection ?? null,
  };
}

function emptyManifestActiveState(): ManifestPromotionActiveState {
  const state: ActiveCatalogManifestStateV1 = {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
  const stateBody = canonicalJson(state);
  return {
    state,
    canonicalStateBody: stateBody,
    stateSha256: sha256(stateBody),
    canonicalActiveStateReceiptBody: canonicalJson({ state }),
    activeStateReceiptSha256: sha256(canonicalJson({ state })),
    exactResponseBody: null,
    responseSha256: null,
    activeSelections: [],
  };
}

function manifestSnapshot(input: Readonly<{
  sequence: bigint;
  facts: readonly ManifestPromotionProviderFact[];
  activeState?: ManifestPromotionActiveState;
}>): ManifestPromotionEvaluationSnapshot {
  const platformKeys = input.facts.map(({ platformKey }) => platformKey);
  const epoch = input.facts[0]!.checkpoint.sharedConfigurationEpoch;
  return {
    evaluationSequence: input.sequence,
    snapshotSha256: sha256(`healthy-path:${input.sequence}`),
    eligibility: {
      organizationId: "54000000-0000-4000-8000-000000000001",
      sharedConfigurationEpoch: epoch,
      confidencePolicyVersion: "confidence-v1",
      staleAfterSeconds: 900,
      configuredPlatformKeys: platformKeys,
      enabledPlatformKeys: platformKeys,
      lifecycleDecisionSequence: input.sequence,
      checkpoints: input.facts.map(({ checkpoint }) => checkpoint),
    },
    providerFacts: input.facts,
    activeState: input.activeState ?? emptyManifestActiveState(),
  };
}

function manifestPlanResolver(
  plans: readonly ProviderCatalogReleasePublishPlanV1[],
): ManifestProviderPlanResolver {
  const byId = new Map(plans.map((plan) => [
    `${plan.platformKey}:${plan.publicProviderReleaseId}`,
    plan,
  ]));
  return {
    loadPublishPlan(input) {
      return Promise.resolve(
        byId.get(`${input.platformKey}:${input.publicProviderReleaseId}`) ??
          null,
      );
    },
  };
}

function activeManifestFromRequest(
  request: CatalogManifestActivateRequest,
  heads: readonly ProviderPromotionCompletedHead[],
): ManifestPromotionActiveState {
  const state: ActiveCatalogManifestStateV1 = {
    generation: 1,
    activeManifest: {
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: request.manifest.providerReferenceSetHash,
      createdAt: "2026-08-15T03:00:01.000Z",
      completedAt: "2026-08-15T03:00:01.000Z",
    },
    previousManifest: null,
    observation: request.observation,
    terminalReceiptSha256: "f".repeat(64),
  };
  const activeSelections = request.observation.providerSelections.map(
    (selection): ManifestPromotionActiveSelection => {
      const head = heads.find(({ platformKey }) =>
        platformKey === selection.platformKey)!;
      const selectionBody = canonicalJson(selection);
      return {
        platformKey: selection.platformKey,
        activeGeneration: 1n,
        manifestPublicReleaseId: request.manifest.publicReleaseId,
        providerPublicReleaseId: selection.publicProviderReleaseId,
        providerReleaseFingerprint: head.providerReleaseFingerprint,
        selectedCheckpoint:
          BigInt(selection.selectedProviderCheckpoint.settledSequence),
        selection,
        selectionBody,
        selectionSha256: sha256(selectionBody),
        providerTerminalOperationId: selection.terminalOperationId,
        providerTerminalReceiptSha256: selection.terminalReceiptSha256,
        publishArtifactAttemptId: head.publishArtifactAttemptId,
        activatedAt: new Date("2026-08-15T03:00:01.000Z"),
      };
    },
  );
  const stateBody = canonicalJson(state);
  return {
    state,
    canonicalStateBody: stateBody,
    stateSha256: sha256(stateBody),
    canonicalActiveStateReceiptBody: canonicalJson({ state }),
    activeStateReceiptSha256: sha256(canonicalJson({ state })),
    exactResponseBody: null,
    responseSha256: null,
    activeSelections,
  };
}

class MemoryProviderLane implements ProviderPromotionLanePort {
  checkpoint: ProviderPromotionCheckpointIdentity | null = null;
  attemptCheckpoint: ProviderPromotionCheckpointIdentity | null = null;
  claimCount = 0;
  evaluationSequence = 1n;
  retryCount = 0;
  retryExhaustionResults: Array<"status_required" | "requeued"> = [];
  completedHead: ProviderPromotionCompletedHead | null = null;
  completedOutcome: string | null = null;
  operations: ProviderPromotionOperationRecord[] = [];
  prepared: ProviderPromotionPreparedSummary | null = null;
  retryDue = false;
  terminal = false;
  reconciliationLoss: string | null = null;

  constructor(readonly platformKey: string) {}

  enqueueEvaluation(input: {
    checkpoint: ProviderPromotionCheckpointIdentity;
    requestedAt: Date;
  }) {
    void input.requestedAt;
    const created = this.checkpoint === null;
    this.checkpoint = input.checkpoint;
    return Promise.resolve({
      evaluationSequence: this.evaluationSequence,
      result: created ? "created" as const : "coalesced" as const,
    });
  }

  claim(input: { workerId: string; now: Date; leaseExpiresAt: Date }) {
    void input.workerId;
    void input.now;
    if (this.checkpoint === null || this.terminal ||
        (this.claimCount > 0 && !this.retryDue)) return Promise.resolve(null);
    this.claimCount += 1;
    this.retryDue = false;
    this.attemptCheckpoint ??= this.checkpoint;
    return Promise.resolve({
      attemptId: `${this.platformKey}-attempt`,
      claimToken: `${this.platformKey}-claim-${this.claimCount}`,
      claimExpiresAt: input.leaseExpiresAt,
      claimCount: this.claimCount,
      retryCount: this.retryCount,
      recovered: this.claimCount > 1,
      evaluationSequence: this.evaluationSequence,
      checkpointSha256: "a".repeat(64),
      platformKey: this.platformKey,
      checkpoint: this.attemptCheckpoint,
      state: this.prepared === null ? "assembling" as const : "in_progress" as const,
      preparedSummary: this.prepared,
    } satisfies ProviderPromotionClaim);
  }

  heartbeat() { return Promise.resolve(true); }
  loadCompletedHead() { return Promise.resolve(this.completedHead); }

  recordReconciliationLoss(input: {
    failureCode: string;
    canonicalErrorBody: string;
  }) {
    assert.equal(JSON.parse(input.canonicalErrorBody).code, input.failureCode);
    this.reconciliationLoss = input.failureCode;
    this.terminal = true;
    return Promise.resolve({ evaluationSequence: 2n });
  }

  persistPreparedOperations(input: {
    summary: ProviderPromotionPreparedSummary;
    operations: readonly ProviderPromotionPreparedOperation[];
  }) {
    this.prepared = input.summary;
    this.operations = input.operations.map((operation) => ({
      ...operation,
      state: "pending" as const,
      sendCount: 0,
      lastSentAt: null,
      acknowledgedAt: null,
      canonicalReceiptBody: null,
      receiptSha256: null,
      exactResponseBody: null,
      responseSha256: null,
    }));
    return Promise.resolve(this.operations);
  }

  listOperations() { return Promise.resolve(this.operations); }

  markOperationSent(input: { operationId: string; sentAt: Date }) {
    const operation = this.operations.find(
      ({ operationId }) => operationId === input.operationId,
    );
    if (operation === undefined) return Promise.resolve(false);
    Object.assign(operation, {
      state: "sent",
      sendCount: operation.sendCount + 1,
      lastSentAt: input.sentAt,
    });
    return Promise.resolve(true);
  }

  acknowledgeOperation(input: {
    operationId: string;
    evidence: { canonicalReceiptBody: string; exactResponseBody?: string | null };
    acknowledgedAt: Date;
  }) {
    const operation = this.operations.find(
      ({ operationId }) => operationId === input.operationId,
    );
    if (operation === undefined) return Promise.resolve(false);
    Object.assign(operation, {
      state: "acknowledged",
      acknowledgedAt: input.acknowledgedAt,
      canonicalReceiptBody: input.evidence.canonicalReceiptBody,
      receiptSha256: sha256(input.evidence.canonicalReceiptBody),
      exactResponseBody: input.evidence.exactResponseBody ?? null,
      responseSha256: input.evidence.exactResponseBody == null
        ? null
        : sha256(input.evidence.exactResponseBody),
    });
    return Promise.resolve(true);
  }

  scheduleRetry() {
    this.retryCount += 1;
    this.retryDue = true;
    return Promise.resolve(true);
  }

  recordRetryExhaustion() {
    if (this.operations.some(({ sendCount }) => sendCount > 0)) {
      this.retryCount += 1;
      this.retryDue = true;
      this.retryExhaustionResults.push("status_required");
      return Promise.resolve({
        result: "status_required" as const,
        evaluationSequence: this.evaluationSequence,
      });
    }
    this.completedOutcome = "failed";
    this.evaluationSequence += 1n;
    this.retryCount = 0;
    this.prepared = null;
    this.operations = [];
    this.attemptCheckpoint = this.checkpoint;
    this.retryDue = true;
    this.retryExhaustionResults.push("requeued");
    return Promise.resolve({
      result: "requeued" as const,
      evaluationSequence: this.evaluationSequence,
    });
  }

  complete(input: { outcome: string }) {
    this.completedOutcome = input.outcome;
    this.terminal = true;
    return Promise.resolve(true);
  }

  loadHealth() {
    return Promise.resolve({
      platformKey: this.platformKey,
      lifecycleState: "active" as const,
      settledCheckpoint: this.checkpoint?.settledSequence ?? 0n,
      sourceHeadCheckpoint: this.checkpoint?.sourceHeadSequence ?? 0n,
      requestedEvaluationSequence: this.checkpoint === null ? 0n : 1n,
      confirmedEvaluationSequence: this.terminal ? 1n : 0n,
      completedCheckpoint: 0n,
      completedPublicProviderReleaseId: null,
      activeCheckpoint: null,
      activePublicProviderReleaseId: null,
      activeManifestPublicReleaseId: null,
      activeAttemptId: this.terminal ? null : `${this.platformKey}-attempt`,
      activeAttemptState: this.terminal ? null : "in_progress",
      activeAttemptStartedAt: this.terminal
        ? null : new Date("2026-08-16T12:00:00.000Z"),
      retryAt: null,
      completedAt: null,
    });
  }
}

class MemoryProviderTransport implements ProviderPromotionTransport {
  readonly receipts = new Map<string, ProviderReleasePublicationResult>();
  readonly sends = new Map<string, number>();
  readonly statuses = new Map<string, number>();
  loseAfterStore: string | null = null;
  loseBeforeStore: string | null = null;
  statusFailures = 0;
  conflictOnSend:
    | "PROVIDER_RELEASE_PREDECESSOR_CONFLICT"
    | "PROVIDER_RELEASE_STATE_CONFLICT"
    | "PROVIDER_RELEASE_RECONCILIATION_FAILED"
    | null = null;

  async sendExact(input: {
    kind: "start" | "applyBatch" | "finalize" | "confirmReuse";
    canonicalRequestBody: string;
  }): Promise<ProviderReleasePublicationResult> {
    const operation = {
      operationIndex: 0,
      operationKind: input.kind,
      operationId: JSON.parse(input.canonicalRequestBody).operationId as string,
      requestPath: `/internal/provider-release/v1/${input.kind}`,
      canonicalRequestBody: input.canonicalRequestBody,
      requestSha256: sha256(input.canonicalRequestBody),
    } as ProviderPromotionPreparedOperation;
    const request = parseProviderPromotionOperation({
      ...operation,
      requestPath: input.kind === "applyBatch"
        ? "/internal/provider-release/v1/apply-batch"
        : input.kind === "confirmReuse"
          ? "/internal/provider-release/v1/confirm-reuse"
          : operation.requestPath,
    });
    const count = (this.sends.get(request.operationId) ?? 0) + 1;
    this.sends.set(request.operationId, count);
    if (this.conflictOnSend !== null) {
      const code = this.conflictOnSend;
      this.conflictOnSend = null;
      const canonicalErrorBody = canonicalJson({
        error: "provider release reconciliation conflict",
        code,
      });
      throw new PublicationClientError(
        code,
        "terminal",
        false,
        null,
        canonicalErrorBody,
        sha256(canonicalErrorBody),
      );
    }
    if (this.loseBeforeStore === input.kind) {
      this.loseBeforeStore = null;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    assert.ok("release" in request);
    const common = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationKind: input.kind,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
      providerCheckpoint: request.providerCheckpoint,
      serverTime: "2026-08-15T03:00:01.000Z",
      requestDigest: sha256(input.canonicalRequestBody),
    };
    const context = {
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark,
      observation: request.observation,
      expectedCompletedHead: request.expectedCompletedHead,
    };
    let body: Record<string, unknown>;
    if (input.kind === "start") {
      body = {
        ...common,
        terminalState: "staging",
        result: "created",
        details: { ...context, acceptedBatchCount: 0 },
      };
    } else if (input.kind === "applyBatch" && "batch" in request) {
      body = {
        ...common,
        terminalState: "staging",
        result: "accepted",
        details: {
          ...context,
          batchIndex: request.batch.batchIndex,
          kind: request.batch.kind,
          batchHash: request.batch.batchHash,
          recordCount: request.batch.records.length,
          byteCount: request.batch.byteCount,
          acceptedBatchCount: request.batch.batchIndex + 1,
          acceptedCounts: request.release.counts,
          acceptedEntityHashes: request.release.entityHashes,
          acceptedBatchChainHash: request.release.batchChainHash,
        },
      };
    } else {
      body = {
        ...common,
        terminalState: "complete",
        result: input.kind === "finalize" ? "completed" : "reused",
        details: {
          ...context,
          completedHead: {
            platformKey: request.release.platformKey,
            release: request.release,
            providerCheckpoint: request.providerCheckpoint,
            observation: request.observation,
          },
        },
      };
    }
    const receipt = {
      ...body,
      receiptDigest: await providerReleaseReceiptDigest(body),
    } as ProviderReleaseReceipt;
    const canonicalReceiptBody = canonicalJson(receipt);
    const result = {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
    } satisfies ProviderReleasePublicationResult;
    this.receipts.set(request.operationId, result);
    if (this.loseAfterStore === input.kind) {
      this.loseAfterStore = null;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    return result;
  }

  async status(request: ProviderReleaseStatusRequest) {
    const id = request.target.operationId;
    this.statuses.set(id, (this.statuses.get(id) ?? 0) + 1);
    if (this.statusFailures > 0) {
      this.statusFailures -= 1;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    }
    const found = this.receipts.get(id);
    if (found !== undefined) return found;
    const receipt: ProviderReleaseStatusNotFoundReceipt = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      target: request.target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: "2026-08-15T03:00:02.000Z",
      requestDigest: request.target.requestDigest,
      details: {},
      receiptDigest: null,
    };
    const canonicalReceiptBody = canonicalJson(receipt);
    return {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
    };
  }
}

function runner(input: Awaited<ReturnType<typeof plan>>, lane: MemoryProviderLane,
  transport: MemoryProviderTransport, healthThrows = false, overrides: Readonly<{
    checkpoint?: { current: Awaited<ReturnType<typeof plan>>["checkpoint"] };
    assemblerPlan?: Awaited<ReturnType<typeof plan>>["plan"];
    assemblyFailures?: { remaining: number };
    maximumRetries?: number;
    alerts?: string[];
    onAssemble?: () => void;
  }> = {}) {
  return new ProviderPromotionRunner({
    platformKey: input.checkpoint.platformKey,
    workerId: `${input.checkpoint.platformKey}-worker`,
    lane,
    checkpoints: {
      getCheckpoint: () => Promise.resolve(
        overrides.checkpoint?.current ?? input.checkpoint,
      ),
    },
    assembler: {
      assemble: () => {
        overrides.onAssemble?.();
        if (overrides.assemblyFailures !== undefined &&
            overrides.assemblyFailures.remaining > 0) {
          overrides.assemblyFailures.remaining -= 1;
          return Promise.reject(new Error("temporary assembler failure"));
        }
        return Promise.resolve(overrides.assemblerPlan ?? input.plan);
      },
    },
    transport,
    clock: { now: () => new Date("2026-08-15T03:00:00.000Z") },
    random: { fraction: () => 0 },
    alerts: { notify: ({ failureCode }) => {
      overrides.alerts?.push(failureCode);
      return Promise.resolve();
    } },
    maximumRetries: overrides.maximumRetries,
    health: healthThrows ? { report() { throw new Error("sink"); } } : undefined,
  });
}

test("provider lanes complete concurrently without sharing claims", async () => {
  const [alpha, beta] = await Promise.all([plan("alpha"), plan("beta")]);
  const transport = new MemoryProviderTransport();
  const alphaLane = new MemoryProviderLane("alpha");
  const betaLane = new MemoryProviderLane("beta");

  const [alphaResult, betaResult] = await Promise.all([
    runner(alpha, alphaLane, transport).runCycle(),
    runner(beta, betaLane, transport).runCycle(),
  ]);

  assert.equal(alphaResult.outcome, "published");
  assert.equal(betaResult.outcome, "published");
  assert.notEqual(alphaResult.attemptId, betaResult.attemptId);
  assert.equal(alphaLane.completedOutcome, "published");
  assert.equal(betaLane.completedOutcome, "published");
});

test("process restart after lost finalize response reconciles status-first", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  transport.loseAfterStore = "finalize";
  assert.equal(
    (await runner(input, lane, transport, true).runCycle()).outcome,
    "retry_scheduled",
  );
  assert.equal(
    (await runner(input, lane, transport, true).runCycle()).outcome,
    "published",
  );
  const finalize = [...transport.sends.keys()].find((id) => id.startsWith("finalize:"))!;
  assert.equal(transport.sends.get(finalize), 1);
  assert.equal(transport.statuses.get(finalize), 1);
});

test("predispatch retry exhaustion forces a fresh same-checkpoint evaluation", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  const assemblyFailures = { remaining: 2 };
  const alerts: string[] = [];
  const target = runner(input, lane, transport, false, {
    assemblyFailures,
    maximumRetries: 1,
    alerts,
  });

  const first = await target.runCycle();
  const exhausted = await target.runCycle();
  const recovered = await target.runCycle();

  assert.equal(first.outcome, "retry_scheduled");
  assert.equal(exhausted.outcome, "failed");
  assert.equal(exhausted.failureCode, "PROVIDER_RETRY_EXHAUSTED");
  assert.equal(recovered.outcome, "published");
  assert.equal(recovered.evaluationSequence, 2n);
  assert.deepEqual(lane.retryExhaustionResults, ["requeued"]);
  assert.deepEqual(alerts, ["PROVIDER_RETRY_EXHAUSTED"]);
});

test("dispatched retry exhaustion preserves exact status-first work", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  transport.loseBeforeStore = "start";
  transport.statusFailures = 1;
  const alerts: string[] = [];
  const target = runner(input, lane, transport, false, {
    maximumRetries: 1,
    alerts,
  });

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  const exhausted = await target.runCycle();
  const recovered = await target.runCycle();

  assert.equal(exhausted.outcome, "retry_scheduled");
  assert.equal(exhausted.failureCode, "PROVIDER_RETRY_EXHAUSTED");
  assert.equal(recovered.outcome, "published");
  assert.equal(recovered.evaluationSequence, 1n);
  assert.deepEqual(lane.retryExhaustionResults, ["status_required"]);
  assert.deepEqual(alerts, ["PROVIDER_RETRY_EXHAUSTED"]);
  const start = [...transport.sends.keys()].find((id) => id.startsWith("start:"))!;
  assert.equal(transport.statuses.get(start), 2);
  assert.equal(transport.sends.get(start), 2);
});

test("signed status not-found permits one exact replay after an ambiguous send", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  transport.loseBeforeStore = "start";
  const target = runner(input, lane, transport);

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  assert.equal((await target.runCycle()).outcome, "published");
  const start = [...transport.sends.keys()].find((id) => id.startsWith("start:"))!;
  assert.equal(transport.sends.get(start), 2);
  assert.equal(transport.statuses.get(start), 1);
});

test("exact predecessor conflict terminalizes stale attempt and forces reevaluation", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  transport.conflictOnSend = "PROVIDER_RELEASE_PREDECESSOR_CONFLICT";

  const cycle = await runner(input, lane, transport).runCycle();

  assert.equal(cycle.outcome, "reconciliation_lost");
  assert.equal(cycle.failureCode, "PROVIDER_RELEASE_PREDECESSOR_CONFLICT");
  assert.equal(
    lane.reconciliationLoss,
    "PROVIDER_RELEASE_PREDECESSOR_CONFLICT",
  );
  assert.equal(lane.completedOutcome, null);
});

test("dispatched attempt resumes status-first after a newer checkpoint arrives", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  transport.loseAfterStore = "finalize";
  const checkpoint = { current: input.checkpoint };
  const target = runner(input, lane, transport, false, { checkpoint });

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  checkpoint.current = providerFixtureCheckpoint({
    platformKey: "alpha",
    settledSequence: 30n,
    sourceHeadSequence: 30n,
    settledAt: new Date("2026-08-15T03:10:00.000Z"),
    sourceHeadAt: new Date("2026-08-15T03:10:00.000Z"),
    lastSuccessfulObservationAt: new Date("2026-08-15T03:10:00.000Z"),
    staleAt: new Date("2026-08-15T03:25:00.000Z"),
  });
  assert.equal((await target.runCycle()).outcome, "published");
  assert.equal(lane.completedOutcome, "published");
  const finalize = [...transport.sends.keys()].find(
    (id) => id.startsWith("finalize:"),
  )!;
  assert.equal(transport.sends.get(finalize), 1);
  assert.equal(transport.statuses.get(finalize), 1);
});

test("disabled lane reconciles a dispatched attempt without enqueueing fresh work", async () => {
  const input = await plan("alpha");
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  transport.loseAfterStore = "finalize";
  const target = runner(input, lane, transport);

  assert.equal((await target.runCycle()).outcome, "retry_scheduled");
  const checkpointBeforeRecovery = lane.checkpoint;
  assert.equal((await target.runRecoveryCycle()).outcome, "published");

  assert.equal(lane.checkpoint, checkpointBeforeRecovery);
  const finalize = [...transport.sends.keys()].find(
    (operationId) => operationId.startsWith("finalize:"),
  )!;
  assert.equal(transport.sends.get(finalize), 1);
  assert.equal(transport.statuses.get(finalize), 1);
});

test("observation-only change at a completed checkpoint skips confirm-reuse", async () => {
  const input = await plan("alpha");
  const observationOnlyCheckpoint = providerFixtureCheckpoint({
    platformKey: "alpha",
    settledSequence: input.checkpoint.settledSequence,
    sourceHeadSequence: input.checkpoint.sourceHeadSequence,
    settledAt: input.checkpoint.settledAt,
    sourceHeadAt: input.checkpoint.sourceHeadAt,
    lastSuccessfulObservationAt:
      new Date("2026-08-15T03:05:00.000Z"),
    staleAt: new Date("2026-08-15T03:20:00.000Z"),
  });
  const lane = new MemoryProviderLane("alpha");
  lane.completedHead = manifestCompletedHead(input.plan, "a");
  const transport = new MemoryProviderTransport();

  const cycle = await runner(input, lane, transport, false, {
    checkpoint: { current: observationOnlyCheckpoint },
  }).runCycle();

  assert.equal(cycle.outcome, "superseded");
  assert.equal(lane.completedOutcome, "superseded");
  assert.equal(transport.sends.size, 0);
  assert.equal(
    [...transport.sends.keys()].some((id) => id.startsWith("reuse:")),
    false,
  );
});

test("same-settled observation race supersedes before dispatch", async () => {
  const input = await plan("alpha");
  const racedCheckpoint = providerFixtureCheckpoint({
    platformKey: "alpha",
    settledSequence: input.checkpoint.settledSequence,
    sourceHeadSequence: input.checkpoint.sourceHeadSequence,
    settledAt: input.checkpoint.settledAt,
    sourceHeadAt: input.checkpoint.sourceHeadAt,
    lastSuccessfulObservationAt:
      new Date("2026-08-15T02:30:00.000Z"),
    staleAt: new Date("2026-08-15T02:45:00.000Z"),
  });
  const raced = await planFrom({
    checkpoint: racedCheckpoint,
    configuration: providerFixtureApprovedConfiguration({
      platformKey: "alpha",
    }),
    lastSuccessfulObservationAt:
      racedCheckpoint.lastSuccessfulObservationAt,
  });
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  const checkpoint = { current: input.checkpoint };

  const cycle = await runner(input, lane, transport, false, {
    checkpoint,
    assemblerPlan: raced.plan,
    onAssemble() { checkpoint.current = racedCheckpoint; },
  }).runCycle();

  assert.equal(cycle.outcome, "superseded");
  assert.equal(transport.sends.size, 0);
  assert.equal(lane.completedOutcome, "superseded");
});

test("configuration epoch race supersedes before dispatch", async () => {
  const input = await plan("alpha");
  const racedCheckpoint = providerFixtureCheckpoint({
    platformKey: "alpha",
    revision: 2,
    configurationHash: "b".repeat(64),
  });
  const raced = await planFrom({
    checkpoint: racedCheckpoint,
    configuration: providerFixtureApprovedConfiguration({
      platformKey: "alpha",
      revision: 2,
    }),
  });
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  const checkpoint = { current: input.checkpoint };

  const cycle = await runner(input, lane, transport, false, {
    checkpoint,
    assemblerPlan: raced.plan,
    onAssemble() { checkpoint.current = racedCheckpoint; },
  }).runCycle();

  assert.equal(cycle.outcome, "superseded");
  assert.equal(transport.sends.size, 0);
  assert.equal(lane.completedOutcome, "superseded");
});

test("stable-checkpoint assembler scope drift retries instead of coalescing away work", async () => {
  const input = await plan("alpha");
  const drifted = await planFrom({
    checkpoint: input.checkpoint,
    configuration: providerFixtureApprovedConfiguration({
      platformKey: "alpha",
    }),
    lastSuccessfulObservationAt:
      new Date("2026-08-15T02:30:00.000Z"),
  });
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();

  const cycle = await runner(input, lane, transport, false, {
    assemblerPlan: drifted.plan,
  }).runCycle();

  assert.equal(cycle.outcome, "retry_scheduled");
  assert.equal(cycle.failureCode, "PROVIDER_ASSEMBLY_SCOPE_INVALID");
  assert.equal(lane.completedOutcome, null);
  assert.equal(transport.sends.size, 0);
});

function volumeManifestOperationRecord(
  operation: ManifestPromotionPreparedOperation,
): ManifestPromotionOperationRecord {
  return {
    ...operation,
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

class VolumeManifestLane implements ManifestPromotionLanePort {
  operation: ManifestPromotionOperationRecord | null = null;
  summary: ManifestPromotionPreparedSummary | null = null;
  completedOutcome: string | null = null;
  claimed = false;

  constructor(readonly snapshot: ManifestPromotionEvaluationSnapshot) {}

  enqueueEvaluation() {
    return Promise.resolve({
      evaluationSequence: this.snapshot.evaluationSequence,
      result: "coalesced" as const,
    });
  }

  claim(input: Readonly<{ leaseExpiresAt: Date }>) {
    if (this.claimed) return Promise.resolve(null);
    this.claimed = true;
    return Promise.resolve({
      attemptId: "manifest-volume-attempt",
      claimToken: "manifest-volume-claim",
      claimExpiresAt: input.leaseExpiresAt,
      claimCount: 1,
      retryCount: 0,
      recovered: false,
      evaluationSequence: this.snapshot.evaluationSequence,
      state: "assembling" as const,
      preparedSummary: null,
      pendingCasLoss: null,
    } satisfies ManifestPromotionClaim);
  }

  heartbeat() { return Promise.resolve(true); }
  loadEvaluationSnapshot() { return Promise.resolve(this.snapshot); }

  persistPreparedOperation(input: Readonly<{
    summary: ManifestPromotionPreparedSummary;
    operation: ManifestPromotionPreparedOperation | null;
  }>) {
    this.summary = input.summary;
    this.operation = input.operation === null
      ? null : volumeManifestOperationRecord(input.operation);
    return Promise.resolve(this.operation);
  }

  listOperations() {
    return Promise.resolve(this.operation === null ? [] : [this.operation]);
  }

  markOperationSent(input: Readonly<{ sentAt: Date }>) {
    if (this.operation === null) return Promise.resolve(false);
    Object.assign(this.operation, {
      state: "sent",
      sendCount: this.operation.sendCount + 1,
      lastSentAt: input.sentAt,
    });
    return Promise.resolve(true);
  }

  acknowledgeOperation(input: Readonly<{
    acknowledgedAt: Date;
    evidence: Readonly<{
      canonicalReceiptBody: string;
      exactResponseBody?: string | null;
    }>;
  }>) {
    if (this.operation === null) return Promise.resolve(false);
    Object.assign(this.operation, {
      state: "acknowledged",
      acknowledgedAt: input.acknowledgedAt,
      canonicalReceiptBody: input.evidence.canonicalReceiptBody,
      receiptSha256: sha256(input.evidence.canonicalReceiptBody),
      exactResponseBody: input.evidence.exactResponseBody ?? null,
      responseSha256: input.evidence.exactResponseBody === undefined
        ? null : sha256(input.evidence.exactResponseBody ?? ""),
    });
    return Promise.resolve(true);
  }

  scheduleRetry(): Promise<boolean> {
    return Promise.reject(new Error("Unexpected manifest retry."));
  }
  recordRetryExhaustion(): Promise<null> {
    return Promise.reject(new Error("Unexpected manifest retry exhaustion."));
  }
  deferCasLoss(): Promise<boolean> {
    return Promise.reject(new Error("Unexpected manifest CAS deferral."));
  }

  complete(input: Readonly<{ outcome: string }>) {
    this.completedOutcome = input.outcome;
    return Promise.resolve(true);
  }

  recordCasLoss(): Promise<null> {
    return Promise.reject(new Error("Unexpected manifest CAS loss."));
  }

  loadHealth() {
    return Promise.resolve({
      bootstrapState: "verified_active" as const,
      requestedEvaluationSequence: this.snapshot.evaluationSequence,
      confirmedEvaluationSequence: this.completedOutcome === null
        ? this.snapshot.evaluationSequence - 1n
        : this.snapshot.evaluationSequence,
      activeGeneration: BigInt(
        this.snapshot.activeState?.state.generation ?? 0,
      ),
      activePublicReleaseId:
        this.snapshot.activeState?.state.activeManifest?.publicReleaseId ?? null,
      activeConfigurationEpochSequence:
        this.snapshot.eligibility.sharedConfigurationEpoch.publicChangeSequence,
      delayedProviderCount: 1,
      activeAttemptId: this.completedOutcome === null
        ? "manifest-volume-attempt" : null,
      activeAttemptState: this.completedOutcome === null ? "in_progress" : null,
      activeAttemptStartedAt: this.completedOutcome === null
        ? new Date("2026-08-15T03:00:00.000Z") : null,
      retryAt: null,
      lastActivatedAt: this.completedOutcome === null
        ? null : new Date("2026-08-15T03:01:01.000Z"),
      lastReconciledAt: this.completedOutcome === null
        ? null : new Date("2026-08-15T03:01:01.000Z"),
    });
  }
}

class VolumeManifestTransport implements ManifestPromotionTransport {
  sends = 0;
  request: CatalogManifestActivateRequest | null = null;

  async sendExact(input: Readonly<{
    kind: "activateManifest" | "refreshActiveState" | "rollback" | "block";
    canonicalRequestBody: string;
  }>): Promise<CatalogManifestPublicationResult> {
    assert.equal(input.kind, "activateManifest");
    const request = JSON.parse(
      input.canonicalRequestBody,
    ) as CatalogManifestActivateRequest;
    this.sends += 1;
    this.request = request;
    const withoutDigest = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "activateManifest" as const,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      terminalState: "complete" as const,
      result: "activated" as const,
      serverTime: "2026-08-15T03:01:01.000Z",
      requestDigest: sha256(input.canonicalRequestBody),
      details: {
        expectedActiveState: request.expectedActiveState,
        activeState: {
          generation: request.expectedActiveState.generation + 1,
          activeManifest: {
            publicReleaseId: request.manifest.publicReleaseId,
            manifestFingerprint: request.manifest.manifestFingerprint,
            sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
            providerReferenceSetHash: request.manifest.providerReferenceSetHash,
            createdAt: "2026-08-15T03:01:01.000Z",
            completedAt: "2026-08-15T03:01:01.000Z",
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
    const exactResponseBody = canonicalJson({ ok: true, receipt });
    return {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
      exactResponseBody,
      exactResponseSha256: sha256(exactResponseBody),
    };
  }

  status(): Promise<never> {
    return Promise.reject(new Error("Unexpected manifest status lookup."));
  }

  activeState(): Promise<never> {
    return Promise.reject(new Error("Unexpected manifest active-state lookup."));
  }
}

test("8k provider completion activates one manifest with delayed fallback under one minute", async () => {
  const input = await representativeVolumePlan();
  const [oldAlpha, beta] = await Promise.all([plan("alpha"), plan("beta")]);
  const oldHeads = [
    manifestCompletedHead(oldAlpha.plan, "a"),
    manifestCompletedHead(beta.plan, "b"),
  ];
  const initial = await prepareManifestPromotion({
    snapshot: manifestSnapshot({
      sequence: 1n,
      facts: [
        manifestFact({
          plan: oldAlpha.plan,
          checkpoint: oldAlpha.checkpoint,
          head: oldHeads[0]!,
        }),
        manifestFact({
          plan: beta.plan,
          checkpoint: beta.checkpoint,
          head: oldHeads[1]!,
        }),
      ],
    }),
    providerPlans: manifestPlanResolver([oldAlpha.plan, beta.plan]),
  });
  assert.equal(initial.outcome, "activate");
  const initialRequest = parseManifestPromotionOperation(initial.operation!);
  assert.ok("manifest" in initialRequest);
  const active = activeManifestFromRequest(
    initialRequest as CatalogManifestActivateRequest,
    oldHeads,
  );
  assert.equal(input.plan.counts.collectibles, 8_000);
  assert.ok(input.plan.batches.length >= 80);
  const lane = new MemoryProviderLane("alpha");
  const transport = new MemoryProviderTransport();
  const startedAt = performance.now();

  const cycle = await runner(input, lane, transport).runCycle();
  assert.equal(cycle.outcome, "published");
  assert.equal(
    transport.sends.size,
    input.plan.batches.length + 2,
  );

  const betaSettled = BigInt(beta.plan.providerCheckpoint.settledSequence);
  const betaDelayedCheckpoint = providerFixtureCheckpoint({
    platformKey: "beta",
    settledSequence: betaSettled,
    sourceHeadSequence: betaSettled + 1n,
    settledAt: new Date("2026-08-15T03:00:00.000Z"),
    sourceHeadAt: new Date("2026-08-15T03:01:00.000Z"),
    lastSuccessfulObservationAt: new Date("2026-08-15T03:01:00.000Z"),
    staleAt: new Date("2026-08-15T03:16:00.000Z"),
  });
  const nextSnapshot = manifestSnapshot({
    sequence: 2n,
    activeState: active,
    facts: [
      manifestFact({
        plan: input.plan,
        checkpoint: input.checkpoint,
        head: manifestCompletedHead(input.plan, "c"),
      }),
      manifestFact({
        plan: beta.plan,
        checkpoint: betaDelayedCheckpoint,
        head: null,
        activeSelection: active.activeSelections[1],
      }),
    ],
  });
  const manifestLane = new VolumeManifestLane(nextSnapshot);
  const manifestTransport = new VolumeManifestTransport();
  const manifestCycle = await new ManifestPromotionRunner({
    workerId: "manifest-volume-worker",
    lane: manifestLane,
    triggers: { loadEvaluationTrigger: () => Promise.resolve(null) },
    providerPlans: manifestPlanResolver([input.plan, beta.plan]),
    transport: manifestTransport,
    clock: { now: () => new Date("2026-08-15T03:01:01.000Z") },
    random: { fraction: () => 0 },
    alerts: { notify: () => Promise.resolve() },
  }).runCycle();
  assert.equal(manifestCycle.outcome, "activated");
  assert.equal(manifestLane.completedOutcome, "activated");
  assert.equal(manifestLane.summary?.providerSelections[1]?.source,
    "active_fallback");
  assert.equal(manifestLane.operation?.operationKind, "activateManifest");
  assert.equal(manifestTransport.sends, 1);
  const activate = manifestTransport.request;
  assert.ok(activate);
  assert.equal(
    activate.observation.providerSelections[1]?.settledSourceFreshness,
    "delayed",
  );
  const elapsedMilliseconds = performance.now() - startedAt;

  assert.ok(elapsedMilliseconds < 60_000, `${elapsedMilliseconds}ms`);
});
