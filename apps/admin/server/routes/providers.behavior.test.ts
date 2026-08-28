import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import {
  AuthServiceError,
  ProviderConfigurationServiceError,
  type AuthenticatedActor,
} from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createProvidersRouter,
  type ProvidersRouterDependencies,
} from "./providers.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const revisionId = "00000000-0000-4000-8000-000000000021";
const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId,
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  permissions: ["providers:view", "providers:manage"],
  csrfToken: "csrf-token",
};
const dataOperator: AuthenticatedActor = {
  ...admin,
  sessionId: "data-session",
  operatorId: "00000000-0000-4000-8000-000000000002",
  role: "data_operator",
  permissions: ["providers:view"],
};

function summary(state: "draft" | "active" | "disabled" | "archived" = "draft") {
  return {
    id: providerId,
    platformKey: "fanatics",
    displayName: "Fanatics cards",
    state,
    latestRevision: {
      id: revisionId,
      version: 1,
      adapterKey: "cursor-http",
      endpoint: "https://feed.packscout.test/cards",
      endpointHost: "feed.packscout.test",
      authMode: "bearer" as const,
      hasBearerSecret: true,
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      testedAt: null,
      createdAt: "2026-08-06T12:00:00.000Z",
      lastConnectionTest: null,
    },
    activeRevisionId: state === "active" ? revisionId : null,
    nextRunAt: null,
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  };
}

const health = {
  providerId,
  freshnessState: "stale" as const,
  qualityState: "healthy" as const,
  activeRun: null,
  latestRun: null,
  lastHeadReachedAt: null,
  nextDueAt: null,
  openQuarantineCount: 0,
  consecutiveFailures: 0,
  latestFailureClass: null,
  recoveryHint: "Run an import through provider head.",
};

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
  overrides: Partial<ProvidersRouterDependencies["configuration"]> = {},
  initialState: "draft" | "active" | "disabled" | "archived" = "draft",
) {
  let current = summary(initialState);
  const calls = { create: 0, test: 0, activate: 0, disable: 0, archive: 0 };
  const auth: ProvidersRouterDependencies["auth"] = {
    async resolveSession({ sessionToken, csrfToken }) {
      if (!sessionToken) throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      if (csrfToken !== undefined && csrfToken !== "csrf-token") {
        throw new AuthServiceError("FORBIDDEN", "The request could not be verified.", 403);
      }
      return sessionToken === "data-session" ? dataOperator : admin;
    },
    requirePermission(actor, permission) {
      if (!actor.permissions.includes(permission)) {
        throw new AuthServiceError("FORBIDDEN", "You do not have permission to perform this action.", 403);
      }
    },
  };
  const configuration: ProvidersRouterDependencies["configuration"] = {
    async getProvider() { return current; },
    async createProvider() { calls.create += 1; return current; },
    async replaceRevision() { return current; },
    async testConnection() {
      calls.test += 1;
      return {
        verdict: "success",
        checkedAt: "2026-08-06T12:01:00.000Z",
        latencyMs: 42,
        responseStatus: 200,
        recordCounts: { catalog: 2, pulls: 1, trades: 1 },
        hasMore: false,
        nextCursorPresent: false,
        sanitizedCode: null,
      };
    },
    async activateRevision() { calls.activate += 1; current = summary("active"); return current; },
    async disableProvider() { calls.disable += 1; current = summary("disabled"); return current; },
    async archiveProvider() { calls.archive += 1; current = summary("archived"); return current; },
    ...overrides,
  };
  const cookiePolicy = createSessionCookiePolicy({ production: false, maxAgeMs: 43_200_000 });
  const app = express();
  app.use(express.json());
  app.use("/api/data-providers", createProvidersRouter({
    auth,
    configuration,
    catalog: { async listProviders(requestOrganizationId) {
      assert.equal(requestOrganizationId, organizationId);
      return [{ provider: current, health }];
    } },
    health: { async getHealth() { return health; } },
    cookiePolicy,
    sameOrigin: createSameOriginGuard([origin]),
  }));
  return { app, calls, cookiePolicy };
}

function headers(cookieName: string, session = "admin-session") {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `${cookieName}=${session}`,
    "X-CSRF-Token": "csrf-token",
  };
}

