import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  promotionJobInvocationDetailSchema,
  promotionJobMonitoringOverviewSchema,
} from "@packscout/contracts";
import {
  promotionJobSha256,
  type BoundedProviderDatabaseGateway,
  type PromotionJobLivenessEvaluatorStateRecord,
  type PromotionJobLivenessRosterSnapshotRecord,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  PromotionJobMonitoringReadService,
  type CentralManifestPromotionMonitoringEvidence,
  type CentralPromotionJobMonitoringInvocationRecord,
  type CentralProviderPromotionMonitoringEvidence,
  type LiveProviderPromotionMonitoringSnapshot,
  type PromotionJobMonitoringReadRepository,
  type PromotionJobMonitoringRosterProvider,
} from "./promotion-job-monitoring-runtime.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const otherOrganizationId = "10000000-0000-4000-8000-000000000009";
const alphaId = "20000000-0000-4000-8000-000000000001";
const betaId = "20000000-0000-4000-8000-000000000002";
const archivedId = "20000000-0000-4000-8000-000000000003";
const alphaProjectionId = "30000000-0000-4000-8000-000000000001";
const betaProjectionId = "30000000-0000-4000-8000-000000000002";
const archivedProjectionId = "30000000-0000-4000-8000-000000000003";
const manifestInvocationId = "40000000-0000-4000-8000-000000000001";
const observedAt = new Date("2026-09-01T12:00:00.000Z");
const digest = "a".repeat(64);

function release(token: string, position = "2") {
  return {
    publicReleaseId: `release-${token}`,
    fingerprint: token.repeat(64),
    position,
  };
}

const providers: readonly PromotionJobMonitoringRosterProvider[] = [
  { id: alphaId, providerKey: "alpha", displayName: "Alpha", lifecycle: "active" },
  { id: betaId, providerKey: "beta", displayName: "Beta", lifecycle: "active" },
  { id: archivedId, providerKey: "old_lane", displayName: "Old lane", lifecycle: "archived" },
];

const roster: PromotionJobLivenessRosterSnapshotRecord = {
  rosterVersion: 10n,
  rosterHighWater: 11n,
  rosterDigest: digest,
  capturedAt: observedAt,
  providers: providers.slice(0, 2).map((provider) => ({
    organizationId,
    providerId: provider.id,
    providerKey: provider.providerKey,
  })),
};

const evaluator: PromotionJobLivenessEvaluatorStateRecord = {
  state: "current",
  lifecycle: "active",
  evaluatorEpoch: 1n,
  cadenceSeconds: 60,
  baselineAt: new Date("2026-09-01T11:00:00.000Z"),
  activatedAt: new Date("2026-09-01T11:00:00.000Z"),
  pausedAt: null,
  lastSuccessfulWindowIndex: 59n,
  lastSuccessfulEvaluationAt: observedAt,
  evaluatedThrough: observedAt,
  rosterVersion: 10n,
  rosterHighWater: 11n,
  rosterDigest: digest,
  expectedCount: 3,
  reachableCount: 2,
  unavailableCount: 1,
  healthyCount: 2,
  overdueCount: 0,
  alertingCount: 0,
  manifestEvaluated: true,
  lastFailureCode: null,
};

function projection(
  centralId: string,
  providerKey: string,
  startedAt: Date,
  body = "[]",
): CentralPromotionJobMonitoringInvocationRecord {
  return {
    kind: "provider",
    centralId,
    providerKey,
    trigger: "reconciliation_cron",
    state: "terminal",
    outcome: "no_change",
    requestedAt: startedAt,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1_000),
    cycleCount: 1,
    attemptCount: JSON.parse(body).length as number,
    retryCount: 0,
    failureCode: null,
    continuationPending: false,
    settledPosition: 2n,
    attemptSetDigest: promotionJobSha256(body),
    canonicalDetailBody: body,
    canonicalDetailDigest: promotionJobSha256(body),
  };
}

function manifestRecord(): CentralPromotionJobMonitoringInvocationRecord {
  return {
    kind: "manifest",
    centralId: manifestInvocationId,
    providerKey: null,
    trigger: "manual",
    state: "terminal",
    outcome: "caught_up",
    requestedAt: new Date("2026-09-01T12:02:00.000Z"),
    startedAt: new Date("2026-09-01T12:02:00.000Z"),
    finishedAt: new Date("2026-09-01T12:02:01.000Z"),
    cycleCount: 1,
    attemptCount: 0,
    retryCount: 0,
    failureCode: null,
    continuationPending: false,
    settledPosition: null,
    attemptSetDigest: promotionJobSha256("[]"),
    canonicalDetailBody: "[]",
    canonicalDetailDigest: promotionJobSha256("[]"),
  };
}

