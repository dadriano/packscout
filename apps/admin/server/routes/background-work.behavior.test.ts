import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type {
  RecomputationQueueEntry,
  RecomputationRecoveryResult,
  RetentionExecutionSummary,
} from "@packscout/contracts";
import {
  evaluateRecomputationBacklog,
  evaluateRetentionCadence,
} from "@packscout/contracts";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createBackgroundWorkRouter,
  type BackgroundWorkRouterDependencies,
} from "./background-work.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const stuckId = "00000000-0000-4000-8000-000000000050";
const failedId = "00000000-0000-4000-8000-000000000051";
const executionId = "00000000-0000-4000-8000-000000000060";
const now = "2026-08-19T12:00:00.000Z";

const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId,
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  permissions: ["providers:view", "imports:start", "imports:retry"],
  csrfToken: "csrf-token",
};
const dataOperator: AuthenticatedActor = {
  ...admin,
  sessionId: "data-session",
  operatorId: "00000000-0000-4000-8000-000000000002",
  role: "data_operator",
};
const viewer: AuthenticatedActor = {
  ...dataOperator,
  sessionId: "viewer-session",
  permissions: ["providers:view"],
};
const outsider: AuthenticatedActor = {
  ...dataOperator,
  sessionId: "outsider-session",
  permissions: [],
};
const sessions: Record<string, AuthenticatedActor> = {
  "admin-session": admin,
  "data-session": dataOperator,
  "viewer-session": viewer,
  "outsider-session": outsider,
};

/**
 * Deliberately unsafe fixtures. Every field the browser must never see carries
 * a recognizable marker so the sanitization assertions cannot pass by accident.
 */
const stuck = {
  id: stuckId,
  providerId,
  platformKey: "fanatics",
  state: "claimed",
  packReference: "pack-private-user-0xprivate",
  attemptCount: 2,
  createdAt: "2026-08-19T11:30:00.000Z",
  availableAt: "2026-08-19T11:30:00.000Z",
  completedAt: null,
  claimedBy: "worker:departed:1",
  claimExpiresAt: "2026-08-19T11:55:00.000Z",
  claimAgeMs: 900_000,
  claimExpired: true,
  failureCode: "ESTIMATED_EV_CALCULATION_FAILED",
  failureSummary: null,
  rawPayload: { username: "private-user", walletAddress: "0xprivate" },
  bearerToken: "never-serialize",
} as const satisfies RecomputationQueueEntry & {
  rawPayload: unknown;
  bearerToken: string;
};
const failed = {
  ...stuck,
  id: failedId,
  state: "failed",
  claimedBy: null,
  claimExpiresAt: null,
  claimAgeMs: null,
  claimExpired: false,
  attemptCount: 5,
  failureCode: "not a stable code: private-user threw at line 42",
  failureSummary: "raw exception body about private-user and 0xprivate",
} as const satisfies RecomputationQueueEntry & {
  rawPayload: unknown;
  bearerToken: string;
};
const execution = {
  id: executionId,
  state: "failed",
  startedAt: "2026-08-19T10:00:00.000Z",
  finishedAt: "2026-08-19T10:00:02.000Z",
  durationMs: 2_000,
  cutoffAt: "2026-05-21T10:00:00.000Z",
  pruned: { pages: 2, sourceRecords: 5, quarantines: 1, total: 8 },
  alreadyExpired: 4,
  remaining: 12,
  failureCode: "RETENTION_BATCH_FAILED",
  failureSummary: "A bounded protected-data cleanup did not complete.",
  rawPayload: { username: "private-user" },
} as const satisfies RetentionExecutionSummary & { rawPayload: unknown };

const backlog = evaluateRecomputationBacklog({
  now,
  pending: 4,
  readyPending: 3,
  claimed: 2,
  expiredClaims: 1,
  failed: 1,
  oldestPendingAvailableAt: "2026-08-19T11:00:00.000Z",
  timelyAfterMs: 60_000,
  depthLimit: 100,
});
const cadence = evaluateRetentionCadence({
  now,
  expectedIntervalMs: 60_000,
  latest: execution,
});