test("provider reads require a session, allow data operators, and never expose bearer material", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/data-providers`)).status, 401);
    const list = await fetch(`${baseUrl}/api/data-providers`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(list.status, 200);
    const serialized = await list.text();
    assert.match(serialized, /"hasBearerSecret":true/);
    assert.doesNotMatch(serialized, /"(?:bearerSecret|authorization|token)"\s*:/i);

    const detail = await fetch(`${baseUrl}/api/data-providers/${providerId}`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(detail.status, 200);
    assert.doesNotMatch(await detail.text(), /"(?:bearerSecret|authorization|token)"\s*:/i);
  });
});

test("provider mutations enforce permission, origin, CSRF, validation, and masked responses", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  const input = {
    platformKey: "fanatics",
    displayName: "Fanatics cards",
    adapterKey: "cursor-http",
    endpoint: "https://feed.packscout.test/cards",
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
    auth: { mode: "bearer", bearerSecret: "never-echo-this-secret" },
  };
  await withServer(app, async (baseUrl) => {
    const forbidden = await fetch(`${baseUrl}/api/data-providers`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "data-session"),
      body: JSON.stringify(input),
    });
    assert.equal(forbidden.status, 403);

    const crossOrigin = await fetch(`${baseUrl}/api/data-providers`, {
      method: "POST",
      headers: { ...headers(cookiePolicy.name), Origin: "https://attacker.test" },
      body: JSON.stringify(input),
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await fetch(`${baseUrl}/api/data-providers`, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: JSON.stringify({ ...input, adapterKey: "UPPER CASE", extra: true }),
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, "INVALID_PROVIDER_CONFIGURATION");

    const created = await fetch(`${baseUrl}/api/data-providers`, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: JSON.stringify(input),
    });
    assert.equal(created.status, 201);
    assert.doesNotMatch(await created.text(), /never-echo-this-secret|"bearerSecret"\s*:/);
  });
  assert.equal(calls.create, 1);
});

test("test, enable, disable, and archive endpoints retain lifecycle guards", async () => {
  const { app, calls, cookiePolicy } = createHarness(undefined, "active");
  await withServer(app, async (baseUrl) => {
    const tested = await fetch(`${baseUrl}/api/data-providers/${providerId}/revisions/${revisionId}/test`, {
      method: "POST",
      headers: headers(cookiePolicy.name),
    });
    assert.equal(tested.status, 200);

    const enabled = await fetch(`${baseUrl}/api/data-providers/${providerId}/revisions/${revisionId}/activate`, {
      method: "POST",
      headers: headers(cookiePolicy.name),
    });
    assert.equal(enabled.status, 200);

    const archiveActive = await fetch(`${baseUrl}/api/data-providers/${providerId}/archive`, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: JSON.stringify({ expectedRevisionId: revisionId }),
    });
    assert.equal(archiveActive.status, 409);
    assert.equal((await archiveActive.json()).code, "PROVIDER_LIFECYCLE_CONFLICT");

    assert.equal((await fetch(`${baseUrl}/api/data-providers/${providerId}/disable`, {
      method: "POST", headers: headers(cookiePolicy.name), body: JSON.stringify({ expectedRevisionId: revisionId }),
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/data-providers/${providerId}/archive`, {
      method: "POST", headers: headers(cookiePolicy.name), body: JSON.stringify({ expectedRevisionId: revisionId }),
    })).status, 200);
  });
  assert.deepEqual(calls, { create: 0, test: 1, activate: 1, disable: 1, archive: 1 });
});

test("revision conflicts return masked current state without overwriting", async () => {
  const current = summary();
  const { app, cookiePolicy } = createHarness({
    async replaceRevision() {
      throw new ProviderConfigurationServiceError(
        "CONFIG_REVISION_CONFLICT",
        "Provider configuration changed. Refresh and review the current revision.",
        409,
        current,
      );
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-providers/${providerId}/revisions`, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: JSON.stringify({
        expectedRevisionId: revisionId,
        displayName: "Unsaved name",
        adapterKey: "cursor-http",
        endpoint: "https://feed.packscout.test/cards",
        scheduleSeconds: 300,
        staleAfterSeconds: 900,
        auth: { mode: "bearer", reuseExistingSecret: true },
      }),
    });
    assert.equal(response.status, 409);
    const serialized = await response.text();
    assert.match(serialized, /CONFIG_REVISION_CONFLICT/);
    assert.match(serialized, /hasBearerSecret/);
    assert.doesNotMatch(serialized, /"(?:bearerSecret|authorization|token)"\s*:/i);
  });
});
