import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type {
  ProductUserAccessAction,
  ProductUserAccessDecision,
  ProductUserAccessQueuePage,
  ProductUserAccessState,
  ProductUserDetail,
  ProductUserDirectoryPage,
  ProductUserRecord,
  ProductUserStandingChange,
} from "@packscout/contracts";
import {
  AuthServiceError,
  type AuthenticatedActor,
  type EnqueueEmailMessageCommand,
  type EnqueueEmailMessageResult,
} from "@packscout/services";
import { createAccessDecisionNotifier } from "../access-decision-notice.ts";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import type { ProductUserAuditEvent } from "../product-user-audit.ts";
import {
  ProductUserDirectoryError,
  type ProductUserAccessDecisionOutcome,
} from "../product-user-directory.ts";
import {
  createProductUsersRouter,
  type ProductUserAuditFailure,
  type ProductUserNoticeFailure,
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
  access: {
    state: "approved",
    decidedBy: "allowlist",
    decidedAt: "2026-08-01T09:00:05.000Z",
    allowlistEntryId: "allowlist-entry-never-serialize",
  },
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
  access: {
    state: "awaiting_review",
    decidedBy: "default",
    decidedAt: "2026-08-01T09:00:00.000Z",
  },
  lastSeenAt: "2026-08-18T08:00:00.000Z",
  savedRepackCount: 0,
  savedCollectibleCount: 0,
} as const;
const emailUser = {
  ...walletOnly,
  subject: "https://auth.example.test/|did:example:email-user",
  email: "ada@example.test",
  access: {
    state: "awaiting_review",
    decidedBy: "default",
    decidedAt: "2026-08-01T09:00:00.000Z",
  },
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

interface QueueRequest {
  readonly accessState: ProductUserAccessState;
  readonly cursor?: string;
  readonly limit: number;
}

type DecisionRequest = {
  action: ProductUserAccessAction;
  subject: string;
  operatorId: string;
};

const DECISION_TARGET_STATE: Record<ProductUserAccessAction, ProductUserAccessState> = {
  approve: "approved",
  decline: "declined",
  revoke: "awaiting_review",
};

/**
 * A decision store that behaves like the product backend: convergent flips
 * keyed by subject, `nothing_to_decide` for unknown subjects, provenance kept
 * intact on repeats, and effective access composed with the fixed standing.
 */
function createDecisionDirectory(
  initial: Record<string, ProductUserAccessDecision>,
  suspended: ReadonlySet<string> = new Set(),
) {
  const decisions = { ...initial };
  return async function decideProductUserAccess(
    request: DecisionRequest,
  ): Promise<ProductUserAccessDecisionOutcome> {
    const previous = decisions[request.subject];
    if (previous === undefined) return { outcome: "nothing_to_decide" };
    const target = DECISION_TARGET_STATE[request.action];
    const changed = previous.state !== target;
    const resulting: ProductUserAccessDecision = changed
      ? {
          state: target,
          decidedBy: "operator",
          decidedAt: "2026-08-20T10:00:00.000Z",
        }
      : previous;
    decisions[request.subject] = resulting;
    const admitted = resulting.state === "approved" && !suspended.has(request.subject);
    return {
      outcome: "decided",
      changed,
      previous,
      resulting,
      effectiveAccess: admitted
        ? { admitted: true, reason: "approved" }
        : {
            admitted: false,
            reason: suspended.has(request.subject)
              ? resulting.state === "approved"
                ? "suspended"
                : resulting.state
              : resulting.state === "approved"
                ? "undetermined"
                : resulting.state,
          },
    };
  };
}

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
  access?: {
    listQueue?: ProductUsersRouterDependencies["directory"]["listProductUserAccessQueue"];
    count?: ProductUsersRouterDependencies["directory"]["countAwaitingReview"];
    decide?: ProductUsersRouterDependencies["directory"]["decideProductUserAccess"];
    /** The single-record read the decision notice takes after a commit. */
    record?: ProductUsersRouterDependencies["directory"]["getProductUserRecord"];
    /** The outbox enqueue behind the decision notice. */
    enqueue?: (
      command: EnqueueEmailMessageCommand,
    ) => Promise<EnqueueEmailMessageResult>;
  },
) {
  const requests: DirectoryRequest[] = [];
  const detailRequests: { subject: string }[] = [];
  const standingRequests: StandingRequest[] = [];
  const queueRequests: QueueRequest[] = [];
  const countRequests: number[] = [];
  const decisionRequests: DecisionRequest[] = [];
  const recordRequests: { subject: string }[] = [];
  const noticeCommands: EnqueueEmailMessageCommand[] = [];
  const auditEvents: ProductUserAuditEvent[] = [];
  const auditFailures: ProductUserAuditFailure[] = [];
  const noticeFailures: ProductUserNoticeFailure[] = [];
  const fixtureRecords: Record<string, ProductUserRecord> = {
    [emailUser.subject]: emailUser as unknown as ProductUserRecord,
    [walletOnly.subject]: walletOnly as unknown as ProductUserRecord,
    [subjectOnly.subject]: subjectOnly as unknown as ProductUserRecord,
  };
  /** The single-record integration read, shared by the route's directory
   * dependency and the decision notice exactly as production wires it. */
  async function getProductUserRecordStub(request: {
    subject: string;
  }): Promise<ProductUserRecord> {
    recordRequests.push(request);
    if (access?.record) return access.record(request);
    const record = fixtureRecords[request.subject];
    if (record === undefined) {
      throw new ProductUserDirectoryError(
        "PRODUCT_USER_NOT_FOUND",
        "That product user is not in the directory.",
        404,
      );
    }
    return record;
  }
  const fallbackStanding = createStandingDirectory({
    [emailUser.subject]: "active",
  });
  const fallbackDecision = createDecisionDirectory(
    {
      [emailUser.subject]: {
        state: "awaiting_review",
        decidedBy: "default",
        decidedAt: "2026-08-01T09:00:00.000Z",
      },
      [walletOnly.subject]: {
        state: "approved",
        decidedBy: "allowlist",
        decidedAt: "2026-08-01T09:00:05.000Z",
      },
      [subjectOnly.subject]: {
        state: "awaiting_review",
        decidedBy: "default",
        decidedAt: "2026-08-01T09:00:00.000Z",
      },
    },
    new Set([subjectOnly.subject]),
  );
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
        getProductUserRecord: getProductUserRecordStub,
        async setProductUserStanding(request) {
          standingRequests.push(request);
          return setProductUserStanding
            ? await setProductUserStanding(request)
            : await fallbackStanding(request);
        },
        async listProductUserAccessQueue(request) {
          queueRequests.push(request);
          if (access?.listQueue) return access.listQueue(request);
          // The queue is the directory oldest request first.
          return {
            items: [subjectOnly, emailUser],
            nextCursor: "queue-cursor-two",
            queueTruncated: false,
          } as unknown as ProductUserAccessQueuePage;
        },
        async countAwaitingReview() {
          countRequests.push(countRequests.length);
          if (access?.count) return access.count();
          return { count: 2, truncated: false };
        },
        async decideProductUserAccess(request) {
          decisionRequests.push(request);
          return access?.decide
            ? await access.decide(request)
            : await fallbackDecision(request);
        },
      },
      audit: {
        async append(event) {
          if (appendAudit) return appendAudit(event);
          auditEvents.push(event);
        },
      },
      decisionNotice: createAccessDecisionNotifier({
        directory: { getProductUserRecord: getProductUserRecordStub },
        outbox: {
          async enqueueEmailMessage(command) {
            noticeCommands.push(command);
            if (access?.enqueue) return access.enqueue(command);
            return {
              status: "enqueued",
              intentId: `intent-${noticeCommands.length}`,
              deduplicated: false,
            };
          },
        },
      }),
      onAuditFailure: (auditFailure) => auditFailures.push(auditFailure),
      onNoticeFailure: (noticeFailure) => noticeFailures.push(noticeFailure),
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
    queueRequests,
    countRequests,
    decisionRequests,
    recordRequests,
    noticeCommands,
    auditEvents,
    auditFailures,
    noticeFailures,
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
      `${integrationToken}|never-serialize|walletAddressKey|rawIdentity|allowlistEntryId|operatorId`,
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
      "access",
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
    // The decision is exactly its three display fields; the stored decision's
    // allowlist reference was dropped by the projection.
    assert.deepEqual(payload.items[1].access, {
      state: "approved",
      decidedBy: "allowlist",
      decidedAt: "2026-08-01T09:00:05.000Z",
    });
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
      "access",
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

