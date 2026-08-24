import assert from "node:assert/strict";
import { test } from "node:test";
import {
  permissionsForOperatorRole,
  type OperatorSummary,
} from "@packscout/contracts";
import {
  AuthService,
  AuthServiceError,
  BoundedLoginAttemptLimiter,
  type AuthAuditEvent,
  type AuthAuditWriteFailure,
  type AuthRepository,
  type AuthoritativeSessionRecord,
  type LoginOperatorRecord,
  type ActivateInvitedOperatorResult,
  type CancelInvitedOperatorResult,
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
  provisionResult: ProvisionOperatorResult;
  updateResult: UpdateOperatorResult;
  activateResult: ActivateInvitedOperatorResult;
  cancelResult: CancelInvitedOperatorResult;
  operatorById: OperatorSummary | null;
  provisionInputs: Array<Parameters<AuthRepository["provisionOperator"]>[0]>;
  activations: Array<Parameters<AuthRepository["activateInvitedOperator"]>[0]>;
  cancellations: Array<Parameters<AuthRepository["cancelInvitedOperator"]>[0]>;
}

function createRepository(): { repository: AuthRepository; state: RepositoryState } {
  const state: RepositoryState = {
    loginOperator: admin,
    authoritativeSession: null,
    rotated: [],
    revokedTokens: [],
    operatorUpdates: [],
    refreshed: [],
    provisionResult: { kind: "created", operator: summary({ state: "pending" }) },
    updateResult: { kind: "updated", operator: summary() },
    activateResult: { kind: "activated", operator: summary() },
    cancelResult: { kind: "cancelled", operator: summary({ state: "cancelled" }) },
    operatorById: summary({ state: "pending" }),
    provisionInputs: [],
    activations: [],
    cancellations: [],
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
    async revokeSessionByTokenHash(tokenHash) {
      state.revokedTokens.push(tokenHash);
    },
    async listOperators() {
      return { items: [summary()], nextCursor: null };
    },
    async findOperatorById() {
      return state.operatorById;
    },
    async provisionOperator(input) {
      state.provisionInputs.push(input);
      return state.provisionResult;
    },
    async activateInvitedOperator(input) {
      state.activations.push(input);
      return state.activateResult;
    },
    async cancelInvitedOperator(input) {
      state.cancellations.push(input);
      return state.cancelResult;
    },
    async updateOperator(input) {
      state.operatorUpdates.push(input);
      return state.updateResult;
    },
  };
  return { repository, state };
}

function createHarness(overrides?: {
  /** Which records the ledger refuses, standing in for an unavailable sink. */
  auditFailsOn?: (event: AuthAuditEvent) => boolean;
}) {
  const { repository, state } = createRepository();
  const audits: AuthAuditEvent[] = [];
  const auditFailures: AuthAuditWriteFailure[] = [];
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
        if (overrides?.auditFailsOn?.(event)) {
          throw new Error("the audit ledger is unavailable");
        }
        audits.push(event);
      },
    },
    reportAuditFailure: (failure) => auditFailures.push(failure),
    config: {
      sessionIdleMs: 60 * 60 * 1_000,
      sessionAbsoluteMs: 12 * 60 * 60 * 1_000,
      dummyPasswordHash: "hash:dummy value",
    },
  });
  return { service, state, audits, auditFailures, passwordVerifications };
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
  assert.equal(
    state.rotated[0]?.session.csrfHash,
    `csrf:${result.session.csrfToken}`,
  );
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

test("bounded login limiter evicts the least-recently-used bucket", async () => {
  const limiter = new BoundedLoginAttemptLimiter({
    windowMs: 60_000,
    blockMs: 30_000,
    maximumFailures: 1,
    maximumBuckets: 2,
  });
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  await limiter.recordFailure(["oldest"], at(0));
  await limiter.recordFailure(["newer"], at(1));
  assert.ok(await limiter.retryAt(["oldest"], at(2)));

  await limiter.recordFailure(["newest"], at(3));

  assert.equal(await limiter.retryAt(["newer"], at(4)), null);
  assert.ok(await limiter.retryAt(["oldest"], at(4)));
  assert.ok(await limiter.retryAt(["newest"], at(4)));
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
  // Compared against the authoritative grant rather than a restated literal, so
  // this test proves the role was re-resolved and does not have to be edited
  // every time the role's capabilities change.
  assert.deepEqual(actor.permissions, permissionsForOperatorRole("data_operator"));
  assert.equal(state.refreshed[0]?.idleExpiresAt.toISOString(), state.authoritativeSession.absoluteExpiresAt.toISOString());

  state.authoritativeSession = { ...state.authoritativeSession, state: "disabled" };
  const disabled = await captureServiceError(() =>
    service.resolveSession({ sessionToken: "session-token" }),
  );
  assert.equal(disabled.code, "AUTH_REQUIRED");
  assert.deepEqual(state.revokedTokens, ["session:session-token"]);
});

