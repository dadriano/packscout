import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import {
  PROVIDER_SOURCE_OPERATIONS_VERSION,
  type ProviderSourceDiagnosticHistory,
  type ProviderSourceOperationsDetail,
  type ProviderSourceOperationsOverview,
  type ProviderSourceOperationsSource,
} from "@packscout/contracts";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import {
  createProviderSourceOperationsRouter,
  type ProviderSourceOperationsRouterDependencies,
} from "./provider-source-operations.ts";

const uuid = (value: number) =>
  `8a000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = uuid(1);
const otherOrganizationId = uuid(2);
const providerId = uuid(10);
const eventId = uuid(20);
const now = "2026-08-21T12:00:00.000Z";
const actor: AuthenticatedActor = {
  sessionId: uuid(30),
  operatorId: uuid(31),
  organizationId,
  organizationName: "PackScout",
  email: "operator@packscout.test",
  displayName: "Data Operator",
  state: "active",
  role: "data_operator",
  permissions: ["providers:view", "imports:start", "imports:retry"],
  csrfToken: "csrf",
};

function source(index: number): ProviderSourceOperationsSource {
  const provider = [
    "courtyard",
    "collector_crypt",
    "phygitals",
    "clutchpacks",
  ][index] as ProviderSourceOperationsSource["provider"];
  return {
    providerId: index === 0 ? providerId : uuid(10 + index),
    provider,
    displayName: provider.replaceAll("_", " "),
    configured: false,
    source: null,
    schedule: null,
    processor: null,
    freshness: {
      state: "unknown",
      lastHeadReachedAt: null,
      lastProgressAt: null,
    },
    quality: {
      state: "unknown",
      consecutiveFailures: 0,
      latestFailureCode: null,
      recoveredAt: null,
    },
    checkpoint: null,
    progress: {
      pages: 0,
      records: { catalog: 0, pulls: 0, trades: 0, total: 0 },
      dispositions: { inserted: 0, revised: 0, duplicate: 0, quarantined: 0 },
      throughputRecordsPerSecond: null,
      elapsedMilliseconds: 0,
      openQuarantine: 0,
      total: { kind: "unknown", label: "Total unknown" },
    },
    activeRun: null,
    latestRun: null,
    connectionImpact: {
      state: "none",
      safeCode: null,
      healthGeneration: null,
    },
  };
}

const overview: ProviderSourceOperationsOverview = {
  version: PROVIDER_SOURCE_OPERATIONS_VERSION,
  refreshedAt: now,
  connection: null,
  sources: [source(0), source(1), source(2), source(3)],
};
const detail: ProviderSourceOperationsDetail = {
  version: PROVIDER_SOURCE_OPERATIONS_VERSION,
  refreshedAt: now,
  connection: null,
  source: overview.sources[0]!,
  runHistory: [],
  pageProgress: [],
  sourceTest: null,
};
const history: ProviderSourceDiagnosticHistory = {
  version: PROVIDER_SOURCE_OPERATIONS_VERSION,
  refreshedAt: now,
  snapshot: overview.sources[0]!,
  events: [],
  nextCursor: null,
  history: { state: "current" },
  filter: {
    severity: null,
    phase: null,
    runId: null,
    contextEventsHidden: false,
  },
  availablePhases: ["commit"],
};

async function withServer(
  dependencies: ProviderSourceOperationsRouterDependencies,
  callback: (origin: string) => Promise<void>,
) {
  const app = express();
  app.use("/api/provider-source-operations", createProviderSourceOperationsRouter(
    dependencies,
  ));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    await callback(`http://${address.address}:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

