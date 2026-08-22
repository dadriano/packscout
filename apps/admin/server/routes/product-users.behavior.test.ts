import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type {
  ProductUserDetail,
  ProductUserDirectoryPage,
  ProductUserStandingChange,
} from "@packscout/contracts";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import type { ProductUserAuditEvent } from "../product-user-audit.ts";
import { ProductUserDirectoryError } from "../product-user-directory.ts";
import {
  createProductUsersRouter,
  type ProductUserAuditFailure,
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

async function withServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
) {
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

/**
 * A saved-item payload carrying values the browser must never receive, so the
 * relay assertions cannot pass by accident.
 */
const savedRepacks = [
  {
    resolution: "resolved",
    publicRepackId: "40000000-0000-5000-8000-000000000001",
    savedAt: "2026-08-19T12:00:02.000Z",
    name: "Mythic Pokemon Gacha",
    vendorDisplayName: "Collector Crypt",
    availability: "available",
    estimatedEv: {
      evDollarsMinorUnits: 12_500,
      grossReturnBasisPoints: 10_500,
      confidenceBand: "high",
    },
    listingUrl: "https://collector.example/packs/1?ref=packscout",
    integrationToken,
  },
  {
    resolution: "unresolved",
    publicRepackId: "40000000-0000-5000-8000-000000000999",
    savedAt: "2026-08-19T12:00:01.000Z",
    rawIdentity: { accessToken: "never-serialize" },
  },
] as const;
const savedCollectibles = [
  {
    resolution: "resolved",
    publicCollectibleId: "30000000-0000-5000-8000-000000000001",
    savedAt: "2026-08-19T12:00:03.000Z",
    name: "1999 Pokemon Base Set Charizard Holo PSA 10",
    collectibleType: "card",
    searchText: "never-serialize",
  },
] as const;

const detail = {
  user: emailUser,
  catalogAvailable: true,
  savedRepacks,
  savedCollectibles,
} as unknown as ProductUserDetail;

interface DirectoryRequest {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit: number;
}

type StandingRequest = { subject: string; standing: "active" | "suspended" };

/**
 * A directory that behaves like the product backend: standing is stored per
 * subject, the flip is idempotent, and the authoritative result — not the
 * requested one — comes back.
 */
function createStandingDirectory(
  initial: Record<string, "active" | "suspended">,
) {
  const standings = { ...initial };
  return async function setProductUserStanding(
    request: StandingRequest,
  ): Promise<ProductUserStandingChange> {
    const current = standings[request.subject];
    if (current === undefined) {
      throw new ProductUserDirectoryError(
        "PRODUCT_USER_NOT_FOUND",
        "That product user is not in the directory.",
        404,
      );
    }
    const changed = current !== request.standing;
    standings[request.subject] = request.standing;
    return {
      user: { ...emailUser, standing: request.standing },
      changed,
    };
  };
}

function createHarness(
  listProductUsers?: ProductUsersRouterDependencies["directory"]["listProductUsers"],
  getProductUserDetail?: ProductUsersRouterDependencies["directory"]["getProductUserDetail"],
  setProductUserStanding?: ProductUsersRouterDependencies["directory"]["setProductUserStanding"],
  /** A trail that cannot be written, to separate it from a refused change. */
  appendAudit?: ProductUsersRouterDependencies["audit"]["append"],
) {
  const requests: DirectoryRequest[] = [];
  const detailRequests: { subject: string }[] = [];
  const standingRequests: StandingRequest[] = [];
  const auditEvents: ProductUserAuditEvent[] = [];
  const auditFailures: ProductUserAuditFailure[] = [];
  const fallbackStanding = createStandingDirectory({
    [emailUser.subject]: "active",
  });
  const auth: ProductUsersRouterDependencies["auth"] = {
    async resolveSession({ sessionToken }) {
      if (!sessionToken) {
        throw new AuthServiceError(
          "AUTH_REQUIRED",
          "Sign in to continue.",
          401,
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
        async getProductUserDetail(request) {
          detailRequests.push(request);
          return getProductUserDetail
            ? await getProductUserDetail(request)
            : detail;
        },
        async setProductUserStanding(request) {
          standingRequests.push(request);
          return setProductUserStanding
            ? await setProductUserStanding(request)
            : await fallbackStanding(request);
        },
      },
      audit: {
        async append(event) {
          if (appendAudit) return appendAudit(event);
          auditEvents.push(event);
        },
      },
      onAuditFailure: (auditFailure) => auditFailures.push(auditFailure),
      cookiePolicy,
      sameOrigin: createSameOriginGuard([origin]),
    }),
  );
  return {
    app,
    cookiePolicy,
    requests,
    detailRequests,
    standingRequests,
    auditEvents,
    auditFailures,
  };
}

/** Requests carry the CSRF token unless a case is deliberately omitting it. */
function mutationHeaders(cookieName: string, session?: string) {
  return { ...headers(cookieName, session), "X-CSRF-Token": "csrf-token" };
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
    new RegExp(
      `${integrationToken}|never-serialize|walletAddressKey|rawIdentity`,
    ),
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
      assert.equal(
        (await response.json()).code,
        "INVALID_PRODUCT_USER_REQUEST",
      );
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

test("the user detail read enforces the product-user authorization matrix", async () => {
  const { app, cookiePolicy, detailRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/detail`;
    const body = JSON.stringify({ subject: emailUser.subject });

    const anonymous = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body,
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "data-session"),
      body,
    });
    assert.equal(restricted.status, 403);
    assert.equal((await restricted.json()).code, "FORBIDDEN");

    const crossOrigin = await fetch(path, {
      method: "POST",
      headers: {
        ...headers(cookiePolicy.name, "admin-session"),
        Origin: "https://attacker.test",
      },
      body,
    });
    assert.equal(crossOrigin.status, 403);

    const authorized = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
  });
  // Only the authorized request reached the product backend.
  assert.deepEqual(detailRequests, [{ subject: emailUser.subject }]);
});

test("the detail read relays resolved and unresolved saved items verbatim", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/detail`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: `  ${emailUser.subject}  ` }),
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assertBrowserSafe(serialized);
    assert.doesNotMatch(serialized, /listingUrl|searchText/);
    const payload = JSON.parse(serialized);

    assert.deepEqual(Object.keys(payload).sort(), [
      "catalogAvailable",
      "savedCollectibles",
      "savedRepacks",
      "user",
    ]);
    assert.equal(payload.user.subject, emailUser.subject);
    assert.equal(payload.user.standing, "active");
    assert.equal(payload.catalogAvailable, true);

    // The product backend's newest-save-first ordering is preserved verbatim.
    assert.deepEqual(
      payload.savedRepacks.map((item: { savedAt: string }) => item.savedAt),
      ["2026-08-19T12:00:02.000Z", "2026-08-19T12:00:01.000Z"],
    );
    assert.deepEqual(Object.keys(payload.savedRepacks[0]).sort(), [
      "availability",
      "estimatedEv",
      "name",
      "publicRepackId",
      "resolution",
      "savedAt",
      "vendorDisplayName",
    ]);
    assert.deepEqual(payload.savedRepacks[0].estimatedEv, {
      evDollarsMinorUnits: 12_500,
      grossReturnBasisPoints: 10_500,
      confidenceBand: "high",
    });

    // An unresolved item keeps its identifier and claims no catalog detail.
    assert.deepEqual(payload.savedRepacks[1], {
      resolution: "unresolved",
      publicRepackId: "40000000-0000-5000-8000-000000000999",
      savedAt: "2026-08-19T12:00:01.000Z",
    });
    assert.deepEqual(payload.savedCollectibles, [
      {
        resolution: "resolved",
        publicCollectibleId: "30000000-0000-5000-8000-000000000001",
        savedAt: "2026-08-19T12:00:03.000Z",
        name: "1999 Pokemon Base Set Charizard Holo PSA 10",
        collectibleType: "card",
      },
    ]);
  });
});

