import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperatorSummary } from "@packscout/contracts";
import {
  AuthService,
  AuthServiceError,
  BoundedLoginAttemptLimiter,
  type AuthAuditEvent,
  type AuthRepository,
  type AuthoritativeSessionRecord,
  type LoginOperatorRecord,
  type ProvisionOperatorResult,
  type UpdateOperatorResult,
} from "./auth-service.ts";

const now = new Date("2026-08-06T12:00:00.000Z");
const admin: LoginOperatorRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000010",
  organizationName: "PackScout",
  emailNormalized: "admin@packscout.test",
  displayName: "Primary Admin",
  passwordHash: "hash:correct horse battery staple",
  state: "active",
  role: "admin",
};

function summary(
  overrides: Partial<OperatorSummary> = {},
): OperatorSummary {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    email: "operator@packscout.test",
    displayName: "Data Operator",
    state: "active",
    role: "data_operator",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastAccessAt: null,
    ...overrides,
  };
}

interface RepositoryState {
  loginOperator: LoginOperatorRecord | null;
  authoritativeSession: AuthoritativeSessionRecord | null;
  rotated: Array<Parameters<AuthRepository["rotateSession"]>[0]>;
  revokedTokens: string[];
  operatorUpdates: Array<Parameters<AuthRepository["updateOperator"]>[0]>;
  refreshed: Array<Parameters<AuthRepository["refreshSession"]>[0]>;
  csrfReplacements: Array<Parameters<AuthRepository["replaceSessionCsrf"]>[0]>;
  provisionResult: ProvisionOperatorResult;
  updateResult: UpdateOperatorResult;
}

function createRepository(): { repository: AuthRepository; state: RepositoryState } {
  const state: RepositoryState = {
    loginOperator: admin,
    authoritativeSession: null,
    rotated: [],
    revokedTokens: [],
    operatorUpdates: [],
    refreshed: [],
    csrfReplacements: [],
    provisionResult: { kind: "created", operator: summary() },
    updateResult: { kind: "updated", operator: summary() },
  };
  const repository: AuthRepository = {
    async findOperatorForLogin() {
      return state.loginOperator;
    },
    async rotateSession(input) {
      state.rotated.push(input);
    },
    async findAuthoritativeSession() {
      return state.authoritativeSession;
    },
    async refreshSession(input) {
      state.refreshed.push(input);
    },
    async replaceSessionCsrf(input) {
      state.csrfReplacements.push(input);
    },
    async revokeSessionByTokenHash(tokenHash) {
      state.revokedTokens.push(tokenHash);
    },
    async listOperators() {
      return { items: [summary()], nextCursor: null };
    },
    async provisionOperator() {
      return state.provisionResult;
    },
    async updateOperator(input) {
      state.operatorUpdates.push(input);
      return state.updateResult;
    },
  };
  return { repository, state };
}

function createHarness() {
  const { repository, state } = createRepository();
  const audits: AuthAuditEvent[] = [];
  const passwordVerifications: string[] = [];
  const limiter = new BoundedLoginAttemptLimiter({
    windowMs: 60_000,
    blockMs: 30_000,
    maximumFailures: 3,
    maximumBuckets: 20,
  });
  let tokenIndex = 0;
  const service = new AuthService({
    repository,
    clock: { now: () => now },
    random: {
      id: () => `00000000-0000-4000-8000-${String(++tokenIndex).padStart(12, "0")}`,
      token: () => `opaque-${++tokenIndex}`,
    },
    passwordHasher: {
      algorithm: "argon2id",
      hash: async (password) => `hash:${password}`,
      verify: async (passwordHash, password) => {
        passwordVerifications.push(passwordHash);
        return passwordHash === `hash:${password}`;
      },
    },
    sessionDigest: {
      digest: (value) => `session:${value}`,
      matches: (value, digest) => digest === `session:${value}`,
    },
    csrfDigest: {
      digest: (value) => `csrf:${value}`,
      matches: (value, digest) => digest === `csrf:${value}`,
    },
    bucketKeyer: {
      keys: ({ normalizedEmail, networkIdentifier }) => ({
        account: `email-key:${normalizedEmail}`,
        network: `network-key:${networkIdentifier}`,
      }),
    },
    loginLimiter: limiter,
    audit: {
      async append(event) {
        audits.push(event);
      },
    },
    config: {
      sessionIdleMs: 60 * 60 * 1_000,
      sessionAbsoluteMs: 12 * 60 * 60 * 1_000,
      dummyPasswordHash: "hash:dummy value",
    },
  });
  return { service, state, audits, passwordVerifications };
}

function captureServiceError(run: () => Promise<unknown>): Promise<AuthServiceError> {
  return run().then(
    () => {
      throw new Error("Expected AuthServiceError.");
    },
    (error: unknown) => {
      assert.ok(error instanceof AuthServiceError);
      return error;
    },
  );
}

test("login rotates the presented session and returns only browser-safe identity data", async () => {
  const { service, state } = createHarness();
  const result = await service.login({
    normalizedEmail: admin.emailNormalized,
    password: "correct horse battery staple",
    networkIdentifier: "network-a",
    previousSessionToken: "old-token",
  });

  assert.equal(result.session.operator.email, admin.emailNormalized);
  assert.equal(result.session.membership.role, "admin");
  assert.ok(result.session.permissions.includes("operators:manage"));
  assert.equal(state.rotated.length, 1);
  assert.equal(state.rotated[0]?.previousTokenHash, "session:old-token");
  assert.notEqual(state.rotated[0]?.session.tokenHash, result.sessionToken);
  assert.equal("password" in result.session.operator, false);
  assert.equal("passwordHash" in result.session.operator, false);
});

