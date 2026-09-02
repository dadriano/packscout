import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  promotionJobInvocationDetailSchema,
  promotionJobMonitoringOverviewSchema,
  type PromotionJobPublicReleaseMonitoring,
} from "@packscout/contracts";
import {
  promotionJobSha256,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type PromotionJobLivenessEvaluatorStateRecord,
  type PromotionJobLivenessRosterSnapshotRecord,
  type ProviderPrismaClient,
} from "@packscout/database";
import { PromotionJobMonitoringIdCodec } from "@packscout/services";
import {
  PrismaPromotionJobMonitoringReadRepository,
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

function rawSqlText(statement: unknown): string {
  if (Array.isArray(statement)) return statement.join("?");
  if (
    typeof statement === "object"
    && statement !== null
    && "strings" in statement
    && Array.isArray(statement.strings)
  ) return statement.strings.join("?");
  throw new TypeError("Expected a Prisma SQL statement.");
}

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
    lanePosition: 2n,
    settledPosition: 2n,
    completedRelease: release(providerKey === "alpha" ? "a" : "b"),
    executionState: "ready",
  };
}

function providerDatabaseWithPositions(input: Readonly<{
  lanePosition: bigint;
  settledPosition: bigint;
  readOrder: string[];
}>): ProviderPrismaClient {
  const completedReleaseId = "20000000-0000-4000-8000-000000000010";
  return {
    async $queryRaw(statement: unknown) {
      const text = (statement as { strings?: readonly string[] }).strings
        ?.join(" ") ?? "";
      if (text.includes("provider_promotion_job_schedule")) {
        return [{
          lifecycle: "active",
          scheduleEpoch: 1n,
          cadenceSeconds: 60,
          baselineAt: new Date("2026-09-01T11:00:00.000Z"),
          activatedAt: new Date("2026-09-01T11:00:00.000Z"),
          pausedAt: null,
          lastAdmittedWindowIndex: 59n,
          lastScheduledCheckinAt: observedAt,
          nextExpectedCheckinAt: new Date("2026-09-01T12:01:00.000Z"),
        }];
      }
      if (text.includes("provider_promotion_job_wake")) {
        return [{
          requestedGeneration: 1n,
          acknowledgedGeneration: 1n,
          latestCause: "canonical_settlement",
          latestRequestedAt: observedAt,
          latestDeliveryGeneration: 1n,
          latestDeliveryState: "delivered",
          lastDeliveryAttemptAt: observedAt,
          latestDeliveryFailureCode: null,
        }];
      }
      throw new Error("Unexpected live monitoring query.");
    },
    promotion_ledger: {
      async findUnique(query: unknown) {
        input.readOrder.push("lane");
        assert.deepEqual(query, {
          where: { singleton_key: true },
          select: { last_sequence: true },
        });
        return { last_sequence: input.lanePosition };
      },
    },
    provider_publication_state: {
      async findUnique(query: unknown) {
        input.readOrder.push("settlement");
        assert.deepEqual(query, {
          where: { singleton_key: true },
          select: {
            completed_release_id: true,
            completed_through_change_sequence: true,
          },
        });
        return {
          completed_release_id: completedReleaseId,
          completed_through_change_sequence: input.settledPosition,
        };
      },
    },
    provider_activity_outbox: {
      async findFirst(query: unknown) {
        input.readOrder.push("completion");
        assert.deepEqual(query, {
          where: {
            event_type: "provider_release_completed",
            dedupe_key:
              `provider-release-completed:${completedReleaseId}:${input.settledPosition}`,
          },
          orderBy: [{ event_at: "desc" }, { id: "desc" }],
          select: { evidence: true },
        });
        return null;
      },
    },
    provider_promotion_job_invocations: {
      async findFirst() { return null; },
    },
  } as unknown as ProviderPrismaClient;
}

function providerAt(index: number): PromotionJobMonitoringRosterProvider {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    id: `21000000-0000-4000-8000-${suffix}`,
    providerKey: `provider_${String(index + 1).padStart(2, "0")}`,
    displayName: `Provider ${index + 1}`,
    lifecycle: "active",
  };
}

function releaseAt(index: number): PromotionJobPublicReleaseMonitoring {
  const fingerprintPart = index.toString(16).padStart(2, "0");
  return {
    publicReleaseId: `release-provider-${index + 1}`,
    fingerprint: fingerprintPart.repeat(32),
    position: "2",
  };
}

