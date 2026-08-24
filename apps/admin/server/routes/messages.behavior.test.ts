import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type {
  EmailMessageAttemptRecord,
  EmailMessageIntentRecord,
} from "@packscout/database";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import type { MessageDeliveryAuditEvent } from "../message-delivery-audit.ts";
import {
  createMessagesRouter,
  type MessageDeliveryAuditFailure,
  type MessageDeliveryQueue,
  type MessagesRouterDependencies,
} from "./messages.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000010";
const now = new Date("2026-08-23T09:00:00.000Z");
const databaseSecret = "postgres://outbox:credential@db.internal/packscout";

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
    "message_delivery:view",
    "message_delivery:manage",
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
 * Deliberately unsafe queue rows: each carries the stored rendering input and
 * marker values the browser must never receive, so the explicit-projection
 * assertions cannot pass by accident.
 */
const failedIntent = {
  id: "b6f6f4a0-3a89-4a90-8f6e-6a1d2c3b4a5f",
  kind: "access_approved",
  recipient: "ada@example.test",
  source: "closed_beta",
  state: "failed",
  dueAt: new Date("2026-08-23T08:00:00.000Z"),
  attemptCount: 3,
  claimedBy: null,
  claimExpiresAt: null,
  lastProvider: "postmark",
  lastErrorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
  lastSkipReason: null,
  lastAttemptedAt: new Date("2026-08-23T08:05:00.000Z"),
  finalizedAt: new Date("2026-08-23T08:05:00.000Z"),
  createdAt: new Date("2026-08-23T07:00:00.000Z"),
  updatedAt: new Date("2026-08-23T08:05:00.000Z"),
  // What the queue row also holds and the browser must never see.
  input_json: { body: "Dear Ada, your access is approved-BODY-MARKER" },
  renderedSubject: "SUBJECT-MARKER",
  databaseSecret,
} as unknown as EmailMessageIntentRecord;

const sentIntent = {
  ...failedIntent,
  id: "0f0e0d0c-0b0a-4a90-8f6e-6a1d2c3b4a50",
  kind: "welcome",
  recipient: "grace@example.test",
  state: "sent",
  attemptCount: 1,
  lastErrorCode: null,
  createdAt: new Date("2026-08-23T06:00:00.000Z"),
} as unknown as EmailMessageIntentRecord;

const attempts = [
  {
    id: "1a1b1c1d-1e1f-4a90-8f6e-6a1d2c3b4a51",
    intentId: failedIntent.id,
    attemptNumber: 1,
    attemptedAt: new Date("2026-08-23T07:01:00.000Z"),
    outcome: "failed",
    provider: "postmark",
    providerMessageId: null,
    errorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
    errorMessage: "Provider connection reset.",
    errorRetryable: true,
    skipReason: null,
    input_json: { body: "BODY-MARKER" },
  },
  {
    id: "2a2b2c2d-2e2f-4a90-8f6e-6a1d2c3b4a52",
    intentId: failedIntent.id,
    attemptNumber: 2,
    attemptedAt: new Date("2026-08-23T08:05:00.000Z"),
    outcome: "sent",
    provider: "postmark",
    providerMessageId: "pm-message-0002",
    errorCode: null,
    errorMessage: null,
    errorRetryable: null,
    skipReason: null,
  },
] as unknown as readonly EmailMessageAttemptRecord[];

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

interface HarnessOverrides {
  countIntents?: MessageDeliveryQueue["countIntents"];
  listIntents?: MessageDeliveryQueue["listIntents"];
  getIntent?: MessageDeliveryQueue["getIntent"];
  listAttempts?: MessageDeliveryQueue["listAttempts"];
  requeueTerminalIntent?: MessageDeliveryQueue["requeueTerminalIntent"];
  /** A trail that cannot be written, to separate it from a refused retry. */
  appendAudit?: MessagesRouterDependencies["audit"]["append"];
}