async function withServer(app: Express, runTest: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    await runTest(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

interface HarnessOverrides {
  reads?: Partial<BackgroundWorkRouterDependencies["reads"]>;
  recover?: BackgroundWorkRouterDependencies["recovery"]["recover"];
}

function createHarness(overrides: HarnessOverrides = {}) {
  const organizations: string[] = [];
  const recoveries: {
    action: string;
    requestIds: readonly string[];
    operatorId: string;
    organizationId: string;
  }[] = [];
  const auth: BackgroundWorkRouterDependencies["auth"] = {
    async resolveSession({ sessionToken, csrfToken }) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      }
      if (csrfToken !== undefined && csrfToken !== "csrf-token") {
        throw new AuthServiceError(
          "FORBIDDEN",
          "The request could not be verified.",
          403,
        );
      }
      return sessions[sessionToken] ?? admin;
    },
    requirePermission(session, permission) {
      if (!session.permissions.includes(permission)) {
        throw new AuthServiceError(
          "FORBIDDEN",
          "You do not have permission to perform this action.",
          403,
        );
      }
    },
  };
  const reads: BackgroundWorkRouterDependencies["reads"] = {
    async listRecomputations(request) {
      organizations.push(request.organizationId);
      return { items: [stuck, failed], nextCursor: "queue-next", backlog };
    },
    async listRetentionExecutions(request) {
      organizations.push(request.organizationId);
      return { items: [execution], nextCursor: "retention-next", cadence };
    },
    ...overrides.reads,
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/background-work",
    createBackgroundWorkRouter({
      auth,
      reads,
      recovery: {
        recover:
          overrides.recover ??
          (async (request) => {
            recoveries.push({
              action: request.action,
              requestIds: request.requestIds,
              operatorId: request.actor.operatorId,
              organizationId: request.actor.organizationId,
            });
            return request.requestIds.map((requestId) => ({
              requestId,
              outcome: request.action === "release" ? "released" : "requeued",
              entry: { ...stuck, id: requestId, state: "pending" },
            })) satisfies RecomputationRecoveryResult[];
          }),
      },
      cookiePolicy: createSessionCookiePolicy({
        production: false,
        maxAgeMs: 43_200_000,
      }),
      sameOrigin: createSameOriginGuard([origin]),
    }),
  );
  return {
    app,
    organizations,
    recoveries,
    cookiePolicy: createSessionCookiePolicy({
      production: false,
      maxAgeMs: 43_200_000,
    }),
  };
}

function mutationHeaders(cookieName: string, session = "admin-session") {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `${cookieName}=${session}`,
    "X-CSRF-Token": "csrf-token",
  };
}

function assertBrowserSafe(serialized: string) {
  assert.doesNotMatch(
    serialized,
    /private-user|0xprivate|never-serialize|threw at line 42|raw exception body/,
  );
  assert.doesNotMatch(
    serialized,
    /"(?:rawPayload|bearerToken|username|walletAddress|packExternalId|evInputExternalId)"\s*:/i,
  );
}

