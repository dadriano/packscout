import { permissionsForOperatorRole } from "@packscout/contracts";
import type {
  AuthSessionResponse,
  ListOperatorsQuery,
  NormalizedInviteOperatorRequest,
  NormalizedUpdateOperatorRequest,
  OperatorListResponse,
  OperatorMutationResponse,
  OperatorPermission,
  OperatorRole,
  OperatorState,
  OperatorSummary,
} from "@packscout/contracts";

export interface Clock {
  now(): Date;
}

export interface OpaqueRandomSource {
  id(): string;
  token(byteLength: number): string;
}

export interface PasswordHasher {
  readonly algorithm: "argon2id";
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export interface SecretDigest {
  digest(value: string): string;
  matches(value: string, digest: string): boolean;
}

export interface LoginBucketKeyer {
  keys(input: {
    normalizedEmail: string;
    networkIdentifier: string;
  }): {
    account: string;
    network: string;
  };
}

export interface LoginAttemptLimiter {
  retryAt(bucketKeys: readonly string[], now: Date): Promise<Date | null>;
  recordFailure(bucketKeys: readonly string[], now: Date): Promise<Date | null>;
  clear(bucketKeys: readonly string[]): Promise<void>;
}

export interface AuthAuditEvent {
  organizationId: string | null;
  actorId: string | null;
  action:
    | "auth.login"
    | "auth.logout"
    | "operator.provision"
    | "operator.invite"
    | "operator.invitation_accept"
    | "operator.invitation_cancel"
    | "operator.invitation_reissue"
    | "operator.update"
    | "operator.password_reset";
  subjectId: string | null;
  outcome: "success" | "failure" | "blocked";
  occurredAt: Date;
  metadata: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export interface AuthAuditSink {
  append(event: AuthAuditEvent): Promise<void>;
}

export interface LoginOperatorRecord {
  id: string;
  organizationId: string;
  organizationName: string;
  emailNormalized: string;
  displayName: string;
  /**
   * Absent for an invited account that has never been activated. Every path
   * that verifies a password already falls back to the configured dummy
   * hash, so a credential-less account costs exactly what a real one does
   * and is refused for its state, never for its shape.
   */
  passwordHash: string | null;
  state: OperatorState;
  role: OperatorRole;
}

export interface AuthoritativeSessionRecord {
  sessionId: string;
  operatorId: string;
  organizationId: string;
  organizationName: string;
  emailNormalized: string;
  displayName: string;
  state: OperatorState;
  role: OperatorRole;
  csrfHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface AuthenticatedActor {
  sessionId: string;
  operatorId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  displayName: string;
  state: "active";
  role: OperatorRole;
  permissions: OperatorPermission[];
  csrfToken: string;
}

export interface CreateSessionRecord {
  id: string;
  operatorId: string;
  tokenHash: string;
  csrfHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export type ProvisionOperatorResult =
  | { kind: "created"; operator: OperatorSummary }
  | { kind: "email_conflict" };

export type UpdateOperatorResult =
  | { kind: "updated"; operator: OperatorSummary }
  | { kind: "not_found" }
  | { kind: "last_active_admin" }
  /** The target is an invited or cancelled account, not one to administer. */
  | { kind: "not_activated" };

export type ActivateInvitedOperatorResult =
  | { kind: "activated"; operator: OperatorSummary }
  | { kind: "not_pending" };

export type CancelInvitedOperatorResult =
  | { kind: "cancelled"; operator: OperatorSummary }
  | { kind: "not_pending" };

export interface AuthRepository {
  findOperatorForLogin(normalizedEmail: string): Promise<LoginOperatorRecord | null>;
  rotateSession(input: {
    previousTokenHash: string | null;
    session: CreateSessionRecord;
  }): Promise<void>;
  findAuthoritativeSession(
    tokenHash: string,
    now: Date,
  ): Promise<AuthoritativeSessionRecord | null>;
  refreshSession(input: {
    sessionId: string;
    lastSeenAt: Date;
    idleExpiresAt: Date;
  }): Promise<void>;
  revokeSessionByTokenHash(tokenHash: string, revokedAt: Date): Promise<void>;
  listOperators(
    organizationId: string,
    query: ListOperatorsQuery,
  ): Promise<OperatorListResponse>;
  /** One operator in the acting organization, or null. */
  findOperatorById(
    organizationId: string,
    operatorId: string,
  ): Promise<OperatorSummary | null>;
  provisionOperator(input: {
    id: string;
    organizationId: string;
    emailNormalized: string;
    displayName: string;
    /** Null for an invitation: the invited person chooses their own. */
    passwordHash: string | null;
    role: OperatorRole;
    state: "active" | "pending";
    now: Date;
  }): Promise<ProvisionOperatorResult>;
  /**
   * Updates the operator and atomically revokes all of that operator's active
   * sessions when password, role, or state changes.
   */
  updateOperator(input: {
    organizationId: string;
    operatorId: string;
    displayName?: string;
    passwordHash?: string;
    role?: OperatorRole;
    state?: OperatorState;
    now: Date;
  }): Promise<UpdateOperatorResult>;
  /**
   * The only transition from `pending` to `active`, guarded on the pending
   * state inside the write itself.
   */
  activateInvitedOperator(input: {
    organizationId: string;
    operatorId: string;
    passwordHash: string;
    now: Date;
  }): Promise<ActivateInvitedOperatorResult>;
  cancelInvitedOperator(input: {
    organizationId: string;
    operatorId: string;
    now: Date;
  }): Promise<CancelInvitedOperatorResult>;
}

export interface AuthServiceConfig {
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  dummyPasswordHash: string;
}

export type AuthServiceErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "OPERATOR_EMAIL_CONFLICT"
  | "LAST_ACTIVE_ADMIN"
  | "OPERATOR_NOT_FOUND"
  | "OPERATOR_NOT_ACTIVATED"
  | "SERVICE_UNAVAILABLE";

export class AuthServiceError extends Error {
  constructor(
    readonly code: AuthServiceErrorCode,
    message: string,
    readonly status: number,
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AuthServiceDependencies {
  repository: AuthRepository;
  clock: Clock;
  random: OpaqueRandomSource;
  passwordHasher: PasswordHasher;
  sessionDigest: SecretDigest;
  csrfDigest: SecretDigest;
  bucketKeyer: LoginBucketKeyer;
  loginLimiter: LoginAttemptLimiter;
  audit: AuthAuditSink;
  config: AuthServiceConfig;
}

function permissionsForRole(role: OperatorRole): OperatorPermission[] {
  // The role grant is contract-owned so every surface reads one vocabulary.
  return permissionsForOperatorRole(role);
}

function toSessionResponse(actor: AuthenticatedActor): AuthSessionResponse {
  return {
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
    permissions: [...actor.permissions],
    csrfToken: actor.csrfToken,
  };
}

function assertAdmin(actor: AuthenticatedActor): void {
  if (actor.role !== "admin") {
    throw new AuthServiceError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    );
  }
}

export class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {
    if (dependencies.passwordHasher.algorithm !== "argon2id") {
      throw new Error("AuthService requires an Argon2id password hasher.");
    }
    if (
      dependencies.config.sessionIdleMs <= 0 ||
      dependencies.config.sessionAbsoluteMs < dependencies.config.sessionIdleMs
    ) {
      throw new Error("Session expiry configuration is invalid.");
    }
  }

