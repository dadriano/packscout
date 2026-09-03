import assert from "node:assert/strict";
import { test } from "node:test";
import { unavailableProviderSourceMeasurements } from "@packscout/contracts";
import type { AdminLocalRunRecord } from "@packscout/database";
import { createLaunchSourceIntegrationCapabilities } from "@packscout/services";
import { configuredSource, type CentralSourceProvider, type LocalSourceEvidence } from "./distributed-provider-source-projection.ts";

const uuid = (value: number) => `7a000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = new Date("2026-08-30T12:01:00.000Z");
const provider: CentralSourceProvider = {
  id: uuid(1), key: "clutchpacks", displayName: "ClutchPacks", lifecycle: "active",
  activeConfig: { id: uuid(2), adapterKey: "dataforrest-clutchpacks-distributed-adapter-v1",
    scheduleSeconds: 300, staleAfterSeconds: 900 },
};
const active: AdminLocalRunRecord = {
  id: uuid(3), trigger: "manual", state: "running", requestedByOperatorId: null,
  configVersionId: uuid(2), configVersionNumber: 1n, workerFence: 1n,
  attemptNumber: 1, recoveryOfRunId: null, requestedCursorHash: null, finalCursorHash: null,
  reachedSourceHead: false, pageCount: 8, catalogCount: 100, pullCount: 200,
  marketEventCount: 300, acceptedCount: 570, duplicateCount: 10, quarantinedCount: 20,
  materialChangeCount: 550, failureCode: null, failureClass: null,
  requestedAt: new Date("2026-08-30T11:59:55.000Z"),
  startedAt: new Date("2026-08-30T12:00:00.000Z"),
  lastProgressAt: new Date("2026-08-30T12:00:50.000Z"),
  heartbeatAt: new Date("2026-08-30T12:00:55.000Z"), finishedAt: null,
};

function evidence(newest: AdminLocalRunRecord, activeRun = true): LocalSourceEvidence {
  return {
    overview: {
      runtimeState: activeRun ? "running" : "idle", runtimeReason: null, runtimeGeneration: 1n,
      nextDueAt: null, lastAttemptedAt: active.requestedAt, lastHeadReachedAt: null,
      lastRunnerHeartbeatAt: active.heartbeatAt, freshnessState: "unknown", qualityState: "healthy",
      consecutiveFailures: 0, latestFailureCode: null, recoveredAt: null,
      activeRun: activeRun ? { id: active.id, state: "running" } : null,
      latestRun: newest, openQuarantineCount: 2, latestQuarantineReasonCode: null, latestRetention: null,
    },
    runs: newest.id === active.id ? [active] : [newest, active], details: [],
    measurements: unavailableProviderSourceMeasurements("query_failed"),
  };
}

function project(value: LocalSourceEvidence) {
  return configuredSource({ provider, evidence: value, now,
    capability: createLaunchSourceIntegrationCapabilities().resolve(provider.key, provider.activeConfig!.adapterKey) });
}

for (const newestState of ["queued", "succeeded"] as const) {
  test(`current-run progress stays attached to the older running run when the newest run is ${newestState}`, () => {
    const queued = newestState === "queued";
    const newest: AdminLocalRunRecord = {
      ...active, id: uuid(4), state: newestState, pageCount: queued ? 0 : 1,
      catalogCount: queued ? 0 : 1, pullCount: queued ? 0 : 2, marketEventCount: queued ? 0 : 3,
      acceptedCount: queued ? 0 : 3, duplicateCount: queued ? 0 : 1,
      quarantinedCount: queued ? 0 : 2, materialChangeCount: queued ? 0 : 3,
      requestedAt: new Date("2026-08-30T12:00:20.000Z"),
      startedAt: queued ? null : new Date("2026-08-30T12:00:20.000Z"),
      lastProgressAt: queued ? null : new Date("2026-08-30T12:00:30.000Z"),
      heartbeatAt: queued ? null : new Date("2026-08-30T12:00:30.000Z"),
      finishedAt: queued ? null : new Date("2026-08-30T12:00:40.000Z"),
      reachedSourceHead: !queued,
    };
    const source = project(evidence(newest));
    assert.equal(source.activeRun?.id, active.id);
    assert.equal(source.latestRun?.id, newest.id, "latest history identity remains separate");
    assert.equal(source.processor?.activity, "running");
    assert.equal(source.progress.pages, 8);
    assert.deepEqual(source.progress.records, { catalog: 100, pulls: 200, trades: 300, total: 600 });
    assert.deepEqual(source.progress.dispositions, { inserted: null, revised: null, duplicate: 10, quarantined: 20 });
    assert.equal(source.progress.elapsedMilliseconds, 60_000);
    assert.equal(source.progress.throughputRecordsPerSecond, 10);
    assert.equal(source.freshness.lastProgressAt, active.lastProgressAt!.toISOString());
    assert.equal(source.progress.openQuarantine, 2, "provider-wide quarantine remains independently scoped");

    const withoutActive = project(evidence(newest, false));
    assert.equal(withoutActive.activeRun, null);
    assert.deepEqual(withoutActive.progress.records, queued
      ? { catalog: 0, pulls: 0, trades: 0, total: 0 }
      : { catalog: 1, pulls: 2, trades: 3, total: 6 });
    assert.equal(withoutActive.progress.elapsedMilliseconds, queued ? 0 : 20_000);
    assert.equal(withoutActive.progress.throughputRecordsPerSecond, queued ? null : 0.3);
    assert.equal(withoutActive.freshness.lastProgressAt, newest.lastProgressAt?.toISOString() ?? null);
  });
}

test("paused and failed runtime state do not become running merely because active-run counters are retained", () => {
  for (const runtimeState of ["paused", "error"] as const) {
    const value = evidence(active);
    const source = project({ ...value, overview: { ...value.overview, runtimeState } });
    assert.equal(source.activeRun?.state, "running");
    assert.equal(source.processor?.activity, runtimeState === "paused" ? "paused" : "action_required");
    assert.equal(source.progress.records.total, 600);
  }
});