function harness(overrides: Partial<ProviderSourceOperationsRouterDependencies["operations"]> = {}) {
  const organizations: string[] = [];
  const diagnosticInputs: unknown[] = [];
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 43_200_000,
  });
  const dependencies: ProviderSourceOperationsRouterDependencies = {
    cookiePolicy,
    diagnosticCursorKey: new Uint8Array(32).fill(7),
    auth: {
      async resolveSession({ sessionToken }) {
        if (!sessionToken) {
          throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
        }
        if (sessionToken === "rate-session") {
          throw new AuthServiceError(
            "RATE_LIMITED",
            "Too many requests.",
            429,
            new Date(Date.now() + 10_000),
          );
        }
        return sessionToken === "other-session"
          ? { ...actor, organizationId: otherOrganizationId }
          : sessionToken === "forbidden-session"
            ? { ...actor, permissions: [] }
            : actor;
      },
      requirePermission(session, permission) {
        if (!session.permissions.includes(permission)) {
          throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
        }
      },
    },
    operations: {
      async overview(organization) {
        organizations.push(organization);
        return overview;
      },
      async detail(organization) {
        organizations.push(organization);
        return detail;
      },
      async diagnostics(input) {
        organizations.push(input.organizationId);
        diagnosticInputs.push(input);
        return {
          response: {
            ...history,
            filter: {
              severity: input.filter.severity ?? null,
              phase: input.filter.phase ?? null,
              runId: input.filter.runId ?? null,
              contextEventsHidden: input.filter.runId !== undefined,
            },
          },
          next: input.before ? null : {
            occurredAt: new Date(now),
            id: eventId,
          },
        };
      },
      ...overrides,
    },
  };
  const cookie = (token: string) => ({
    cookie: `${cookiePolicy.name}=${token}`,
  });
  return { dependencies, organizations, diagnosticInputs, cookie };
}

test("authenticated source operation reads remain tenant scoped and strict", async () => {
  const fixture = harness();
  await withServer(fixture.dependencies, async (origin) => {
    const unauthorized = await fetch(`${origin}/api/provider-source-operations`);
    assert.equal(unauthorized.status, 401);
    const forbidden = await fetch(`${origin}/api/provider-source-operations`, {
      headers: fixture.cookie("forbidden-session"),
    });
    assert.equal(forbidden.status, 403);
    const response = await fetch(`${origin}/api/provider-source-operations`, {
      headers: fixture.cookie("operator-session"),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as ProviderSourceOperationsOverview).sources.length, 4);
    const invalid = await fetch(
      `${origin}/api/provider-source-operations/providers/not-a-provider`,
      { headers: fixture.cookie("operator-session") },
    );
    assert.equal(invalid.status, 422);
    assert.deepEqual(fixture.organizations, [organizationId]);
  });
});

test("diagnostic cursors are opaque and bound to tenant, provider, and filters", async () => {
  const fixture = harness();
  await withServer(fixture.dependencies, async (origin) => {
    const base = `${origin}/api/provider-source-operations/providers/${providerId}/diagnostics`;
    const first = await fetch(base, { headers: fixture.cookie("operator-session") });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as ProviderSourceDiagnosticHistory;
    assert.ok(firstBody.nextCursor);
    assert.doesNotMatch(firstBody.nextCursor, new RegExp(providerId));
    assert.doesNotMatch(firstBody.nextCursor, new RegExp(eventId));
    const second = await fetch(`${base}?cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
      headers: fixture.cookie("operator-session"),
    });
    assert.equal(second.status, 200);
    assert.equal((fixture.diagnosticInputs[1] as { before?: { id: string } }).before?.id, eventId);
    const changedFilter = await fetch(
      `${base}?severity=warning&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: fixture.cookie("operator-session") },
    );
    assert.equal(changedFilter.status, 422);
    const changedTenant = await fetch(
      `${base}?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: fixture.cookie("other-session") },
    );
    assert.equal(changedTenant.status, 422);
    assert.equal(fixture.diagnosticInputs.length, 2);
  });
});

test("rate responses and strict serialization never return unsafe injected fields", async () => {
  const fixture = harness({
    async overview() {
      return { ...overview, bearerCredential: "never-return" } as never;
    },
  });
  await withServer(fixture.dependencies, async (origin) => {
    const rate = await fetch(`${origin}/api/provider-source-operations`, {
      headers: fixture.cookie("rate-session"),
    });
    assert.equal(rate.status, 429);
    assert.ok(rate.headers.get("retry-after"));
    const unsafe = await fetch(`${origin}/api/provider-source-operations`, {
      headers: fixture.cookie("operator-session"),
    });
    assert.equal(unsafe.status, 503);
    assert.doesNotMatch(await unsafe.text(), /never-return/);
  });
});