function providerEvidence(
  provider: PromotionJobMonitoringRosterProvider,
): CentralProviderPromotionMonitoringEvidence {
  const token = provider.providerKey === "alpha"
    ? "a"
    : provider.providerKey === "beta"
      ? "b"
      : "c";
  const id = provider.providerKey === "alpha"
    ? alphaProjectionId
    : provider.providerKey === "beta"
      ? betaProjectionId
      : archivedProjectionId;
  return {
    observation: null,
    latestProjection: projection(id, provider.providerKey, observedAt),
    completedRelease: release(token),
    completionObservedAt: new Date("2026-09-01T12:00:03.000Z"),
    activeRelease: release(token),
    pendingGate: null,
    projectedAt: new Date("2026-09-01T12:00:02.000Z"),
  };
}

function manifestEvidence(): CentralManifestPromotionMonitoringEvidence {
  return {
    activeReleases: new Map(providers.map((provider, index) => [
      provider.providerKey,
      {
        publicReleaseId: release(String.fromCharCode(97 + index)).publicReleaseId,
        fingerprint: String.fromCharCode(97 + index).repeat(64),
        releasePosition: "2",
      },
    ])),
    view: {
      evidenceSource: "live",
      observedAt: observedAt.toISOString(),
      stale: false,
      schedule: null,
      wake: null,
      activeManifest: null,
      previousManifest: null,
      gateQueueDepth: 0,
      oldestGateAgeMs: null,
      serializedOperation: null,
      lastActivationAt: null,
      lastReconciliationAt: observedAt.toISOString(),
      latestInvocation: null,
    },
  };
}

function repository(
  history: readonly CentralPromotionJobMonitoringInvocationRecord[] = [],
  evaluatorState: PromotionJobLivenessEvaluatorStateRecord = evaluator,
): PromotionJobMonitoringReadRepository {
  return {
    async captureEligibleRoster() { return roster; },
    async readEvaluator() { return evaluatorState; },
    async listRoster(scope) {
      assert.equal(scope, organizationId);
      return providers;
    },
    async readManifestEvidence() { return manifestEvidence(); },
    async readProviderEvidence(input) { return providerEvidence(input.provider); },
    async listHistory() { return history; },
    async readDetail(input) {
      return history.find((record) => record.centralId === input.reference.centralId)
        ?? null;
    },
  };
}

function live(providerKey: string): LiveProviderPromotionMonitoringSnapshot {
  return {
    observedAt,
    schedule: {
      authority: "provider_publication",
      lifecycle: "active",
      scheduleEpoch: 1n,
      cadenceSeconds: 60,
      baselineAt: new Date("2026-09-01T11:00:00.000Z"),
      activatedAt: new Date("2026-09-01T11:00:00.000Z"),
      pausedAt: null,
      lastAdmittedWindowIndex: 59n,
      lastScheduledCheckinAt: observedAt,
      nextExpectedCheckinAt: new Date("2026-09-01T12:01:00.000Z"),
    },
    wake: {
      authority: "provider_publication",
      requestedGeneration: 1n,
      acknowledgedGeneration: 1n,
      latestCause: "canonical_settlement",
      latestRequestedAt: observedAt,
      pending: false,
      latestDeliveryGeneration: 1n,
      latestDeliveryState: "delivered",
      lastDeliveryAttemptAt: observedAt,
      latestDeliveryFailureCode: null,
    },
    settledPosition: 2n,
    completedRelease: release(providerKey === "alpha" ? "a" : "b"),
    executionState: "ready",
  };
}

test("overview isolates a provider outage and retains archived truth without live routing", async () => {
  const routed: string[] = [];
  const gateway = {
    async runWithAdminProviderDatabase(input, operation) {
      routed.push(input.providerId);
      if (input.providerId === betaId) {
        return {
          state: "unreachable" as const,
          providerId: betaId,
          observedAt: observedAt.toISOString(),
          failureCode: "database_unreachable" as const,
          retryHint: "Retry later.",
        };
      }
      const database = { monitoringProviderKey: "alpha" } as unknown as ProviderPrismaClient;
      return {
        state: "reachable" as const,
        providerId: input.providerId,
        observedAt: observedAt.toISOString(),
        value: await operation(database),
      };
    },
  } satisfies Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  const service = new PromotionJobMonitoringReadService({
    repository: repository(),
    gateway,
    deployment: "test",
    secret: new Uint8Array(32).fill(8),
    now: () => observedAt,
    readLiveProvider: async () => live("alpha"),
  });

  const overview = promotionJobMonitoringOverviewSchema.parse(
    await service.overview({ organizationId }),
  );
  assert.equal(overview.roster.providerCount, 3);
  assert.equal(overview.roster.eligibleProviderCount, 2);
  assert.equal(overview.evaluator.expectedCount, 3);
  assert.equal(overview.manifest.evidenceSource, "live");
  assert.equal(overview.providers[0]?.state, "current");
  assert.equal(overview.providers[0]?.evidenceSource, "live");
  assert.equal(overview.providers[1]?.state, "last_known");
  assert.equal(overview.providers[1]?.evidenceSource, "last_known");
  assert.equal(overview.providers[1]?.routeFailureCode, "DATABASE_UNREACHABLE");
  assert.equal(overview.providers[2]?.lifecycle, "archived");
  assert.equal(overview.providers[2]?.state, "last_known");
  assert.deepEqual(routed, [alphaId, betaId]);
});