function capacityRepository(
  providerRows: readonly PromotionJobMonitoringRosterProvider[],
): PromotionJobMonitoringReadRepository {
  const rosterSnapshot: PromotionJobLivenessRosterSnapshotRecord = {
    ...roster,
    providers: providerRows.map((provider) => ({
      organizationId,
      providerId: provider.id,
      providerKey: provider.providerKey,
    })),
  };
  return {
    async captureEligibleRoster() { return rosterSnapshot; },
    async readEvaluator() {
      return {
        ...evaluator,
        expectedCount: providerRows.length + 1,
        reachableCount: 0,
        unavailableCount: providerRows.length,
      };
    },
    async listRoster(scope) {
      assert.equal(scope, organizationId);
      return providerRows;
    },
    async readManifestEvidence() {
      const evidence = manifestEvidence();
      return {
        ...evidence,
        activeReleases: new Map(providerRows.map((provider, index) => [
          provider.providerKey,
          releaseAt(index),
        ])),
      };
    },
    async readProviderEvidence(input) {
      const index = providerRows.indexOf(input.provider);
      assert.notEqual(index, -1);
      const completedRelease = releaseAt(index);
      return {
        observation: null,
        latestProjection: null,
        completedRelease,
        completionObservedAt: observedAt,
        activeRelease: completedRelease,
        pendingGate: null,
        projectedAt: null,
      };
    },
    async listHistory() { return []; },
    async readDetail() { return null; },
  };
}

test("overview separates live lane and settlement while isolating a provider outage", async () => {
  const routed: string[] = [];
  const readOrder: string[] = [];
  const providerClient = providerDatabaseWithPositions({
    lanePosition: 3n,
    settledPosition: 2n,
    readOrder,
  });
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
      return {
        state: "reachable" as const,
        providerId: input.providerId,
        observedAt: observedAt.toISOString(),
        value: await operation(providerClient),
      };
    },
  } satisfies Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  const service = new PromotionJobMonitoringReadService({
    repository: repository(),
    gateway,
    deployment: "test",
    secret: new Uint8Array(32).fill(8),
    now: () => observedAt,
  });

  const overview = promotionJobMonitoringOverviewSchema.parse(
    await service.overview({ organizationId }),
  );
  assert.equal(overview.roster.providerCount, 3);
  assert.equal(overview.roster.eligibleProviderCount, 2);
  assert.equal(overview.evaluator.expectedCount, 3);
  assert.equal(overview.manifest.evidenceSource, "live");
  assert.equal(overview.providers[0]?.state, "awaiting_publication");
  assert.equal(overview.providers[0]?.settledPosition, "2");
  assert.equal(overview.providers[0]?.evidenceSource, "live");
  assert.equal(overview.providers[1]?.state, "last_known");
  assert.equal(overview.providers[1]?.evidenceSource, "last_known");
  assert.equal(overview.providers[1]?.routeFailureCode, "DATABASE_UNREACHABLE");
  assert.equal(overview.providers[2]?.lifecycle, "archived");
  assert.equal(overview.providers[2]?.state, "last_known");
  assert.deepEqual(readOrder, ["settlement", "completion", "lane"]);
  assert.deepEqual(routed, [alphaId, betaId]);
});

test("overview bounds a 64-provider outage with one deadline and preserves every last-known row", {
  timeout: 1_000,
}, async () => {
  const providerRows = Array.from({ length: 64 }, (_, index) =>
    providerAt(index)
  );
  const routed: string[] = [];
  const deadlines = new Set<number>();
  const gateway = {
    runWithAdminProviderDatabase(input) {
      routed.push(input.providerId);
      assert.equal(typeof input.deadlineAt, "number");
      deadlines.add(input.deadlineAt!);
      return new Promise<never>(() => undefined);
    },
  } satisfies Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  const service = new PromotionJobMonitoringReadService({
    repository: capacityRepository(providerRows),
    gateway,
    deployment: "test",
    secret: new Uint8Array(32).fill(8),
    now: () => observedAt,
    overviewProviderReadTimeoutMs: 25,
    readLiveProvider: async () => live("alpha"),
  });

  const startedAt = performance.now();
  const overview = promotionJobMonitoringOverviewSchema.parse(
    await service.overview({ organizationId }),
  );
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs < 500, `overview took ${elapsedMs}ms`);
  assert.equal(routed.length, 4);
  assert.equal(deadlines.size, 1);
  assert.equal(overview.roster.providerCount, 64);
  assert.deepEqual(
    overview.providers.map((provider) => provider.providerKey),
    providerRows.map((provider) => provider.providerKey),
  );
  for (const provider of overview.providers) {
    assert.equal(provider.state, "last_known");
    assert.equal(provider.evidenceSource, "last_known");
    assert.equal(
      provider.routeFailureCode,
      "MONITORING_PROBE_BUDGET_EXHAUSTED",
    );
  }
});

