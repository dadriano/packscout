import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import {
  evaluateRunStall,
  evaluateScheduleHealth,
  evaluateWorkerFleet,
  resolveWorkerFleetSettings,
  type ScheduleHealthView,
  type StalledRunView,
  type WorkerEffectiveSettings,
  type WorkerInstanceView,
} from "@packscout/contracts";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import {
  createWorkerFleetRouter,
  type WorkerFleetRouterDependencies,
} from "./worker-fleet.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";
const otherOrganizationId = "00000000-0000-4000-8000-000000000011";
const providerId = "00000000-0000-4000-8000-000000000020";
const foreignProviderId = "00000000-0000-4000-8000-000000000021";
const runId = "00000000-0000-4000-8000-000000000030";
const foreignRunId = "00000000-0000-4000-8000-000000000031";
const now = "2026-08-20T12:00:00.000Z";

const settings: WorkerEffectiveSettings = {
  heartbeatIntervalMs: 15_000,
  presenceStaleAfterMs: 60_000,
  runHeartbeatStaleAfterMs: 300_000,
  scheduleClaimLeaseMs: 120_000,
  importRunLeaseMs: 600_000,
  protectedPayloadRetentionDays: 90,
  presenceRetentionDays: 30,
};

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
const outsider: AuthenticatedActor = {
  ...dataOperator,
  sessionId: "outsider-session",
  permissions: [],
};
const sessions: Record<string, AuthenticatedActor> = {
  "admin-session": admin,
  "data-session": dataOperator,
  "outsider-session": outsider,
};

/**
 * Deliberately unsafe fixtures. Every field the browser must never see carries
 * a recognizable marker so the sanitization assertions cannot pass by accident.
 */
const liveInstance = {
  instanceId: "worker:live:1",
  status: "running",
  state: "running",
  version: "1.4.2",
  host: "pipeline-a",
  runtimeVersion: "22.11.0",
  startedAt: "2026-08-20T08:00:00.000Z",
  upForMs: 14_400_000,
  lastHeartbeatAt: "2026-08-20T11:59:55.000Z",
  heartbeatAgeMs: 5_000,
  stoppedAt: null,
  activity: {
    kind: "importing",
    scope: "workspace",
    providerId,
    providerName: "Fanatics Live",
    runId,
    startedAt: "2026-08-20T11:50:00.000Z",
    ageMs: 600_000,
  },
  effectiveSettings: settings,
  bearerToken: "never-serialize",
} as const satisfies WorkerInstanceView & { bearerToken: string };

const foreignInstance = {
  ...liveInstance,
  instanceId: "worker:live:2\nX-Injected: true",
  activity: {
    kind: "importing",
    scope: "other_workspace",
    // A foreign workspace's identifiers must not reach this operator, even
    // when the runtime hands them to the route.
    providerId: foreignProviderId,
    providerName: "private-user competitor feed",
    runId: foreignRunId,
    startedAt: "2026-08-20T11:40:00.000Z",
    ageMs: 1_200_000,
  },
} as const satisfies WorkerInstanceView & { bearerToken: string };

const staleInstance = {
  ...liveInstance,
  instanceId: "worker:departed:1",
  status: "stale",
  lastHeartbeatAt: "2026-08-20T11:40:00.000Z",
  heartbeatAgeMs: 1_200_000,
  activity: {
    kind: "idle",
    scope: "idle",
    providerId: null,
    providerName: null,
    runId: null,
    startedAt: null,
    ageMs: null,
  },
} as const satisfies WorkerInstanceView & { bearerToken: string };

const stalledRun = {
  runId,
  providerId,
  providerName: "Fanatics Live",
  platformKey: "fanatics",
  trigger: "scheduled",
  startedAt: "2026-08-20T11:00:00.000Z",
  lastHeartbeatAt: "2026-08-20T11:50:00.000Z",
  stall: evaluateRunStall({
    now,
    stalled: true,
    lastSignalAt: "2026-08-20T11:50:00.000Z",
    staleAfterMs: settings.runHeartbeatStaleAfterMs,
  }),
  leaseOwner: "worker:departed:1",
  leaseOwnerPresent: false,
  leaseExpiresAt: "2026-08-20T11:55:00.000Z",
  leaseExpired: true,
  rawPayload: { username: "private-user", walletAddress: "0xprivate" },
} as const satisfies StalledRunView & { rawPayload: unknown };

