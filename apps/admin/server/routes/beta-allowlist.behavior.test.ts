import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type {
  BetaAllowlistEntryChange,
  BetaAllowlistRemoval,
  OperatorListResponse,
} from "@packscout/contracts";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import type { BetaAllowlistAuditEvent } from "../beta-allowlist-audit.ts";
import { BetaAllowlistDirectoryError } from "../beta-allowlist-directory.ts";
import {
  createBetaAllowlistRouter,
  type BetaAllowlistAuditFailure,
  type BetaAllowlistRouterDependencies,
} from "./beta-allowlist.ts";

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
    "product_users:view",
    "product_users:manage",
    "beta_allowlist:view",
    "beta_allowlist:manage",
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
 * Deliberately unsafe entries: each carries markers for values the browser
 * must never receive, so the projection assertions cannot pass by accident.
 */
const emailEntry = {
  entryId: "entry-0000000000000001",
  email: "ada@example.test",
  walletAddress: null,
  label: "First invite wave",
  createdAt: "2026-08-19T12:00:00.000Z",
  updatedAt: "2026-08-19T12:00:00.000Z",
  createdByOperatorId: admin.operatorId,
  walletAddressKey: "0xwalletaddress0001",
  integrationToken,
  rawIdentity: { accessToken: "never-serialize" },
} as const;
const walletEntry = {
  ...emailEntry,
  entryId: "entry-0000000000000002",
  email: null,
  walletAddress: "0xWalletAddress0002",
  label: null,
  createdAt: "2026-08-18T08:00:00.000Z",
  updatedAt: "2026-08-18T08:00:00.000Z",
  // An operator the admin can no longer resolve to a display name.
  createdByOperatorId: "00000000-0000-4000-8000-000000000099",
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

interface ListRequest {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit: number;
}

interface HarnessOverrides {
  listEntries?: BetaAllowlistRouterDependencies["directory"]["listEntries"];
  createEntry?: BetaAllowlistRouterDependencies["directory"]["createEntry"];
  updateEntry?: BetaAllowlistRouterDependencies["directory"]["updateEntry"];
  removeEntry?: BetaAllowlistRouterDependencies["directory"]["removeEntry"];
  /** A trail that cannot be written, to separate it from a refused change. */
  appendAudit?: BetaAllowlistRouterDependencies["audit"]["append"];
  listOperators?: BetaAllowlistRouterDependencies["auth"]["listOperators"];
}

function createHarness(overrides: HarnessOverrides = {}) {
  const listRequests: ListRequest[] = [];
  const createRequests: Parameters<
    BetaAllowlistRouterDependencies["directory"]["createEntry"]
  >[0][] = [];
  const updateRequests: Parameters<
    BetaAllowlistRouterDependencies["directory"]["updateEntry"]
  >[0][] = [];
  const removeRequests: { entryId: string }[] = [];
  const auditEvents: BetaAllowlistAuditEvent[] = [];
  const auditFailures: BetaAllowlistAuditFailure[] = [];
  const operatorListings: { limit?: number }[] = [];

  const auth: BetaAllowlistRouterDependencies["auth"] = {
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
    async listOperators(actor, query) {
      operatorListings.push({ limit: query.limit });
      if (overrides.listOperators) return overrides.listOperators(actor, query);
      const response: OperatorListResponse = {
        items: [
          {
            id: admin.operatorId,
            email: admin.email,
            displayName: admin.displayName,
            state: "active",
            role: "admin",
            createdAt: "2026-08-01T09:00:00.000Z",
            updatedAt: "2026-08-01T09:00:00.000Z",
            lastAccessAt: null,
          },
        ],
        nextCursor: null,
      };
      return response;
    },
  };
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 43_200_000,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/beta-allowlist",
    createBetaAllowlistRouter({
      auth,
      directory: {
        async listEntries(request) {
          listRequests.push(request);
          if (overrides.listEntries) return overrides.listEntries(request);
          return {
            items: (request.search
              ? [emailEntry]
              : [emailEntry, walletEntry]) as never,
            nextCursor: "cursor-page-two",
            searchTruncated: false,
          };
        },
        async createEntry(request) {
          createRequests.push(request);
          if (overrides.createEntry) return overrides.createEntry(request);
          return {
            entry: emailEntry,
            admittedCount: 2,
          } as unknown as BetaAllowlistEntryChange;
        },
        async updateEntry(request) {
          updateRequests.push(request);
          if (overrides.updateEntry) return overrides.updateEntry(request);
          return {
            entry: { ...emailEntry, label: "Renamed" },
            admittedCount: 0,
          } as unknown as BetaAllowlistEntryChange;
        },
        async removeEntry(request) {
          removeRequests.push(request);
          if (overrides.removeEntry) return overrides.removeEntry(request);
          const removal: BetaAllowlistRemoval = { removed: true };
          return removal;
        },
      },
      audit: {
        async append(event) {
          if (overrides.appendAudit) return overrides.appendAudit(event);
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
    listRequests,
    createRequests,
    updateRequests,
    removeRequests,
    auditEvents,
    auditFailures,
    operatorListings,
  };
}

function headers(cookieName: string, session?: string) {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    ...(session ? { Cookie: `${cookieName}=${session}` } : {}),
  };
}

/** Requests carry the CSRF token unless a case is deliberately omitting it. */
function mutationHeaders(cookieName: string, session?: string) {
  return { ...headers(cookieName, session), "X-CSRF-Token": "csrf-token" };
}

function assertBrowserSafe(serialized: string) {
  assert.doesNotMatch(
    serialized,
    new RegExp(`${integrationToken}|never-serialize|walletAddressKey|rawIdentity`),
  );
}

test("the allowlist listing enforces the beta-allowlist authorization matrix", async () => {
  const { app, cookiePolicy, listRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/beta-allowlist/list`;

    const anonymous = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: "{}",
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    // A data operator holds neither beta-allowlist permission.
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
  assert.equal(listRequests.length, 1);
});

test("allowlist rows reach the browser as a bounded, explicit projection with creator names", async () => {
  const { app, cookiePolicy, operatorListings } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    const body = await response.text();
    assertBrowserSafe(body);
    const payload = JSON.parse(body);

    assert.equal(payload.items.length, 2);
    assert.equal(payload.nextCursor, "cursor-page-two");
    assert.equal(payload.searchTruncated, false);
    // Ordering is the backend's recency ordering, preserved verbatim.
    assert.deepEqual(
      payload.items.map((item: { entryId: string }) => item.entryId),
      [emailEntry.entryId, walletEntry.entryId],
    );
    assert.deepEqual(Object.keys(payload.items[0]).sort(), [
      "createdAt",
      "createdByDisplayName",
      "createdByOperatorId",
      "email",
      "entryId",
      "label",
      "updatedAt",
      "walletAddress",
    ]);
    // The creating operator resolves to a display name when the admin still
    // knows them, and to null — never a failed listing — when it does not.
    assert.equal(payload.items[0].createdByDisplayName, "Primary Admin");
    assert.equal(payload.items[1].createdByDisplayName, null);
    assert.equal(payload.items[1].email, null);
    assert.equal(payload.items[1].walletAddress, "0xWalletAddress0002");
  });
  assert.deepEqual(operatorListings, [{ limit: 100 }]);
});

test("a failed operator-name lookup degrades to null names, never a failed listing", async () => {
  const { app, cookiePolicy } = createHarness({
    listOperators: async () => {
      throw new Error("operator directory offline");
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.items.map(
        (item: { createdByDisplayName: string | null }) =>
          item.createdByDisplayName,
      ),
      [null, null],
    );
  });
});

test("search terms travel in the body and can never be expressed as a URL", async () => {
  const { app, cookiePolicy, listRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/list`, {
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

    // The listing is POST-only, so a search can never ride in a query string.
    const asQuery = await fetch(
      `${baseUrl}/api/beta-allowlist/list?search=ada%40example.test`,
      { headers: headers(cookiePolicy.name, "admin-session") },
    );
    assert.equal(asQuery.status, 404);
  });
  assert.deepEqual(listRequests, [{ search: "ada@example.test", limit: 5 }]);
});

test("listing requests stay bounded and validated", async () => {
  const { app, cookiePolicy, listRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const invalidBodies = [
      { limit: 0 },
      { limit: 21 },
      { limit: "many" },
      { cursor: "" },
      { search: "" },
      { search: "a".repeat(321) },
      { limit: 5, page: 2 },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${baseUrl}/api/beta-allowlist/list`, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.equal(
        (await response.json()).code,
        "INVALID_BETA_ALLOWLIST_REQUEST",
      );
    }
  });
  assert.equal(listRequests.length, 0);
});

test("adding an entry enforces the manage matrix, stamps the session operator, and reports admissions", async () => {
  const { app, cookiePolicy, createRequests, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/beta-allowlist/create`;
    const body = JSON.stringify({
      email: "ada@example.test",
      label: "First invite wave",
    });

    const anonymous = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name),
      body,
    });
    assert.equal(anonymous.status, 401);

    const restricted = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "data-session"),
      body,
    });
    assert.equal(restricted.status, 403);
    assert.equal((await restricted.json()).code, "FORBIDDEN");

    // A state change additionally requires the CSRF token a read does not.
    const withoutToken = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(withoutToken.status, 403);

    const crossOrigin = await fetch(path, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy.name, "admin-session"),
        Origin: "https://attacker.test",
      },
      body,
    });
    assert.equal(crossOrigin.status, 403);

    // The browser cannot name the acting operator; the session does.
    const impersonating = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        email: "ada@example.test",
        operatorId: "attacker-chosen",
      }),
    });
    assert.equal(impersonating.status, 422);

    const authorized = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
    const serialized = await authorized.text();
    assertBrowserSafe(serialized);
    const payload = JSON.parse(serialized);
    assert.equal(payload.admittedCount, 2);
    assert.equal(payload.entry.entryId, emailEntry.entryId);
  });

  // Only the authorized request reached the product backend, stamped with the
  // acting administrator from the session.
  assert.deepEqual(createRequests, [
    {
      email: "ada@example.test",
      walletAddress: null,
      label: "First invite wave",
      operatorId: admin.operatorId,
    },
  ]);
  // The one attempt that acted is the one attempt on the trail.
  assert.equal(auditEvents.length, 1);
  const event = auditEvents[0]!;
  assert.equal(event.action, "beta_allowlist.add");
  assert.equal(event.outcome, "success");
  assert.equal(event.actorId, admin.operatorId);
  assert.equal(event.organizationId, organizationId);
  assert.equal(event.entryId, emailEntry.entryId);
  assert.equal(event.admittedCount, 2);
  assert.ok(event.occurredAt instanceof Date);
});