test("unknown, incorrect, and disabled credentials share one generic failure", async () => {
  const unknown = createHarness();
  unknown.state.loginOperator = null;
  const unknownError = await captureServiceError(() =>
    unknown.service.login({
      normalizedEmail: "missing@packscout.test",
      password: "incorrect",
      networkIdentifier: "unknown-network",
    }),
  );
  assert.equal(unknown.passwordVerifications[0], "hash:dummy value");

  const incorrect = createHarness();
  const incorrectError = await captureServiceError(() =>
    incorrect.service.login({
      normalizedEmail: admin.emailNormalized,
      password: "incorrect",
      networkIdentifier: "incorrect-network",
    }),
  );

  const disabled = createHarness();
  disabled.state.loginOperator = { ...admin, state: "disabled" };
  const disabledError = await captureServiceError(() =>
    disabled.service.login({
      normalizedEmail: admin.emailNormalized,
      password: "correct horse battery staple",
      networkIdentifier: "disabled-network",
    }),
  );

  for (const error of [unknownError, incorrectError, disabledError]) {
    assert.equal(error.status, 401);
    assert.equal(error.code, "INVALID_CREDENTIALS");
    assert.equal(
      error.message,
      "We couldn't sign you in. Check your details and try again.",
    );
  }
});

test("repeated failures are rate limited by bounded pseudonymous buckets", async () => {
  const { service } = createHarness();
  const attempt = () =>
    service.login({
      normalizedEmail: admin.emailNormalized,
      password: "incorrect",
      networkIdentifier: "same-network",
    });

  assert.equal((await captureServiceError(attempt)).code, "INVALID_CREDENTIALS");
  assert.equal((await captureServiceError(attempt)).code, "INVALID_CREDENTIALS");
  const limited = await captureServiceError(attempt);
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAt?.toISOString(), "2026-08-06T12:00:30.000Z");
});

test("successful login clears only its account bucket, not the network spray bucket", async () => {
  const { service, state } = createHarness();
  const failAs = async (email: string) => {
    state.loginOperator = null;
    return captureServiceError(() =>
      service.login({
        normalizedEmail: email,
        password: "incorrect",
        networkIdentifier: "shared-network",
      }),
    );
  };

  assert.equal((await failAs("first@packscout.test")).code, "INVALID_CREDENTIALS");
  assert.equal((await failAs("second@packscout.test")).code, "INVALID_CREDENTIALS");

  state.loginOperator = admin;
  await service.login({
    normalizedEmail: admin.emailNormalized,
    password: "correct horse battery staple",
    networkIdentifier: "shared-network",
  });

  const blocked = await failAs("third@packscout.test");
  assert.equal(blocked.code, "RATE_LIMITED");
});

test("session resolution rechecks authoritative role and rejects disabled accounts", async () => {
  const { service, state } = createHarness();
  state.authoritativeSession = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    emailNormalized: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active",
    role: "data_operator",
    csrfHash: "csrf:valid-csrf",
    idleExpiresAt: new Date(now.getTime() + 10_000),
    absoluteExpiresAt: new Date(now.getTime() + 20_000),
  };
  const actor = await service.resolveSession({
    sessionToken: "session-token",
    csrfToken: "valid-csrf",
  });
  assert.equal(actor.role, "data_operator");
  assert.deepEqual(actor.permissions, [
    "providers:view",
    "imports:start",
    "imports:retry",
  ]);
  assert.equal(state.refreshed[0]?.idleExpiresAt.toISOString(), state.authoritativeSession.absoluteExpiresAt.toISOString());

  state.authoritativeSession = { ...state.authoritativeSession, state: "disabled" };
  const disabled = await captureServiceError(() =>
    service.resolveSession({ sessionToken: "session-token" }),
  );
  assert.equal(disabled.code, "AUTH_REQUIRED");
  assert.deepEqual(state.revokedTokens, ["session:session-token"]);
});

test("operator mutations are admin-only, revoke stale sessions, and keep audits secret-free", async () => {
  const { service, state, audits } = createHarness();
  state.authoritativeSession = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    emailNormalized: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active",
    role: "admin",
    csrfHash: "csrf:valid",
    idleExpiresAt: new Date(now.getTime() + 1_000),
    absoluteExpiresAt: new Date(now.getTime() + 10_000),
  };
  const actor = await service.resolveSession({
    sessionToken: "session-token",
    csrfToken: "valid",
  });
  await service.updateOperator(actor, summary().id, {
    password: "new secret password",
    role: "admin",
  });

  assert.equal(state.operatorUpdates.length, 1);
  assert.equal(state.operatorUpdates[0]?.passwordHash, "hash:new secret password");
  assert.equal(state.operatorUpdates[0]?.role, "admin");
  const serializedAudit = JSON.stringify(audits.at(-1));
  assert.doesNotMatch(serializedAudit, /new secret password|hash:/);
  assert.match(serializedAudit, /credential/);

  const dataOperator = { ...actor, role: "data_operator" as const };
  const forbidden = await captureServiceError(() =>
    service.provisionOperator(dataOperator, {
      email: "new@packscout.test",
      displayName: "New Operator",
      password: "initial secure password",
      role: "data_operator",
    }),
  );
  assert.equal(forbidden.code, "FORBIDDEN");
});

test("atomic repository last-admin protection maps to a stable conflict", async () => {
  const { service, state } = createHarness();
  state.updateResult = { kind: "last_active_admin" };
  const actor = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    email: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active" as const,
    role: "admin" as const,
    permissions: ["operators:manage" as const],
    csrfToken: "valid",
  };
  const error = await captureServiceError(() =>
    service.updateOperator(actor, admin.id, { state: "disabled" }),
  );
  assert.equal(error.status, 409);
  assert.equal(error.code, "LAST_ACTIVE_ADMIN");
  assert.equal(state.operatorUpdates.length, 1);
});