test("detail requests are validated and the surface stays read-only", async () => {
  const { app, cookiePolicy, detailRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/detail`;
    for (const body of [
      {},
      { subject: "" },
      { subject: "   " },
      { subject: "s".repeat(1_025) },
      { subject: emailUser.subject, savedRepackId: "40000000" },
    ]) {
      const response = await fetch(path, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.equal(
        (await response.json()).code,
        "INVALID_PRODUCT_USER_REQUEST",
      );
    }

    // No method on this surface can change what a user has saved.
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(path, {
        method,
        headers: headers(cookiePolicy.name, "admin-session"),
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify({ subject: emailUser.subject }) }),
      });
      assert.equal(response.status, 404);
    }
  });
  assert.deepEqual(detailRequests, []);
});

test("an over-long saved-item collection is truncated to the per-kind cap", async () => {
  const oversized = Array.from({ length: 300 }, (_, index) => ({
    resolution: "unresolved",
    publicRepackId: `40000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
    savedAt: "2026-08-19T12:00:00.000Z",
  }));
  const { app, cookiePolicy } = createHarness(
    undefined,
    async () =>
      ({
        user: emailUser,
        catalogAvailable: true,
        savedRepacks: oversized,
        savedCollectibles: [],
      }) as unknown as ProductUserDetail,
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/detail`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: emailUser.subject }),
    });
    const payload = await response.json();
    assert.equal(payload.savedRepacks.length, 250);
    assert.deepEqual(payload.savedCollectibles, []);
  });
});

test("an unrecorded subject reads as not found rather than an empty user", async () => {
  const { app, cookiePolicy } = createHarness(undefined, async () => {
    throw new ProductUserDirectoryError(
      "PRODUCT_USER_NOT_FOUND",
      "That product user is not in the directory.",
      404,
    );
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/detail`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: subjectOnly.subject }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "That product user is not in the directory.",
      code: "PRODUCT_USER_NOT_FOUND",
    });
  });
});

