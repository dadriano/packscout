import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express, { type Express } from "express";
import {
  AuthService,
  BoundedLoginAttemptLimiter,
  createEmailLinkTokenSecurity,
  resolveEmailLinkTokenConfiguration,
  type AuthAuditEvent,
  type AuthRepository,
  type AuthoritativeSessionRecord,
  type EmailLinkAuditEventRecord,
  type EmailLinkIssuanceThrottle,
  type EnqueueEmailMessageCommand,
  type LoginOperatorRecord,
} from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createOperatorPasswordResetFlow,
  type PasswordResetTokenStore,
} from "../password-reset-runtime.ts";
import { createAuthRouter } from "./auth.ts";
import {
  createPasswordResetRouter,
  PASSWORD_RESET_ACCEPTED_BODY,
  PASSWORD_RESET_LINK_INVALID_MESSAGE,
  type OperatorPasswordResetFlow,
} from "./password-reset.ts";

const trustedOrigin = "https://admin.packscout.test";
const operatorId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000010";
const operatorEmail = "operator@packscout.test";
const originalPassword = "the original password";
const newPassword = "a brand new strong password";

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

function captureConsole(context: TestContext): string[] {
  const lines: string[] = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
  console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
  console.warn = (...parts: unknown[]) => void lines.push(parts.join(" "));
  context.after(() => {
    console.error = original.error;
    console.log = original.log;
    console.warn = original.warn;
  });
  return lines;
}

function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: trustedOrigin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Route contract, over a fake flow.
// ---------------------------------------------------------------------------

function createRouteHarness(flowOverrides: Partial<OperatorPasswordResetFlow> = {}) {
  const calls = { request: 0, complete: 0 };
  const flow: OperatorPasswordResetFlow = {
    async requestReset() {
      calls.request += 1;
    },
    async completeReset() {
      calls.complete += 1;
      return { status: "completed" };
    },
    ...flowOverrides,
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth/password-reset",
    createPasswordResetRouter({
      flow,
      sameOrigin: createSameOriginGuard([trustedOrigin]),
    }),
  );
  return { app, calls };
}

test("both reset endpoints require a trusted Origin before any flow work", async () => {
  const { app, calls } = createRouteHarness();
  await withServer(app, async (baseUrl) => {
    for (const path of ["/api/auth/password-reset/request", "/api/auth/password-reset/complete"]) {
      for (const origin of [undefined, "https://attacker.test"]) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify({ email: operatorEmail }),
        });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
          error: "The request could not be verified.",
          code: "FORBIDDEN",
        });
      }
    }
  });
  assert.equal(calls.request, 0);
  assert.equal(calls.complete, 0);
});

test("a reset request is accepted identically whatever the flow found, including a flow failure", async (context) => {
  const lines = captureConsole(context);
  let behavior: "resolved" | "nothing" | "throws" = "resolved";
  const { app } = createRouteHarness({
    async requestReset() {
      if (behavior === "throws") throw new Error("db exploded");
    },
  });
  await withServer(app, async (baseUrl) => {
    const bodies: unknown[] = [];
    for (const next of ["resolved", "nothing", "throws"] as const) {
      behavior = next;
      const response = await post(baseUrl, "/api/auth/password-reset/request", {
        email: operatorEmail,
      });
      assert.equal(response.status, 202);
      bodies.push(await response.json());
    }
    assert.deepEqual(bodies[0], PASSWORD_RESET_ACCEPTED_BODY);
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);

    // A syntactically unusable address is a form problem, not an oracle.
    const invalid = await post(baseUrl, "/api/auth/password-reset/request", {
      email: "not-an-address",
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, "VALIDATION_FAILED");
  });
  // The swallowed failure left a content-free operational record only.
  assert.equal(lines.some((line) => line.includes("admin_password_reset_request_failed")), true);
  assert.equal(lines.some((line) => line.includes(operatorEmail)), false);
});