  async login(input: {
    normalizedEmail: string;
    password: string;
    networkIdentifier: string;
    previousSessionToken?: string;
  }): Promise<{ sessionToken: string; session: AuthSessionResponse }> {
    const now = this.dependencies.clock.now();
    const keyedBuckets = this.dependencies.bucketKeyer.keys({
      normalizedEmail: input.normalizedEmail,
      networkIdentifier: input.networkIdentifier,
    });
    const bucketKeys = [keyedBuckets.account, keyedBuckets.network];
    const existingRetryAt = await this.dependencies.loginLimiter.retryAt(
      bucketKeys,
      now,
    );
    if (existingRetryAt) {
      throw new AuthServiceError(
        "RATE_LIMITED",
        "Too many sign-in attempts. Try again later.",
        429,
        existingRetryAt,
      );
    }

    const operator = await this.dependencies.repository.findOperatorForLogin(
      input.normalizedEmail,
    );
    let verified = false;
    try {
      verified = await this.dependencies.passwordHasher.verify(
        operator?.passwordHash ?? this.dependencies.config.dummyPasswordHash,
        input.password,
      );
    } catch {
      throw new AuthServiceError(
        "SERVICE_UNAVAILABLE",
        "The authentication service is temporarily unavailable.",
        503,
      );
    }

    if (!operator || !verified || operator.state !== "active") {
      const retryAt = await this.dependencies.loginLimiter.recordFailure(
        bucketKeys,
        now,
      );
      await this.dependencies.audit.append({
        organizationId: operator?.organizationId ?? null,
        actorId: null,
        action: "auth.login",
        subjectId: operator?.id ?? null,
        outcome: retryAt ? "blocked" : "failure",
        occurredAt: now,
        metadata: {},
      });
      if (retryAt) {
        throw new AuthServiceError(
          "RATE_LIMITED",
          "Too many sign-in attempts. Try again later.",
          429,
          retryAt,
        );
      }
      throw new AuthServiceError(
        "INVALID_CREDENTIALS",
        "We couldn't sign you in. Check your details and try again.",
        401,
      );
    }

    const sessionToken = this.dependencies.random.token(32);
    const csrfToken = this.csrfTokenForSession(sessionToken);
    const sessionId = this.dependencies.random.id();
    const absoluteExpiresAt = new Date(
      now.getTime() + this.dependencies.config.sessionAbsoluteMs,
    );
    const idleExpiresAt = new Date(
      Math.min(
        absoluteExpiresAt.getTime(),
        now.getTime() + this.dependencies.config.sessionIdleMs,
      ),
    );
    await this.dependencies.repository.rotateSession({
      previousTokenHash: input.previousSessionToken
        ? this.dependencies.sessionDigest.digest(input.previousSessionToken)
        : null,
      session: {
        id: sessionId,
        operatorId: operator.id,
        tokenHash: this.dependencies.sessionDigest.digest(sessionToken),
        csrfHash: this.dependencies.csrfDigest.digest(csrfToken),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      },
    });
    // A valid account may clear its own failures, but must never reset the
    // shared network spray-defense bucket for other identities.
    await this.dependencies.loginLimiter.clear([keyedBuckets.account]);
    await this.dependencies.audit.append({
      organizationId: operator.organizationId,
      actorId: operator.id,
      action: "auth.login",
      subjectId: operator.id,
      outcome: "success",
      occurredAt: now,
      metadata: {},
    });

    const actor: AuthenticatedActor = {
      sessionId,
      operatorId: operator.id,
      organizationId: operator.organizationId,
      organizationName: operator.organizationName,
      email: operator.emailNormalized,
      displayName: operator.displayName,
      state: "active",
      role: operator.role,
      permissions: permissionsForRole(operator.role),
      csrfToken,
    };
    return { sessionToken, session: toSessionResponse(actor) };
  }

