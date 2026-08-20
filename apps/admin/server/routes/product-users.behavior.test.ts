import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type { ProductUserDirectoryPage } from "@packscout/contracts";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import { ProductUserDirectoryError } from "../product-user-directory.ts";
import {
  createProductUsersRouter,
  type ProductUsersRouterDependencies,
} from "./product-users.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000010";
const integrationToken = "product-directory-integration-token-value";

const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId,
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  permissions: [
    "operators:manage",
    "providers:view",
    "imports:start",
    "imports:retry",
    "product_users:view",
    "product_users:manage",
  ],
  csrfToken: "csrf-token",
};
const dataOperator: AuthenticatedActor = {
  ...admin,
  sessionId: "data-session",
  operatorId: "00000000-0000-4000-8000-000000000002",
  role: "data_operator",
  permissions: ["providers:view", "imports:start", "imports:retry"],
};
const sessions: Record<string, AuthenticatedActor> = {
  "admin-session": admin,
  "data-session": dataOperator,
};

/**
 * Deliberately unsafe rows: each carries markers for values the browser must
 * never receive, so the projection assertions cannot pass by accident.
 */
const walletOnly = {
  subject: "https://auth.example.test/|did:example:wallet-user",
  authMethod: "https://auth.example.test",
  email: null,
  walletAddress: "0xWalletAddress0001",
  firstSeenAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-19T11:59:00.000Z",
  standing: "active",
  savedRepackCount: 3,
  savedCollectibleCount: 1,
  walletAddressKey: "0xwalletaddress0001",
  integrationToken,
  rawIdentity: { accessToken: "never-serialize" },
} as const;
const subjectOnly = {
  ...walletOnly,
  subject: "https://auth.example.test/|did:example:opaque-only-user",
  walletAddress: null,
  standing: "suspended",
  lastSeenAt: "2026-08-18T08:00:00.000Z",
  savedRepackCount: 0,
  savedCollectibleCount: 0,
} as const;
const emailUser = {
  ...walletOnly,
  subject: "https://auth.example.test/|did:example:email-user",
  email: "ada@example.test",
  lastSeenAt: "2026-08-19T12:00:00.000Z",
} as const;

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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

interface DirectoryRequest {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit: number;
}

function createHarness(
  listProductUsers?: ProductUsersRouterDependencies["directory"]["listProductUsers"],
) {
  const requests: DirectoryRequest[] = [];
  const auth: ProductUsersRouterDependencies["auth"] = {
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
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 43_200_000,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/product-users",
    createProductUsersRouter({
      auth,
      directory: {
        async listProductUsers(request) {
          requests.push(request);
          if (listProductUsers) return listProductUsers(request);
          const items = request.search
            ? [emailUser]
            : [emailUser, walletOnly, subjectOnly];
          return {
            items,
            nextCursor: "cursor-page-two",
            searchTruncated: false,
          } as unknown as ProductUserDirectoryPage;
        },
      },
      cookiePolicy,
      sameOrigin: createSameOriginGuard([origin]),
    }),
  );
  return { app, cookiePolicy, requests };
}

function headers(cookieName: string, session?: string) {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    ...(session ? { Cookie: `${cookieName}=${session}` } : {}),
  };
}

function assertBrowserSafe(serialized: string) {
  assert.doesNotMatch(
    serialized,
    new RegExp(`${integrationToken}|never-serialize|walletAddressKey|rawIdentity`),
  );
}

