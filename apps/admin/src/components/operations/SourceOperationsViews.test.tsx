import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type {
  ProviderSourceDiagnosticHistory,
  ProviderSourceOperationsConnection,
  ProviderSourceOperationsSource,
} from "@packscout/contracts";
import { SourceDiagnosticFeed } from "./SourceDiagnosticFeed.tsx";
import {
  ConnectionOperationsSummary,
  ProviderSourceOperationsLedger,
  sourceOperationalLabel,
} from "./SourceOperationsViews.tsx";

const ids = {
  provider: "00000000-0000-4000-8000-000000000001",
  profile: "00000000-0000-4000-8000-000000000002",
  source: "00000000-0000-4000-8000-000000000003",
  revision: "00000000-0000-4000-8000-000000000004",
  schedule: "00000000-0000-4000-8000-000000000005",
  run: "00000000-0000-4000-8000-000000000006",
};
const now = "2026-08-21T12:00:00.000Z";

const connection: ProviderSourceOperationsConnection = {
  connectionProfileId: ids.profile,
  displayName: "Shared events ingress",
  sourceType: {
    sourceTypeKey: "dataforrest-events-v1",
    label: "Registered event pages",
    adapterVersion: "source-adapter-v1",
    normalizedContractVersion: "provider-observation-v1",
    capabilities: {
      connectionTest: true,
      sourceTest: true,
      pageRead: true,
      cancellation: false,
    },
  },
  state: "active",
  endpointHost: "events.example.test",
  credential: { configured: true, mask: "••••••••" },
  test: {
    state: "succeeded",
    outcome: "success",
    safeCode: "connection_valid",
    requestedAt: now,
    testedAt: now,
    current: true,
  },
  health: { generation: "2", state: "healthy", blocking: null },
  supervisor: {
    state: "active",
    lastRenewedAt: now,
    leaseExpiresAt: now,
    safeTakeoverAt: null,
    safeReasonCode: null,
  },
  capacity: {
    state: "available",
    safeCode: null,
    executionSlots: { used: 2, maximum: 4 },
    requestPermits: { used: 1, maximum: 2, waiting: 1 },
  },
};

const baseSource: ProviderSourceOperationsSource = {
  providerId: ids.provider,
  provider: "courtyard",
  displayName: "First platform",
  configured: true,
  source: {
    sourceInstanceId: ids.source,
    sourceRevisionId: ids.revision,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "source-adapter-v1",
    normalizedContractVersion: "provider-observation-v1",
    mapperKey: "provider-mapper-v1",
    mapperVersion: "1",
    identityNamespaceKey: "provider-records-v1",
    recordIdScopes: ["catalog-record-v1"],
    lifecycle: "active",
    pauseRequested: false,
    recordsPerRequest: 1_000,
    requestSizePolicy: "schedule_revision",
    configuration: {
      validated: true,
      fields: [{ label: "Binding", value: "registered", masked: false }],
    },
  },
  schedule: {
    scheduleRevisionId: ids.schedule,
    intervalSeconds: 300,
    freshnessGraceSeconds: 900,
    nextDueAt: now,
  },
  processor: {
    activity: "running",
    phase: "requesting",
    waitReason: null,
    actionRequiredCode: null,
    continuation: { kind: "continue" },
    retryCount: 0,
    retryNotBefore: null,
    runLeaseAgeMilliseconds: 2_000,
  },
  freshness: { state: "fresh", lastHeadReachedAt: now, lastProgressAt: now },
  quality: {
    state: "warning",
    consecutiveFailures: 0,
    latestFailureCode: null,
    recoveredAt: null,
  },
  cursor: {
    generation: "4",
    fingerprint: "a".repeat(64),
    resumeLabel: "Saved cursor",
  },
  progress: {
    pages: 8,
    records: { catalog: 10, pulls: 20, trades: 30, total: 60 },
    dispositions: { inserted: 44, revised: 4, duplicate: 10, quarantined: 2 },
    throughputRecordsPerSecond: 12.5,
    elapsedMilliseconds: 8_000,
    openQuarantine: 2,
    total: { kind: "unknown", label: "Total unknown" },
  },
  activeRun: {
    id: ids.run,
    trigger: "manual",
    state: "running",
    requestedAt: now,
    startedAt: now,
    finishedAt: null,
    lastProgressAt: now,
    reachedHead: false,
    failureCode: null,
    recordsPerRequest: 500,
  },
  latestRun: null,
  connectionImpact: { state: "none", safeCode: null, healthGeneration: null },
};