test("completion reports password-rule violations with the schema's own messages and keeps dead links uniform", async () => {
  const { app, calls } = createRouteHarness();
  await withServer(app, async (baseUrl) => {
    const short = await post(baseUrl, "/api/auth/password-reset/complete", {
      token: "a-presented-token",
      password: "short",
    });
    assert.equal(short.status, 422);
    const shortBody = (await short.json()) as {
      code: string;
      details: { password?: string[] };
    };
    assert.equal(shortBody.code, "VALIDATION_FAILED");
    assert.deepEqual(shortBody.details.password, [
      "Password must be at least 12 characters.",
    ]);

    // A structurally missing token is just another dead link.
    const missingToken = await post(baseUrl, "/api/auth/password-reset/complete", {
      token: "",
      password: newPassword,
    });
    assert.equal(missingToken.status, 410);
    assert.deepEqual(await missingToken.json(), {
      error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
      code: "EMAIL_LINK_INVALID",
    });
  });
  assert.equal(calls.complete, 0);
});

test("completion maps the flow's closed outcomes onto the stable response contract", async (context) => {
  const lines = captureConsole(context);
  let outcome: "completed" | "rejected" | "unavailable" | "throws" = "completed";
  const { app } = createRouteHarness({
    async completeReset() {
      if (outcome === "throws") throw new Error("flow exploded");
      return { status: outcome };
    },
  });
  await withServer(app, async (baseUrl) => {
    const complete = (body: unknown) =>
      post(baseUrl, "/api/auth/password-reset/complete", body);
    const payload = { token: "a-presented-token", password: newPassword };

    const completed = await complete(payload);
    assert.equal(completed.status, 204);
    assert.equal(await completed.text(), "");

    outcome = "rejected";
    const rejected = await complete(payload);
    assert.equal(rejected.status, 410);
    assert.deepEqual(await rejected.json(), {
      error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
      code: "EMAIL_LINK_INVALID",
    });

    outcome = "unavailable";
    const unavailable = await complete(payload);
    assert.equal(unavailable.status, 503);
    const unavailableBody = await unavailable.text();
    assert.match(unavailableBody, /SERVICE_UNAVAILABLE/);

    outcome = "throws";
    const thrown = await complete(payload);
    assert.equal(thrown.status, 503);

    // No response and no log ever carries the token or the password.
    for (const captured of [unavailableBody, JSON.stringify(lines)]) {
      assert.doesNotMatch(captured, /a-presented-token|brand new strong/);
    }
  });
});

// ---------------------------------------------------------------------------
// The full journey, over the real flow, real token service, and real
// AuthService — only persistence is in memory.
// ---------------------------------------------------------------------------

interface StoredTokenRow {
  id: string;
  purpose: "operator_password_reset" | "operator_invitation";
  selector: string;
  verifierHash: string;
  subjectId: string;
  addressNormalized: string;
  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  supersededAt: Date | null;
}