  async resolveSession(input: {
    sessionToken: string | undefined;
    csrfToken?: string;
  }): Promise<AuthenticatedActor> {
    return this.resolveAuthoritativeSession(input, true);
  }

  private async resolveAuthoritativeSession(
    input: {
      sessionToken: string | undefined;
      csrfToken?: string;
    },
    allowSessionWrites: boolean,
  ): Promise<AuthenticatedActor> {
    if (!input.sessionToken) {
      throw new AuthServiceError(
        "AUTH_REQUIRED",
        "Sign in to continue.",
        401,
      );
    }
    const now = this.dependencies.clock.now();
    const tokenHash = this.dependencies.sessionDigest.digest(input.sessionToken);
    const record = await this.dependencies.repository.findAuthoritativeSession(
      tokenHash,
      now,
    );
    if (!record || record.state !== "active") {
      if (record && allowSessionWrites) {
        await this.dependencies.repository.revokeSessionByTokenHash(tokenHash, now);
      }
      throw new AuthServiceError(
        "AUTH_REQUIRED",
        "Your session ended. Sign in again to continue.",
        401,
      );
    }
    if (
      input.csrfToken !== undefined &&
      !this.dependencies.csrfDigest.matches(input.csrfToken, record.csrfHash)
    ) {
      throw new AuthServiceError(
        "FORBIDDEN",
        "The request could not be verified.",
        403,
      );
    }

    const idleExpiresAt = new Date(
      Math.min(
        record.absoluteExpiresAt.getTime(),
        now.getTime() + this.dependencies.config.sessionIdleMs,
      ),
    );
    if (allowSessionWrites) {
      await this.dependencies.repository.refreshSession({
        sessionId: record.sessionId,
        lastSeenAt: now,
        idleExpiresAt,
      });
    }
    return {
      sessionId: record.sessionId,
      operatorId: record.operatorId,
      organizationId: record.organizationId,
      organizationName: record.organizationName,
      email: record.emailNormalized,
      displayName: record.displayName,
      state: "active",
      role: record.role,
      permissions: permissionsForRole(record.role),
      csrfToken: input.csrfToken ?? "",
    };
  }