test("duplicate identifiers surface as a human conflict and are recorded as a failed attempt", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness({
    createEntry: async () => {
      throw new BetaAllowlistDirectoryError(
        "BETA_ALLOWLIST_DUPLICATE_EMAIL",
        "Another allowlist entry already covers this email address.",
        409,
      );
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/create`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ email: "ada@example.test" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Another allowlist entry already covers this email address.",
      code: "BETA_ALLOWLIST_DUPLICATE_EMAIL",
    });
  });
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]!.outcome, "failure");
  assert.equal(auditEvents[0]!.reason, "BETA_ALLOWLIST_DUPLICATE_EMAIL");
  assert.equal(auditEvents[0]!.entryId, null);
});

test("integration failures map to stable codes without leaking the upstream", async () => {
  const failures: [
    ConstructorParameters<typeof BetaAllowlistDirectoryError>[0],
    number,
  ][] = [
    ["BETA_ALLOWLIST_UNCONFIGURED", 503],
    ["BETA_ALLOWLIST_UNAVAILABLE", 503],
    ["INVALID_BETA_ALLOWLIST_CURSOR", 422],
    ["INVALID_BETA_ALLOWLIST_REQUEST", 422],
  ];
  for (const [code, status] of failures) {
    const { app, cookiePolicy } = createHarness({
      listEntries: async () => {
        throw new BetaAllowlistDirectoryError(code, "The allowlist refused.", status);
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/beta-allowlist/list`, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: "{}",
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), {
        error: "The allowlist refused.",
        code,
      });
    });
  }

  const { app, cookiePolicy } = createHarness({
    listEntries: async () => {
      throw new Error(
        `upstream 500 from https://backend.example.test with ${integrationToken}`,
      );
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 503);
    const body = await response.text();
    assertBrowserSafe(body);
    assert.doesNotMatch(body, /backend\.example\.test|upstream 500/);
    assert.deepEqual(JSON.parse(body), {
      error: "The beta allowlist is temporarily unavailable.",
      code: "BETA_ALLOWLIST_UNAVAILABLE",
    });
  });
});