const wedgedSchedule = {
  providerId,
  providerName: "Fanatics Live",
  platformKey: "fanatics",
  nextDueAt: "2026-08-20T11:00:00.000Z",
  health: evaluateScheduleHealth({
    now,
    nextDueAt: "2026-08-20T11:00:00.000Z",
    claimOwner: "worker:departed:1",
    claimExpiresAt: "2026-08-20T11:05:00.000Z",
    lastClaimedAt: "2026-08-20T11:00:30.000Z",
    overdueAfterMs: settings.presenceStaleAfterMs,
  }),
  claimOwner: "worker:departed:1",
  claimOwnerPresent: false,
  claimExpiresAt: "2026-08-20T11:05:00.000Z",
  lastClaimedAt: "2026-08-20T11:00:30.000Z",
  lastOutcome: "raw failure: private-user threw at line 42",
  lastRunId: runId,
  rawPayload: { walletAddress: "0xprivate" },
} as const satisfies ScheduleHealthView & { rawPayload: unknown };

const degradedFleet = evaluateWorkerFleet({
  now,
  instances: [
    { status: "running", heartbeatAgeMs: 5_000 },
    { status: "running", heartbeatAgeMs: 5_000 },
    { status: "stale", heartbeatAgeMs: 1_200_000 },
  ],
  stalledRuns: 1,
  wedgedSchedules: 1,
});
const resolution = resolveWorkerFleetSettings([settings]);

async function withServer(
  app: Express,
  runTest: (baseUrl: string) => Promise<void>,
) {
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

function createHarness(
  overrides: Partial<WorkerFleetRouterDependencies["reads"]> = {},
) {
  const organizations: string[] = [];
  const cursors: (string | undefined)[] = [];
  const auth: WorkerFleetRouterDependencies["auth"] = {
    async resolveSession({ sessionToken }) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
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
  const reads: WorkerFleetRouterDependencies["reads"] = {
    async listInstances(request) {
      organizations.push(request.organizationId);
      return {
        instances: [liveInstance, foreignInstance, staleInstance],
        hasMore: true,
        fleet: degradedFleet,
        settings: resolution,
      };
    },
    async listStalledRuns(request) {
      organizations.push(request.organizationId);
      cursors.push(request.cursor);
      return {
        items: [stalledRun],
        nextCursor: "stalled-next",
        staleAfterMs: settings.runHeartbeatStaleAfterMs,
      };
    },
    async listScheduleHealth(request) {
      organizations.push(request.organizationId);
      cursors.push(request.cursor);
      return {
        items: [wedgedSchedule],
        nextCursor: "schedule-next",
        overdueAfterMs: settings.presenceStaleAfterMs,
      };
    },
    async readSettings(request) {
      organizations.push(request.organizationId);
      return { settings: resolution, observedAt: now };
    },
    ...overrides,
  };
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 43_200_000,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker-fleet",
    createWorkerFleetRouter({ auth, reads, cookiePolicy }),
  );
  return { app, organizations, cursors, cookiePolicy };
}

const readPaths = [
  "/api/worker-fleet/instances",
  "/api/worker-fleet/stalled-runs",
  "/api/worker-fleet/schedules",
  "/api/worker-fleet/settings",
];

function assertBrowserSafe(serialized: string) {
  assert.doesNotMatch(
    serialized,
    /private-user|0xprivate|never-serialize|threw at line 42|X-Injected/,
  );
  assert.doesNotMatch(
    serialized,
    /"(?:rawPayload|bearerToken|username|walletAddress)"\s*:/i,
  );
  assert.doesNotMatch(serialized, new RegExp(otherOrganizationId));
  assert.doesNotMatch(serialized, new RegExp(foreignProviderId));
  assert.doesNotMatch(serialized, new RegExp(foreignRunId));
}

test("anonymous requests are refused and both operator roles may read", async () => {
  const { app, organizations, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    for (const path of readPaths) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
    }

    // Worker status is operational reading, so the data operator sees exactly
    // what the administrator sees.
    for (const session of ["admin-session", "data-session"]) {
      for (const path of readPaths) {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { Cookie: `${cookiePolicy.name}=${session}` },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assertBrowserSafe(await response.text());
      }
    }

    for (const path of readPaths) {
      const restricted = await fetch(`${baseUrl}${path}`, {
        headers: { Cookie: `${cookiePolicy.name}=outsider-session` },
      });
      assert.equal(restricted.status, 403);
    }
  });
  assert.equal(organizations.length, readPaths.length * 2);
  assert.ok(organizations.every((value) => value === organizationId));
});