  sessionResponse(actor: AuthenticatedActor, csrfToken: string): AuthSessionResponse {
    return toSessionResponse({ ...actor, csrfToken });
  }

  async bootstrapSession(
    sessionToken: string | undefined,
  ): Promise<{ actor: AuthenticatedActor; session: AuthSessionResponse }> {
    const csrfToken = sessionToken
      ? this.csrfTokenForSession(sessionToken)
      : undefined;
    const actor = await this.resolveAuthoritativeSession(
      { sessionToken, csrfToken },
      false,
    );
    return {
      actor,
      session: toSessionResponse(actor),
    };
  }

  private csrfTokenForSession(sessionToken: string): string {
    // The production digest is a purpose-separated HMAC. This gives every tab
    // the same CSRF token without exposing the HttpOnly session token or
    // requiring a state-changing session bootstrap.
    return this.dependencies.csrfDigest.digest(sessionToken);
  }

  requirePermission(
    actor: AuthenticatedActor,
    permission: OperatorPermission,
  ): void {
    if (!actor.permissions.includes(permission)) {
      throw new AuthServiceError(
        "FORBIDDEN",
        "You do not have permission to perform this action.",
        403,
      );
    }
  }

  async logout(actor: AuthenticatedActor, sessionToken: string): Promise<void> {
    const now = this.dependencies.clock.now();
    await this.dependencies.repository.revokeSessionByTokenHash(
      this.dependencies.sessionDigest.digest(sessionToken),
      now,
    );
    await this.dependencies.audit.append({
      organizationId: actor.organizationId,
      actorId: actor.operatorId,
      action: "auth.logout",
      subjectId: actor.operatorId,
      outcome: "success",
      occurredAt: now,
      metadata: {},
    });
  }

  async listOperators(
    actor: AuthenticatedActor,
    query: ListOperatorsQuery,
  ): Promise<OperatorListResponse> {
    assertAdmin(actor);
    return this.dependencies.repository.listOperators(actor.organizationId, query);
  }