test("source-neutral overview renders shared capacity and the exact supplied registered rows", () => {
  Object.assign(globalThis, { React });
  const sources = ["First platform", "Second platform", "Third platform", "Fourth platform"].map(
    (displayName, index) => ({
      ...baseSource,
      providerId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      displayName,
    }),
  );
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ConnectionOperationsSummary connection={connection} mode="shared" />
      <ProviderSourceOperationsLedger sources={sources} canOperate pendingKey={null} onCommand={() => undefined} />
    </MemoryRouter>,
  );
  assert.match(html, /Execution slots/);
  assert.match(html, /2 \/ 4/);
  assert.match(html, /Platform request permits/);
  assert.match(html, /1 waiting/);
  for (const displayName of sources.map((source) => source.displayName)) {
    assert.match(html, new RegExp(displayName));
  }
  assert.equal((html.match(/Total unknown/g) ?? []).length, 4);
  assert.match(html, /60 · Total unknown/);
  assert.match(html, /12\.5\/s/);
  assert.equal(
    (html.match(/Current run: 500\. Next run: 1,000\./g) ?? []).length,
    4,
  );
  assert.doesNotMatch(html, /Maximum records per request[\s\S]*?<input/);
  assert.doesNotMatch(html, /bearer|authorization|rawPayload|vendorCursor/i);
});

test("split-profile migration renders an intentional transition instead of missing configuration", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ConnectionOperationsSummary connection={null} mode="split" />
    </MemoryRouter>,
  );
  assert.match(html, /Multiple profiles in service/);
  assert.match(html, /exact adapter, health, and capacity evidence/);
  assert.doesNotMatch(html, /Not configured|before activating/u);
});

test("source ledger names an unavailable insert/update breakdown without inventing counts", () => {
  Object.assign(globalThis, { React });
  const source = {
    ...baseSource,
    progress: {
      ...baseSource.progress,
      dispositions: { inserted: null, revised: null, duplicate: 10, quarantined: 2 },
    },
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProviderSourceOperationsLedger sources={[source]} canOperate={false}
        pendingKey={null} onCommand={() => undefined} />
    </MemoryRouter>,
  );
  assert.match(html, /Insert\/update breakdown unavailable/);
  assert.match(html, /10 duplicate · 2 quarantined/);
  assert.doesNotMatch(html, /\d+ inserted|\d+ revised/);
});

test("bounded operational labels cover worker, capacity, recovery, retry, pause, failure, and head states", () => {
  const cases: Array<[string, ProviderSourceOperationsSource]> = [
    ["Not configured", { ...baseSource, configured: false, source: null, schedule: null, processor: null, cursor: null }],
    ["Connection transition uncertain", { ...baseSource, connectionImpact: { state: "uncertain", safeCode: "CONNECTION_OUTCOME_UNCERTAIN", healthGeneration: "3" } }],
    ["Waiting on connection recovery", { ...baseSource, connectionImpact: { state: "reconnecting", safeCode: null, healthGeneration: "3" } }],
    ["Pause requested", { ...baseSource, source: { ...baseSource.source!, pauseRequested: true } }],
    ["No live worker", { ...baseSource, processor: null }],
    ["Retrying", { ...baseSource, processor: { ...baseSource.processor!, retryCount: 2 } }],
    ["Queued", { ...baseSource, processor: { ...baseSource.processor!, activity: "queued" } }],
    ["Running", baseSource],
    ["Paused", { ...baseSource, processor: { ...baseSource.processor!, activity: "paused" } }],
    ["Action required", { ...baseSource, processor: { ...baseSource.processor!, activity: "action_required" } }],
    ["Waiting for capacity", { ...baseSource, processor: { ...baseSource.processor!, activity: "waiting", waitReason: "request_lane_capacity" } }],
    ["Failed", { ...baseSource, processor: { ...baseSource.processor!, activity: "inactive" }, activeRun: null, latestRun: { ...baseSource.activeRun!, state: "failed", finishedAt: now, failureCode: "SOURCE_FAILED" } }],
    ["Reached head", { ...baseSource, processor: { ...baseSource.processor!, activity: "inactive", phase: "reached_head" }, activeRun: null }],
  ];
  for (const [expected, source] of cases) {
    assert.equal(sourceOperationalLabel(source), expected);
  }
});