interface SessionRow {
  operatorId: string;
  csrfHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

function createJourneyHarness(configurationEnv: Record<string, string> = {}) {
  const clock = {
    current: new Date("2026-08-23T10:00:00.000Z"),
    now: () => clock.current,
  };

  // --- operators, sessions, and the auth audit ledger -----------------------
  const operator: LoginOperatorRecord = {
    id: operatorId,
    organizationId,
    organizationName: "PackScout",
    emailNormalized: operatorEmail,
    displayName: "Data Operator",
    passwordHash: `hash:${originalPassword}`,
    state: "active",
    role: "data_operator",
  };
  const operators = new Map<string, LoginOperatorRecord>([[operatorEmail, operator]]);
  const sessions = new Map<string, SessionRow>();
  const authAudits: AuthAuditEvent[] = [];
  const operatorUpdates: Array<Parameters<AuthRepository["updateOperator"]>[0]> = [];
  const journeyState = { updateOperatorUnavailable: false };

  const authRepository: AuthRepository = {
    async findOperatorForLogin(normalizedEmail) {
      return operators.get(normalizedEmail) ?? null;
    },
    async rotateSession({ session }) {
      sessions.set(session.tokenHash, {
        operatorId: session.operatorId,
        csrfHash: session.csrfHash,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        revokedAt: null,
      });
    },
    async findAuthoritativeSession(tokenHash, now): Promise<AuthoritativeSessionRecord | null> {
      const session = sessions.get(tokenHash);
      if (!session || session.revokedAt) return null;
      if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null;
      const record = [...operators.values()].find(
        (candidate) => candidate.id === session.operatorId,
      );
      if (!record) return null;
      return {
        sessionId: tokenHash,
        operatorId: record.id,
        organizationId: record.organizationId,
        organizationName: record.organizationName,
        emailNormalized: record.emailNormalized,
        displayName: record.displayName,
        state: record.state,
        role: record.role,
        csrfHash: session.csrfHash,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      };
    },
    async refreshSession() {},
    async revokeSessionByTokenHash(tokenHash, revokedAt) {
      const session = sessions.get(tokenHash);
      if (session && !session.revokedAt) session.revokedAt = revokedAt;
    },
    async findOperatorById() {
      throw new Error("The password-reset journey never reads one operator.");
    },
    async activateInvitedOperator() {
      throw new Error("The password-reset journey never activates invitations.");
    },
    async cancelInvitedOperator() {
      throw new Error("The password-reset journey never cancels invitations.");
    },
    async listOperators() {
      return { items: [], nextCursor: null };
    },
    async provisionOperator() {
      throw new Error("The journey never provisions.");
    },
    async updateOperator(input) {
      operatorUpdates.push(input);
      if (journeyState.updateOperatorUnavailable) return { kind: "not_found" };
      const record = [...operators.values()].find(
        (candidate) => candidate.id === input.operatorId,
      );
      if (!record || record.organizationId !== input.organizationId) {
        return { kind: "not_found" };
      }
      if (input.passwordHash !== undefined) record.passwordHash = input.passwordHash;
      if (input.state !== undefined) record.state = input.state;
      // The documented contract: a password, role, or state change atomically
      // revokes every one of the operator's active sessions.
      if (
        input.passwordHash !== undefined ||
        input.role !== undefined ||
        input.state !== undefined
      ) {
        for (const session of sessions.values()) {
          if (session.operatorId === input.operatorId && !session.revokedAt) {
            session.revokedAt = input.now;
          }
        }
      }
      return {
        kind: "updated",
        operator: {
          id: record.id,
          email: record.emailNormalized,
          displayName: record.displayName,
          state: record.state,
          role: record.role,
          createdAt: clock.current.toISOString(),
          updatedAt: clock.current.toISOString(),
          lastAccessAt: null,
        },
      };
    },
  };

  let opaqueCounter = 0;
  const authService = new AuthService({
    repository: authRepository,
    clock,
    random: {
      id: () => `00000000-0000-4000-8000-9${String(++opaqueCounter).padStart(11, "0")}`,
      token: () => `opaque-session-${++opaqueCounter}`,
    },
    passwordHasher: {
      algorithm: "argon2id",
      hash: async (password) => `hash:${password}`,
      verify: async (passwordHash, password) => passwordHash === `hash:${password}`,
    },
    sessionDigest: {
      digest: (value) => `sess:${value}`,
      matches: (value, digest) => digest === `sess:${value}`,
    },
    csrfDigest: {
      digest: (value) => `csrf:${value}`,
      matches: (value, digest) => digest === `csrf:${value}`,
    },
    bucketKeyer: {
      keys: ({ normalizedEmail, networkIdentifier }) => ({
        account: `login-email:${normalizedEmail}`,
        network: `login-network:${networkIdentifier}`,
      }),
    },
    loginLimiter: new BoundedLoginAttemptLimiter({
      windowMs: 15 * 60_000,
      blockMs: 15 * 60_000,
      maximumFailures: 3,
      maximumBuckets: 100,
    }),
    audit: {
      async append(event) {
        authAudits.push(event);
      },
    },
    config: {
      sessionIdleMs: 60 * 60_000,
      sessionAbsoluteMs: 12 * 60 * 60_000,
      dummyPasswordHash: "hash:a dummy value",
    },
  });

  // --- the token store, throttle, audit, and atomic commit ------------------
  const tokens = new Map<string, StoredTokenRow>();
  const store: PasswordResetTokenStore = {
    async issue(input) {
      let supersededCount = 0;
      for (const row of tokens.values()) {
        if (
          row.purpose === input.purpose &&
          row.subjectId === input.subjectId &&
          row.redeemedAt === null &&
          row.supersededAt === null
        ) {
          row.supersededAt = input.issuedAt;
          supersededCount += 1;
        }
      }
      tokens.set(input.selector, {
        ...input,
        redeemedAt: null,
        supersededAt: null,
      });
      return { tokenId: input.id, supersededCount };
    },
    async findBySelector(selector) {
      return tokens.get(selector) ?? null;
    },
    async consume({ tokenId, purpose, now }) {
      const row = [...tokens.values()].find((candidate) => candidate.id === tokenId);
      if (
        !row ||
        row.purpose !== purpose ||
        row.redeemedAt !== null ||
        row.supersededAt !== null ||
        row.expiresAt.getTime() <= now.getTime()
      ) {
        return "unavailable";
      }
      row.redeemedAt = now;
      return "consumed";
    },
    async findOutstanding({ purpose, subjectId }) {
      const outstanding = [...tokens.values()]
        .filter(
          (row) =>
            row.purpose === purpose &&
            row.subjectId === subjectId &&
            row.redeemedAt === null &&
            row.supersededAt === null,
        )
        .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());
      const latest = outstanding[0];
      return latest ? { addressNormalized: latest.addressNormalized } : null;
    },
  };