  /**
   * Creates an operator by invitation: an address, a name, and a role, and no
   * credential at all. The account exists so it can carry its role and appear
   * in the access ledger, and it holds `pending` until the invited person
   * proves control of the mailbox — until then every authentication path
   * refuses it for its state. Issuing and mailing the one-time link is the
   * caller's separate, atomic step; this method never sees token material.
   */
  async inviteOperator(
    actor: AuthenticatedActor,
    input: NormalizedInviteOperatorRequest,
  ): Promise<OperatorMutationResponse> {
    assertAdmin(actor);
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.repository.provisionOperator({
      id: this.dependencies.random.id(),
      organizationId: actor.organizationId,
      emailNormalized: input.email,
      displayName: input.displayName,
      passwordHash: null,
      role: input.role,
      state: "pending",
      now,
    });
    if (result.kind === "email_conflict") {
      await this.dependencies.audit.append({
        organizationId: actor.organizationId,
        actorId: actor.operatorId,
        action: "operator.invite",
        subjectId: null,
        outcome: "failure",
        occurredAt: now,
        metadata: { reason: "email_conflict" },
      });
      throw new AuthServiceError(
        "OPERATOR_EMAIL_CONFLICT",
        "An operator with that email already exists.",
        409,
      );
    }
    await this.dependencies.audit.append({
      organizationId: actor.organizationId,
      actorId: actor.operatorId,
      action: "operator.invite",
      subjectId: result.operator.id,
      outcome: "success",
      occurredAt: now,
      metadata: { role: result.operator.role },
    });
    return { operator: result.operator };
  }

  /**
   * The redemption-time eligibility recheck for an invitation link: the
   * account the token was bound to still exists, still holds the address the
   * link was mailed to, and is still waiting to be activated. Consulted
   * before the token is consumed, so an invitation cancelled after issuance
   * is refused without spending the link — and so a link can never activate
   * an account that already works.
   */
  async isOperatorEligibleForInvitation(
    operatorId: string,
    addressNormalized: string,
  ): Promise<boolean> {
    const operator = await this.dependencies.repository.findOperatorForLogin(
      addressNormalized,
    );
    return (
      operator !== null &&
      operator.id === operatorId &&
      operator.state === "pending"
    );
  }

  /**
   * Completes a mailbox-proven invitation: hashes the chosen password with
   * the same hasher administrator-set passwords use and applies it through
   * the one repository transition that leaves `pending`, guarded on that
   * state inside the write. The password is expected to have passed the
   * managed password rules at the boundary; this method defines no policy of
   * its own. Audit carries identifiers and a closed outcome, never the
   * password or any token material.
   */
  async activateInvitedOperator(input: {
    operatorId: string;
    addressNormalized: string;
    newPassword: string;
  }): Promise<OperatorMutationResponse> {
    const now = this.dependencies.clock.now();
    const operator = await this.dependencies.repository.findOperatorForLogin(
      input.addressNormalized,
    );
    if (
      !operator ||
      operator.id !== input.operatorId ||
      operator.state !== "pending"
    ) {
      await this.dependencies.audit.append({
        organizationId: operator?.organizationId ?? null,
        actorId: null,
        action: "operator.invitation_accept",
        subjectId: input.operatorId,
        outcome: "blocked",
        occurredAt: now,
        metadata: { reason: "subject_ineligible" },
      });
      throw new AuthServiceError(
        "FORBIDDEN",
        "The request could not be verified.",
        403,
      );
    }
    const passwordHash = await this.dependencies.passwordHasher.hash(
      input.newPassword,
    );
    const result = await this.dependencies.repository.activateInvitedOperator({
      organizationId: operator.organizationId,
      operatorId: operator.id,
      passwordHash,
      now,
    });
    if (result.kind !== "activated") {
      // Lost the race with a cancellation or a concurrent redemption. The
      // caller maps this to the one uniform invalid-link outcome.
      await this.dependencies.audit.append({
        organizationId: operator.organizationId,
        actorId: null,
        action: "operator.invitation_accept",
        subjectId: operator.id,
        outcome: "blocked",
        occurredAt: now,
        metadata: { reason: "subject_ineligible" },
      });
      throw new AuthServiceError(
        "FORBIDDEN",
        "The request could not be verified.",
        403,
      );
    }
    await this.dependencies.audit.append({
      organizationId: operator.organizationId,
      actorId: operator.id,
      action: "operator.invitation_accept",
      subjectId: operator.id,
      outcome: "success",
      occurredAt: now,
      metadata: { fields: ["credential", "state"] },
    });
    return { operator: result.operator };
  }