test("overview marks an active evaluator stale after two missed windows", async () => {
  const staleAt = new Date(
    observedAt.getTime() + evaluator.cadenceSeconds * 2_000 + 1,
  );
  const service = new PromotionJobMonitoringReadService({
    repository: repository([], evaluator),
    gateway: {
      async runWithAdminProviderDatabase(input, operation) {
        return {
          state: "reachable" as const,
          providerId: input.providerId,
          observedAt: staleAt.toISOString(),
          value: await operation({} as ProviderPrismaClient),
        };
      },
    },
    deployment: "test",
    secret: new Uint8Array(32).fill(8),
    now: () => staleAt,
    readLiveProvider: async () => live("alpha"),
  });

  const overview = promotionJobMonitoringOverviewSchema.parse(
    await service.overview({ organizationId }),
  );

  assert.equal(overview.evaluator.state, "stale");
  // Publication facts remain visible, but their liveness judgment is marked
  // stale until a fresh evaluator cycle succeeds.
  assert.equal(overview.providers[0]?.state, "current");
  assert.equal(overview.providers[0]?.stale, true);
});

test("history merges newest-first and detail exposes only bounded safe evidence", async () => {
  const attemptBody = canonicalJson([{
    snapshotOrdinal: 0,
    attemptIdentityDigest: "1".repeat(64),
    snapshotDigest: "2".repeat(64),
    observedState: "accepted",
    targetPosition: "2",
    retryCount: 0,
    safeFailureCode: null,
    releaseFingerprint: "a".repeat(64),
    totalOperationCount: 1,
    orderedOperationDigest: "3".repeat(64),
    truncatedOperationCount: 0,
    operationSummariesDigest: "4".repeat(64),
    observedAt: observedAt.toISOString(),
    recentOperations: [{
      operationIndex: 0,
      operationKind: "finalize",
      state: "acknowledged",
      sendCount: 1,
      sentAt: observedAt.toISOString(),
      acknowledgedAt: observedAt.toISOString(),
      operationIdDigest: "5".repeat(64),
      requestDigest: "6".repeat(64),
      receiptDigest: "7".repeat(64),
    }],
  }]);
  const provider = projection(
    alphaProjectionId,
    "alpha",
    new Date("2026-09-01T12:01:00.000Z"),
    attemptBody,
  );
  const records = [provider, manifestRecord()];
  const service = new PromotionJobMonitoringReadService({
    repository: repository(records),
    gateway: {} as Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">,
    deployment: "test",
    secret: new Uint8Array(32).fill(8),
    now: () => observedAt,
  });

  const first = await service.history({ organizationId, query: { limit: 1 } });
  assert.equal(first.items[0]?.job, "manifest");
  assert.notEqual(first.nextCursor, null);
  assert.equal(first.items[0]?.monitoringId.includes(manifestInvocationId), false);
  const second = await service.history({
    organizationId,
    query: { limit: 1, cursor: first.nextCursor! },
  });
  assert.equal(second.items[0]?.job, "provider:alpha");
  const detail = promotionJobInvocationDetailSchema.parse(await service.detail({
    organizationId,
    monitoringId: second.items[0]!.monitoringId,
  }));
  assert.equal(detail.totalAttemptCount, 1);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0]?.attemptNumber, 1);
  assert.equal(detail.attempts[0]?.operations.length, 1);
  assert.equal(detail.attempts[0]?.operations[0]?.operationNumber, 1);
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(
    serialized,
    /providerReleaseId|database|credential|requestBody|responseBody|receiptBody/u,
  );
  assert.equal(await service.detail({
    organizationId: otherOrganizationId,
    monitoringId: second.items[0]!.monitoringId,
  }), null);
});
