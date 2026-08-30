import assert from "node:assert/strict";
import { test } from "node:test";
import { dataforrestClutchpacksDistributedSourceAdapterManifest } from "@packscout/contracts";
import {
  PrismaAdminProviderRuntimeRepository,
  type AdminLocalProviderOverview,
  type AdminLocalRunDetailRecord,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type ProviderPrismaClient,
} from "@packscout/database";
import { createLaunchSourceIntegrationCapabilities } from "@packscout/services";
import { providerRunSummary } from "./distributed-import-operations-runtime.ts";
import { createDistributedProviderSourceOperationsRuntime } from
  "./distributed-provider-source-operations-runtime.ts";

const provider = {
  id: "31000000-0000-4000-8000-000000000001",
  key: "clutchpacks",
  displayName: "ClutchPacks",
};
const organizationId = "31000000-0000-4000-8000-000000000002";
const now = new Date("2026-08-30T00:00:00.000Z");
const run: AdminLocalRunDetailRecord = {
  id: "31000000-0000-4000-8000-000000000003",
  trigger: "manual",
  state: "running",
  requestedByOperatorId: null,
  configVersionId: "31000000-0000-4000-8000-000000000004",
  configVersionNumber: 1n,
  workerFence: 1n,
  attemptNumber: 1,
  recoveryOfRunId: null,
  requestedCursorHash: null,
  finalCursorHash: "a".repeat(64),
  reachedSourceHead: false,
  pageCount: 1,
  catalogCount: 10,
  pullCount: 0,
  marketEventCount: 0,
  acceptedCount: 7,
  duplicateCount: 2,
  quarantinedCount: 1,
  materialChangeCount: 4,
  failureCode: null,
  failureClass: null,
  requestedAt: now,
  startedAt: now,
  lastProgressAt: now,
  heartbeatAt: now,
  finishedAt: null,
  pages: [{
    pageNumber: 1,
    continuation: "more",
    committedAt: now,
    requestedCursorHash: null,
    nextCursorHash: "a".repeat(64),
    responseDigest: "b".repeat(64),
    catalogCount: 10,
    pullCount: 0,
    marketEventCount: 0,
    acceptedCount: 7,
    duplicateCount: 2,
    quarantinedCount: 1,
    materialChangeCount: 4,
  }],
  relatedQuarantines: [],
};

test("combined material changes never become a measured revision count", () => {
  for (const materialChangeCount of [0, 4, 7]) {
    const view = providerRunSummary(provider, { ...run, materialChangeCount });
    assert.equal(view.counters.accepted, 7);
    assert.equal(view.counters.unchanged, 2);
    assert.equal(view.counters.quarantined, 1);
    assert.equal(view.counters.revised, null);
  }
});

test("source and page projections preserve known dispositions without guessing inserts", async (context) => {
  const overview: AdminLocalProviderOverview = {
    runtimeState: "running", runtimeReason: null, runtimeGeneration: 1n,
    nextDueAt: null, lastAttemptedAt: now, lastHeadReachedAt: null,
    lastRunnerHeartbeatAt: now, freshnessState: "unknown", qualityState: "warning",
    consecutiveFailures: 0, latestFailureCode: null, recoveredAt: null,
    activeRun: { id: run.id, state: "running" }, latestRun: run,
    openQuarantineCount: 1, latestQuarantineReasonCode: null, latestRetention: null,
  };
  context.mock.method(PrismaAdminProviderRuntimeRepository.prototype, "overview", async () => overview);
  context.mock.method(PrismaAdminProviderRuntimeRepository.prototype, "listRuns", async () => ({ items: [run], hasMore: false }));
  context.mock.method(PrismaAdminProviderRuntimeRepository.prototype, "getRun", async () => run);
  const central = {
    providers: {
      async findMany() {
        return [{
          id: provider.id, provider_key: provider.key, display_name: provider.displayName,
          lifecycle: "active",
          active_config_version: {
            id: run.configVersionId,
            adapter_key: dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
            schedule_seconds: 300, stale_after_seconds: 900,
          },
        }];
      },
    },
  } as unknown as CentralPrismaClient;
  const gateway = {
    async runWithAdminProviderDatabase(
      target: { organizationId: string; providerId: string },
      read: (database: ProviderPrismaClient) => Promise<unknown>,
    ) {
      assert.deepEqual(target, { organizationId, providerId: provider.id });
      return { state: "reachable", value: await read({} as ProviderPrismaClient) };
    },
  } as unknown as Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  const runtime = createDistributedProviderSourceOperationsRuntime({
    central, gateway, sourceIntegrations: createLaunchSourceIntegrationCapabilities(),
    diagnosticCursorKey: new Uint8Array(32), now: () => now,
  });
  const detail = await runtime.operations.detail(organizationId, provider.id);
  const expected = { inserted: null, revised: null, duplicate: 2, quarantined: 1 };
  assert.deepEqual(detail.source.progress.dispositions, expected);
  assert.deepEqual(detail.pageProgress[0]?.dispositions, expected);
  assert.equal(detail.source.progress.records.total, 10);
});