test("the review queue and its count enforce the product-user view matrix", async () => {
  const { app, cookiePolicy, queueRequests, countRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    for (const path of [
      `${baseUrl}/api/product-users/access/queue`,
      `${baseUrl}/api/product-users/access/queue-count`,
    ]) {
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
      assert.equal((await restricted.json()).code, "FORBIDDEN");

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
    }
  });
  // Only the authorized requests reached the product backend.
  assert.equal(queueRequests.length, 1);
  assert.equal(countRequests.length, 1);
});

test("the queue lists waiting identities oldest-first as the bounded projection", async () => {
  const { app, cookiePolicy, queueRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/access/queue`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assertBrowserSafe(serialized);
    const payload = JSON.parse(serialized);

    // The backend's oldest-request-first ordering is preserved verbatim.
    assert.deepEqual(
      payload.items.map((item: { subject: string }) => item.subject),
      [subjectOnly.subject, emailUser.subject],
    );
    assert.equal(payload.nextCursor, "queue-cursor-two");
    assert.equal(payload.queueTruncated, false);
    // Queue rows are the ledger's own bounded projection, access included.
    assert.deepEqual(Object.keys(payload.items[0]).sort(), [
      "access",
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
    assert.deepEqual(payload.items[0].access, {
      state: "awaiting_review",
      decidedBy: "default",
      decidedAt: "2026-08-01T09:00:00.000Z",
    });
  });
  // An unstated access state means the queue that matters: awaiting review.
  assert.deepEqual(queueRequests, [
    { accessState: "awaiting_review", limit: 20 },
  ]);
});

test("queue requests are validated, bounded, and never expressible as a URL", async () => {
  const { app, cookiePolicy, queueRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/access/queue`;
    for (const body of [
      { accessState: "suspended" },
      { accessState: "" },
      { limit: 0 },
      { limit: 21 },
      { cursor: "" },
      { cursor: "c".repeat(4_097) },
      { search: "ada@example.test" },
    ]) {
      const response = await fetch(path, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "INVALID_PRODUCT_USER_REQUEST");
    }

    // The queue accepts named states and passes cursors through unchanged.
    const declined = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ accessState: "declined", cursor: "queue-cursor-two", limit: 5 }),
    });
    assert.equal(declined.status, 200);

    // The queue is POST-only, so its filter can never be expressed as a URL.
    const asQuery = await fetch(`${path}?accessState=awaiting_review`, {
      headers: headers(cookiePolicy.name, "admin-session"),
    });
    assert.equal(asQuery.status, 404);
  });
  assert.deepEqual(queueRequests, [
    { accessState: "declined", cursor: "queue-cursor-two", limit: 5 },
  ]);
});