  interface ThrottleBucket {
    windowStart: number;
    count: number;
    blockedUntil: number | null;
  }
  const throttleBuckets = new Map<string, ThrottleBucket>();
  const throttle: EmailLinkIssuanceThrottle = {
    async recordRequest(bucketKeys, now, options) {
      let latest: Date | null = null;
      for (const key of new Set(bucketKeys)) {
        const bucket = throttleBuckets.get(key) ?? {
          windowStart: now.getTime(),
          count: 0,
          blockedUntil: null,
        };
        if (bucket.blockedUntil !== null && bucket.blockedUntil > now.getTime()) {
          if (!latest || bucket.blockedUntil > latest.getTime()) {
            latest = new Date(bucket.blockedUntil);
          }
          throttleBuckets.set(key, bucket);
          continue;
        }
        if (now.getTime() - bucket.windowStart >= options.windowMs) {
          bucket.windowStart = now.getTime();
          bucket.count = 0;
          bucket.blockedUntil = null;
        }
        bucket.count += 1;
        if (bucket.count > options.maxRequests) {
          bucket.blockedUntil = now.getTime() + options.blockMs;
        }
        throttleBuckets.set(key, bucket);
        if (bucket.blockedUntil !== null && (!latest || bucket.blockedUntil > latest.getTime())) {
          latest = new Date(bucket.blockedUntil);
        }
      }
      return latest;
    },
  };

  const linkAudits: EmailLinkAuditEventRecord[] = [];
  const outboxIntents: EnqueueEmailMessageCommand[] = [];
  const flow = createOperatorPasswordResetFlow({
    authService,
    security: createEmailLinkTokenSecurity("a".repeat(48)),
    configuration: resolveEmailLinkTokenConfiguration(configurationEnv),
    throttle,
    linkAudit: {
      async append(event) {
        linkAudits.push(event);
      },
    },
    store,
    clock,
    // Both-or-neither, the way the Prisma composition commits them: the token
    // row and its message intent land together or not at all.
    async commitIssuance({ token, message }) {
      await store.issue(token);
      outboxIntents.push(message);
    },
  });

  // --- the HTTP surface: the existing auth routes plus the reset routes -----
  const cookiePolicy = createSessionCookiePolicy({
    production: true,
    maxAgeMs: 12 * 60 * 60_000,
  });
  const sameOrigin = createSameOriginGuard([trustedOrigin]);
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ service: authService, cookiePolicy, sameOrigin }));
  app.use("/api/auth/password-reset", createPasswordResetRouter({ flow, sameOrigin }));

  return {
    app,
    clock,
    cookiePolicy,
    operators,
    operator,
    sessions,
    tokens,
    authAudits,
    linkAudits,
    outboxIntents,
    operatorUpdates,
    journeyState,
  };
}

function sessionCookieFrom(response: Response, cookieName: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  assert.ok(match, "expected a session cookie");
  return `${cookieName}=${match[1]}`;
}