function createHarness(overrides: HarnessOverrides = {}) {
  const listRequests: Parameters<MessageDeliveryQueue["listIntents"]>[0][] = [];
  const countRequests: Parameters<MessageDeliveryQueue["countIntents"]>[0][] = [];
  const detailRequests: string[] = [];
  const requeueRequests: Parameters<
    MessageDeliveryQueue["requeueTerminalIntent"]
  >[0][] = [];
  const auditEvents: MessageDeliveryAuditEvent[] = [];
  const auditFailures: MessageDeliveryAuditFailure[] = [];

  const auth: MessagesRouterDependencies["auth"] = {
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
    "/api/messages",
    createMessagesRouter({
      auth,
      queue: {
        async countIntents(input) {
          countRequests.push(input);
          if (overrides.countIntents) return overrides.countIntents(input);
          return {
            pending: 4,
            retrying: 2,
            due: 1,
            claimed: 1,
            failed: 6,
            sent: 120,
            skipped: 3,
            oldestDueAt: new Date("2026-08-23T08:30:00.000Z"),
          };
        },
        async listIntents(input) {
          listRequests.push(input);
          if (overrides.listIntents) return overrides.listIntents(input);
          return { items: [failedIntent, sentIntent], hasMore: true };
        },
        async getIntent(intentId) {
          detailRequests.push(intentId);
          if (overrides.getIntent) return overrides.getIntent(intentId);
          return intentId === failedIntent.id ? failedIntent : null;
        },
        async listAttempts(intentId) {
          if (overrides.listAttempts) return overrides.listAttempts(intentId);
          return intentId === failedIntent.id ? attempts : [];
        },
        async requeueTerminalIntent(input) {
          requeueRequests.push(input);
          if (overrides.requeueTerminalIntent) {
            return overrides.requeueTerminalIntent(input);
          }
          if (input.intentId !== failedIntent.id) return null;
          return {
            ...failedIntent,
            state: "pending",
            dueAt: input.now,
            finalizedAt: null,
            updatedAt: input.now,
          } as EmailMessageIntentRecord;
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
      clock: { now: () => now },
    }),
  );
  return {
    app,
    cookiePolicy,
    listRequests,
    countRequests,
    detailRequests,
    requeueRequests,
    auditEvents,
    auditFailures,
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

/**
 * No response may carry the stored rendering input, a rendered body or
 * subject, or any database credential — whatever the queue rows held.
 */
function assertBrowserSafe(serialized: string) {
  assert.doesNotMatch(
    serialized,
    /BODY-MARKER|SUBJECT-MARKER|input_json|renderedSubject|databaseSecret|db\.internal/,
  );
}

test("the delivery listing enforces the view-permission matrix", async () => {
  const { app, cookiePolicy, listRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/messages/list`;

    const anonymous = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name),
      body: "{}",
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    // A data operator holds neither message-delivery permission.
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
  // Only the authorized request reached the queue.
  assert.equal(listRequests.length, 1);
});

test("intent rows reach the browser as an explicit projection with no message body", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assertBrowserSafe(body);
    const payload = JSON.parse(body);

    // Recency ordering is the queue's ordering, preserved verbatim.
    assert.deepEqual(
      payload.items.map((item: { intentId: string }) => item.intentId),
      [failedIntent.id, sentIntent.id],
    );
    // The full closed key set: nothing a body could travel in exists.
    assert.deepEqual(Object.keys(payload.items[0]).sort(), [
      "attemptCount",
      "createdAt",
      "dueAt",
      "finalizedAt",
      "intentId",
      "kind",
      "lastAttemptedAt",
      "lastErrorCode",
      "lastProvider",
      "lastSkipReason",
      "recipient",
      "source",
      "state",
    ]);
    assert.equal(payload.items[0].recipient, "ada@example.test");
    assert.equal(payload.items[0].state, "failed");
    assert.equal(payload.items[0].attemptCount, 3);
    assert.equal(payload.items[0].lastProvider, "postmark");
    assert.equal(payload.items[0].lastErrorCode, "EMAIL_POSTMARK_TRANSPORT_FAILED");

    // The continuation cursor is opaque, bounded, and round-trips.
    assert.equal(typeof payload.nextCursor, "string");
    assert.doesNotMatch(payload.nextCursor, /@/);
    const nextPage = await fetch(`${baseUrl}/api/messages/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ cursor: payload.nextCursor }),
    });
    assert.equal(nextPage.status, 200);
  });
});