test("the awaiting count is relayed with its truncation flag for 500+ display", async () => {
  const { app, cookiePolicy } = createHarness(undefined, undefined, undefined, undefined, {
    count: async () => ({ count: 500, truncated: true }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/access/queue-count`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 500, truncated: true });
  });
});

test("queue and count integration failures map to stable codes without leaking", async () => {
  const upstream = async () => {
    throw new Error(
      `upstream 500 from https://backend.example.test with ${integrationToken}`,
    );
  };
  const { app, cookiePolicy } = createHarness(undefined, undefined, undefined, undefined, {
    listQueue: upstream,
    count: upstream,
  });
  await withServer(app, async (baseUrl) => {
    for (const path of [
      `${baseUrl}/api/product-users/access/queue`,
      `${baseUrl}/api/product-users/access/queue-count`,
    ]) {
      const response = await fetch(path, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: "{}",
      });
      assert.equal(response.status, 503);
      const body = await response.text();
      assertBrowserSafe(body);
      assert.doesNotMatch(body, /backend\.example\.test|upstream 500/);
      assert.equal(JSON.parse(body).code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
    }
  });
});

test("each access decision enforces the manage-product-users matrix", async () => {
  const { app, cookiePolicy, decisionRequests, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    for (const action of ["approve", "decline", "revoke"] as const) {
      const path = `${baseUrl}/api/product-users/access/${action}`;
      const body = JSON.stringify({ subject: emailUser.subject });

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
    }
  });
  // Only the authorized requests reached the product backend, and only they
  // are recorded: a refused attempt never touched anyone's account.
  assert.equal(decisionRequests.length, 3);
  assert.equal(auditEvents.length, 3);
});