function mailedTokenFrom(intent: EnqueueEmailMessageCommand): string {
  const input = intent.input as { resetLinkPath: string };
  const url = new URL(input.resetLinkPath, "https://admin.packscout.test");
  assert.equal(url.pathname, "/reset-password");
  // The credential rides in the fragment, which browsers never send: not in
  // the query string, where access logs and `Referer` headers would hold it.
  assert.equal(url.search, "");
  assert.equal(url.searchParams.get("token"), null);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.ok(token, "expected the mailed link to carry a token");
  return token;
}

test("an operator completes the full request-to-fresh-sign-in journey, and completion signs them out everywhere", async (context) => {
  const lines = captureConsole(context);
  const harness = createJourneyHarness();
  await withServer(harness.app, async (baseUrl) => {
    // An existing session — the one a mailbox intruder would be holding.
    const login = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: originalPassword,
    });
    assert.equal(login.status, 200);
    const priorCookie = sessionCookieFrom(login, harness.cookiePolicy.name);
    const priorSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: priorCookie },
    });
    assert.equal(priorSession.status, 200);

    // Request the reset from the sign-in area, unauthenticated.
    const requested = await post(baseUrl, "/api/auth/password-reset/request", {
      email: `  ${operatorEmail.toUpperCase()}  `,
    });
    assert.equal(requested.status, 202);
    assert.deepEqual(await requested.json(), PASSWORD_RESET_ACCEPTED_BODY);

    // The message intent and the token were recorded together: the intent
    // renders through messaging/003's typed input and the link path carries
    // the only usable copy of the token.
    assert.equal(harness.outboxIntents.length, 1);
    const intent = harness.outboxIntents[0];
    assert.ok(intent);
    assert.equal(intent.kind, "operator_password_reset");
    assert.equal(intent.recipient, operatorEmail);
    assert.equal(intent.source, "operator_accounts");
    assert.match(intent.idempotencyKey, /^operator_password_reset:[0-9a-f-]{36}$/);
    const intentInput = intent.input as {
      toEmail: string;
      resetLinkPath: string;
      linkExpiresAt: string;
    };
    assert.equal(intentInput.toEmail, operatorEmail);
    assert.equal(
      intentInput.linkExpiresAt,
      new Date(harness.clock.current.getTime() + 60 * 60_000).toISOString(),
    );
    const token = mailedTokenFrom(intent);

    // Redeem the link with a new password.
    const completed = await post(baseUrl, "/api/auth/password-reset/complete", {
      token,
      password: newPassword,
    });
    assert.equal(completed.status, 204);

    // The password changed through the session-revoking update: the prior
    // session is dead, the old password no longer signs in, the new one does.
    const revokedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: priorCookie },
    });
    assert.equal(revokedSession.status, 401);
    const oldPasswordLogin = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: originalPassword,
    });
    assert.equal(oldPasswordLogin.status, 401);
    const freshLogin = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: newPassword,
    });
    assert.equal(freshLogin.status, 200);

    // The same link a second time is just another dead link.
    const reused = await post(baseUrl, "/api/auth/password-reset/complete", {
      token,
      password: "another perfectly fine password",
    });
    assert.equal(reused.status, 410);
    assert.deepEqual(await reused.json(), {
      error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
      code: "EMAIL_LINK_INVALID",
    });

    // Audit covers request and completion — identifiers and closed words
    // only. No audit record, log line, or response carried the token, the
    // link, or either password.
    assert.ok(
      harness.linkAudits.some(
        (event) =>
          event.action === "email_link.issue" &&
          event.outcome === "success" &&
          event.subjectId === operatorId,
      ),
    );
    assert.ok(
      harness.linkAudits.some(
        (event) =>
          event.action === "email_link.redeem" &&
          event.outcome === "success" &&
          event.subjectId === operatorId,
      ),
    );
    assert.ok(
      harness.authAudits.some(
        (event) =>
          event.action === "operator.password_reset" &&
          event.outcome === "success" &&
          event.subjectId === operatorId,
      ),
    );
    const [selector, verifier] = token.split(".");
    for (const serialized of [
      JSON.stringify(harness.linkAudits),
      JSON.stringify(harness.authAudits),
      JSON.stringify(lines),
    ]) {
      assert.doesNotMatch(serialized, new RegExp(`${selector}|${verifier}`));
      assert.doesNotMatch(serialized, /original password|brand new strong|perfectly fine/);
    }
  });
});