test("filters travel in the request body and can never be expressed as a URL", async () => {
  const { app, cookiePolicy, listRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        state: "failed",
        kind: "access_approved",
        recipient: "  ada@example.test  ",
        limit: 5,
      }),
    });
    assert.equal(response.status, 200);

    // The listing is POST-only, so a recipient can never ride a query string.
    const asQuery = await fetch(
      `${baseUrl}/api/messages/list?recipient=ada%40example.test`,
      { headers: headers(cookiePolicy.name, "admin-session") },
    );
    assert.equal(asQuery.status, 404);
  });
  assert.deepEqual(listRequests, [
    {
      limit: 5,
      state: "failed",
      kind: "access_approved",
      recipient: "ada@example.test",
    },
  ]);
});

test("listing requests stay bounded and validated, and a bad cursor refuses cleanly", async () => {
  const { app, cookiePolicy, listRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const invalidBodies = [
      { limit: 0 },
      { limit: 21 },
      { limit: "many" },
      { state: "delivered" },
      { kind: "Not-A-Kind" },
      { recipient: "a" },
      { recipient: "a".repeat(321) },
      { cursor: "" },
      { limit: 5, page: 2 },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${baseUrl}/api/messages/list`, {
        method: "POST",
        headers: headers(cookiePolicy.name, "admin-session"),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.equal(
        (await response.json()).code,
        "INVALID_MESSAGE_DELIVERY_REQUEST",
      );
    }

    // A cursor that parses but is not one of ours refuses with its own code.
    const badCursor = await fetch(`${baseUrl}/api/messages/list`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({
        cursor: Buffer.from('{"version":1,"kind":"other"}').toString("base64url"),
      }),
    });
    assert.equal(badCursor.status, 422);
    assert.equal((await badCursor.json()).code, "INVALID_MESSAGE_DELIVERY_CURSOR");
  });
  assert.equal(listRequests.length, 0);
});

test("queue-state counts are readable at a glance under the view permission", async () => {
  const { app, cookiePolicy, countRequests } = createHarness();
  await withServer(app, async (baseUrl) => {
    const restricted = await fetch(`${baseUrl}/api/messages/counts`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "data-session"),
      body: "{}",
    });
    assert.equal(restricted.status, 403);

    const response = await fetch(`${baseUrl}/api/messages/counts`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      pending: 4,
      retrying: 2,
      due: 1,
      claimed: 1,
      failed: 6,
      sent: 120,
      skipped: 3,
      oldestDueAt: "2026-08-23T08:30:00.000Z",
    });
  });
  assert.deepEqual(countRequests, [{ now }]);
});

test("an intent's detail lists its attempts with provider facts and no body", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages/detail`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ intentId: failedIntent.id }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assertBrowserSafe(body);
    const payload = JSON.parse(body);

    assert.equal(payload.intent.intentId, failedIntent.id);
    assert.equal(payload.attempts.length, 2);
    assert.deepEqual(Object.keys(payload.attempts[0]).sort(), [
      "attemptNumber",
      "attemptedAt",
      "errorCode",
      "errorMessage",
      "outcome",
      "provider",
      "providerMessageId",
      "skipReason",
    ]);
    // The failure carries its stable code and sanitized text; the success
    // carries the provider's own message identifier for correlation.
    assert.equal(payload.attempts[0].outcome, "failed");
    assert.equal(payload.attempts[0].errorCode, "EMAIL_POSTMARK_TRANSPORT_FAILED");
    assert.equal(payload.attempts[0].errorMessage, "Provider connection reset.");
    assert.equal(payload.attempts[1].outcome, "sent");
    assert.equal(payload.attempts[1].provider, "postmark");
    assert.equal(payload.attempts[1].providerMessageId, "pm-message-0002");

    const missing = await fetch(`${baseUrl}/api/messages/detail`, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ intentId: sentIntent.id }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "MESSAGE_DELIVERY_INTENT_NOT_FOUND");
  });
});