test("decisions are stamped with the session operator and converge on repeats", async () => {
  const { app, cookiePolicy, decisionRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    async function decide(action: string, subject: string) {
      const response = await fetch(
        `${baseUrl}/api/product-users/access/${action}`,
        {
          method: "POST",
          headers: mutationHeaders(cookiePolicy.name, "admin-session"),
          body: JSON.stringify({ subject: `  ${subject}  ` }),
        },
      );
      const serialized = await response.text();
      assertBrowserSafe(serialized);
      return { status: response.status, payload: JSON.parse(serialized) };
    }

    const approved = await decide("approve", emailUser.subject);
    assert.equal(approved.status, 200);
    assert.deepEqual(Object.keys(approved.payload).sort(), [
      "access",
      "action",
      "changed",
      "effectiveAccess",
    ]);
    assert.equal(approved.payload.action, "approve");
    assert.equal(approved.payload.changed, true);
    assert.deepEqual(approved.payload.access, {
      state: "approved",
      decidedBy: "operator",
      decidedAt: "2026-08-20T10:00:00.000Z",
    });
    assert.deepEqual(approved.payload.effectiveAccess, {
      admitted: true,
      reason: "approved",
    });

    // Approving an already-approved identity converges: the authoritative
    // decision is stated, and the outcome says this call changed nothing.
    const again = await decide("approve", emailUser.subject);
    assert.equal(again.status, 200);
    assert.equal(again.payload.changed, false);
    assert.equal(again.payload.access.state, "approved");

    const declined = await decide("decline", emailUser.subject);
    assert.equal(declined.payload.changed, true);
    assert.equal(declined.payload.access.state, "declined");
    assert.deepEqual(declined.payload.effectiveAccess, {
      admitted: false,
      reason: "declined",
    });

    const revoked = await decide("revoke", emailUser.subject);
    assert.equal(revoked.payload.changed, true);
    assert.equal(revoked.payload.access.state, "awaiting_review");

    // Approving a suspended account reports the composed truth, never a
    // bare success that would read as the person being let in.
    const suspendedApproval = await decide("approve", subjectOnly.subject);
    assert.equal(suspendedApproval.payload.changed, true);
    assert.deepEqual(suspendedApproval.payload.effectiveAccess, {
      admitted: false,
      reason: "suspended",
    });
  });

  // Every decision was stamped with the acting session's operator — the
  // request named nobody — and the subject was trimmed at the boundary.
  assert.equal(decisionRequests.length, 5);
  for (const request of decisionRequests) {
    assert.equal(request.operatorId, admin.operatorId);
  }
  assert.deepEqual(
    decisionRequests.map(({ action }) => action),
    ["approve", "approve", "decline", "revoke", "approve"],
  );
  assert.deepEqual(
    new Set(decisionRequests.map(({ subject }) => subject)),
    new Set([emailUser.subject, subjectOnly.subject]),
  );
});

