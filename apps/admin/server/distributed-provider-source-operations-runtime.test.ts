import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { PROVIDER_SOURCE_OPERATIONS_VERSION, unavailableProviderSourceMeasurements } from "@packscout/contracts";
import type { AdminLocalProviderOverview, AdminLocalRunRecord, CentralPrismaClient } from "@packscout/database";
import { AuthServiceError, createLaunchSourceIntegrationCapabilities, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "./auth/cookies.ts";
import { createDistributedProviderSourceOperationsRuntime } from
  "./distributed-provider-source-operations-runtime.ts";
import { createProviderSourceOperationsRouter } from
  "./routes/provider-source-operations.ts";

const uuid = (value: number) =>
  `8a000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = uuid(1);
const otherOrganizationId = uuid(2);
const now = "2026-08-21T12:00:00.000Z";
const expectedOverview = {
  version: PROVIDER_SOURCE_OPERATIONS_VERSION,
  refreshedAt: now,
  connectionMode: "none",
  connection: null,
  sources: [],
};
const actor: AuthenticatedActor = {
  sessionId: uuid(3),
  operatorId: uuid(4),
  organizationId,
  organizationName: "Empty organization",
  email: "operator@packscout.test",
  displayName: "Data Operator",
  state: "active",
  role: "data_operator",
  permissions: ["providers:view"],
  csrfToken: "csrf",
};

interface ProviderQuery {
  readonly where: {
    readonly organization_id: string;
    readonly lifecycle: { readonly not: string };
  };
  readonly take: number;
}

function emptyOrganizationFixture() {
  const queries: ProviderQuery[] = [];
  const rows = [
    { id: uuid(10), organization_id: organizationId, lifecycle: "archived" },
    { id: uuid(11), organization_id: otherOrganizationId, lifecycle: "active" },
  ];
  let downstreamCalls = 0;
  const runtime = createDistributedProviderSourceOperationsRuntime({
    central: {
      providers: {
        async findMany(query: ProviderQuery) {
          queries.push(query);
          return rows.filter((row) =>
            row.organization_id === query.where.organization_id &&
            row.lifecycle !== query.where.lifecycle.not
          );
        },
      },
    } as unknown as CentralPrismaClient,
    gateway: {
      async runWithAdminProviderDatabase() {
        downstreamCalls += 1;
        throw new Error("An empty organization must not open provider databases.");
      },
    },
    sourceIntegrations: {
      resolve() {
        downstreamCalls += 1;
        throw new Error("An empty organization must not resolve source capabilities.");
      },
    },
    diagnosticCursorKey: new Uint8Array(32).fill(7),
    now: () => new Date(now),
  });
  return { runtime, queries, downstreamCalls: () => downstreamCalls };
}

test("an organization with only archived providers receives an empty runtime overview", async () => {
  const fixture = emptyOrganizationFixture();
  assert.deepEqual(await fixture.runtime.operations.overview(organizationId), expectedOverview);
  assert.equal(fixture.queries.length, 1);
  assert.deepEqual(fixture.queries[0]?.where, {
    organization_id: organizationId,
    lifecycle: { not: "archived" },
  });
  assert.equal(fixture.queries[0]?.take, 50);
  assert.equal(fixture.downstreamCalls(), 0);
});

test("an unsupported configured adapter is distinct from absent configuration without querying either database", async () => {
  let databaseReads = 0;
  const runtime = createDistributedProviderSourceOperationsRuntime({
    central: {
      providers: { async findMany() { return [
        {
          id: uuid(20), provider_key: "clutchpacks", display_name: "ClutchPacks", lifecycle: "active",
          active_config_version: {
            id: uuid(22), adapter_key: "unsupported-adapter-v99",
            schedule_seconds: 3_600, stale_after_seconds: 7_200,
          },
        },
        {
          id: uuid(30), provider_key: "courtyard", display_name: "Courtyard", lifecycle: "active",
          active_config_version: null,
        },
      ]; } },
    } as unknown as CentralPrismaClient,
    gateway: {
      async runWithAdminProviderDatabase() {
        databaseReads += 1;
        throw new Error("Unavailable source capabilities must not open provider databases.");
      },
    },
    sourceIntegrations: createLaunchSourceIntegrationCapabilities(),
    diagnosticCursorKey: new Uint8Array(32).fill(7), now: () => new Date(now),
  });
  const overview = await runtime.operations.overview(organizationId);
  assert.equal(overview.sources.length, 2);
  assert.deepEqual(overview.sources[0]!.measurements, unavailableProviderSourceMeasurements("unsupported"));
  assert.deepEqual(overview.sources[1]!.measurements, unavailableProviderSourceMeasurements("not_configured"));
  assert.equal(databaseReads, 0);
});

test("distributed request sizes use the current immutable profile, never a different run's configuration", async () => {
  const configId = uuid(22);
  const run: AdminLocalRunRecord = {
    id: uuid(21), trigger: "manual", state: "running", requestedByOperatorId: uuid(4),
    configVersionId: configId, configVersionNumber: 4n, workerFence: 3n,
    attemptNumber: 1, recoveryOfRunId: null, requestedCursorHash: null, finalCursorHash: null,
    reachedSourceHead: false, pageCount: 1, catalogCount: 100, pullCount: 0,
    marketEventCount: 0, acceptedCount: 100, duplicateCount: 0, quarantinedCount: 0,
    materialChangeCount: 100, failureCode: null, failureClass: null,
    requestedAt: new Date(now), startedAt: new Date(now), lastProgressAt: new Date(now),
    heartbeatAt: new Date(now), finishedAt: null,
  };
  const overview: AdminLocalProviderOverview = {
    runtimeState: "running", runtimeReason: null, runtimeGeneration: 4n,
    nextDueAt: null, lastAttemptedAt: new Date(now), lastHeadReachedAt: null,
    lastRunnerHeartbeatAt: new Date(now), freshnessState: "unknown", qualityState: "healthy",
    consecutiveFailures: 0, latestFailureCode: null, recoveredAt: null,
    activeRun: { id: run.id, state: "running" }, latestRun: run,
    openQuarantineCount: 0, latestQuarantineReasonCode: null, latestRetention: null,
  };
  const older = { ...run, id: uuid(23), configVersionId: uuid(24), state: "succeeded" as const };
  const runtime = createDistributedProviderSourceOperationsRuntime({
    central: {
      providers: { async findMany() { return [{
        id: uuid(20), provider_key: "clutchpacks", display_name: "ClutchPacks", lifecycle: "active",
        active_config_version: {
          id: configId, adapter_key: "dataforrest-clutchpacks-distributed-adapter-v1",
          schedule_seconds: 3_600, stale_after_seconds: 7_200,
        },
      }]; } },
    } as unknown as CentralPrismaClient,
    gateway: {
      async runWithAdminProviderDatabase() {
        return { state: "reachable", value: { overview, runs: [run, older], details: [],
          measurements: unavailableProviderSourceMeasurements("query_failed") } };
      },
    } as unknown as Parameters<typeof createDistributedProviderSourceOperationsRuntime>[0]["gateway"],
    sourceIntegrations: createLaunchSourceIntegrationCapabilities(),
    diagnosticCursorKey: new Uint8Array(32).fill(7), now: () => new Date(now),
  });
  const detail = await runtime.operations.detail(organizationId, uuid(20));
  assert.equal(detail.source.source?.requestSizePolicy, "adapter_profile");
  assert.equal(detail.source.source?.recordsPerRequest, 2_000);
  assert.equal(detail.source.activeRun?.recordsPerRequest, 2_000);
  assert.equal(detail.source.processor?.activity, "running", "a count failure does not hide runtime state");
  assert.deepEqual(detail.source.measurements.storage, { state: "unavailable", reason: "query_failed" });
  assert.deepEqual(detail.runHistory.map((value) => value.recordsPerRequest), [2_000, null]);
});

test("authorized empty-org source overview returns 200 while unauthorized reads do no work", async () => {
  const fixture = emptyOrganizationFixture();
  const cookiePolicy = createSessionCookiePolicy({ production: false, maxAgeMs: 43_200_000 });
  const app = express();
  app.use("/api/provider-source-operations", createProviderSourceOperationsRouter({
    ...fixture.runtime,
    cookiePolicy,
    auth: {
      async resolveSession({ sessionToken }) {
        if (!sessionToken) {
          throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
        }
        return sessionToken === "forbidden" ? { ...actor, permissions: [] } : actor;
      },
      requirePermission(session, permission) {
        if (!session.permissions.includes(permission)) {
          throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
        }
      },
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const url = `http://${address.address}:${address.port}/api/provider-source-operations`;
    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);
    const forbidden = await fetch(url, {
      headers: { cookie: `${cookiePolicy.name}=forbidden` },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(fixture.queries.length, 0);
    assert.equal(fixture.downstreamCalls(), 0);

    const response = await fetch(`${url}?organizationId=${otherOrganizationId}`, {
      headers: { cookie: `${cookiePolicy.name}=allowed` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedOverview);
    assert.equal(fixture.queries.length, 1);
    assert.equal(fixture.queries[0]?.where.organization_id, organizationId);
    assert.equal(fixture.downstreamCalls(), 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