test("editing an entry keeps omitted fields, clears explicit nulls, and refuses a vanished entry", async () => {
  const { app, cookiePolicy, updateRequests, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/update`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        entryId: emailEntry.entryId,
        label: "Renamed",
        walletAddress: null,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const serialized = await response.text();
    assertBrowserSafe(serialized);
    const payload = JSON.parse(serialized);
    assert.equal(payload.entry.label, "Renamed");
    assert.equal(payload.admittedCount, 0);
  });
  // The omitted email never crossed; the explicit null wallet clear did.
  assert.deepEqual(updateRequests, [
    { entryId: emailEntry.entryId, walletAddress: null, label: "Renamed" },
  ]);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]!.action, "beta_allowlist.edit");
  assert.equal(auditEvents[0]!.outcome, "success");
  assert.equal(auditEvents[0]!.entryId, emailEntry.entryId);

  const vanished = createHarness({
    updateEntry: async () => {
      throw new BetaAllowlistDirectoryError(
        "BETA_ALLOWLIST_ENTRY_NOT_FOUND",
        "That allowlist entry no longer exists.",
        404,
      );
    },
  });
  await withServer(vanished.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/update`, {
      method: "POST",
      headers: mutationHeaders(vanished.cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ entryId: "entry-gone", label: "Renamed" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "BETA_ALLOWLIST_ENTRY_NOT_FOUND");
  });
  assert.equal(vanished.auditEvents[0]!.outcome, "failure");
  assert.equal(
    vanished.auditEvents[0]!.reason,
    "BETA_ALLOWLIST_ENTRY_NOT_FOUND",
  );
});