test("every decision is audited with operator, target, movement, and outcome", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness();
  const before = Date.now();
  await withServer(app, async (baseUrl) => {
    for (const action of ["approve", "decline", "revoke"] as const) {
      const response = await fetch(
        `${baseUrl}/api/product-users/access/${action}`,
        {
          method: "POST",
          headers: mutationHeaders(cookiePolicy.name, "admin-session"),
          body: JSON.stringify({ subject: emailUser.subject }),
        },
      );
      assert.equal(response.status, 200);
    }
  });

  assert.deepEqual(
    auditEvents.map(({ action, outcome, accessChange }) => ({
      action,
      outcome,
      accessChange,
    })),
    [
      {
        action: "product_user.approve_access",
        outcome: "success",
        accessChange: {
          previous: { state: "awaiting_review", decidedBy: "default" },
          resulting: { state: "approved", decidedBy: "operator" },
          changed: true,
        },
      },
      {
        action: "product_user.decline_access",
        outcome: "success",
        accessChange: {
          previous: { state: "approved", decidedBy: "operator" },
          resulting: { state: "declined", decidedBy: "operator" },
          changed: true,
        },
      },
      {
        action: "product_user.revoke_access",
        outcome: "success",
        accessChange: {
          previous: { state: "declined", decidedBy: "operator" },
          resulting: { state: "awaiting_review", decidedBy: "operator" },
          changed: true,
        },
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

test("a refused decision is still audited and never leaks the upstream", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    {
      decide: async () => {
        throw new Error(
          `upstream 500 from https://backend.example.test with ${integrationToken}`,
        );
      },
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/access/decline`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: emailUser.subject }),
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

  assert.deepEqual(
    auditEvents.map(({ action, outcome, reason, accessChange }) => ({
      action,
      outcome,
      reason,
      accessChange,
    })),
    [
      {
        action: "product_user.decline_access",
        outcome: "failure",
        reason: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
        accessChange: undefined,
      },
    ],
  );
});

test("deciding about an unknown subject reports nothing to decide, not a record", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/access/approve`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        subject: "https://auth.example.test/|did:example:never-signed-in",
      }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error:
        "That product user is not in the directory, so there is nothing to decide.",
      code: "PRODUCT_USER_NOT_FOUND",
    });
  });
  // The failed attempt is still on the trail, in non-personal terms.
  assert.deepEqual(
    auditEvents.map(({ action, outcome, reason }) => ({ action, outcome, reason })),
    [
      {
        action: "product_user.approve_access",
        outcome: "failure",
        reason: "PRODUCT_USER_NOT_FOUND",
      },
    ],
  );
});

/**
 * The decision commits remotely and cannot be rolled back from here, so once
 * it has committed the response reports it — an unwritable trail is reported
 * as an audit failure, never restated as a decision failure.
 */
test("a committed decision is reported as committed even when the audit write fails", async () => {
  const { app, cookiePolicy, decisionRequests, auditFailures } = createHarness(
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error(`audit sink unavailable with ${integrationToken}`);
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/product-users/access/approve`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: emailUser.subject }),
    });
    const serialized = await response.text();
    assertBrowserSafe(serialized);
    assert.equal(response.status, 200);
    const payload = JSON.parse(serialized);
    assert.equal(payload.changed, true);
    assert.equal(payload.access.state, "approved");
  });
  assert.equal(decisionRequests.length, 1);
  // The unwritten record is reported in its own terms, with nothing personal
  // in it, and is marked as having happened after the decision committed.
  assert.deepEqual(auditFailures, [
    {
      action: "product_user.approve_access",
      outcome: "success",
      afterCommit: true,
    },
  ]);
});

test("decision requests are validated and can never name the acting operator", async () => {
  const { app, cookiePolicy, decisionRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/product-users/access/approve`;
    for (const body of [
      {},
      { subject: "" },
      { subject: "   " },
      { subject: "s".repeat(1_025) },
      // The acting operator is always the session, never a request field.
      { subject: emailUser.subject, operatorId: admin.operatorId },
      { subject: emailUser.subject, action: "decline" },
    ]) {
      const response = await fetch(path, {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "INVALID_PRODUCT_USER_REQUEST");
    }

    // The decision surface offers three reversible flips and no removal.
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(path, {
        method,
        headers: mutationHeaders(cookiePolicy.name, "admin-session"),
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify({ subject: emailUser.subject }) }),
      });
      assert.equal(response.status, 404);
    }
  });
  assert.deepEqual(decisionRequests, []);
});

/** The decision instant the harness's convergent decision store stamps. */
const FALLBACK_DECIDED_AT = "2026-08-20T10:00:00.000Z";

