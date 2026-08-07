import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createOperationalHealthRouter } from "./operational-health.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";
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

test("operational health is protected, tenant-scoped, shallow, and sanitized", async () => {
  const app = express();
  app.use(
    "/api/operational-health",
    createOperationalHealthRouter({
      auth: {
        async resolveSession({ sessionToken }) {
          if (!sessionToken) {
            throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
          }
          return actor;
        },
        requirePermission(authenticated, permission) {
          assert.equal(authenticated.organizationId, organizationId);
          assert.equal(permission, "providers:view");
        },
      },
      health: {
        async protectedDetail(requestOrganizationId) {
          assert.equal(requestOrganizationId, organizationId);
          return {
            state: "degraded",
            checkedAt: "2026-08-06T12:00:00.000Z",
            configuredProviderCount: 8,
            staleProviderCount: 0,
            degradedProviderCount: 1,
            failedProviderCount: 0,
            activeAlertCount: 1,
            latestRetentionState: "succeeded",
            latestRetentionAt: "2026-08-06T11:00:00.000Z",
            latestRetentionFailureCode: null,
          };
        },
      },
      cookiePolicy: createSessionCookiePolicy({
        production: false,
        maxAgeMs: 43_200_000,
      }),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    const baseUrl = `http://${address}:${port}/api/operational-health`;
    assert.equal((await fetch(baseUrl)).status, 401);
    const response = await fetch(baseUrl, {
      headers: { cookie: "packscout_session=operator-session" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.text();
    assert.doesNotMatch(payload, /bearer|cookie|password|secret|0x[0-9a-f]{16}/i);
    assert.deepEqual(JSON.parse(payload), {
      health: {
        state: "degraded",
        checkedAt: "2026-08-06T12:00:00.000Z",
        configuredProviderCount: 8,
        staleProviderCount: 0,
        degradedProviderCount: 1,
        failedProviderCount: 0,
        activeAlertCount: 1,
        latestRetentionState: "succeeded",
        latestRetentionAt: "2026-08-06T11:00:00.000Z",
        latestRetentionFailureCode: null,
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