test("retrying enforces the manage matrix with CSRF and re-enters the queue", async () => {
  const { app, cookiePolicy, requeueRequests, auditEvents } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/messages/retry`;
    const body = JSON.stringify({ intentId: failedIntent.id });

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

    // The retry is a state change: without the CSRF token it never runs.
    const noToken = await fetch(path, {
      method: "POST",
      headers: headers(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(noToken.status, 403);
    assert.equal(requeueRequests.length, 0);

    const authorized = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body,
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
    const responseText = await authorized.text();
    assertBrowserSafe(responseText);
    const payload = JSON.parse(responseText);
    // The intent is back in the normal queue, due now — not sent inline.
    assert.equal(payload.intent.state, "pending");
    assert.equal(payload.intent.dueAt, now.toISOString());
    assert.equal(payload.intent.finalizedAt, null);
    assert.equal(payload.intent.attemptCount, 3);
  });
  assert.deepEqual(requeueRequests, [{ intentId: failedIntent.id, now }]);
  // The allowed retry is on the audit trail with the actor and the target.
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, "message_delivery.retry");
  assert.equal(auditEvents[0]?.outcome, "success");
  assert.equal(auditEvents[0]?.actorId, admin.operatorId);
  assert.equal(auditEvents[0]?.organizationId, organizationId);
  assert.equal(auditEvents[0]?.intentId, failedIntent.id);
  assert.equal(auditEvents[0]?.kind, "access_approved");
});

test("retrying a non-terminal or vanished intent is refused, recorded, and changes nothing", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness({
    // The queue refuses: this intent is live again — the shape a lost
    // concurrent-retry race takes, since the winner already requeued it.
    requeueTerminalIntent: async () => null,
    getIntent: async (intentId) =>
      intentId === failedIntent.id
        ? ({ ...failedIntent, state: "pending" } as EmailMessageIntentRecord)
        : null,
  });
  await withServer(app, async (baseUrl) => {
    const refused = await fetch(`${baseUrl}/api/messages/retry`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ intentId: failedIntent.id }),
    });
    assert.equal(refused.status, 409);
    const payload = await refused.json();
    assert.equal(payload.code, "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL");
    assert.equal(payload.state, "pending");
    assert.match(payload.error, /already queued/);

    const vanished = await fetch(`${baseUrl}/api/messages/retry`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ intentId: sentIntent.id }),
    });
    assert.equal(vanished.status, 404);
    assert.equal((await vanished.json()).code, "MESSAGE_DELIVERY_INTENT_NOT_FOUND");
  });
  assert.deepEqual(
    auditEvents.map((event) => [event.outcome, event.reason]),
    [
      ["failure", "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL"],
      ["failure", "MESSAGE_DELIVERY_INTENT_NOT_FOUND"],
    ],
  );
});

test("an unavailable queue degrades to a stable code with no backend detail", async () => {
  const { app, cookiePolicy, auditEvents } = createHarness({
    listIntents: async () => {
      throw new Error(`connect ECONNREFUSED ${databaseSecret}`);
    },
    countIntents: async () => {
      throw new Error(`connect ECONNREFUSED ${databaseSecret}`);
    },
    requeueTerminalIntent: async () => {
      throw new Error(`connect ECONNREFUSED ${databaseSecret}`);
    },
  });
  await withServer(app, async (baseUrl) => {
    for (const [path, requestHeaders] of [
      ["list", headers(cookiePolicy.name, "admin-session")],
      ["counts", headers(cookiePolicy.name, "admin-session")],
      ["retry", mutationHeaders(cookiePolicy.name, "admin-session")],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/messages/${path}`, {
        method: "POST",
        headers: requestHeaders,
        body:
          path === "retry" ? JSON.stringify({ intentId: failedIntent.id }) : "{}",
      });
      assert.equal(response.status, 503, path);
      const body = await response.text();
      assertBrowserSafe(body);
      assert.doesNotMatch(body, /ECONNREFUSED/);
      assert.equal(JSON.parse(body).code, "MESSAGE_DELIVERY_UNAVAILABLE");
    }
  });
  // The failed retry attempt still reached the trail before the refusal.
  assert.deepEqual(
    auditEvents.map((event) => [event.outcome, event.reason]),
    [["failure", "MESSAGE_DELIVERY_UNAVAILABLE"]],
  );
});

test("a committed retry is reported even when its audit record cannot be written", async () => {
  const { app, cookiePolicy, auditFailures } = createHarness({
    appendAudit: async () => {
      throw new Error("audit trail unavailable");
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages/retry`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "admin-session"),
      body: JSON.stringify({ intentId: failedIntent.id }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).intent.state, "pending");
  });
  assert.deepEqual(auditFailures, [{ outcome: "success", afterCommit: true }]);
});