function subjectDigest(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

async function decideAs(
  baseUrl: string,
  cookieName: string,
  action: string,
  subject: string,
) {
  const response = await fetch(`${baseUrl}/api/product-users/access/${action}`, {
    method: "POST",
    headers: mutationHeaders(cookieName, "admin-session"),
    body: JSON.stringify({ subject }),
  });
  const serialized = await response.text();
  assertBrowserSafe(serialized);
  return {
    status: response.status,
    serialized,
    payload: JSON.parse(serialized) as Record<string, unknown>,
  };
}

test("a genuine approval enqueues the approval message after the decision commits", async () => {
  const {
    app,
    cookiePolicy,
    recordRequests,
    noticeCommands,
    auditEvents,
    noticeFailures,
  } = createHarness();
  await withServer(app, async (baseUrl) => {
    const approved = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      emailUser.subject,
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.changed, true);
    // The browser payload stays exactly the decision; no notice detail and
    // no address ride back to the page.
    assert.deepEqual(Object.keys(approved.payload).sort(), [
      "access",
      "action",
      "changed",
      "effectiveAccess",
    ]);
    assert.doesNotMatch(approved.serialized, /ada@example\.test/);
  });

  // The verified address was read back through the single-record
  // integration read, for this decision alone, after it committed.
  assert.deepEqual(recordRequests, [{ subject: emailUser.subject }]);
  assert.equal(noticeCommands.length, 1);
  const command = noticeCommands[0]!;
  assert.equal(command.kind, "access_approved");
  assert.equal(command.recipient, "ada@example.test");
  assert.deepEqual(command.input, { toEmail: "ada@example.test" });
  assert.equal(command.source, "beta_access_decision");
  // The key is the decision transition: subject digest, resulting state,
  // and this transition's decision instant — never the raw subject or the
  // address, because the key travels into delivery records and logs.
  assert.equal(
    command.idempotencyKey,
    `accessdecision:${subjectDigest(emailUser.subject)}:approved:${Date.parse(
      FALLBACK_DECIDED_AT,
    )}`,
  );
  assert.doesNotMatch(command.idempotencyKey, /did:example|@|example\.test/);

  // The trail records, on the decision's own success event, that the
  // person was told.
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]!.outcome, "success");
  assert.deepEqual(auditEvents[0]!.notice, { outcome: "enqueued" });
  assert.deepEqual(noticeFailures, []);
});

test("a genuine decline enqueues the decline message", async () => {
  const { app, cookiePolicy, noticeCommands, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const declined = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "decline",
      emailUser.subject,
    );
    assert.equal(declined.status, 200);
    assert.equal(declined.payload.changed, true);
  });

  assert.equal(noticeCommands.length, 1);
  assert.equal(noticeCommands[0]!.kind, "access_declined");
  assert.deepEqual(noticeCommands[0]!.input, { toEmail: "ada@example.test" });
  assert.equal(
    noticeCommands[0]!.idempotencyKey,
    `accessdecision:${subjectDigest(emailUser.subject)}:declined:${Date.parse(
      FALLBACK_DECIDED_AT,
    )}`,
  );
  assert.deepEqual(auditEvents[0]!.notice, { outcome: "enqueued" });
});

test("revoke and allowlist admission announce nothing", async () => {
  const {
    app,
    cookiePolicy,
    recordRequests,
    noticeCommands,
    auditEvents,
    noticeFailures,
  } = createHarness();
  await withServer(app, async (baseUrl) => {
    // Revoking the approved wallet-only user is an enforcement action, not
    // an announcement: the decision commits and nothing is enqueued.
    const revoked = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "revoke",
      walletOnly.subject,
    );
    assert.equal(revoked.status, 200);
    assert.equal(revoked.payload.changed, true);

    // A subject with no record has nothing to decide and nothing to announce.
    const unknown = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      "https://auth.example.test/|did:example:never-signed-in",
    );
    assert.equal(unknown.status, 404);

    // The standing control is account enforcement, never an access decision.
    const suspended = await fetch(`${baseUrl}/api/product-users/standing`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ subject: emailUser.subject, standing: "suspended" }),
    });
    assert.equal(suspended.status, 200);
  });

  // Nothing was announced, so nothing about anyone was even read back.
  assert.deepEqual(noticeCommands, []);
  assert.deepEqual(recordRequests, []);
  assert.deepEqual(noticeFailures, []);
  // The revoke's trail records the decision movement and claims no notice.
  const revokeEvent = auditEvents.find(
    (event) => event.action === "product_user.revoke_access",
  );
  assert.equal(revokeEvent?.outcome, "success");
  assert.equal(revokeEvent?.notice, undefined);

  // Allowlist admissions never pass through this surface at all: they are
  // decided at sign-in inside the product backend (closed-beta-access/001
  // and 002), no admin decision route runs, and the greeting an admitted
  // first sign-in earns is the welcome (messaging/007), not an access
  // notice — so there is deliberately nothing here to enqueue for them.
});