test("known, unknown, disabled, and rate-limited requests are indistinguishable at the endpoint", async () => {
  const harness = createJourneyHarness({
    PACKSCOUT_EMAIL_LINK_RESET_ADDRESS_MAX_PER_WINDOW: "2",
  });
  await withServer(harness.app, async (baseUrl) => {
    const request = (email: string) =>
      post(baseUrl, "/api/auth/password-reset/request", { email });

    const known = await request(operatorEmail);
    const unknown = await request("nobody@packscout.test");
    harness.operator.state = "disabled";
    const disabled = await request(operatorEmail);
    harness.operator.state = "active";
    const limited = await request(operatorEmail); // third hit on the address bucket
    const whileLimited = await request(operatorEmail);

    const responses = [known, unknown, disabled, limited, whileLimited];
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const response of responses) assert.equal(response.status, 202);
    for (const body of bodies) assert.deepEqual(body, PASSWORD_RESET_ACCEPTED_BODY);

    // Only the eligible, unthrottled request produced mail — and the audit
    // trail recorded the truth of each attempt without enumerating anyone.
    assert.equal(harness.outboxIntents.length, 1);
    const reasons = harness.linkAudits
      .filter((event) => event.action === "email_link.issue")
      .map((event) => event.reason);
    assert.deepEqual(reasons, [
      "issued",
      "subject_unknown",
      "subject_unknown",
      "rate_limited",
      "rate_limited",
    ]);
  });
});

test("reuse, expiry, and supersession collapse into the one invalid-link state", async () => {
  const harness = createJourneyHarness();
  await withServer(harness.app, async (baseUrl) => {
    const request = () =>
      post(baseUrl, "/api/auth/password-reset/request", { email: operatorEmail });
    const complete = (token: string) =>
      post(baseUrl, "/api/auth/password-reset/complete", {
        token,
        password: newPassword,
      });

    // A newer link supersedes the older one.
    await request();
    harness.clock.current = new Date(harness.clock.current.getTime() + 1_000);
    await request();
    assert.equal(harness.outboxIntents.length, 2);
    const first = harness.outboxIntents[0];
    const second = harness.outboxIntents[1];
    assert.ok(first && second);
    const supersededResponse = await complete(mailedTokenFrom(first));

    // The live link expires at its lifetime.
    harness.clock.current = new Date(harness.clock.current.getTime() + 60 * 60_000);
    const expiredResponse = await complete(mailedTokenFrom(second));

    // A token that never existed.
    const unknownResponse = await complete(
      `${"c".repeat(22)}.${"d".repeat(43)}`,
    );

    // A used link, tried again.
    harness.clock.current = new Date(harness.clock.current.getTime() + 16 * 60_000);
    await request();
    const third = harness.outboxIntents[2];
    assert.ok(third);
    const thirdToken = mailedTokenFrom(third);
    assert.equal((await complete(thirdToken)).status, 204);
    const reusedResponse = await complete(thirdToken);

    const dead = [supersededResponse, expiredResponse, unknownResponse, reusedResponse];
    const bodies = await Promise.all(dead.map((response) => response.json()));
    for (const response of dead) assert.equal(response.status, 410);
    for (const body of bodies) {
      assert.deepEqual(body, {
        error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
        code: "EMAIL_LINK_INVALID",
      });
    }
  });
});

test("a disabled operator cannot complete a reset, and the refusal spends nothing", async () => {
  const harness = createJourneyHarness();
  await withServer(harness.app, async (baseUrl) => {
    await post(baseUrl, "/api/auth/password-reset/request", { email: operatorEmail });
    const intent = harness.outboxIntents[0];
    assert.ok(intent);
    const token = mailedTokenFrom(intent);

    // Disabled between issuance and redemption: refused like any dead link.
    harness.operator.state = "disabled";
    const refused = await post(baseUrl, "/api/auth/password-reset/complete", {
      token,
      password: newPassword,
    });
    assert.equal(refused.status, 410);
    assert.deepEqual(await refused.json(), {
      error: PASSWORD_RESET_LINK_INVALID_MESSAGE,
      code: "EMAIL_LINK_INVALID",
    });
    assert.equal(harness.operator.passwordHash, `hash:${originalPassword}`);
    assert.ok(
      harness.linkAudits.some(
        (event) =>
          event.action === "email_link.redeem" &&
          event.reason === "subject_ineligible",
      ),
    );

    // The refusal happened before consumption: re-enabled, the link works.
    harness.operator.state = "active";
    const completed = await post(baseUrl, "/api/auth/password-reset/complete", {
      token,
      password: newPassword,
    });
    assert.equal(completed.status, 204);
    assert.equal(harness.operator.passwordHash, `hash:${newPassword}`);
  });
});