test("detail integration failures map to stable codes without leaking the upstream", async () => {
  const { app, cookiePolicy } = createHarness(undefined, async () => {
    throw new Error(
      `upstream 500 from https://backend.example.test with ${integrationToken}`,
    );
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/detail`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: emailUser.subject }),
    });
    assert.equal(response.status, 503);
    const body = await response.text();
    assertBrowserSafe(body);
    assert.doesNotMatch(body, /backend\.example\.test|upstream 500/);
    assert.equal(JSON.parse(body).code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
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
      throw new ProductUserDirectoryError(
        code,
        "The directory refused.",
        status,
      );
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

test("the standing control enforces the manage-product-users matrix", async () => {
  const { app, cookiePolicy, standingRequests, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/standing`;
    const body = JSON.stringify({
      subject: emailUser.subject,
      standing: "suspended",
    });

    const anonymous = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name),
      body,
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    // A data operator holds neither product-user permission.
    const restricted = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "data-session"),
      body,
    });
    assert.equal(restricted.status, 403);
    assert.deepEqual(await restricted.json(), {
      error: "You do not have permission to perform this action.",
      code: "FORBIDDEN",
    });

    const crossOrigin = await fetch(path, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy.name, "admin-session"),
        Origin: "https://attacker.test",
      },
      body,
    });
    assert.equal(crossOrigin.status, 403);

    // A state change additionally requires the CSRF token a read does not.
    const withoutToken = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(withoutToken.status, 403);
    assert.equal((await withoutToken.json()).code, "FORBIDDEN");

    const authorized = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
  });
  // Only the authorized request reached the product backend, and only it is
  // recorded: a refused attempt never touched anyone's account.
  assert.deepEqual(standingRequests, [
    { subject: emailUser.subject, standing: "suspended" },
  ]);
  assert.equal(auditEvents.length, 1);
});

