import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import {
  AuthServiceError,
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

function summary() {
  return {
    id: providerId,
    platformKey: "clutchpacks",
    displayName: "ClutchPacks",
    state: "draft" as const,
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
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

function createHarness(options: {
  readonly providerExists?: boolean;
} = {}) {
  const current = summary();
  const calls = { list: 0, get: 0 };
  const auth: ProvidersRouterDependencies["auth"] = {
    async resolveSession({ sessionToken }) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      }
      return sessionToken === "data-session" ? dataOperator : admin;
    },
    requirePermission(actor, permission) {
      if (!actor.permissions.includes(permission)) {
        throw new AuthServiceError(
          "FORBIDDEN",
          "You do not have permission to perform this action.",
          403,
        );
      }
    },
  };
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 43_200_000,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/data-providers", createProvidersRouter({
    auth,
    catalog: {
      async listProviders(requestOrganizationId) {
        calls.list += 1;
        assert.equal(requestOrganizationId, organizationId);
        return [current];
      },
      async getProvider(requestOrganizationId, requestProviderId) {
        calls.get += 1;
        assert.equal(requestOrganizationId, organizationId);
        assert.equal(requestProviderId, providerId);
        return options.providerExists === false ? null : current;
      },
    },
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
  };
}

test("source-native provider list and detail expose clean V3 provider roots", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/data-providers`)).status, 401);

    const list = await fetch(`${baseUrl}/api/data-providers`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(list.status, 200);
    const serializedList = await list.text();
    assert.match(serializedList, /"platformKey":"clutchpacks"/);
    assert.match(serializedList, /"displayName":"ClutchPacks"/);
    assert.doesNotMatch(serializedList, /"(?:latestRevision|health)"\s*:/i);

    const detail = await fetch(`${baseUrl}/api/data-providers/${providerId}`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), { provider: summary() });
  });
  assert.deepEqual(calls, { list: 1, get: 1 });
});

test("a missing provider source root keeps the stable not-found contract", async () => {
  const { app, cookiePolicy } = createHarness({ providerExists: false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-providers/${providerId}`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Provider not found.",
      code: "PROVIDER_NOT_FOUND",
    });
  });
});

test("every retired provider mutation returns the same explicit Provider Sources cutover", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  const paths = [
    "/api/data-providers",
    `/api/data-providers/${providerId}/revisions`,
    `/api/data-providers/${providerId}/revisions/${revisionId}/test`,
    `/api/data-providers/${providerId}/revisions/${revisionId}/activate`,
    `/api/data-providers/${providerId}/disable`,
    `/api/data-providers/${providerId}/archive`,
  ];

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}${paths[0]}`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(unauthenticated.status, 401);

    const crossOrigin = await fetch(`${baseUrl}${paths[0]}`, {
      method: "POST",
      headers: { ...headers(cookiePolicy.name), Origin: "https://attacker.test" },
      body: JSON.stringify({}),
    });
    assert.equal(crossOrigin.status, 403);

    for (const [index, path] of paths.entries()) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers(
          cookiePolicy.name,
          index === 0 ? "data-session" : "admin-session",
        ),
        body: JSON.stringify({ deliberately: "ignored" }),
      });
      assert.equal(response.status, 410, path);
      assert.deepEqual(await response.json(), {
        error: "Legacy provider configuration mutations are retired. Use Provider Sources.",
        code: "LEGACY_PROVIDER_MUTATION_RETIRED",
        details: { replacement: "/api/provider-sources" },
      });
    }
  });

  assert.deepEqual(calls, { list: 0, get: 0 });
});