  /**
   * Withdraws an invitation. The account moves to the terminal `cancelled`
   * state — refused by every authentication path and by every ordinary
   * update — and the caller invalidates its outstanding link separately.
   * Only a `pending` account can be cancelled, so this can never be a
   * shortcut around the last-active-administrator protection.
   */
  async cancelInvitedOperator(
    actor: AuthenticatedActor,
    operatorId: string,
  ): Promise<OperatorMutationResponse> {
    assertAdmin(actor);
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.repository.cancelInvitedOperator({
      organizationId: actor.organizationId,
      operatorId,
      now,
    });
    if (result.kind !== "cancelled") {
      await this.dependencies.audit.append({
        organizationId: actor.organizationId,
        actorId: actor.operatorId,
        action: "operator.invitation_cancel",
        subjectId: operatorId,
        outcome: "failure",
        occurredAt: now,
        metadata: { reason: "not_pending" },
      });
      throw new AuthServiceError(
        "OPERATOR_NOT_FOUND",
        "Operator not found.",
        404,
      );
    }
    await this.dependencies.audit.append({
      organizationId: actor.organizationId,
      actorId: actor.operatorId,
      action: "operator.invitation_cancel",
      subjectId: operatorId,
      outcome: "success",
      occurredAt: now,
      metadata: {},
    });
    return { operator: result.operator };
  }

  /**
   * Confirms an account is still awaiting activation before an administrator
   * reissues its invitation, and hands back the address the new link must be
   * mailed to — the account's own, never a caller-supplied one.
   */
  async resolvePendingOperatorForReissue(
    actor: AuthenticatedActor,
    operatorId: string,
  ): Promise<{ operatorId: string; email: string; displayName: string }> {
    assertAdmin(actor);
    const summary = await this.dependencies.repository.findOperatorById(
      actor.organizationId,
      operatorId,
    );
    if (!summary || summary.state !== "pending") {
      throw new AuthServiceError(
        "OPERATOR_NOT_FOUND",
        "Operator not found.",
        404,
      );
    }
    return {
      operatorId: summary.id,
      email: summary.email,
      displayName: summary.displayName,
    };
  }

  /**
   * The administrator-facing audit record for a reissue: who acted, which
   * account, and how it ended. The link's own issuance is audited separately
   * by the token mechanism; this is the operator-management trail, and like
   * every other entry here it carries identifiers and a closed outcome, never
   * an address, a link, or token material.
   */
  async recordInvitationReissue(
    actor: AuthenticatedActor,
    operatorId: string,
    outcome: "success" | "failure" | "blocked",
  ): Promise<void> {
    assertAdmin(actor);
    await this.dependencies.audit.append({
      organizationId: actor.organizationId,
      actorId: actor.operatorId,
      action: "operator.invitation_reissue",
      subjectId: operatorId,
      outcome,
      occurredAt: this.dependencies.clock.now(),
      metadata: {},
    });
  }

