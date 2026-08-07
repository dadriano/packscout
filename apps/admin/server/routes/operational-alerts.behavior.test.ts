import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type { AdminAlertDetail, AdminAlertSummary } from "@packscout/contracts";
import {
  AuthServiceError,
  OperationalAlertServiceError,
  type AuthenticatedActor,
} from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createOperationalAlertsRouter,
  type OperationalAlertsRouterDependencies,
} from "./operational-alerts.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000010";
const alertId = "00000000-0000-4000-8000-000000000020";
const providerId = "00000000-0000-4000-8000-000000000030";
const runId = "00000000-0000-4000-8000-000000000040";
const actor: AuthenticatedActor = {
  sessionId: "operator-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId,
  organizationName: "PackScout",
  email: "operator@packscout.test",
  displayName: "Data Operator",
  state: "active",
  role: "data_operator",
  permissions: ["providers:view"],
  csrfToken: "csrf-token",
};

function alert(state: AdminAlertSummary["state"] = "active"): AdminAlertSummary {
  return {
    id: alertId,
    kind: "run_failed",
    severity: "critical",
    state,
    title: "Import failed",
    summary: "The provider import stopped with a bounded failure.",
    providerId,
    runId,
    quarantineId: null,
    firstSeenAt: "2026-08-06T12:00:00.000Z",
    lastSeenAt: "2026-08-06T12:05:00.000Z",
    occurrenceCount: 2,
    reopenedCount: 0,
    acknowledgedAt:
      state === "acknowledged" ? "2026-08-06T12:06:00.000Z" : null,
    resolvedAt: state === "resolved" ? "2026-08-06T12:07:00.000Z" : null,
  };
}

function detail(): AdminAlertDetail {
  return {
    ...alert(),
    occurrences: [
      {
        id: "00000000-0000-4000-8000-000000000050",
        kind: "run_failed",
        severity: "critical",
        occurredAt: "2026-08-06T12:05:00.000Z",
        evidence: { failureCode: "IMPORT_CONTRACT_FAILED", count: 2 },
      },
    ],
  };
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    await run(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createHarness(
  overrides: Partial<OperationalAlertsRouterDependencies["alerts"]> = {},
) {
  const calls: string[] = [];
  const dependencies: OperationalAlertsRouterDependencies = {
    auth: {
      async resolveSession({ sessionToken, csrfToken }) {
        if (!sessionToken) {
          throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
        }
        if (csrfToken !== undefined && csrfToken !== actor.csrfToken) {
          throw new AuthServiceError(
            "FORBIDDEN",
            "The request could not be verified.",
            403,
          );
        }
        return actor;
      },
      requirePermission(authenticated, permission) {
        if (!authenticated.permissions.includes(permission)) {
          throw new AuthServiceError("FORBIDDEN", "Permission denied.", 403);
        }
      },
    },
    alerts: {
      async list(requestActor, input) {
        assert.equal(requestActor.organizationId, organizationId);
        assert.deepEqual(input, { state: "active", limit: 25 });
        calls.push("list");
        return [alert()];
      },
      async detail(requestActor, requestAlertId) {
        assert.equal(requestActor.organizationId, organizationId);
        assert.equal(requestAlertId, alertId);
        calls.push("detail");
        return detail();
      },
      async acknowledge(requestActor, requestAlertId) {
        assert.equal(requestActor.organizationId, organizationId);
        assert.equal(requestAlertId, alertId);
        calls.push("acknowledge");
        return alert("acknowledged");
      },
      async resolve(requestActor, requestAlertId) {
        assert.equal(requestActor.organizationId, organizationId);
        assert.equal(requestAlertId, alertId);
        calls.push("resolve");
        return alert("resolved");
      },
      ...overrides,
    },
    cookiePolicy: createSessionCookiePolicy({
      production: false,
      maxAgeMs: 43_200_000,
    }),
    sameOrigin: createSameOriginGuard([origin]),
  };
  const app = express();
  app.use(express.json());
  app.use("/api/operational-alerts", createOperationalAlertsRouter(dependencies));
  return { app, calls };
}

function authorized(path: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    headers: {
      cookie: "packscout_session=operator-session",
      ...(init.headers ?? {}),
    },
  });
}

test("alert reads are tenant-scoped and return bounded operational evidence", async () => {
  const { app, calls } = createHarness();
  await withServer(app, async (baseUrl) => {
    const listResponse = await authorized(
      `${baseUrl}/api/operational-alerts?state=active&limit=25`,
    );
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), { items: [alert()] });

    const detailResponse = await authorized(
      `${baseUrl}/api/operational-alerts/${alertId}`,
    );
    assert.equal(detailResponse.status, 200);
    const payload = await detailResponse.text();
    assert.doesNotMatch(payload, /bearer|password|0x[0-9a-f]{16}/i);
    assert.deepEqual(JSON.parse(payload), { alert: detail() });
  });
  assert.deepEqual(calls, ["list", "detail"]);
});

test("alert mutations require session, same-origin, csrf, and a valid ID", async () => {
  const { app, calls } = createHarness();
  await withServer(app, async (baseUrl) => {
    const endpoint = `${baseUrl}/api/operational-alerts/${alertId}/acknowledge`;
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 403);
    assert.equal((await authorized(endpoint, { method: "POST" })).status, 403);
    assert.equal(
      (
        await authorized(endpoint, {
          method: "POST",
          headers: { origin, "x-csrf-token": "wrong" },
        })
      ).status,
      403,
    );
    const invalid = await authorized(
      `${baseUrl}/api/operational-alerts/not-an-id/acknowledge`,
      {
        method: "POST",
        headers: { origin, "x-csrf-token": actor.csrfToken },
      },
    );
    assert.equal(invalid.status, 422);

    const acknowledged = await authorized(endpoint, {
      method: "POST",
      headers: { origin, "x-csrf-token": actor.csrfToken },
    });
    assert.equal(acknowledged.status, 200);
    assert.equal((await acknowledged.json()).alert.state, "acknowledged");

    const resolved = await authorized(
      `${baseUrl}/api/operational-alerts/${alertId}/resolve`,
      {
        method: "POST",
        headers: { origin, "x-csrf-token": actor.csrfToken },
      },
    );
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).alert.state, "resolved");
  });
  assert.deepEqual(calls, ["acknowledge", "resolve"]);
});

test("alert service errors keep stable status and safe messages", async () => {
  const { app } = createHarness({
    async detail() {
      throw new OperationalAlertServiceError("ALERT_NOT_FOUND", 404);
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await authorized(
      `${baseUrl}/api/operational-alerts/${alertId}`,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Operational alert not found.",
      code: "ALERT_NOT_FOUND",
    });
  });
});
