#!/usr/bin/env node

import { createServer, type ServerResponse } from "node:http";
import type {
  PromotionJobHistoryPage,
  PromotionJobInvocationDetail,
  PromotionJobInvocationMonitoring,
  PromotionJobMonitoringOverview,
} from "@packscout/contracts";
import { operationsSession } from "../../apps/admin/src/testing/provider-source-operations-fixture.ts";

const port = Number(process.env.PACKSCOUT_ADMIN_PROMOTION_FIXTURE_PORT ?? "4175");
const browserOrigin = process.env.PACKSCOUT_ADMIN_PROMOTION_FIXTURE_ORIGIN ??
  "http://127.0.0.1:5175";
const now = "2026-09-01T12:00:00.000Z";
const digest = "a".repeat(64);
const monitoringId = "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g";

if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new TypeError("PACKSCOUT_ADMIN_PROMOTION_FIXTURE_PORT must be a non-reserved TCP port.");
}

function headers(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", browserOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type, X-CSRF-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function invocation(
  id: string,
  job: PromotionJobInvocationMonitoring["job"],
  outcome: PromotionJobInvocationMonitoring["outcome"] = "caught_up",
): PromotionJobInvocationMonitoring {
  return {
    monitoringId: id,
    job,
    trigger: job === "manifest" ? "reconciliation_cron" : "change_wake",
    state: "terminal",
    outcome,
    requestedAt: now,
    startedAt: now,
    finishedAt: "2026-09-01T12:00:01.250Z",
    durationMs: 1_250,
    cycleCount: 1,
    attemptCount: 1,
    retryCount: outcome === "failed" ? 1 : 0,
    failureCode: outcome === "failed" ? "PROVIDER_UNREACHABLE" : null,
    continuationPending: false,
  };
}

const providerInvocation = invocation(monitoringId, "provider:alpha");

const overview: PromotionJobMonitoringOverview = {
  observedAt: now,
  roster: { observedAt: now, version: "12", highWater: "96", digest, eligibleProviderCount: 3 },
  evaluator: {
    state: "stale",
    observedAt: now,
    evaluatedThrough: "2026-09-01T11:58:00.000Z",
    rosterVersion: "11",
    rosterHighWater: "95",
    rosterDigest: "b".repeat(64),
    expectedCount: 4,
    reachableCount: 3,
    unavailableCount: 1,
    manifestEvaluated: true,
    failureCode: null,
  },
  manifest: {
    evidenceSource: "live",
    observedAt: now,
    stale: false,
    schedule: {
      lifecycle: "active",
      health: "healthy",
      scheduleEpoch: "12",
      missedWindowCount: "0",
      lastScheduledCheckinAt: now,
      nextExpectedCheckinAt: "2026-09-01T12:01:00.000Z",
    },
    wake: {
      pending: true,
      requestedGeneration: "22",
      acknowledgedGeneration: "21",
      latestCause: "provider_release_completed",
      latestRequestedAt: now,
      deliveryState: "pending",
      lastDeliveryAttemptAt: null,
      failureCode: null,
    },
    activeManifest: {
      publicManifestId: "manifest-96",
      fingerprint: digest,
      generation: "96",
      activatedAt: now,
    },
    previousManifest: {
      publicManifestId: "manifest-95",
      fingerprint: "c".repeat(64),
      generation: "95",
      activatedAt: "2026-09-01T11:55:00.000Z",
    },
    gateQueueDepth: 1,
    oldestGateAgeMs: 12_000,
    serializedOperation: {
      operation: "advance",
      providerKey: "alpha",
      state: "sent",
      attemptCount: 1,
      failureCode: null,
    },
    lastActivationAt: now,
    lastReconciliationAt: now,
    latestInvocation: invocation(
      "pj_7HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
      "manifest",
      "no_change",
    ),
  },
  providers: [
    {
      providerKey: "alpha",
      displayName: "Alpha Cards",
      lifecycle: "active",
      evidenceSource: "live",
      observedAt: now,
      stale: false,
      routeFailureCode: null,
      state: "awaiting_activation",
      schedule: {
        lifecycle: "active",
        health: "healthy",
        scheduleEpoch: "4",
        missedWindowCount: "0",
        lastScheduledCheckinAt: now,
        nextExpectedCheckinAt: "2026-09-01T12:01:00.000Z",
      },
      wake: null,
      settledPosition: "91",
      completedRelease: { publicReleaseId: "alpha-91", fingerprint: digest, position: "91" },
      activeRelease: { publicReleaseId: "alpha-90", fingerprint: digest, position: "90" },
      pendingGate: {
        operation: "advance",
        state: "running",
        requestedGeneration: "2",
        acknowledgedGeneration: "1",
        requestedAt: now,
        attemptCount: 1,
        retryAt: null,
        failureCode: null,
      },
      latestInvocation: providerInvocation,
      projectionLagMs: 250,
    },
    {
      providerKey: "beta",
      displayName: "Beta Breaks",
      lifecycle: "archived",
      evidenceSource: "last_known",
      observedAt: "2026-09-01T11:45:00.000Z",
      stale: true,
      routeFailureCode: "PROVIDER_UNREACHABLE",
      state: "last_known",
      schedule: null,
      wake: null,
      settledPosition: "44",
      completedRelease: null,
      activeRelease: null,
      pendingGate: null,
      latestInvocation: null,
      projectionLagMs: null,
    },
    {
      providerKey: "gamma",
      displayName: "Gamma Market",
      lifecycle: "disabled",
      evidenceSource: "live",
      observedAt: now,
      stale: false,
      routeFailureCode: null,
      state: "inactive",
      schedule: null,
      wake: null,
      settledPosition: "12",
      completedRelease: null,
      activeRelease: { publicReleaseId: "gamma-12", fingerprint: digest, position: "12" },
      pendingGate: null,
      latestInvocation: null,
      projectionLagMs: 0,
    },
  ],
};