test("action-required processors block manual runs and name the tested lifecycle recovery", () => {
  Object.assign(globalThis, { React });
  const source: ProviderSourceOperationsSource = {
    ...baseSource,
    source: {
      ...baseSource.source!,
      lifecycle: "paused",
    },
    processor: {
      ...baseSource.processor!,
      activity: "action_required",
      phase: "action_required",
      waitReason: "action_required",
      actionRequiredCode: "SOURCE_ACTION_REQUIRED",
    },
    activeRun: null,
    latestRun: {
      ...baseSource.activeRun!,
      state: "failed",
      finishedAt: now,
      failureCode: "SOURCE_ACTION_REQUIRED",
    },
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProviderSourceOperationsLedger
        sources={[source]}
        canOperate
        pendingKey={null}
        onCommand={() => undefined}
      />
    </MemoryRouter>,
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*>Resolve before run<\/button>/u);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Resume<\/button>/u);
  assert.match(html, /Disable this source.*Test source.*Activate paused.*Resume/u);
  assert.doesNotMatch(html, />Retry source<|>Run now</u);
});

test("diagnostic feed labels shared context, run-filter hiding, expiry gaps, and safe references", () => {
  Object.assign(globalThis, { React });
  const page: ProviderSourceDiagnosticHistory = {
    version: "packscout.provider-source-operations.v1",
    refreshedAt: now,
    snapshot: baseSource,
    events: [{
      scope: "connection",
      scopeLabel: "Shared connection",
      eventKind: "connection_episode",
      severity: "critical",
      phase: "request",
      safeCode: "CONNECTION_BLOCKED",
      occurredAt: now,
      durationMilliseconds: 120,
      responseBytes: null,
      retryDelayMilliseconds: 5_000,
      continuation: null,
      cursorFingerprint: null,
      counters: { attempts: 2 },
      references: [{ kind: "run", label: "Open run", href: `/runs/${ids.run}?providerId=${baseSource.providerId}` }],
    }],
    nextCursor: null,
    history: {
      state: "expired",
      message: "Older diagnostic history has expired. Current source state is shown above.",
    },
    filter: {
      severity: null,
      phase: null,
      runId: ids.run,
      contextEventsHidden: true,
    },
    availablePhases: ["request"],
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SourceDiagnosticFeed pages={[page]} filter={{ runId: ids.run }} runs={[]}
        loading={false} loadingOlder={false} error={null} onFilterChange={() => undefined}
        onLoadOlder={() => undefined} onRetry={() => undefined} />
    </MemoryRouter>,
  );
  assert.match(html, /Shared connection/);
  assert.match(html, /only matching run and page events/);
  assert.match(html, /History gap/);
  assert.match(html, /Older diagnostic history has expired/);
  assert.ok(html.includes(`href="/runs/${ids.run}?providerId=${baseSource.providerId}"`));
  assert.doesNotMatch(html, /eventId|connectionTestJobId|commandCorrelationKey|authorization/i);
});