test("suspending and reinstating report the authoritative standing and converge on repeats", async () => {
  const { app, cookiePolicy, standingRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/standing`;
    async function set(standing: string) {
      const response = await fetch(path, {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        body: JSON.stringify({ subject: `  ${emailUser.subject}  `, standing }),
      });
      const serialized = await response.text();
      assertBrowserSafe(serialized);
      return { status: response.status, payload: JSON.parse(serialized) };
    }

    const suspended = await set("suspended");
    assert.equal(suspended.status, 200);
    assert.deepEqual(Object.keys(suspended.payload).sort(), [
      "changed",
      "user",
    ]);
    assert.equal(suspended.payload.changed, true);
    assert.equal(suspended.payload.user.standing, "suspended");
    // The record is the same bounded projection every other route returns.
    assert.deepEqual(Object.keys(suspended.payload.user).sort(), [
      "authMethod",
      "email",
      "firstSeenAt",
      "lastSeenAt",
      "standing",
      "subject",
      "walletAddress",
    ]);

    // Suspending an already-suspended user converges: the standing is stated,
    // and the outcome says plainly that this call changed nothing.
    const again = await set("suspended");
    assert.equal(again.status, 200);
    assert.equal(again.payload.changed, false);
    assert.equal(again.payload.user.standing, "suspended");

    const reinstated = await set("active");
    assert.equal(reinstated.status, 200);
    assert.equal(reinstated.payload.changed, true);
    assert.equal(reinstated.payload.user.standing, "active");
  });
  assert.deepEqual(
    standingRequests.map(({ standing }) => standing),
    ["suspended", "suspended", "active"],
  );
  // The subject is trimmed once, at the contract boundary.
  assert.deepEqual(
    new Set(standingRequests.map(({ subject }) => subject)),
    new Set([emailUser.subject]),
  );
});

test("both standing actions are audited with operator, target, action, and outcome", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness();
  const before = Date.now();
  await withServer(app, async (baseUrl) => {
    for (const standing of ["suspended", "active"]) {
      const response = await fetch(`${baseUrl}/api/product-users/standing`, {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        body: JSON.stringify({ subject: emailUser.subject, standing }),
      });
      assert.equal(response.status, 200);
    }
  });

  assert.equal(auditEvents.length, 2);
  assert.deepEqual(
    auditEvents.map(({ action, outcome, standing }) => ({
      action,
      outcome,
      standing,
    })),
    [
      {
        action: "product_user.suspend",
        outcome: "success",
        standing: "suspended",
      },
      {
        action: "product_user.reinstate",
        outcome: "success",
        standing: "active",
      },
    ],
  );
  for (const event of auditEvents) {
    assert.equal(event.actorId, admin.operatorId);
    assert.equal(event.organizationId, organizationId);
    assert.equal(event.subject, emailUser.subject);
    assert.ok(event.occurredAt.getTime() >= before);
    assert.ok(event.occurredAt.getTime() <= Date.now());
  }
});

test("a refused standing change is still audited and never leaks the upstream", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness(
    undefined,
    undefined,
    async () => {
      throw new Error(
        `upstream 500 from https://backend.example.test with ${integrationToken}`,
      );
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/standing`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        subject: emailUser.subject,
        standing: "suspended",
      }),
    });
    assert.equal(response.status, 503);
    const serialized = await response.text();
    assertBrowserSafe(serialized);
    assert.doesNotMatch(serialized, /backend\.example\.test|upstream 500/);
    assert.equal(
      JSON.parse(serialized).code,
      "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
    );
  });

  assert.equal(auditEvents.length, 1);
  assert.deepEqual(
    {
      action: auditEvents[0]?.action,
      outcome: auditEvents[0]?.outcome,
      reason: auditEvents[0]?.reason,
      standing: auditEvents[0]?.standing,
    },
    {
      action: "product_user.suspend",
      outcome: "failure",
      reason: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
      standing: undefined,
    },
  );
});

/**
 * The directory change commits remotely and cannot be rolled back from here.
 * Recording it is a separate failure domain and must stay one: a trail that
 * cannot be written must never turn a suspension that happened into a
 * directory failure, which would leave the operator and the audit outcome both
 * describing something that is not true.
 */
test("a committed standing change is reported as committed even when the audit write fails", async () => {
  const standings: Record<string, "active" | "suspended"> = {
    [emailUser.subject]: "active",
  };
  const commit = async (
    request: StandingRequest,
  ): Promise<ProductUserStandingChange> => {
    const current = standings[request.subject];
    if (current === undefined) {
      throw new ProductUserDirectoryError(
        "PRODUCT_USER_NOT_FOUND",
        "That product user is not in the directory.",
        404,
      );
    }
    const changed = current !== request.standing;
    standings[request.subject] = request.standing;
    return { user: { ...emailUser, standing: request.standing }, changed };
  };
  const { app, cookiePolicy, standingRequests, auditFailures } = createHarness(
    undefined,
    undefined,
    commit,
    async () => {
      throw new Error(`audit sink unavailable with ${integrationToken}`);
    },
  );

  await withServer(app, async (baseUrl) => {
    async function suspend() {
      const response = await fetch(`${baseUrl}/api/product-users/standing`, {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        body: JSON.stringify({
          subject: emailUser.subject,
          standing: "suspended",
        }),
      });
      const serialized = await response.text();
      assertBrowserSafe(serialized);
      return { status: response.status, payload: JSON.parse(serialized) };
    }

    const suspended = await suspend();
    // The account was suspended, so that is what the operator is told — not a
    // 503 that would have them try again against an already-suspended user.
    assert.equal(suspended.status, 200);
    assert.equal(suspended.payload.user.standing, "suspended");
    assert.equal(suspended.payload.changed, true);
    assert.deepEqual(Object.keys(suspended.payload).sort(), [
      "changed",
      "user",
    ]);

    // The commit really stuck: the directory now holds the new standing, and a
    // repeat converges instead of claiming a second change.
    assert.equal(standings[emailUser.subject], "suspended");
    const again = await suspend();
    assert.equal(again.status, 200);
    assert.equal(again.payload.changed, false);
    assert.equal(again.payload.user.standing, "suspended");
  });

  assert.equal(standingRequests.length, 2);
  // The unwritten record is reported in its own terms, with nothing personal
  // in it, and is marked as having happened after the change committed.
  assert.deepEqual(auditFailures, [
    { action: "product_user.suspend", outcome: "success", afterCommit: true },
    { action: "product_user.suspend", outcome: "success", afterCommit: true },
  ]);
});

test("a refused change with an unwritable trail is still refused, and the gap is named", async () => {
  const { app, cookiePolicy, standingRequests, auditFailures } = createHarness(
    undefined,
    undefined,
    async () => {
      throw new ProductUserDirectoryError(
        "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
        "The product-user directory is temporarily unavailable.",
        503,
      );
    },
    async () => {
      throw new Error("audit sink unavailable");
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/standing`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: emailUser.subject, standing: "active" }),
    });
    // Nothing committed, so the refusal is still the outcome reported.
    assert.equal(response.status, 503);
    assert.equal(
      (await response.json()).code,
      "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
    );
  });
  assert.equal(standingRequests.length, 1);
  assert.deepEqual(auditFailures, [
    {
      action: "product_user.reinstate",
      outcome: "failure",
      afterCommit: false,
    },
  ]);
});