const history: PromotionJobHistoryPage = {
  items: [
    providerInvocation,
    invocation("pj_8HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g", "manifest", "no_change"),
    invocation("pj_9HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g", "provider:beta", "failed"),
  ],
  nextCursor: null,
  rosterDigest: digest,
};

const detail: PromotionJobInvocationDetail = {
  invocation: providerInvocation,
  totalAttemptCount: 1,
  truncatedAttemptCount: 0,
  attemptSetDigest: digest,
  attempts: [{
    attemptNumber: 1,
    kind: "provider",
    state: "completed",
    targetPosition: "91",
    retryCount: 0,
    failureCode: null,
    publicReleaseId: "alpha-91",
    releaseFingerprint: digest,
    totalOperationCount: 2,
    truncatedOperationCount: 0,
    orderedOperationDigest: digest,
    operationSummariesDigest: digest,
    observedAt: now,
    operations: [
      {
        operationNumber: 1,
        kind: "stageBatch",
        state: "acknowledged",
        sendCount: 1,
        sentAt: now,
        acknowledgedAt: now,
        operationIdDigest: digest,
        requestDigest: digest,
        receiptDigest: digest,
      },
      {
        operationNumber: 2,
        kind: "finalizeRelease",
        state: "acknowledged",
        sendCount: 1,
        sentAt: now,
        acknowledgedAt: now,
        operationIdDigest: digest,
        requestDigest: digest,
        receiptDigest: digest,
      },
    ],
  }],
};

const server = createServer((request, response) => {
  headers(response);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    json(response, 200, operationsSession("data_operator"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/promotion-jobs/overview") {
    json(response, 200, overview);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/promotion-jobs/history") {
    const filter = url.searchParams.get("filter");
    json(response, 200, {
      ...history,
      items: filter ? history.items.filter((item) => item.job === filter) : history.items,
    });
    return;
  }
  if (
    request.method === "GET"
    && url.pathname === `/api/promotion-jobs/history/${monitoringId}`
  ) {
    json(response, 200, detail);
    return;
  }
  json(response, 404, { error: "Local fixture route not found.", code: "FIXTURE_NOT_FOUND" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PackScout promotion fixture API is available at http://127.0.0.1:${port}/api`);
});

function shutdown(): void {
  server.close((error) => {
    if (error) process.exitCode = 1;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