  async updateOperator(
    actor: AuthenticatedActor,
    operatorId: string,
    input: NormalizedUpdateOperatorRequest,
  ): Promise<OperatorMutationResponse> {
    assertAdmin(actor);
    const now = this.dependencies.clock.now();
    const passwordHash = input.password
      ? await this.dependencies.passwordHasher.hash(input.password)
      : undefined;
    const result = await this.dependencies.repository.updateOperator({
      organizationId: actor.organizationId,
      operatorId,
      displayName: input.displayName,
      passwordHash,
      role: input.role,
      state: input.state,
      now,
    });
    if (result.kind === "not_found") {
      throw new AuthServiceError(
        "OPERATOR_NOT_FOUND",
        "Operator not found.",
        404,
      );
    }
    if (result.kind === "not_activated") {
      // An unredeemed invitation is not an account to administer. Refusing
      // here is what keeps an administrator — or a password reset, which
      // takes the same repository path — from turning a pending account into
      // a usable one without its invitation being redeemed.
      await this.dependencies.audit.append({
        organizationId: actor.organizationId,
        actorId: actor.operatorId,
        action: "operator.update",
        subjectId: operatorId,
        outcome: "blocked",
        occurredAt: now,
        metadata: { reason: "not_activated" },
      });
      throw new AuthServiceError(
        "OPERATOR_NOT_ACTIVATED",
        "This operator has not accepted their invitation yet. Reissue or cancel the invitation instead.",
        409,
      );
    }
    if (result.kind === "last_active_admin") {
      await this.dependencies.audit.append({
        organizationId: actor.organizationId,
        actorId: actor.operatorId,
        action: "operator.update",
        subjectId: operatorId,
        outcome: "blocked",
        occurredAt: now,
        metadata: { reason: "last_active_admin" },
      });
      throw new AuthServiceError(
        "LAST_ACTIVE_ADMIN",
        "The last active administrator cannot be disabled or reassigned.",
        409,
      );
    }

    const changedFields = Object.keys(input).filter(
      (field) => field !== "password",
    );
    if (input.password) changedFields.push("credential");
    await this.dependencies.audit.append({
      organizationId: actor.organizationId,
      actorId: actor.operatorId,
      action: "operator.update",
      subjectId: operatorId,
      outcome: "success",
      occurredAt: now,
      metadata: { fields: changedFields },
    });
    return { operator: result.operator };
  }

  /**
   * Resolves the operator a self-service password reset may be issued for:
   * the account holding this normalized address, only while it is active. A
   * disabled or unknown address resolves to nothing, and the caller's
   * request path (messaging/008's `requestIssuance`) makes that outcome
   * indistinguishable from a successful one.
   */
  async resolveActiveOperatorIdByEmail(
    normalizedEmail: string,
  ): Promise<string | null> {
    const operator = await this.dependencies.repository.findOperatorForLogin(
      normalizedEmail,
    );
    return operator !== null && operator.state === "active"
      ? operator.id
      : null;
  }

  /**
   * The redemption-time eligibility recheck for a password reset link: the
   * operator the token was bound to still exists, still holds the address
   * the link was mailed to, and is still active. Consulted before the token
   * is consumed, so a subject disabled after issuance is refused without
   * spending the link.
   */
  async isOperatorEligibleForPasswordReset(
    operatorId: string,
    addressNormalized: string,
  ): Promise<boolean> {
    const operator = await this.dependencies.repository.findOperatorForLogin(
      addressNormalized,
    );
    return (
      operator !== null &&
      operator.id === operatorId &&
      operator.state === "active"
    );
  }