test("both operator roles read queue and retention pages with server-derived measures", async () => {
  const { app, organizations, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    assert.equal(
      (await fetch(`${baseUrl}/api/background-work/recomputations`)).status,
      401,
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/background-work/retention-executions`)).status,
      401,
    );

    for (const session of ["admin-session", "data-session"]) {
      const queue = await fetch(
        `${baseUrl}/api/background-work/recomputations?state=failed&limit=25`,
        { headers: { Cookie: `${cookiePolicy.name}=${session}` } },
      );
      assert.equal(queue.status, 200);
      assert.equal(queue.headers.get("cache-control"), "no-store");
      const queueBody = await queue.text();
      assertBrowserSafe(queueBody);
      const queuePayload = JSON.parse(queueBody);
      assert.equal(queuePayload.items.length, 2);
      assert.equal(queuePayload.nextCursor, "queue-next");
      // Depth and oldest-pending age arrive already evaluated, so the browser
      // never recomputes a threshold that alerting also depends on.
      assert.deepEqual(queuePayload.backlog, {
        state: "backlogged",
        depth: 6,
        pending: 4,
        readyPending: 3,
        claimed: 2,
        expiredClaims: 1,
        failed: 1,
        oldestPendingAgeMs: 3_600_000,
        timelyAfterMs: 60_000,
        // The configured depth ceiling reaches the browser as a measure, so the
        // page and the queue alert quote the same threshold.
        depthLimit: 100,
      });

      const retention = await fetch(
        `${baseUrl}/api/background-work/retention-executions?limit=25`,
        { headers: { Cookie: `${cookiePolicy.name}=${session}` } },
      );
      assert.equal(retention.status, 200);
      const retentionBody = await retention.text();
      assertBrowserSafe(retentionBody);
      const retentionPayload = JSON.parse(retentionBody);
      assert.deepEqual(retentionPayload.items[0].pruned, {
        pages: 2,
        sourceRecords: 5,
        quarantines: 1,
        total: 8,
      });
      assert.equal(retentionPayload.cadence.state, "overdue");
      assert.equal(retentionPayload.cadence.knownRemaining, 12);
      assert.equal(retentionPayload.cadence.expectedIntervalMs, 60_000);
    }

    const restricted = await fetch(
      `${baseUrl}/api/background-work/recomputations`,
      { headers: { Cookie: `${cookiePolicy.name}=outsider-session` } },
    );
    assert.equal(restricted.status, 403);
  });
  assert.ok(organizations.length >= 4);
  assert.ok(organizations.every((value) => value === organizationId));
});

test("queue evidence is bounded and never carries provider identifiers", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/background-work/recomputations`,
      { headers: { Cookie: `${cookiePolicy.name}=viewer-session` } },
    );
    const payload = await response.json();
    const [claimed, exhausted] = payload.items;

    // A reference that is not the opaque server-issued handle is replaced
    // rather than forwarded.
    assert.match(claimed.packReference, /^pack:[0-9a-f]{12}$/);
    assert.equal(claimed.claimedBy, "worker:departed:1");
    assert.equal(claimed.claimAgeMs, 900_000);
    assert.equal(claimed.claimExpired, true);

    // An unstable failure code collapses to the stable code, and the sentence
    // is derived from that code instead of any exception text.
    assert.equal(exhausted.failureCode, "ESTIMATED_EV_RECOMPUTATION_FAILED");
    assert.equal(
      exhausted.failureSummary,
      "The recalculation stopped with a bounded operational failure.",
    );
    assert.equal(exhausted.attemptCount, 5);
  });
});

test("recovery requires the retry permission, same origin, and a CSRF token", async () => {
  const { app, recoveries, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/background-work/recomputations/recoveries`;
    const body = JSON.stringify({ action: "release", requestIds: [stuckId] });

    const viewerResponse = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "viewer-session"),
      body,
    });
    assert.equal(viewerResponse.status, 403);

    const crossOrigin = await fetch(path, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy.name, "data-session"),
        Origin: "https://attacker.test",
      },
      body,
    });
    assert.equal(crossOrigin.status, 403);

    const withoutCsrf = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: `${cookiePolicy.name}=data-session`,
      },
      body,
    });
    assert.equal(withoutCsrf.status, 403);

    const anonymous = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-CSRF-Token": "csrf-token",
      },
      body,
    });
    assert.equal(anonymous.status, 401);

    const operator = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "data-session"),
      body,
    });
    assert.equal(operator.status, 200);
    assertBrowserSafe(await operator.text());
  });
  assert.deepEqual(recoveries, [
    {
      action: "release",
      requestIds: [stuckId],
      operatorId: dataOperator.operatorId,
      organizationId,
    },
  ]);
});

test("single and bounded bulk recoveries return independent per-entry outcomes", async () => {
  const { app, recoveries, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const single = await fetch(
      `${baseUrl}/api/background-work/recomputations/${failedId}/recoveries`,
      {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name),
        body: JSON.stringify({ action: "requeue" }),
      },
    );
    assert.equal(single.status, 200);
    const singleBody = await single.text();
    assert.match(singleBody, /"outcome":"requeued"/);
    assertBrowserSafe(singleBody);

    const bulk = await fetch(
      `${baseUrl}/api/background-work/recomputations/recoveries`,
      {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name),
        body: JSON.stringify({ action: "release", requestIds: [stuckId, failedId] }),
      },
    );
    assert.equal(bulk.status, 200);
    const results = (await bulk.json()).results;
    assert.deepEqual(
      results.map((result: RecomputationRecoveryResult) => result.outcome),
      ["released", "released"],
    );
  });
  assert.deepEqual(
    recoveries.map(({ action, requestIds }) => ({ action, count: requestIds.length })),
    [
      { action: "requeue", count: 1 },
      { action: "release", count: 2 },
    ],
  );
});

test("a concurrently completing worker resolves as a conflict, never a failure", async () => {
  const { app, cookiePolicy } = createHarness({
    async recover(request) {
      return request.requestIds.map((requestId) => ({
        requestId,
        outcome: requestId === stuckId ? "already_resolved" : "claim_active",
        entry: {
          ...stuck,
          id: requestId,
          state: requestId === stuckId ? "completed" : "claimed",
          claimExpired: false,
          completedAt: requestId === stuckId ? now : null,
        },
      })) satisfies RecomputationRecoveryResult[];
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/background-work/recomputations/recoveries`,
      {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name),
        body: JSON.stringify({ action: "release", requestIds: [stuckId, failedId] }),
      },
    );
    // The worker won: the operator receives a 200 with a per-entry conflict,
    // not an error that would invite a second recovery attempt.
    assert.equal(response.status, 200);
    const body = await response.text();
    assertBrowserSafe(body);
    const results = JSON.parse(body).results;
    assert.deepEqual(
      results.map((result: RecomputationRecoveryResult) => [
        result.requestId,
        result.outcome,
        result.entry?.state,
      ]),
      [
        [stuckId, "already_resolved", "completed"],
        [failedId, "claim_active", "claimed"],
      ],
    );
  });
});