test("the reset path and the sign-in lockout never touch each other's counters", async () => {
  const harness = createJourneyHarness();
  await withServer(harness.app, async (baseUrl) => {
    // Lock the account out of sign-in the ordinary way.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await post(baseUrl, "/api/auth/login", {
        email: operatorEmail,
        password: "a wrong password",
      });
      assert.ok(failed.status === 401 || failed.status === 429);
    }
    const lockedOut = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: originalPassword,
    });
    assert.equal(lockedOut.status, 429);

    // Login lockout does not block the reset path...
    const requested = await post(baseUrl, "/api/auth/password-reset/request", {
      email: operatorEmail,
    });
    assert.equal(requested.status, 202);
    const intent = harness.outboxIntents[0];
    assert.ok(intent);
    const completed = await post(baseUrl, "/api/auth/password-reset/complete", {
      token: mailedTokenFrom(intent),
      password: newPassword,
    });
    assert.equal(completed.status, 204);

    // ...and the reset path neither cleared nor extended the lockout.
    const stillLocked = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: newPassword,
    });
    assert.equal(stillLocked.status, 429);
    harness.clock.current = new Date(harness.clock.current.getTime() + 16 * 60_000);
    const afterBlock = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: newPassword,
    });
    assert.equal(afterBlock.status, 200);

    // And in the other direction: exhausting the reset limiter leaves
    // sign-in untouched for a fresh session.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await post(baseUrl, "/api/auth/password-reset/request", {
        email: operatorEmail,
      });
      assert.equal(response.status, 202);
    }
    const loginUnaffected = await post(baseUrl, "/api/auth/login", {
      email: operatorEmail,
      password: newPassword,
    });
    assert.equal(loginUnaffected.status, 200);
  });
});

test("a completion failure after redemption is honest, and the spent link stays spent", async (context) => {
  const lines = captureConsole(context);
  const harness = createJourneyHarness();
  await withServer(harness.app, async (baseUrl) => {
    await post(baseUrl, "/api/auth/password-reset/request", { email: operatorEmail });
    const intent = harness.outboxIntents[0];
    assert.ok(intent);
    const token = mailedTokenFrom(intent);

    // The password write fails after the token was consumed.
    harness.journeyState.updateOperatorUnavailable = true;
    const failed = await post(baseUrl, "/api/auth/password-reset/complete", {
      token,
      password: newPassword,
    });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, "SERVICE_UNAVAILABLE");
    assert.equal(harness.operator.passwordHash, `hash:${originalPassword}`);

    // A redeemed token cannot be reused even though the follow-on failed.
    harness.journeyState.updateOperatorUnavailable = false;
    const retried = await post(baseUrl, "/api/auth/password-reset/complete", {
      token,
      password: newPassword,
    });
    assert.equal(retried.status, 410);

    // Recovery is a fresh link, which completes normally.
    await post(baseUrl, "/api/auth/password-reset/request", { email: operatorEmail });
    const replacement = harness.outboxIntents[1];
    assert.ok(replacement);
    const recovered = await post(baseUrl, "/api/auth/password-reset/complete", {
      token: mailedTokenFrom(replacement),
      password: newPassword,
    });
    assert.equal(recovered.status, 204);
    assert.equal(harness.operator.passwordHash, `hash:${newPassword}`);
  });
  const captured = JSON.stringify(lines);
  assert.match(captured, /admin_password_reset_completion_failed/);
  assert.doesNotMatch(captured, /brand new strong|original password/);
});