test("removal requires the manage guard, converges when already gone, and is audited", async () => {
  const { app, cookiePolicy, removeRequests, auditEvents } = createHarness({
    removeEntry: async (request) => ({
      removed: request.entryId === emailEntry.entryId,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/beta-allowlist/remove`;

    const withoutToken = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ entryId: emailEntry.entryId }),
    });
    assert.equal(withoutToken.status, 403);

    const restricted = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "data-session"),
      body: JSON.stringify({ entryId: emailEntry.entryId }),
    });
    assert.equal(restricted.status, 403);

    const removed = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ entryId: emailEntry.entryId }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });

    // Removing an entry that is already gone converges instead of failing.
    const repeated = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ entryId: "entry-already-gone" }),
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { removed: false });
  });

  assert.deepEqual(removeRequests, [
    { entryId: emailEntry.entryId },
    { entryId: "entry-already-gone" },
  ]);
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[0]!.action, "beta_allowlist.remove");
  assert.equal(auditEvents[0]!.outcome, "success");
  assert.equal(auditEvents[0]!.removed, true);
  // The removal request names only the opaque entry id, so the trail carries
  // no identifier for it — and could not.
  assert.equal(auditEvents[0]!.email, null);
  assert.equal(auditEvents[0]!.walletAddress, null);
  assert.equal(auditEvents[1]!.removed, false);
});

test("a committed change is reported even when its audit record cannot be written", async () => {
  const { app, cookiePolicy, auditFailures } = createHarness({
    appendAudit: async () => {
      throw new Error("audit store offline");
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/beta-allowlist/create`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ email: "ada@example.test" }),
    });
    // The entry was created upstream; the response must say so.
    assert.equal(response.status, 200);
    assert.equal((await response.json()).admittedCount, 2);
  });
  assert.deepEqual(auditFailures, [
    { action: "beta_allowlist.add", outcome: "success", afterCommit: true },
  ]);
});
