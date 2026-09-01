import assert from "node:assert/strict";
import { test } from "node:test";
import { unavailableProviderSourceMeasurements } from "@packscout/contracts";
import type { CentralPrismaClient, ProviderDatabaseOperationResult } from "@packscout/database";
import { createLaunchSourceIntegrationCapabilities } from "@packscout/services";
import { createDistributedProviderSourceOperationsRuntime } from "./distributed-provider-source-operations-runtime.ts";
import type { LocalSourceEvidence } from "./distributed-provider-source-projection.ts";

const uuid = (value: number) => `9a000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = uuid(1);
const observedAt = "2026-08-30T12:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

const evidence: LocalSourceEvidence = {
  overview: {
    runtimeState: "idle", runtimeReason: null, runtimeGeneration: 1n,
    nextDueAt: new Date(observedAt), lastAttemptedAt: null, lastHeadReachedAt: null,
    lastRunnerHeartbeatAt: null, freshnessState: "unknown", qualityState: "healthy",
    consecutiveFailures: 0, latestFailureCode: null, recoveredAt: null,
    activeRun: null, latestRun: null, openQuarantineCount: 0,
    latestQuarantineReasonCode: null, latestRetention: null,
  },
  runs: [],
  details: [],
  measurements: {
    storage: { state: "available", measuredAt: observedAt, counts: {
      total: 10, categories: 1, packs: 1, collectibles: 1, aliases: 1, instances: 1,
      packContents: 1, accounts: 1, pulls: 1, pullItems: 1, marketEvents: 1,
    } },
    records: { state: "available", measuredAt: observedAt, processed: 20, accepted: 12 },
    activity: {
      state: "available", measuredAt: observedAt, historyMeasuredAt: observedAt, lastCommittedPageAt: null,
      importLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
      promotionLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
      quarantine: { open: 0, resolved: 0, expired: 0, retained: 0 },
    },
  },
};

test("overview bounds parallel provider reads, refills free slots, and preserves order through an unreachable provider", async () => {
  // More roots than the current launch catalog exercise the fixed read bound
  // independently of how many provider keys the catalog currently supports.
  const rows = Array.from({ length: 7 }, (_, index) => ({
    id: uuid(10 + index), provider_key: "clutchpacks", display_name: `Provider ${index}`,
    lifecycle: "active",
    active_config_version: {
      id: uuid(30 + index), adapter_key: "dataforrest-clutchpacks-distributed-adapter-v1",
      schedule_seconds: 300, stale_after_seconds: 900,
    },
  }));
  const pending = rows.map(() => deferred<ProviderDatabaseOperationResult<LocalSourceEvidence>>());
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const runtime = createDistributedProviderSourceOperationsRuntime({
    central: {
      providers: { async findMany(query: { where: { organization_id: string }; take: number }) {
        assert.equal(query.where.organization_id, organizationId);
        assert.equal(query.take, 50);
        return rows;
      } },
    } as unknown as CentralPrismaClient,
    gateway: {
      async runWithAdminProviderDatabase(target: { organizationId: string; providerId: string }) {
        assert.equal(target.organizationId, organizationId);
        const index = rows.findIndex((row) => row.id === target.providerId);
        assert.notEqual(index, -1);
        started.push(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try { return await pending[index]!.promise; }
        finally { active -= 1; }
      },
    } as unknown as Parameters<typeof createDistributedProviderSourceOperationsRuntime>[0]["gateway"],
    sourceIntegrations: createLaunchSourceIntegrationCapabilities(),
    diagnosticCursorKey: new Uint8Array(32).fill(7), now: () => new Date(observedAt),
  });
  const finish = (index: number) => pending[index]!.resolve({
    state: "reachable", providerId: rows[index]!.id, observedAt, value: evidence,
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const overviewRead = runtime.operations.overview(organizationId);
  await settle();
  assert.deepEqual(started, [0, 1, 2, 3], "four authorized reads start before any provider settles");
  assert.equal(active, 4, "remaining providers wait instead of exceeding gateway read capacity");

  finish(2);
  await settle();
  assert.deepEqual(started, [0, 1, 2, 3, 4], "a free slot starts the next provider while the first is still pending");
  assert.equal(active, 4);
  finish(4);
  await settle();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  pending[1]!.resolve({ state: "unreachable", providerId: rows[1]!.id, observedAt,
    failureCode: "database_unreachable", retryHint: "Retry the provider read." });
  await settle();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6], "an unavailable provider also releases its slot");
  assert.equal(maximumActive, 4);
  for (const index of [6, 5, 3, 0]) finish(index);

  const overview = await overviewRead;
  assert.equal(active, 0);
  assert.equal(maximumActive, 4);
  assert.deepEqual(overview.sources.map((source) => source.providerId), rows.map((row) => row.id),
    "out-of-order completion does not reorder the central provider list");
  assert.deepEqual(overview.sources[1]!.measurements, unavailableProviderSourceMeasurements("database_unreachable"));
  assert.equal(overview.sources[1]!.processor?.actionRequiredCode, "PROVIDER_DATABASE_UNREACHABLE");
  for (const source of overview.sources.filter((_, index) => index !== 1)) {
    assert.deepEqual(source.measurements, evidence.measurements);
    assert.equal(source.processor?.activity, "inactive", "an unreachable neighbor does not discard healthy evidence");
  }
});