test("recovery selections and page requests stay bounded and validated", async () => {
  const { app, recoveries, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const tooMany = Array.from({ length: 26 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    );
    const invalidBodies = [
      { action: "release", requestIds: tooMany },
      { action: "release", requestIds: [stuckId, stuckId] },
      { action: "release", requestIds: [] },
      { action: "delete", requestIds: [stuckId] },
      { action: "release", requestIds: [stuckId], extra: true },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(
        `${baseUrl}/api/background-work/recomputations/recoveries`,
        {
          method: "POST",
          headers: mutationHeaders(cookiePolicy.name),
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 422);
      assert.equal(
        (await response.json()).code,
        "INVALID_BACKGROUND_WORK_REQUEST",
      );
    }

    const badId = await fetch(
      `${baseUrl}/api/background-work/recomputations/not-a-uuid/recoveries`,
      {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name),
        body: JSON.stringify({ action: "release" }),
      },
    );
    assert.equal(badId.status, 422);

    for (const query of ["limit=500", "state=archived", "cursor="]) {
      const response = await fetch(
        `${baseUrl}/api/background-work/recomputations?${query}`,
        { headers: { Cookie: `${cookiePolicy.name}=data-session` } },
      );
      assert.equal(response.status, 422);
    }
  });
  assert.deepEqual(recoveries, []);
});

test("read failures map to stable bounded responses", async () => {
  const cursorHarness = createHarness({
    reads: {
      async listRecomputations() {
        throw { code: "INVALID_OPERATION_CURSOR", internalDetail: "private-user" };
      },
      async listRetentionExecutions() {
        throw { code: "RATE_LIMITED", internalDetail: "private throttling key" };
      },
    },
  });
  await withServer(cursorHarness.app, async (baseUrl) => {
    const cursor = await fetch(
      `${baseUrl}/api/background-work/recomputations?cursor=broken`,
      { headers: { Cookie: `${cursorHarness.cookiePolicy.name}=data-session` } },
    );
    assert.equal(cursor.status, 422);
    assert.deepEqual(await cursor.json(), {
      error: "The background work page cursor is invalid.",
      code: "INVALID_OPERATION_CURSOR",
    });

    const limited = await fetch(
      `${baseUrl}/api/background-work/retention-executions`,
      { headers: { Cookie: `${cursorHarness.cookiePolicy.name}=data-session` } },
    );
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "Too many operation requests. Try again later.",
      code: "RATE_LIMITED",
    });
  });

  const brokenHarness = createHarness({
    reads: {
      async listRecomputations() {
        throw new Error("connection to private-user-db refused");
      },
    },
    async recover() {
      throw new Error("private-user recovery detail");
    },
  });
  await withServer(brokenHarness.app, async (baseUrl) => {
    const read = await fetch(`${baseUrl}/api/background-work/recomputations`, {
      headers: { Cookie: `${brokenHarness.cookiePolicy.name}=data-session` },
    });
    assert.equal(read.status, 503);
    assertBrowserSafe(await read.text());

    const mutation = await fetch(
      `${baseUrl}/api/background-work/recomputations/recoveries`,
      {
        method: "POST",
        headers: mutationHeaders(brokenHarness.cookiePolicy.name),
        body: JSON.stringify({ action: "release", requestIds: [stuckId] }),
      },
    );
    assert.equal(mutation.status, 503);
    assertBrowserSafe(await mutation.text());
  });
});