test("the directory listing enforces the product-user authorization matrix", async () => {
  const { app, cookiePolicy, requests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/list`;

    const anonymous = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: "{}",
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "data-session"),
      body: "{}",
    });
    assert.equal(restricted.status, 403);
    assert.deepEqual(await restricted.json(), {
      error: "You do not have permission to perform this action.",
      code: "FORBIDDEN",
    });

    const crossOrigin = await fetch(path, {
      method: "POST",
      headers: {
        ...headers(cookiePolicy.name, "admin-session"),
        Origin: "https://attacker.test",
      },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);

    const authorized = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
  });
  // Only the authorized request reached the product backend.
  assert.equal(requests.length, 1);
});

test("directory rows reach the browser as a bounded, explicit projection", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    const body = await response.text();
    assertBrowserSafe(body);
    const payload = JSON.parse(body);

    assert.equal(payload.items.length, 3);
    assert.equal(payload.nextCursor, "cursor-page-two");
    assert.equal(payload.searchTruncated, false);
    // Ordering is the backend's recency ordering, preserved verbatim.
    assert.deepEqual(
      payload.items.map((item: { subject: string }) => item.subject),
      [emailUser.subject, walletOnly.subject, subjectOnly.subject],
    );
    assert.deepEqual(Object.keys(payload.items[1]).sort(), [
      "authMethod",
      "email",
      "firstSeenAt",
      "lastSeenAt",
      "savedCollectibleCount",
      "savedRepackCount",
      "standing",
      "subject",
      "walletAddress",
    ]);
    // A record with neither email nor wallet keeps its addressable identity.
    assert.equal(payload.items[2].email, null);
    assert.equal(payload.items[2].walletAddress, null);
    assert.equal(payload.items[2].subject, subjectOnly.subject);
    assert.equal(payload.items[2].standing, "suspended");
  });
});

test("search terms travel in the body and reach the directory read", async () => {
  const { app, cookiePolicy, requests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ search: "  ada@example.test  ", limit: 5 }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.items.map((item: { email: string | null }) => item.email),
      ["ada@example.test"],
    );

    // The listing is POST-only, so a search can never be expressed as a URL.
    const asQuery = await fetch(
      `${baseUrl}/api/product-users/list?search=ada%40example.test`,
      { headers: headers(cookiePolicy.name, "admin-session") },
    );
    assert.equal(asQuery.status, 404);
  });
  assert.deepEqual(requests, [{ search: "ada@example.test", limit: 5 }]);
});

test("page requests stay bounded and validated", async () => {
  const { app, cookiePolicy, requests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const invalidBodies = [
      { limit: 0 },
      { limit: 21 },
      { limit: 1.5 },
      { limit: "many" },
      { cursor: "" },
      { search: "" },
      { search: "a".repeat(321) },
      { cursor: "c".repeat(4_097) },
      { limit: 5, page: 2 },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${baseUrl}/api/product-users/list`, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "INVALID_PRODUCT_USER_REQUEST");
    }

    // An omitted limit uses the bounded default rather than an unbounded read.
    const defaulted = await fetch(`${baseUrl}/api/product-users/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ cursor: "cursor-page-two" }),
    });
    assert.equal(defaulted.status, 200);
  });
  assert.deepEqual(requests, [{ cursor: "cursor-page-two", limit: 20 }]);
});

test("an over-long backend page is truncated to the requested page size", async () => {
  const oversized = Array.from({ length: 40 }, (_, index) => ({
    ...walletOnly,
    subject: `https://auth.example.test/|did:example:${index}`,
  }));
  const { app, cookiePolicy } = createHarness(
    async () =>
      ({
        items: oversized,
        nextCursor: null,
        searchTruncated: true,
      }) as unknown as ProductUserDirectoryPage,
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ limit: 3 }),
    });
    const payload = await response.json();
    assert.equal(payload.items.length, 3);
    assert.equal(payload.nextCursor, null);
    assert.equal(payload.searchTruncated, true);
  });
});

test("integration failures map to stable codes without leaking the upstream", async () => {
  const failures: [
    ConstructorParameters<typeof ProductUserDirectoryError>[0],
    number,
  ][] = [
    ["PRODUCT_USER_DIRECTORY_UNCONFIGURED", 503],
    ["PRODUCT_USER_DIRECTORY_UNAVAILABLE", 503],
    ["INVALID_PRODUCT_USER_CURSOR", 422],
    ["INVALID_PRODUCT_USER_REQUEST", 422],
  ];
  for (const [code, status] of failures) {
    const { app, cookiePolicy } = createHarness(async () => {
      throw new ProductUserDirectoryError(code, "The directory refused.", status);
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/product-users/list`, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: "{}",
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), {
        error: "The directory refused.",
        code,
      });
    });
  }

  const { app, cookiePolicy } = createHarness(async () => {
    throw new Error(
      `upstream 500 from https://backend.example.test with ${integrationToken}`,
    );
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 503);
    const body = await response.text();
    assertBrowserSafe(body);
    assert.doesNotMatch(body, /backend\.example\.test|upstream 500/);
    assert.deepEqual(JSON.parse(body), {
      error: "The product-user directory is temporarily unavailable.",
      code: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
    });
  });
});