test("a repeat decision converges without a second message", async () => {
  const {
    app,
    cookiePolicy,
    recordRequests,
    noticeCommands,
    auditEvents,
  } = createHarness();
  await withServer(app, async (baseUrl) => {
    const first = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      emailUser.subject,
    );
    assert.equal(first.payload.changed, true);

    // The repeat — the same operator acting twice, or a second operator
    // converging on the stored decision — moves nothing and sends nothing.
    const repeat = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      emailUser.subject,
    );
    assert.equal(repeat.status, 200);
    assert.equal(repeat.payload.changed, false);
  });

  assert.equal(noticeCommands.length, 1);
  assert.equal(recordRequests.length, 1);
  assert.deepEqual(auditEvents[0]!.notice, { outcome: "enqueued" });
  // The converged repeat's trail records the convergence and claims no
  // notice was attempted.
  assert.equal(auditEvents[1]!.accessChange?.changed, false);
  assert.equal(auditEvents[1]!.notice, undefined);
});

test("a genuine re-transition earns a fresh message with a fresh key", async () => {
  const instants = [
    "2026-08-20T10:00:00.000Z",
    "2026-08-21T09:00:00.000Z",
    "2026-08-22T15:45:00.000Z",
  ];
  let state: ProductUserAccessState = "awaiting_review";
  let transition = 0;
  const { app, cookiePolicy, noticeCommands } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    {
      // The product backend stamps each genuine flip with its own decision
      // instant; the harness's fixed-clock fallback cannot express that.
      decide: async (request) => {
        const target = DECISION_TARGET_STATE[request.action];
        const changed = state !== target;
        const decidedAt = instants[transition]!;
        transition += 1;
        state = target;
        return {
          outcome: "decided",
          changed,
          previous: {
            state: "awaiting_review",
            decidedBy: "default",
            decidedAt: "2026-08-01T09:00:00.000Z",
          },
          resulting: { state: target, decidedBy: "operator", decidedAt },
          effectiveAccess:
            target === "approved"
              ? { admitted: true, reason: "approved" }
              : { admitted: false, reason: "awaiting_review" },
        };
      },
    },
  );
  await withServer(app, async (baseUrl) => {
    // Approved, revoked, approved again: each genuine approval is its own
    // transition and earns its own message; the revoke stays silent.
    for (const action of ["approve", "revoke", "approve"]) {
      const decided = await decideAs(
        baseUrl,
        cookiePolicy.name,
        action,
        emailUser.subject,
      );
      assert.equal(decided.status, 200);
      assert.equal(decided.payload.changed, true);
    }
  });

  assert.equal(noticeCommands.length, 2);
  assert.deepEqual(
    noticeCommands.map(({ kind }) => kind),
    ["access_approved", "access_approved"],
  );
  const [firstKey, secondKey] = noticeCommands.map(
    ({ idempotencyKey }) => idempotencyKey,
  );
  assert.notEqual(firstKey, secondKey);
  assert.equal(
    firstKey,
    `accessdecision:${subjectDigest(emailUser.subject)}:approved:${Date.parse(
      instants[0]!,
    )}`,
  );
  assert.equal(
    secondKey,
    `accessdecision:${subjectDigest(emailUser.subject)}:approved:${Date.parse(
      instants[2]!,
    )}`,
  );
});

