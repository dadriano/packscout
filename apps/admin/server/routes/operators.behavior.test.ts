import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createOperatorsRouter,
  type OperatorsRouterDependencies,
} from "./operators.ts";

const origin = "https://admin.packscout.test";
const operatorId = "00000000-0000-4000-8000-000000000002";
const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000010",
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  permissions: ["operators:manage"],
  csrfToken: "csrf-token",
};
const dataOperator: AuthenticatedActor = {
  ...admin,
  operatorId,
  role: "data_operator",
  permissions: ["providers:view", "imports:start", "imports:retry"],
};
const operator = {
  id: operatorId,
  email: "operator@packscout.test",
  displayName: "Data Operator",
  state: "active" as const,
  role: "data_operator" as const,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  lastAccessAt: null,
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
  overrides: Partial<OperatorsRouterDependencies["service"]> = {},
) {
  const calls = { provision: 0, update: 0 };
  const service: OperatorsRouterDependencies["service"] = {
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
    async listOperators() {
      return { items: [operator], nextCursor: null };
    },
    async provisionOperator() {
      calls.provision += 1;
      return { operator };
    },
    async updateOperator() {
      calls.update += 1;
      return { operator };
    },
    ...overrides,
  };
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 12 * 60 * 60 * 1_000,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/operators",
    createOperatorsRouter({
      service,
      cookiePolicy,
      sameOrigin: createSameOriginGuard([origin]),
    }),
  );
  return { app, calls, cookiePolicy };
}

function mutationHeaders(cookiePolicy: { name: string }, token: string) {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `${cookiePolicy.name}=${token}`,
    "X-CSRF-Token": "csrf-token",
  };
}

test("operator reads reject anonymous and data-operator sessions", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/operators`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(`${baseUrl}/api/operators`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(restricted.status, 403);
    assert.equal((await restricted.json()).code, "FORBIDDEN");

    const authorized = await fetch(`${baseUrl}/api/operators`, {
      headers: { Cookie: `${cookiePolicy.name}=admin-session` },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).items[0].role, "data_operator");
  });
});

test("provisioning enforces admin, Origin, CSRF, and strict input validation", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  const validBody = {
    email: "new@packscout.test",
    displayName: "New Operator",
    password: "initial secure password",
    role: "data_operator",
  };
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(validBody),
    });
    assert.equal(anonymous.status, 403);

    const restricted = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "data-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(restricted.status, 403);

    const crossOrigin = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy, "admin-session"),
        Origin: "https://attacker.test",
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ ...validBody, password: "short", extra: true }),
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, "VALIDATION_FAILED");

    const authorized = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(authorized.status, 201);
    const serialized = await authorized.text();
    assert.doesNotMatch(serialized, /initial secure password|passwordHash/);
  });
  assert.equal(calls.provision, 1);
});

test("credential rotation is protected and never echoes credential material", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators/${operatorId}`, {
      method: "PATCH",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ password: "rotated secure password" }),
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.doesNotMatch(serialized, /rotated secure password|passwordHash/);
  });
  assert.equal(calls.update, 1);
});

test("last-admin protection returns a stable conflict without claiming success", async () => {
  let updateCalls = 0;
  const { app, cookiePolicy } = createHarness({
    async updateOperator() {
      updateCalls += 1;
      throw new AuthServiceError(
        "LAST_ACTIVE_ADMIN",
        "The last active administrator cannot be disabled or reassigned.",
        409,
      );
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators/${admin.operatorId}`, {
      method: "PATCH",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ state: "disabled" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "The last active administrator cannot be disabled or reassigned.",
      code: "LAST_ACTIVE_ADMIN",
    });
  });
  assert.equal(updateCalls, 1);
});
