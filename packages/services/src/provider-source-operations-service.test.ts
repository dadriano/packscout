import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestEventsV2SourceAdapterManifest,
  providerSourceAdminCatalogSchema,
  providerSourceSupervisorSnapshotSchema,
  type LaunchProviderKey,
  type ProviderSourceAdminCatalog,
} from "@packscout/contracts";
import { ProviderSourceOperationsService } from "./provider-source-operations-service.ts";

const uuid = (value: number) =>
  `89000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = uuid(1);
const connectionProfileId = uuid(2);
const connectionRevisionId = uuid(3);
const runId = uuid(4);
const providers: readonly LaunchProviderKey[] = [
  "courtyard",
  "collector_crypt",
  "phygitals",
  "clutchpacks",
];
const now = new Date("2026-08-21T12:00:00.000Z");

function sourceIds(index: number) {
  return {
    providerId: uuid(10 + index),
    sourceInstanceId: uuid(20 + index),
    sourceRevisionId: uuid(30 + index),
    scheduleRevisionId: uuid(40 + index),
  };
}

const catalog = providerSourceAdminCatalogSchema.parse({
  availableSourceTypes: [{
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    label: "Registered event source",
  }],
  providers: providers.map((provider, index) => ({
    id: sourceIds(index).providerId,
    provider,
    sourceRegistration: {
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: `${provider}-mapper`,
      mapperVersion: "v1",
      identityNamespaceKey: `identity-${provider}`,
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
    },
  })),
  connections: [{
    id: connectionProfileId,
    displayName: "Shared feed",
    sourceTypeKey: "dataforrest-events-v1",
    connectionTypeKey: "dataforrest-events-connection-v1",
    state: "active",
    requestLimit: 2,
    activeRevisionId: connectionRevisionId,
    activeRevisionSourceAdapterVersion:
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    recoveryFence: {
      blockedRevisionId: connectionRevisionId,
      blockingEpisodeId: uuid(90),
    },
    latestRevision: {
      id: connectionRevisionId,
      revisionNumber: 1,
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      state: "active",
      endpointHost: "events.example.test",
      credentialConfigured: true,
      credentialMask: "••••••••",
      encryptionKeyVersion: 1,
      healthGeneration: "3",
      revokedAt: null,
      test: {
        jobId: uuid(91),
        connectionRevisionId,
        current: true,
        state: "succeeded",
        outcome: "success",
        safeCode: null,
        requestedAt: now.toISOString(),
        testedAt: now.toISOString(),
      },
      createdAt: now.toISOString(),
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }],
  sources: providers.map((provider, index) => {
    const ids = sourceIds(index);
    return {
      ...ids,
      provider,
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      connectionProfileId,
      connectionRevisionId,
      state: index === 1 ? "paused" : "active",
      pauseRequested: false,
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: `${provider}-mapper`,
      mapperVersion: "v1",
      identityNamespaceKey: `identity-${provider}`,
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
      intervalSeconds: 60,
      freshnessGraceSeconds: 900,
      cursor: {
        generation: "1",
        fingerprint: index === 0 ? "a".repeat(64) : null,
        resumeLabel: index === 0 ? "Saved cursor" : "Feed start",
      },
      test: {
        jobId: uuid(100 + index),
        connectionRevisionId,
        current: true,
        state: "succeeded",
        outcome: "success",
        safeCode: null,
        requestedAt: now.toISOString(),
        testedAt: now.toISOString(),
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }),
});

const snapshot = providerSourceSupervisorSnapshotSchema.parse({
  version: PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION,
  presence: {
    state: "active",
    environmentKey: "local",
    databaseTime: now.toISOString(),
    epochId: uuid(200),
    epochNumber: "7",
    ownerKey: "local-worker",
    lastRenewedAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 30_000).toISOString(),
    safeTakeoverAt: new Date(now.getTime() + 45_000).toISOString(),
    safeReasonCode: null,
  },
  capacity: {
    state: "available",
    safeCode: null,
    checkedAt: now.toISOString(),
    executionSlots: { used: 2, maximum: 4 },
    profiles: [{
      organizationId,
      connectionProfileId,
      used: 1,
      maximum: 2,
      waiting: 1,
    }],
  },
  sources: providers.map((provider, index) => {
    const ids = sourceIds(index);
    return {
      organizationId,
      providerId: ids.providerId,
      sourceInstanceId: ids.sourceInstanceId,
      sourceRevisionId: ids.sourceRevisionId,
      provider,
      connectionProfileId,
      connectionRevisionId,
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: `${provider}-mapper`,
      mapperVersion: "v1",
      identityNamespaceKey: `identity-${provider}`,
      cursorCodecVersion: "dataforrest-cursor-v1",
      cursorGeneration: "1",
      lifecycle: index === 1 ? "paused" : "active",
      phase: index === 0 ? "waiting" : index === 1 ? "paused" : "reached_head",
      activity: index === 0 ? "waiting" : index === 1 ? "paused" : "inactive",
      waitReason: index === 0 ? "profile_capacity" : null,
      actionRequiredCode: null,
      currentRunId: index === 0 ? runId : null,
      runLeaseAgeMilliseconds: index === 0 ? 5_000 : null,
      retry: { attempt: index === 0 ? 1 : 0, notBefore: null },
      progress: {
        pagesCommitted: index === 0 ? 5 : 0,
        recordsCommitted: index === 0 ? 20 : 0,
        lastProgressAt: index === 0
          ? new Date(now.getTime() - 10_000).toISOString()
          : null,
      },
      cursorFingerprint: index === 0 ? "a".repeat(64) : null,
      continuation: index === 0 ? { kind: "continue" } : null,
      nextDueAt: new Date(now.getTime() + 60_000).toISOString(),
      connectionEpisode: { episodeId: uuid(90), healthGeneration: "3" },
    };
  }),
});

const catalogWithV2Candidate = providerSourceAdminCatalogSchema.parse({
  ...catalog,
  connections: catalog.connections.map((connection) => ({
    ...connection,
    latestRevision: {
      ...connection.latestRevision,
      id: uuid(5),
      revisionNumber: 2,
      sourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
      state: "candidate",
      test: {
        ...connection.latestRevision.test,
        connectionRevisionId: uuid(5),
      },
    },
  })),
});

const counters = {
  pages: 5,
  records: 20,
  catalog: 8,
  pulls: 7,
  trades: 5,
  inserted: 12,
  revised: 3,
  duplicate: 4,
  quarantined: 1,
};

function runtime(
  historyState: "current" | "expired" = "current",
  catalogValue: ProviderSourceAdminCatalog = catalog,
) {
  const run = {
    id: runId,
    sourceInstanceId: sourceIds(0).sourceInstanceId,
    trigger: "manual" as const,
    state: "running" as const,
    requestedAt: new Date(now.getTime() - 20_000),
    startedAt: new Date(now.getTime() - 10_000),
    finishedAt: null,
    lastProgressAt: new Date(now.getTime() - 1_000),
    reachedHead: false,
    failureCode: null,
    counters,
  };
  return new ProviderSourceOperationsService({
    environmentKey: "local",
    catalog: { async read() { return catalogValue; } },
    snapshot: { async read() { return snapshot; } },
    sourceTypes: [
      {
        label: "Current event source",
        manifest: dataforrestEventsV2SourceAdapterManifest,
      },
      {
        label: "Registered event source",
        manifest: dataforrestEventsV1SourceAdapterManifest,
      },
    ],
    repository: {
      async readOverview() {
        return {
          providers: providers.map((provider, index) => ({
            providerId: sourceIds(index).providerId,
            provider,
            displayName: provider.replaceAll("_", " "),
          })),
          sources: providers.map((_provider, index) => ({
            sourceInstanceId: sourceIds(index).sourceInstanceId,
            health: {
              lastAttemptedAt: now,
              lastHeadReachedAt: index === 0 ? now : null,
              consecutiveFailures: 0,
              latestFailureCode: null,
              recoveredAt: null,
            },
            activeRun: index === 0 ? run : null,
            latestRun: index === 0 ? run : null,
            openQuarantine: index === 0 ? 1 : 0,
          })),
          connectionEpisodes: [{
            connectionProfileId,
            safeCode: "AUTHENTICATION_FAILED",
            openedAt: new Date(now.getTime() - 30_000),
          }],
        };
      },
      async readDetail() {
        return {
          runs: [run],
          pages: [{
            runId,
            pageNumber: 5,
            committedAt: now,
            records: counters,
            continuation: { kind: "continue" as const },
            cursorFingerprint: "a".repeat(64),
          }],
        };
      },
    },
    diagnostics: {
      async readHistoryPage() {
        return {
          state: historyState,
          events: historyState === "expired" ? [] : [{
            id: uuid(300),
            scope: "source" as const,
            correlationKind: "page" as const,
            eventKind: "source_page",
            severity: "info" as const,
            phase: "commit",
            safeCode: "PAGE_COMMITTED",
            occurredAt: now,
            durationMilliseconds: 50,
            responseBytes: 512,
            retryDelayMilliseconds: null,
            continuation: { kind: "continue" as const },
            cursorFingerprint: "a".repeat(64),
            counters: { records: 20 },
            runId,
            hasTestReference: false,
            hasCommandReference: false,
            quarantineId: uuid(301),
          }],
          next: historyState === "expired"
            ? null
            : { occurredAt: now, id: uuid(300) },
          availablePhases: ["commit", "request"],
        };
      },
    },
  });
}

test("source operations compose the registered four rows with durable supervisor capacity and truthful progress", async () => {
  const overview = await runtime().overview(organizationId);
  assert.equal(overview.sources.length, 4);
  assert.deepEqual(overview.sources.map(({ provider }) => provider), providers);
  assert.equal(overview.connection?.capacity.executionSlots.used, 2);
  assert.equal(
    overview.connection?.sourceType.adapterVersion,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
  assert.notEqual(
    overview.connection?.sourceType.adapterVersion,
    DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  );
  assert.equal(overview.connection?.capacity.requestPermits.waiting, 1);
  assert.equal(overview.connection?.health.state, "blocked");
  const courtyard = overview.sources[0]!;
  assert.equal(courtyard.processor?.waitReason, "profile_capacity");
  assert.equal(courtyard.processor?.retryCount, 1);
  assert.deepEqual(courtyard.progress.records, {
    catalog: 8,
    pulls: 7,
    trades: 5,
    total: 20,
  });
  assert.equal(courtyard.progress.throughputRecordsPerSecond, 2);
  assert.equal(courtyard.progress.total.label, "Total unknown");
  assert.equal(courtyard.quality.state, "warning");
  assert.equal(courtyard.connectionImpact.state, "blocked");
  assert.doesNotMatch(JSON.stringify(overview), /credential-value|cursor-value/);
});

test("source operations report the active profile adapter when no source is selected", async () => {
  const catalogWithoutSources = providerSourceAdminCatalogSchema.parse({
    ...catalogWithV2Candidate,
    sources: [],
  });
  const overview = await runtime("current", catalogWithoutSources).overview(
    organizationId,
  );
  assert.equal(
    overview.connection?.sourceType.adapterVersion,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
});

test("source operations report the selected source adapter ahead of a newer profile candidate", async () => {
  const overview = await runtime("current", catalogWithV2Candidate).overview(
    organizationId,
  );
  assert.equal(
    overview.connection?.sourceType.adapterVersion,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
  assert.notEqual(
    overview.connection?.sourceType.adapterVersion,
    DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  );
});

test("provider detail and filtered diagnostics expose safe links without diagnostic correlation ids", async () => {
  const service = runtime();
  const detail = await service.detail(organizationId, sourceIds(0).providerId);
  assert.equal(detail.runHistory[0]?.id, runId);
  assert.equal(detail.pageProgress[0]?.records.total, 20);
  const diagnostics = await service.diagnostics({
    organizationId,
    providerId: sourceIds(0).providerId,
    filter: { runId },
    limit: 25,
  });
  assert.equal(diagnostics.response.filter.contextEventsHidden, true);
  assert.deepEqual(
    diagnostics.response.events[0]?.references.map(({ kind }) => kind),
    ["run", "quarantine"],
  );
  assert.equal(diagnostics.next?.id, uuid(300));
  assert.doesNotMatch(JSON.stringify(diagnostics.response), new RegExp(uuid(300)));
});

test("expired diagnostic history returns a stable gap with the current source snapshot", async () => {
  const diagnostics = await runtime("expired").diagnostics({
    organizationId,
    providerId: sourceIds(0).providerId,
    filter: {},
    limit: 25,
    before: { occurredAt: now, id: uuid(999) },
  });
  assert.equal(diagnostics.response.history.state, "expired");
  assert.equal(diagnostics.response.events.length, 0);
  assert.equal(diagnostics.response.snapshot.provider, "courtyard");
  assert.equal(diagnostics.next, null);
});