test("fleet evidence arrives already evaluated by the server", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/worker-fleet/instances`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    const payload = await response.json();

    // The browser renders this judgement; admin-tools/009 alerts on the same
    // one, so it is transported verbatim rather than recomputed anywhere.
    assert.deepEqual(payload.fleet, {
      state: "degraded",
      observed: 3,
      live: 2,
      stale: 1,
      stopped: 0,
      silentForMs: null,
      stalledRuns: 1,
      wedgedSchedules: 1,
    });
    assert.equal(payload.hasMore, true);
    assert.deepEqual(payload.settings, {
      settings,
      source: "uniform",
      publishers: 1,
    });

    const [live, foreign, stale] = payload.instances;
    assert.equal(live.instanceId, "worker:live:1");
    assert.equal(live.activity.providerId, providerId);
    assert.equal(live.activity.runId, runId);
    assert.equal(live.heartbeatAgeMs, 5_000);

    // A worker identity that does not match the published shape is dropped
    // instead of forwarded, and foreign work is named by kind only.
    assert.equal(foreign.instanceId, "unidentified-instance");
    assert.equal(foreign.activity.scope, "other_workspace");
    assert.equal(foreign.activity.providerId, null);
    assert.equal(foreign.activity.providerName, null);
    assert.equal(foreign.activity.runId, null);

    assert.equal(stale.status, "stale");
    assert.equal(stale.activity.kind, "idle");
  });
});

test("fleet silence and the never-reported case are distinct answers", async () => {
  const silent = evaluateWorkerFleet({
    now,
    instances: [
      { status: "stale", heartbeatAgeMs: 900_000 },
      { status: "stopped", heartbeatAgeMs: 3_600_000 },
    ],
    stalledRuns: 3,
    wedgedSchedules: 2,
  });
  const silentHarness = createHarness({
    async listInstances() {
      return {
        instances: [staleInstance],
        hasMore: false,
        fleet: silent,
        settings: resolution,
      };
    },
  });
  await withServer(silentHarness.app, async (baseUrl) => {
    const payload = await (
      await fetch(`${baseUrl}/api/worker-fleet/instances`, {
        headers: { Cookie: `${silentHarness.cookiePolicy.name}=data-session` },
      })
    ).json();
    assert.equal(payload.fleet.state, "silent");
    assert.equal(payload.fleet.live, 0);
    assert.equal(payload.fleet.silentForMs, 900_000);
    assert.equal(payload.fleet.observed, 2);
  });

  const emptyHarness = createHarness({
    async listInstances() {
      return {
        instances: [],
        hasMore: false,
        fleet: evaluateWorkerFleet({
          now,
          instances: [],
          stalledRuns: 0,
          wedgedSchedules: 0,
        }),
        settings: resolveWorkerFleetSettings([]),
      };
    },
  });
  await withServer(emptyHarness.app, async (baseUrl) => {
    const payload = await (
      await fetch(`${baseUrl}/api/worker-fleet/instances`, {
        headers: { Cookie: `${emptyHarness.cookiePolicy.name}=admin-session` },
      })
    ).json();
    // No record exists, so no silence duration is invented for one.
    assert.equal(payload.fleet.state, "never_reported");
    assert.equal(payload.fleet.silentForMs, null);
    assert.equal(payload.fleet.observed, 0);
    assert.deepEqual(payload.settings, {
      settings: null,
      source: "none",
      publishers: 0,
    });
  });
});

test("stalled runs and schedules carry their conditions and deep-link identities", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const runs = await (
      await fetch(`${baseUrl}/api/worker-fleet/stalled-runs?limit=25`, {
        headers: { Cookie: `${cookiePolicy.name}=data-session` },
      })
    ).json();
    const [run] = runs.items;
    assert.equal(run.runId, runId);
    assert.equal(run.providerId, providerId);
    assert.equal(run.leaseOwner, "worker:departed:1");
    assert.equal(run.leaseOwnerPresent, false);
    assert.equal(run.stall.stalled, true);
    assert.equal(run.stall.heartbeatAgeMs, 600_000);
    assert.equal(run.stall.staleAfterMs, 300_000);
    assert.equal(run.stall.overdueByMs, 300_000);
    assert.equal(runs.staleAfterMs, 300_000);
    assert.equal(runs.nextCursor, "stalled-next");

    const schedules = await (
      await fetch(`${baseUrl}/api/worker-fleet/schedules?limit=25`, {
        headers: { Cookie: `${cookiePolicy.name}=data-session` },
      })
    ).json();
    const [schedule] = schedules.items;
    assert.equal(schedule.providerId, providerId);
    assert.equal(schedule.health.state, "claim_expired");
    assert.equal(schedule.health.overdueByMs, 3_600_000);
    assert.equal(schedule.claimOwner, "worker:departed:1");
    assert.equal(schedule.lastRunId, runId);
    // An outcome that is not a stable code is dropped rather than shown.
    assert.equal(schedule.lastOutcome, null);
    assert.equal(schedules.overdueAfterMs, 60_000);
    assert.equal(schedules.nextCursor, "schedule-next");
  });
});

test("page requests stay bounded and cursors round-trip", async () => {
  const { app, cursors, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const rejected = [
      "limit=0",
      "limit=51",
      "limit=500",
      "limit=abc",
      "limit=2.5",
      "cursor=",
      "state=running",
    ];
    for (const path of [
      "/api/worker-fleet/stalled-runs",
      "/api/worker-fleet/schedules",
    ]) {
      for (const query of rejected) {
        const response = await fetch(`${baseUrl}${path}?${query}`, {
          headers: { Cookie: `${cookiePolicy.name}=data-session` },
        });
        assert.equal(response.status, 422);
        assert.equal(
          (await response.json()).code,
          "INVALID_WORKER_FLEET_REQUEST",
        );
      }
    }

    // The instance listing takes no cursor, so one is refused rather than
    // silently ignored.
    for (const query of ["limit=51", "cursor=anything"]) {
      const response = await fetch(
        `${baseUrl}/api/worker-fleet/instances?${query}`,
        { headers: { Cookie: `${cookiePolicy.name}=data-session` } },
      );
      assert.equal(response.status, 422);
    }

    const first = await fetch(
      `${baseUrl}/api/worker-fleet/stalled-runs?limit=50`,
      { headers: { Cookie: `${cookiePolicy.name}=data-session` } },
    );
    assert.equal(first.status, 200);
    const second = await fetch(
      `${baseUrl}/api/worker-fleet/stalled-runs?cursor=stalled-next`,
      { headers: { Cookie: `${cookiePolicy.name}=data-session` } },
    );
    assert.equal(second.status, 200);
  });
  assert.deepEqual(cursors, [undefined, "stalled-next"]);
});

test("read failures map to stable bounded responses", async () => {
  const cursorHarness = createHarness({
    async listStalledRuns() {
      throw { code: "INVALID_OPERATION_CURSOR", internalDetail: "private-user" };
    },
    async listScheduleHealth() {
      throw { code: "RATE_LIMITED", internalDetail: "private throttling key" };
    },
  });
  await withServer(cursorHarness.app, async (baseUrl) => {
    const cursor = await fetch(
      `${baseUrl}/api/worker-fleet/stalled-runs?cursor=broken`,
      { headers: { Cookie: `${cursorHarness.cookiePolicy.name}=data-session` } },
    );
    assert.equal(cursor.status, 422);
    assert.deepEqual(await cursor.json(), {
      error: "The worker fleet page cursor is invalid.",
      code: "INVALID_OPERATION_CURSOR",
    });

    const limited = await fetch(`${baseUrl}/api/worker-fleet/schedules`, {
      headers: { Cookie: `${cursorHarness.cookiePolicy.name}=data-session` },
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "Too many operation requests. Try again later.",
      code: "RATE_LIMITED",
    });
  });

  const brokenHarness = createHarness({
    async listInstances() {
      throw new Error("connection to private-user-db refused");
    },
    async readSettings() {
      throw new Error("private-user settings detail");
    },
  });
  await withServer(brokenHarness.app, async (baseUrl) => {
    for (const path of [
      "/api/worker-fleet/instances",
      "/api/worker-fleet/settings",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Cookie: `${brokenHarness.cookiePolicy.name}=data-session` },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Worker fleet status is temporarily unavailable.",
        code: "SERVICE_UNAVAILABLE",
      });
    }
  });
});