test("an identity with no verified address is skipped as a recorded outcome", async () => {
  const {
    app,
    cookiePolicy,
    recordRequests,
    noticeCommands,
    auditEvents,
    noticeFailures,
  } = createHarness();
  await withServer(app, async (baseUrl) => {
    // The wallet-only identity signed in without exposing an address. The
    // administrator's approval still succeeds in full.
    const approved = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      subjectOnly.subject,
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.changed, true);
  });

  // The record was consulted, nothing was enqueued, and the skip is
  // recorded on the decision's own audit event — a normal outcome an
  // operator can see, never a failure.
  assert.deepEqual(recordRequests, [{ subject: subjectOnly.subject }]);
  assert.deepEqual(noticeCommands, []);
  assert.deepEqual(noticeFailures, []);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]!.outcome, "success");
  assert.deepEqual(auditEvents[0]!.notice, {
    outcome: "skipped_no_verified_email",
  });
});

test("a committed decision survives a failed enqueue, and the failure is named", async () => {
  let enqueueMode: "throw" | "reject" | "ok" = "throw";
  let recordMode: "ok" | "unavailable" = "ok";
  const {
    app,
    cookiePolicy,
    noticeCommands,
    auditEvents,
    auditFailures,
    noticeFailures,
  } = createHarness(undefined, undefined, undefined, undefined, {
    enqueue: async () => {
      if (enqueueMode === "throw") {
        throw new Error("outbox database exploded holding ada@example.test");
      }
      if (enqueueMode === "reject") {
        return {
          status: "rejected",
          errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
          activeCount: 10_000,
        };
      }
      return { status: "enqueued", intentId: "intent-ok", deduplicated: false };
    },
    record: async () => {
      if (recordMode === "unavailable") {
        throw new ProductUserDirectoryError(
          "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
          "The product-user directory is temporarily unavailable.",
          503,
        );
      }
      return emailUser as unknown as ProductUserRecord;
    },
  });
  await withServer(app, async (baseUrl) => {
    // A thrown enqueue: the approval is still reported committed, with the
    // authoritative decision, and the browser learns nothing of the outbox.
    const approved = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      emailUser.subject,
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.changed, true);
    assert.equal(
      (approved.payload.access as { state: string }).state,
      "approved",
    );
    assert.doesNotMatch(approved.serialized, /EMAIL_OUTBOX|notice/i);

    // A backlog rejection surfaces the same way.
    enqueueMode = "reject";
    const declined = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "decline",
      emailUser.subject,
    );
    assert.equal(declined.status, 200);
    assert.equal(declined.payload.changed, true);

    // So does an unreadable record between the commit and the enqueue.
    enqueueMode = "ok";
    recordMode = "unavailable";
    const reApproved = await decideAs(
      baseUrl,
      cookiePolicy.name,
      "approve",
      emailUser.subject,
    );
    assert.equal(reApproved.status, 200);
    assert.equal(reApproved.payload.changed, true);
  });

  // Every decision's trail records success with the named notice failure —
  // the same two-failure-domain shape as an unwritable audit record.
  assert.deepEqual(
    auditEvents.map(({ action, outcome, notice }) => ({
      action,
      outcome,
      notice,
    })),
    [
      {
        action: "product_user.approve_access",
        outcome: "success",
        notice: { outcome: "failed", reason: "EMAIL_OUTBOX_UNAVAILABLE" },
      },
      {
        action: "product_user.decline_access",
        outcome: "success",
        notice: {
          outcome: "failed",
          reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
        },
      },
      {
        action: "product_user.approve_access",
        outcome: "success",
        notice: {
          outcome: "failed",
          reason: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
        },
      },
    ],
  );
  // The failures are additionally reported where audit-write failures are,
  // as bounded non-personal codes.
  assert.deepEqual(noticeFailures, [
    {
      action: "product_user.approve_access",
      reason: "EMAIL_OUTBOX_UNAVAILABLE",
    },
    {
      action: "product_user.decline_access",
      reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
    },
    {
      action: "product_user.approve_access",
      reason: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(noticeFailures), /@|did:example/);
  assert.doesNotMatch(
    JSON.stringify(auditEvents.map(({ notice }) => notice)),
    /@|did:example/,
  );
  // The audit trail itself was writable throughout; the notice failures
  // never masqueraded as audit failures.
  assert.deepEqual(auditFailures, []);
  // The first two attempts reached the outbox; the third failed before it.
  assert.equal(noticeCommands.length, 2);
});
