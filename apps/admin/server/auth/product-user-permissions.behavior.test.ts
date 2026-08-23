import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import {
  operatorRolePermissions,
  type OperatorRole,
} from "@packscout/contracts";
import {
  BoundedLoginAttemptLimiter,
  type AuthRepository,
  type AuthoritativeSessionRecord,
} from "@packscout/services";
import { createNodeAuthSecurity } from "./crypto.ts";
import { createRequireSession } from "./middleware.ts";
import { createAdminAuthRuntime } from "./runtime.ts";

const origin = "https://admin.packscout.test";
const sessionSecret = "product-user-permission-boundary-secret-value";
const organizationId = "00000000-0000-4000-8000-000000000010";
const adminToken = "admin-session-token";
const dataOperatorToken = "data-operator-session-token";

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

/**
 * Exercises the real AuthService role grant, the real session-resolution
 * middleware, and the real CSRF/Origin guards. Only the session store is faked,
 * so the authorization matrix asserted here is the one that ships.
 */
async function createHarness() {
  const security = createNodeAuthSecurity(sessionSecret);
  const now = new Date();
  const sessions = new Map<string, AuthoritativeSessionRecord>();

  const seed = (token: string, role: OperatorRole) => {
    sessions.set(security.sessionDigest.digest(token), {
      sessionId: `${role}-session`,
      operatorId: `00000000-0000-4000-8000-00000000000${role === "admin" ? 1 : 2}`,
      organizationId,
      organizationName: "PackScout",
      emailNormalized: `${role}@packscout.test`,
      displayName: role === "admin" ? "Primary Admin" : "Data Operator",
      state: "active",
      role,
      // The service stores a digest of the CSRF token, which is itself a
      // purpose-separated digest of the session token.
      csrfHash: security.csrfDigest.digest(security.csrfDigest.digest(token)),
      idleExpiresAt: new Date(now.getTime() + 60_000),
      absoluteExpiresAt: new Date(now.getTime() + 600_000),
    });
  };
  seed(adminToken, "admin");
  seed(dataOperatorToken, "data_operator");

  const unusedRepositoryCall = () => {
    throw new Error("Unused by the product-user authorization boundary.");
  };
  const repository: AuthRepository = {
    async findOperatorForLogin() {
      return null;
    },
    async rotateSession() {},
    async findAuthoritativeSession(tokenHash) {
      return sessions.get(tokenHash) ?? null;
    },
    async refreshSession() {},
    async revokeSessionByTokenHash() {},
    async findOperatorById() {
      return unusedRepositoryCall();
    },
    async activateInvitedOperator() {
      return unusedRepositoryCall();
    },
    async cancelInvitedOperator() {
      return unusedRepositoryCall();
    },
    async listOperators() {
      return { items: [], nextCursor: null };
    },
    async provisionOperator() {
      return unusedRepositoryCall();
    },
    async updateOperator() {
      return unusedRepositoryCall();
    },
  };

  const runtime = await createAdminAuthRuntime({
    repository,
    loginLimiter: new BoundedLoginAttemptLimiter({
      windowMs: 60_000,
      blockMs: 60_000,
      maximumFailures: 5,
      maximumBuckets: 16,
    }),
    audit: { async append() {} },
    sessionSecret,
    sessionIdleMs: 60_000,
    sessionAbsoluteMs: 600_000,
    production: false,
    allowedOrigins: [origin],
  });

  const app = express();
  app.use(express.json());
  app.get(
    "/api/product-users",
    createRequireSession(runtime.service, runtime.cookiePolicy, {
      permission: "product_users:view",
    }),
    (_request, response) => {
      response.status(200).json({ items: [] });
    },
  );
  app.post(
    "/api/product-users/suspend",
    runtime.sameOrigin,
    createRequireSession(runtime.service, runtime.cookiePolicy, {
      csrf: true,
      permission: "product_users:manage",
    }),
    (_request, response) => {
      response.status(200).json({ suspended: true });
    },
  );

  return {
    app,
    runtime,
    csrfToken: (token: string) => security.csrfDigest.digest(token),
    cookie: (token: string) => `${runtime.cookiePolicy.name}=${token}`,
  };
}

test("product-user reads require the view permission through the shared session guard", async () => {
  const harness = await createHarness();
  await withServer(harness.app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/product-users`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(`${baseUrl}/api/product-users`, {
      headers: { Cookie: harness.cookie(dataOperatorToken) },
    });
    assert.equal(restricted.status, 403);
    assert.deepEqual(await restricted.json(), {
      error: "You do not have permission to perform this action.",
      code: "FORBIDDEN",
    });

    const authorized = await fetch(`${baseUrl}/api/product-users`, {
      headers: { Cookie: harness.cookie(adminToken) },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { items: [] });
  });
});

test("product-user mutations require the manage permission, Origin, and CSRF", async () => {
  const harness = await createHarness();
  const url = (baseUrl: string) => `${baseUrl}/api/product-users/suspend`;
  await withServer(harness.app, async (baseUrl) => {
    const anonymous = await fetch(url(baseUrl), {
      method: "POST",
      headers: { Origin: origin, "X-CSRF-Token": "any-token" },
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(url(baseUrl), {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: harness.cookie(dataOperatorToken),
        "X-CSRF-Token": harness.csrfToken(dataOperatorToken),
      },
    });
    assert.equal(restricted.status, 403);
    assert.equal((await restricted.json()).code, "FORBIDDEN");

    const crossOrigin = await fetch(url(baseUrl), {
      method: "POST",
      headers: {
        Origin: "https://attacker.test",
        Cookie: harness.cookie(adminToken),
        "X-CSRF-Token": harness.csrfToken(adminToken),
      },
    });
    assert.equal(crossOrigin.status, 403);

    const missingCsrf = await fetch(url(baseUrl), {
      method: "POST",
      headers: { Origin: origin, Cookie: harness.cookie(adminToken) },
    });
    assert.equal(missingCsrf.status, 403);

    const authorized = await fetch(url(baseUrl), {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: harness.cookie(adminToken),
        "X-CSRF-Token": harness.csrfToken(adminToken),
      },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { suspended: true });
  });
});

test("session payloads grant product-user permissions to administrators only", async () => {
  const harness = await createHarness();

  const administrator = await harness.runtime.service.bootstrapSession(adminToken);
  assert.equal(administrator.session.membership.role, "admin");
  assert.ok(administrator.session.permissions.includes("product_users:view"));
  assert.ok(administrator.session.permissions.includes("product_users:manage"));

  const dataOperator =
    await harness.runtime.service.bootstrapSession(dataOperatorToken);
  assert.equal(dataOperator.session.membership.role, "data_operator");
  assert.equal(dataOperator.session.permissions.includes("product_users:view"), false);
  assert.equal(
    dataOperator.session.permissions.includes("product_users:manage"),
    false,
  );
  // The data operator keeps exactly the capabilities it had before this feature.
  assert.deepEqual(dataOperator.session.permissions, [
    "providers:view",
    "imports:start",
    "imports:retry",
  ]);
  assert.deepEqual(dataOperator.session.permissions, [
    ...operatorRolePermissions.data_operator,
  ]);
});