test("session bootstrap is read-only and keeps one CSRF token valid across tabs", async () => {
  const { service, state } = createHarness();
  state.authoritativeSession = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    emailNormalized: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active",
    role: "admin",
    csrfHash: "csrf:csrf:session-token",
    idleExpiresAt: new Date(now.getTime() + 10_000),
    absoluteExpiresAt: new Date(now.getTime() + 20_000),
  };

  const firstTab = await service.bootstrapSession("session-token");
  const secondTab = await service.bootstrapSession("session-token");

  assert.equal(firstTab.session.csrfToken, "csrf:session-token");
  assert.equal(secondTab.session.csrfToken, firstTab.session.csrfToken);
  assert.deepEqual(state.refreshed, []);
  assert.deepEqual(state.revokedTokens, []);

  const actor = await service.resolveSession({
    sessionToken: "session-token",
    csrfToken: firstTab.session.csrfToken,
  });
  assert.equal(actor.sessionId, "session-id");
  assert.equal(state.refreshed.length, 1);
});

test("session bootstrap does not revoke an inactive authoritative session", async () => {
  const { service, state } = createHarness();
  state.authoritativeSession = {
    sessionId: "disabled-session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    emailNormalized: admin.emailNormalized,
    displayName: admin.displayName,
    state: "disabled",
    role: "admin",
    csrfHash: "csrf:csrf:session-token",
    idleExpiresAt: new Date(now.getTime() + 10_000),
    absoluteExpiresAt: new Date(now.getTime() + 20_000),
  };

  const error = await captureServiceError(() =>
    service.bootstrapSession("session-token"),
  );
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.deepEqual(state.refreshed, []);
  assert.deepEqual(state.revokedTokens, []);
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
    service.inviteOperator(dataOperator, {
      email: "new@packscout.test",
      displayName: "New Operator",
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

test("password reset issuance resolves only active operators, silently", async () => {
  const { service, state } = createHarness();

  assert.equal(
    await service.resolveActiveOperatorIdByEmail(admin.emailNormalized),
    admin.id,
  );

  state.loginOperator = { ...admin, state: "disabled" };
  assert.equal(
    await service.resolveActiveOperatorIdByEmail(admin.emailNormalized),
    null,
  );

  state.loginOperator = null;
  assert.equal(
    await service.resolveActiveOperatorIdByEmail("nobody@packscout.test"),
    null,
  );
});

test("password reset eligibility requires the same active operator behind the mailed address", async () => {
  const { service, state } = createHarness();

  assert.equal(
    await service.isOperatorEligibleForPasswordReset(
      admin.id,
      admin.emailNormalized,
    ),
    true,
  );
  // The address resolves to a different operator than the token was bound to.
  assert.equal(
    await service.isOperatorEligibleForPasswordReset(
      "00000000-0000-4000-8000-000000000099",
      admin.emailNormalized,
    ),
    false,
  );
  state.loginOperator = { ...admin, state: "disabled" };
  assert.equal(
    await service.isOperatorEligibleForPasswordReset(
      admin.id,
      admin.emailNormalized,
    ),
    false,
  );
  state.loginOperator = null;
  assert.equal(
    await service.isOperatorEligibleForPasswordReset(
      admin.id,
      admin.emailNormalized,
    ),
    false,
  );
});

test("completing a password reset rehashes through the session-revoking update and audits without secrets", async () => {
  const { service, state, audits } = createHarness();

  await service.completePasswordReset({
    operatorId: admin.id,
    addressNormalized: admin.emailNormalized,
    newPassword: "a fresh strong password",
  });

  // The one repository call that both writes the hash and revokes every
  // active session for the operator — the admin's existing machinery.
  assert.equal(state.operatorUpdates.length, 1);
  assert.deepEqual(state.operatorUpdates[0], {
    organizationId: admin.organizationId,
    operatorId: admin.id,
    passwordHash: "hash:a fresh strong password",
    now,
  });

  const audit = audits.at(-1);
  assert.equal(audit?.action, "operator.password_reset");
  assert.equal(audit?.outcome, "success");
  assert.equal(audit?.subjectId, admin.id);
  assert.equal(audit?.actorId, admin.id);
  const serializedAudit = JSON.stringify(audits);
  assert.doesNotMatch(serializedAudit, /fresh strong password|hash:/);
});

test("a reset completion for an ineligible or mismatched operator is refused before any write", async () => {
  const { service, state, audits } = createHarness();

  state.loginOperator = { ...admin, state: "disabled" };
  const disabled = await captureServiceError(() =>
    service.completePasswordReset({
      operatorId: admin.id,
      addressNormalized: admin.emailNormalized,
      newPassword: "a fresh strong password",
    }),
  );
  assert.equal(disabled.code, "FORBIDDEN");

  state.loginOperator = admin;
  const mismatched = await captureServiceError(() =>
    service.completePasswordReset({
      operatorId: "00000000-0000-4000-8000-000000000099",
      addressNormalized: admin.emailNormalized,
      newPassword: "a fresh strong password",
    }),
  );
  assert.equal(mismatched.code, "FORBIDDEN");

  assert.equal(state.operatorUpdates.length, 0);
  assert.equal(
    audits.filter(
      (event) =>
        event.action === "operator.password_reset" &&
        event.outcome === "blocked",
    ).length,
    2,
  );
  assert.doesNotMatch(JSON.stringify(audits), /fresh strong password/);
});

test("a reset completion that cannot update the operator reports unavailability honestly", async () => {
  const { service, state, audits } = createHarness();
  state.updateResult = { kind: "not_found" };

  const error = await captureServiceError(() =>
    service.completePasswordReset({
      operatorId: admin.id,
      addressNormalized: admin.emailNormalized,
      newPassword: "a fresh strong password",
    }),
  );
  assert.equal(error.code, "SERVICE_UNAVAILABLE");
  assert.equal(error.status, 503);
  assert.equal(audits.at(-1)?.outcome, "failure");
  assert.doesNotMatch(JSON.stringify(audits), /fresh strong password/);
});

test("inviting an operator creates a credential-less pending account and audits without secrets", async () => {
  const { service, state, audits } = createHarness();
  const actor = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    email: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active" as const,
    role: "admin" as const,
    permissions: [],
    csrfToken: "csrf",
  };

  const result = await service.inviteOperator(actor, {
    email: "invited@packscout.test",
    displayName: "Invited Operator",
    role: "data_operator",
  });

  assert.equal(result.operator.state, "pending");
  assert.equal(state.provisionInputs.length, 1);
  assert.equal(state.provisionInputs[0]?.passwordHash, null);
  assert.equal(state.provisionInputs[0]?.state, "pending");
  const audit = audits.at(-1);
  assert.equal(audit?.action, "operator.invite");
  assert.equal(audit?.outcome, "success");
  assert.doesNotMatch(JSON.stringify(audits), /hash:|password|token|link/i);

  const dataOperator = { ...actor, role: "data_operator" as const };
  const forbidden = await captureServiceError(() =>
    service.inviteOperator(dataOperator, {
      email: "other@packscout.test",
      displayName: "Other",
      role: "data_operator",
    }),
  );
  assert.equal(forbidden.code, "FORBIDDEN");
});

test("a pending account is refused by every authentication path", async () => {
  // One enumeration over every route into an authenticated identity, so a
  // new path cannot quietly start accepting invited-but-not-activated
  // accounts. Each entry names the site in auth-service.ts it exercises.
  const pending = { ...admin, state: "pending" as const, passwordHash: null };

  // login(): the credential check.
  const loginHarness = createHarness();
  loginHarness.state.loginOperator = pending;
  const login = await captureServiceError(() =>
    loginHarness.service.login({
      normalizedEmail: pending.emailNormalized,
      password: "correct horse battery staple",
      networkIdentifier: "network-a",
      previousSessionToken: undefined,
    }),
  );
  assert.equal(login.code, "INVALID_CREDENTIALS");
  // Verified against the dummy hash, exactly like an unknown address: a
  // credential-less account is refused for its state, not for its shape.
  assert.deepEqual(loginHarness.passwordVerifications, ["hash:dummy value"]);

  // resolveSession(): the authoritative session recheck.
  const sessionHarness = createHarness();
  sessionHarness.state.authoritativeSession = {
    sessionId: "session-id",
    operatorId: pending.id,
    organizationId: pending.organizationId,
    organizationName: pending.organizationName,
    emailNormalized: pending.emailNormalized,
    displayName: pending.displayName,
    state: "pending",
    role: "admin",
    csrfHash: "csrf:valid-csrf",
    idleExpiresAt: new Date(now.getTime() + 10_000),
    absoluteExpiresAt: new Date(now.getTime() + 20_000),
  };
  const resolved = await captureServiceError(() =>
    sessionHarness.service.resolveSession({ sessionToken: "session-token" }),
  );
  assert.equal(resolved.code, "AUTH_REQUIRED");

  // bootstrapSession(): the read-only variant of the same recheck.
  const bootstrapHarness = createHarness();
  bootstrapHarness.state.authoritativeSession =
    sessionHarness.state.authoritativeSession;
  const bootstrapped = await captureServiceError(() =>
    bootstrapHarness.service.bootstrapSession("session-token"),
  );
  assert.equal(bootstrapped.code, "AUTH_REQUIRED");

  // resolveActiveOperatorIdByEmail(): password-reset issuance.
  const issuanceHarness = createHarness();
  issuanceHarness.state.loginOperator = pending;
  assert.equal(
    await issuanceHarness.service.resolveActiveOperatorIdByEmail(
      pending.emailNormalized,
    ),
    null,
  );

  // isOperatorEligibleForPasswordReset(): password-reset redemption.
  assert.equal(
    await issuanceHarness.service.isOperatorEligibleForPasswordReset(
      pending.id,
      pending.emailNormalized,
    ),
    false,
  );

  // completePasswordReset(): a reset can never activate a pending account.
  const resetHarness = createHarness();
  resetHarness.state.loginOperator = pending;
  const reset = await captureServiceError(() =>
    resetHarness.service.completePasswordReset({
      operatorId: pending.id,
      addressNormalized: pending.emailNormalized,
      newPassword: "a fresh strong password",
    }),
  );
  assert.equal(reset.code, "FORBIDDEN");
  assert.equal(resetHarness.state.operatorUpdates.length, 0);

  // updateOperator(): an administrator cannot edit one into usability.
  const updateHarness = createHarness();
  updateHarness.state.updateResult = { kind: "not_activated" };
  const updated = await captureServiceError(() =>
    updateHarness.service.updateOperator(
      {
        sessionId: "session-id",
        operatorId: admin.id,
        organizationId: admin.organizationId,
        organizationName: admin.organizationName,
        email: admin.emailNormalized,
        displayName: admin.displayName,
        state: "active",
        role: "admin",
        permissions: [],
        csrfToken: "csrf",
      },
      pending.id,
      { state: "active", password: "an administrator chosen password" },
    ),
  );
  assert.equal(updated.code, "OPERATOR_NOT_ACTIVATED");
  assert.equal(updated.status, 409);
  assert.equal(updateHarness.audits.at(-1)?.outcome, "blocked");
});

test("invitation redemption activates only the pending account the link was bound to", async () => {
  const { service, state, audits } = createHarness();
  const pending = { ...admin, state: "pending" as const, passwordHash: null };
  state.loginOperator = pending;

  assert.equal(
    await service.isOperatorEligibleForInvitation(
      pending.id,
      pending.emailNormalized,
    ),
    true,
  );
  // A different subject behind the same address, and an account that is no
  // longer pending, are both ineligible.
  assert.equal(
    await service.isOperatorEligibleForInvitation(
      "00000000-0000-4000-8000-0000000000ff",
      pending.emailNormalized,
    ),
    false,
  );
  state.loginOperator = { ...pending, state: "active" };
  assert.equal(
    await service.isOperatorEligibleForInvitation(
      pending.id,
      pending.emailNormalized,
    ),
    false,
  );

  state.loginOperator = pending;
  const activated = await service.activateInvitedOperator({
    operatorId: pending.id,
    addressNormalized: pending.emailNormalized,
    newPassword: "a chosen strong password",
  });
  assert.equal(activated.operator.state, "active");
  assert.equal(state.activations.length, 1);
  assert.equal(state.activations[0]?.passwordHash, "hash:a chosen strong password");
  const audit = audits.at(-1);
  assert.equal(audit?.action, "operator.invitation_accept");
  assert.equal(audit?.outcome, "success");
  assert.doesNotMatch(JSON.stringify(audits), /a chosen strong password|hash:/);
});

test("redeeming for a cancelled or already-activated account is refused before any write", async () => {
  const cancelled = createHarness();
  cancelled.state.loginOperator = {
    ...admin,
    state: "cancelled",
    passwordHash: null,
  };
  const refused = await captureServiceError(() =>
    cancelled.service.activateInvitedOperator({
      operatorId: admin.id,
      addressNormalized: admin.emailNormalized,
      newPassword: "a chosen strong password",
    }),
  );
  assert.equal(refused.code, "FORBIDDEN");
  assert.equal(cancelled.state.activations.length, 0);

  // A cancellation that lands between the eligibility check and the write:
  // the guarded update refuses, and the outcome is the same refusal.
  const raced = createHarness();
  raced.state.loginOperator = { ...admin, state: "pending", passwordHash: null };
  raced.state.activateResult = { kind: "not_pending" };
  const lost = await captureServiceError(() =>
    raced.service.activateInvitedOperator({
      operatorId: admin.id,
      addressNormalized: admin.emailNormalized,
      newPassword: "a chosen strong password",
    }),
  );
  assert.equal(lost.code, "FORBIDDEN");
  assert.equal(raced.audits.at(-1)?.outcome, "blocked");
  assert.doesNotMatch(JSON.stringify(raced.audits), /a chosen strong password/);
});

test("cancelling an invitation is admin-only, terminal, and audited", async () => {
  const { service, state, audits } = createHarness();
  const actor = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    email: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active" as const,
    role: "admin" as const,
    permissions: [],
    csrfToken: "csrf",
  };

  const cancelled = await service.cancelInvitedOperator(actor, summary().id);
  assert.equal(cancelled.operator.state, "cancelled");
  assert.equal(state.cancellations.length, 1);
  assert.equal(audits.at(-1)?.action, "operator.invitation_cancel");
  assert.equal(audits.at(-1)?.outcome, "success");

  const forbidden = await captureServiceError(() =>
    service.cancelInvitedOperator(
      { ...actor, role: "data_operator" },
      summary().id,
    ),
  );
  assert.equal(forbidden.code, "FORBIDDEN");

  // An account that already works is not a pending invitation to withdraw.
  state.cancelResult = { kind: "not_pending" };
  const missing = await captureServiceError(() =>
    service.cancelInvitedOperator(actor, summary().id),
  );
  assert.equal(missing.code, "OPERATOR_NOT_FOUND");
  assert.equal(missing.status, 404);
});

test("reissue resolves the account's own address and refuses non-pending targets", async () => {
  const { service, state } = createHarness();
  const actor = {
    sessionId: "session-id",
    operatorId: admin.id,
    organizationId: admin.organizationId,
    organizationName: admin.organizationName,
    email: admin.emailNormalized,
    displayName: admin.displayName,
    state: "active" as const,
    role: "admin" as const,
    permissions: [],
    csrfToken: "csrf",
  };

  const resolved = await service.resolvePendingOperatorForReissue(
    actor,
    summary().id,
  );
  assert.equal(resolved.email, "operator@packscout.test");

  state.operatorById = summary({ state: "active" });
  const active = await captureServiceError(() =>
    service.resolvePendingOperatorForReissue(actor, summary().id),
  );
  assert.equal(active.code, "OPERATOR_NOT_FOUND");

  state.operatorById = null;
  const unknown = await captureServiceError(() =>
    service.resolvePendingOperatorForReissue(actor, summary().id),
  );
  assert.equal(unknown.code, "OPERATOR_NOT_FOUND");

  const forbidden = await captureServiceError(() =>
    service.resolvePendingOperatorForReissue(
      { ...actor, role: "data_operator" },
      summary().id,
    ),
  );
  assert.equal(forbidden.code, "FORBIDDEN");
});

test("a completed reset stays completed when its audit write fails", async () => {
  // The password is changed, every session the operator held is revoked, and
  // the one-time link that authorized it is spent. Reporting unavailability
  // because the ledger refused would tell the operator their password is
  // unchanged when it is changed, and the link can never be presented again:
  // they would be locked out of an account whose new password they were told
  // did not take.
  const { service, state, audits, auditFailures } = createHarness({
    auditFailsOn: (event) =>
      event.action === "operator.password_reset" && event.outcome === "success",
  });

  await service.completePasswordReset({
    operatorId: admin.id,
    addressNormalized: admin.emailNormalized,
    newPassword: "a fresh strong password",
  });

  // The credential update — and its session revocation — still happened once.
  assert.equal(state.operatorUpdates.length, 1);
  assert.equal(state.operatorUpdates[0]?.passwordHash, "hash:a fresh strong password");
  assert.equal(
    audits.some((event) => event.action === "operator.password_reset"),
    false,
  );

  // The gap is reported on its own, naming nothing the reset was holding.
  assert.deepEqual(auditFailures, [
    {
      action: "operator.password_reset",
      outcome: "success",
      afterCommit: true,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(auditFailures),
    /fresh strong password|hash:|@/,
  );
});
