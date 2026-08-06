import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import { createAuthRouter, type AuthRouterDependencies } from "./auth.ts";

const trustedOrigin = "https://admin.packscout.test";
const actor: AuthenticatedActor = {
  sessionId: "session-id",
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

const session = {
  operator: {
    id: actor.operatorId,
    email: actor.email,
    displayName: actor.displayName,
    state: actor.state,
  },
  membership: {
    organizationId: actor.organizationId,
    organizationName: actor.organizationName,
    role: actor.role,
  },
  permissions: actor.permissions,
  csrfToken: "csrf-token",
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

function createHarness(overrides: Partial<AuthRouterDependencies["service"]> = {}) {
  const calls = { logout: 0 };
  const service: AuthRouterDependencies["service"] = {
    async login() {
      return { sessionToken: "rotated-session", session };
    },
    async bootstrapSession(sessionToken) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      }
      return { actor, session };
    },
    async resolveSession({ sessionToken, csrfToken }) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      }
      if (csrfToken !== "csrf-token") {
        throw new AuthServiceError(
          "FORBIDDEN",
          "The request could not be verified.",
          403,
        );
      }
      return actor;
    },
    requirePermission() {},
    async logout() {
      calls.logout += 1;
    },
    ...overrides,
  };
  const cookiePolicy = createSessionCookiePolicy({
    production: true,
    maxAgeMs: 12 * 60 * 60 * 1_000,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      service,
      cookiePolicy,
      sameOrigin: createSameOriginGuard([trustedOrigin]),
    }),
  );
  return { app, calls, cookiePolicy };
}

test("successful login rotates into a production-safe cookie and omits credentials", async () => {
  const { app } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: trustedOrigin },
      body: JSON.stringify({
        email: "  ADMIN@PackScout.Test ",
        password: "correct horse battery staple",
      }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /__Host-packscout_session=rotated-session/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//i);
    const body = await response.text();
    assert.doesNotMatch(body, /correct horse|passwordHash|rotated-session/);
  });
});

test("login requires a trusted Origin before credential work", async () => {
  let loginCalls = 0;
  const { app } = createHarness({
    async login() {
      loginCalls += 1;
      return { sessionToken: "unused", session };
    },
  });
  await withServer(app, async (baseUrl) => {
    for (const origin of [undefined, "https://attacker.test"]) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ email: actor.email, password: "a password" }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "The request could not be verified.",
        code: "FORBIDDEN",
      });
    }
  });
  assert.equal(loginCalls, 0);
});

test("credential failures remain generic and rate limits use the stable contract", async () => {
  const generic = new AuthServiceError(
    "INVALID_CREDENTIALS",
    "We couldn't sign you in. Check your details and try again.",
    401,
  );
  const { app: invalidApp } = createHarness({
    async login() {
      throw generic;
    },
  });
  await withServer(invalidApp, async (baseUrl) => {
    for (const email of ["known@packscout.test", "unknown@packscout.test"]) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: trustedOrigin },
        body: JSON.stringify({ email, password: "incorrect password" }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: generic.message,
        code: "INVALID_CREDENTIALS",
      });
    }
  });

  const retryAt = new Date(Date.now() + 20_000);
  const { app: limitedApp } = createHarness({
    async login() {
      throw new AuthServiceError(
        "RATE_LIMITED",
        "Too many sign-in attempts. Try again later.",
        429,
        retryAt,
      );
    },
  });
  await withServer(limitedApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: trustedOrigin },
      body: JSON.stringify({ email: actor.email, password: "incorrect" }),
    });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) >= 1);
    assert.equal((await response.json()).code, "RATE_LIMITED");
  });
});

test("session lookup rejects anonymous requests and refreshes CSRF for a valid session", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("set-cookie") ?? "", new RegExp(cookiePolicy.name));

    const valid = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: `${cookiePolicy.name}=valid-session` },
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).csrfToken, "csrf-token");
  });
});

test("logout requires same-origin CSRF and clears the session cookie after revocation", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const noCsrf = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Origin: trustedOrigin,
        Cookie: `${cookiePolicy.name}=valid-session`,
      },
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.logout, 0);

    const valid = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Origin: trustedOrigin,
        Cookie: `${cookiePolicy.name}=valid-session`,
        "X-CSRF-Token": "csrf-token",
      },
    });
    assert.equal(valid.status, 204);
    assert.equal(calls.logout, 1);
    assert.match(valid.headers.get("set-cookie") ?? "", /Expires=/i);
  });
});