test("overview isolates a rejected provider route from healthy peers", async () => {
  const service = new PromotionJobMonitoringReadService({
    repository: repository(),
    gateway: {
      async runWithAdminProviderDatabase(input, operation) {
        if (input.providerId === alphaId) {
          throw new Error("provider route failed");
        }
        return {
          state: "reachable" as const,
          providerId: input.providerId,
          observedAt: observedAt.toISOString(),
          value: await operation({} as ProviderPrismaClient),
        };
      },
    },
    deployment: "test",
    secret: new Uint8Array(32).fill(8),
    now: () => observedAt,
    readLiveProvider: async () => live("beta"),
  });

  const overview = promotionJobMonitoringOverviewSchema.parse(
    await service.overview({ organizationId }),
  );

  assert.equal(overview.providers[0]?.state, "last_known");
  assert.equal(overview.providers[0]?.routeFailureCode, "MONITORING_PROBE_FAILED");
  assert.equal(overview.providers[1]?.state, "current");
  assert.equal(overview.providers[1]?.routeFailureCode, null);
  assert.equal(overview.providers[2]?.state, "last_known");
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

test("manifest evidence aggregates the pending gate queue in Postgres", async () => {
  const oldestRequestedAt = new Date(observedAt.getTime() - 120_000);
  const gateAggregateStatements: string[] = [];
  const central = {
    $queryRaw: async (statement: unknown) => {
      const sql = rawSqlText(statement);
      if (sql.includes("manifest_reconciliation_job_schedule")) {
        return [{
          lifecycle: "paused",
          scheduleEpoch: 0n,
          cadenceSeconds: 60,
          baselineAt: null,
          activatedAt: null,
          pausedAt: null,
          lastAdmittedWindowIndex: null,
          lastScheduledCheckinAt: null,
          nextExpectedCheckinAt: null,
        }];
      }
      if (sql.includes("manifest_reconciliation_job_wake")) return [];
      if (sql.includes("promotion_job_liveness_observations")) return [];
      if (sql.includes("manifest_gate_intents")) {
        gateAggregateStatements.push(sql);
        return [{
          queue_depth: 2n,
          oldest_requested_at: oldestRequestedAt,
        }];
      }
      throw new Error(`Unexpected SQL statement: ${sql}`);
    },
    manifest_activation_state: { findUnique: async () => null },
    manifest_reconciliation_job_invocations: {
      findFirst: async () => null,
    },
    manifest_activation_operations: { findMany: async () => [] },
    manifest_gate_intents: {
      findMany: async () => {
        throw new Error("Gate intents must not be materialized in monitoring.");
      },
    },
  } as unknown as CentralPrismaClient;
  const repository = new PrismaPromotionJobMonitoringReadRepository(central);

  const evidence = await repository.readManifestEvidence({
    organizationId,
    deployment: "test",
    now: observedAt,
    idCodec: new PromotionJobMonitoringIdCodec(new Uint8Array(32).fill(7)),
    evaluatorCurrent: true,
  });

  assert.equal(evidence.view.gateQueueDepth, 2);
  assert.equal(evidence.view.oldestGateAgeMs, 120_000);
  assert.equal(gateAggregateStatements.length, 1);
  assert.match(gateAggregateStatements[0]!, /count\(\*\)::bigint/iu);
  assert.match(gateAggregateStatements[0]!, /min\(latest_requested_at\)/iu);
  assert.match(
    gateAggregateStatements[0]!,
    /requested_generation > acknowledged_generation/iu,
  );
});
