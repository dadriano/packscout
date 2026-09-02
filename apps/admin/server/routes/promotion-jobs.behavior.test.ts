import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type Express } from "express";
import type {
  PromotionJobHistoryPage,
  PromotionJobInvocationDetail,
  PromotionJobInvocationMonitoring,
  PromotionJobMonitoringOverview,
} from "@packscout/contracts";
import {
  AuthServiceError,
  type AuthenticatedActor,
} from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import {
  createPromotionJobsRouter,
  type PromotionJobsRouterDependencies,
} from "./promotion-jobs.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const now = "2026-09-01T12:00:00.000Z";
const monitoringId = "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g";

const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "10000000-0000-4000-8000-000000000011",
  organizationId,
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Admin",
  state: "active",
  role: "admin",
  permissions: ["providers:view"],
  csrfToken: "csrf",
};
const operator: AuthenticatedActor = {
  ...admin,
  sessionId: "operator-session",
  operatorId: "10000000-0000-4000-8000-000000000012",
  role: "data_operator",
};
const outsider: AuthenticatedActor = {
  ...operator,
  sessionId: "outsider-session",
  permissions: [],
};
const sessions: Record<string, AuthenticatedActor> = {
  "admin-session": admin,
  "operator-session": operator,
  "outsider-session": outsider,
};

const invocation: PromotionJobInvocationMonitoring = {
  monitoringId,
  job: "manifest",
  trigger: "reconciliation_cron",
  state: "terminal",
  outcome: "no_change",
  requestedAt: now,
  startedAt: now,
  finishedAt: now,
  durationMs: 0,
  cycleCount: 1,
  attemptCount: 0,
  retryCount: 0,
  failureCode: null,
  continuationPending: false,
};

const overview: PromotionJobMonitoringOverview = {
  observedAt: now,
  roster: {
    observedAt: now,
    version: "1",
    highWater: "1",
    digest: "a".repeat(64),
    providerCount: 0,
    eligibleProviderCount: 0,
  },
  evaluator: {
    state: "current",
    observedAt: now,
    evaluatedThrough: now,
    rosterVersion: "1",
    rosterHighWater: "1",
    rosterDigest: "a".repeat(64),
    expectedCount: 1,
    reachableCount: 1,
    unavailableCount: 0,
    manifestEvaluated: true,
    failureCode: null,
  },
  manifest: {
    evidenceSource: "live",
    observedAt: now,
    stale: false,
    schedule: null,
    wake: null,
    activeManifest: null,
    previousManifest: null,
    gateQueueDepth: 0,
    oldestGateAgeMs: null,
    serializedOperation: null,
    lastActivationAt: null,
    lastReconciliationAt: now,
    latestInvocation: invocation,
  },
  providers: [],
};

const history: PromotionJobHistoryPage = {
  items: [invocation],
  nextCursor: null,
  rosterDigest: "a".repeat(64),
};
const detail: PromotionJobInvocationDetail = {
  invocation,
  totalAttemptCount: 0,
  truncatedAttemptCount: 0,
  attemptSetDigest: "b".repeat(64),
  attempts: [],
};

async function withServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    await run(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

function harness(
  overrides: Partial<PromotionJobsRouterDependencies["reads"]> = {},
) {
  const organizations: string[] = [];
  const auth: PromotionJobsRouterDependencies["auth"] = {
    async resolveSession({ sessionToken }) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in.", 401);
      }
      return sessions[sessionToken] ?? admin;
    },
    requirePermission(session, permission) {
      if (!session.permissions.includes(permission)) {
        throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
      }
    },
  };
  const reads: PromotionJobsRouterDependencies["reads"] = {
    async overview(input) {
      organizations.push(input.organizationId);
      return overview;
    },
    async history(input) {
      organizations.push(input.organizationId);
      return history;
    },
    async detail(input) {
      organizations.push(input.organizationId);
      return input.monitoringId === monitoringId ? detail : null;
    },
    ...overrides,
  };
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 60_000,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/promotion-jobs", createPromotionJobsRouter({
    auth,
    reads,
    cookiePolicy,
  }));
  return { app, cookiePolicy, organizations };
}

function cookie(name: string, session: string) {
  return { Cookie: `${name}=${session}` };
}

test("anonymous and forbidden reads fail while both operator roles are authorized", async () => {
  const context = harness();
  await withServer(context.app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/promotion-jobs/overview`)).status, 401);
    for (const session of ["admin-session", "operator-session"]) {
      const response = await fetch(`${baseUrl}/api/promotion-jobs/overview`, {
        headers: cookie(context.cookiePolicy.name, session),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const forbidden = await fetch(`${baseUrl}/api/promotion-jobs/overview`, {
      headers: cookie(context.cookiePolicy.name, "outsider-session"),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("cache-control"), "no-store");
  });
  assert.deepEqual(context.organizations, [organizationId, organizationId]);
});

test("history filters are exact, bounded, and invalid scope never reaches reads", async () => {
  let queries = 0;
  const context = harness({
    history: async () => {
      queries += 1;
      return history;
    },
  });
  await withServer(context.app, async (baseUrl) => {
    const valid = await fetch(
      `${baseUrl}/api/promotion-jobs/history?filter=manifest&limit=25`,
      { headers: cookie(context.cookiePolicy.name, "operator-session") },
    );
    assert.equal(valid.status, 200);
    for (const query of ["filter=all", "filter=alpha", "limit=101", "extra=x"]) {
      const response = await fetch(
        `${baseUrl}/api/promotion-jobs/history?${query}`,
        { headers: cookie(context.cookiePolicy.name, "operator-session") },
      );
      assert.equal(response.status, 422, query);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });
  assert.equal(queries, 1);
});

test("response validation strips undeclared protected fields", async () => {
  const unsafe = {
    ...overview,
    organizationId: organizationId,
    databaseUrl: "postgres://private",
    manifest: {
      ...overview.manifest,
      credential: "private",
      requestBody: "private",
    },
  } as PromotionJobMonitoringOverview;
  const context = harness({ overview: async () => unsafe });
  await withServer(context.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/promotion-jobs/overview`, {
      headers: cookie(context.cookiePolicy.name, "operator-session"),
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.doesNotMatch(
      serialized,
      /organizationId|databaseUrl|credential|requestBody|postgres:\/\//u,
    );
  });
});

test("opaque detail lookup makes missing and cross-scope records indistinguishable", async () => {
  const context = harness({ detail: async () => null });
  await withServer(context.app, async (baseUrl) => {
    const missing = await fetch(
      `${baseUrl}/api/promotion-jobs/history/${monitoringId}`,
      { headers: cookie(context.cookiePolicy.name, "operator-session") },
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: "The promotion job record was not found.",
      code: "PROMOTION_JOB_MONITORING_NOT_FOUND",
    });
    const invalid = await fetch(
      `${baseUrl}/api/promotion-jobs/history/10000000-0000-4000-8000-000000000001`,
      { headers: cookie(context.cookiePolicy.name, "operator-session") },
    );
    assert.equal(invalid.status, 422);
  });
});

test("cursor, rate-limit, and dependency failures keep stable independent errors", async () => {
  for (const [code, status] of [
    ["INVALID_PROMOTION_JOB_CURSOR", 422],
    ["RATE_LIMITED", 429],
    ["BROKEN", 503],
  ] as const) {
    const context = harness({
      history: async () => Promise.reject({ code }),
    });
    await withServer(context.app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/promotion-jobs/history`, {
        headers: cookie(context.cookiePolicy.name, "operator-session"),
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
  }
});