test("an unrecorded subject cannot be given a standing", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/standing`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        subject: subjectOnly.subject,
        standing: "suspended",
      }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "That product user is not in the directory.",
      code: "PRODUCT_USER_NOT_FOUND",
    });
  });
  assert.deepEqual(
    auditEvents.map(({ outcome, reason }) => ({ outcome, reason })),
    [{ outcome: "failure", reason: "PRODUCT_USER_NOT_FOUND" }],
  );
});

test("standing requests are validated and no method here can delete a user", async () => {
  const { app, cookiePolicy, standingRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/standing`;
    const invalidBodies = [
      {},
      { subject: emailUser.subject },
      { standing: "suspended" },
      { subject: "", standing: "suspended" },
      { subject: "   ", standing: "active" },
      { subject: "s".repeat(1_025), standing: "active" },
      { subject: emailUser.subject, standing: "deleted" },
      { subject: emailUser.subject, standing: "ACTIVE" },
      { subject: emailUser.subject, standing: "suspended", purge: true },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(path, {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.equal(
        (await response.json()).code,
        "INVALID_PRODUCT_USER_REQUEST",
      );
    }

    // The surface offers exactly one reversible control and no removal.
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(path, {
        method,
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        ...(method === "GET"
          ? {}
          : {
              body: JSON.stringify({
                subject: emailUser.subject,
                standing: "suspended",
              }),
            }),
      });
      assert.equal(response.status, 404);
    }
    for (const removal of ["/delete", "/remove", "/purge"]) {
      const response = await fetch(`${baseUrl}/api/product-users${removal}`, {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        body: JSON.stringify({ subject: emailUser.subject }),
      });
      assert.equal(response.status, 404);
    }
  });
  assert.deepEqual(standingRequests, []);
});