  /**
   * Completes a mailbox-proven password reset: hashes the new password with
   * the same hasher administrator-set passwords use, and applies it through
   * the same repository update that atomically revokes every one of the
   * operator's active sessions — so a reset performed because of a suspected
   * compromise actually ends the intruder's access. The new password is
   * expected to have passed the managed password rules at the boundary; this
   * method defines no policy of its own. Audit carries identifiers and a
   * closed outcome, never the password or any token material.
   */
  async completePasswordReset(input: {
    operatorId: string;
    addressNormalized: string;
    newPassword: string;
  }): Promise<void> {
    const now = this.dependencies.clock.now();
    const operator = await this.dependencies.repository.findOperatorForLogin(
      input.addressNormalized,
    );
    if (
      !operator ||
      operator.id !== input.operatorId ||
      operator.state !== "active"
    ) {
      await this.dependencies.audit.append({
        organizationId: operator?.organizationId ?? null,
        actorId: null,
        action: "operator.password_reset",
        subjectId: input.operatorId,
        outcome: "blocked",
        occurredAt: now,
        metadata: { reason: "subject_ineligible" },
      });
      throw new AuthServiceError(
        "FORBIDDEN",
        "The request could not be verified.",
        403,
      );
    }
    const passwordHash = await this.dependencies.passwordHasher.hash(
      input.newPassword,
    );
    const result = await this.dependencies.repository.updateOperator({
      organizationId: operator.organizationId,
      operatorId: operator.id,
      passwordHash,
      now,
    });
    if (result.kind !== "updated") {
      await this.dependencies.audit.append({
        organizationId: operator.organizationId,
        actorId: null,
        action: "operator.password_reset",
        subjectId: operator.id,
        outcome: "failure",
        occurredAt: now,
        metadata: { reason: "update_unavailable" },
      });
      throw new AuthServiceError(
        "SERVICE_UNAVAILABLE",
        "The authentication service is temporarily unavailable.",
        503,
      );
    }
    await this.dependencies.audit.append({
      organizationId: operator.organizationId,
      actorId: operator.id,
      action: "operator.password_reset",
      subjectId: operator.id,
      outcome: "success",
      occurredAt: now,
      metadata: { fields: ["credential"] },
    });
  }
}

interface RateBucket {
  failures: number[];
  blockedUntil: number | null;
}

/**
 * A bounded, process-local limiter for isolated tests and single-process tools.
 * Its buckets are neither durable nor coordinated across replicas. Deployments
 * that can restart or scale horizontally must inject a shared
 * `LoginAttemptLimiter`; the admin runtime uses its database-backed limiter.
 */
export class BoundedLoginAttemptLimiter implements LoginAttemptLimiter {
  // Map insertion order is the LRU queue: touches move a bucket to the tail,
  // so the head can be evicted in O(1) amortized time.
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly options: {
      windowMs: number;
      blockMs: number;
      maximumFailures: number;
      maximumBuckets: number;
    },
  ) {
    if (
      options.windowMs <= 0 ||
      options.blockMs <= 0 ||
      options.maximumFailures <= 0 ||
      options.maximumBuckets <= 0
    ) {
      throw new Error("Rate limiter configuration must be positive.");
    }
  }

  async retryAt(bucketKeys: readonly string[], now: Date): Promise<Date | null> {
    const nowMs = now.getTime();
    let latestBlock = 0;
    for (const key of new Set(bucketKeys)) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      this.prune(bucket, nowMs);
      this.markMostRecentlyUsed(key, bucket);
      latestBlock = Math.max(latestBlock, bucket.blockedUntil ?? 0);
    }
    return latestBlock > nowMs ? new Date(latestBlock) : null;
  }

  async recordFailure(
    bucketKeys: readonly string[],
    now: Date,
  ): Promise<Date | null> {
    const nowMs = now.getTime();
    let latestBlock = 0;
    for (const key of new Set(bucketKeys)) {
      const bucket = this.getOrCreate(key);
      this.prune(bucket, nowMs);
      bucket.failures.push(nowMs);
      if (bucket.failures.length >= this.options.maximumFailures) {
        bucket.blockedUntil = nowMs + this.options.blockMs;
      }
      this.markMostRecentlyUsed(key, bucket);
      latestBlock = Math.max(latestBlock, bucket.blockedUntil ?? 0);
    }
    this.enforceBound();
    return latestBlock > nowMs ? new Date(latestBlock) : null;
  }

  async clear(bucketKeys: readonly string[]): Promise<void> {
    for (const key of new Set(bucketKeys)) this.buckets.delete(key);
  }

  private getOrCreate(key: string): RateBucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const created: RateBucket = {
      failures: [],
      blockedUntil: null,
    };
    this.buckets.set(key, created);
    return created;
  }

  private markMostRecentlyUsed(key: string, bucket: RateBucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
  }

  private prune(bucket: RateBucket, nowMs: number): void {
    const windowStart = nowMs - this.options.windowMs;
    bucket.failures = bucket.failures.filter((failure) => failure > windowStart);
    if (bucket.blockedUntil !== null && bucket.blockedUntil <= nowMs) {
      bucket.blockedUntil = null;
      bucket.failures = [];
    }
  }

  private enforceBound(): void {
    while (this.buckets.size > this.options.maximumBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }
}
