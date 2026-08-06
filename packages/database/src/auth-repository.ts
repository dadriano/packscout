import type {
  ListOperatorsQuery,
  OperatorListResponse,
  OperatorRole,
  OperatorState,
  OperatorSummary,
} from "@packscout/contracts";
import { and, asc, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import {
  authRateLimits,
  auditEvents,
  operatorMemberships,
  operators,
  operatorSessions,
  organizations,
} from "./schema/index.ts";
import { sanitizeAuthAuditMetadata } from "./security.ts";

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

export interface LoginOperatorRecord {
  id: string;
  organizationId: string;
  organizationName: string;
  emailNormalized: string;
  displayName: string;
  passwordHash: string;
  state: OperatorState;
  role: OperatorRole;
}

export interface AuthoritativeSessionRecord extends LoginOperatorRecord {
  sessionId: string;
  operatorId: string;
  csrfHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export type ProvisionOperatorResult =
  | { kind: "created"; operator: OperatorSummary }
  | { kind: "email_conflict" };

export type UpdateOperatorResult =
  | { kind: "updated"; operator: OperatorSummary }
  | { kind: "not_found" }
  | { kind: "last_active_admin" };

interface OperatorRow {
  id: string;
  email: string;
  displayName: string;
  state: OperatorState;
  role: OperatorRole;
  createdAt: Date;
  updatedAt: Date;
}

function toOperatorSummary(row: OperatorRow, lastAccessAt: Date | null): OperatorSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    state: row.state,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAccessAt: lastAccessAt?.toISOString() ?? null,
  };
}

export class DrizzleAuthRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async findOperatorForLogin(normalizedEmail: string): Promise<LoginOperatorRecord | null> {
    const [record] = await this.database
      .select({
        id: operators.id,
        organizationId: organizations.id,
        organizationName: organizations.name,
        emailNormalized: operators.emailNormalized,
        displayName: operators.displayName,
        passwordHash: operators.passwordHash,
        state: operators.state,
        role: operatorMemberships.role,
      })
      .from(operators)
      .innerJoin(operatorMemberships, eq(operatorMemberships.operatorId, operators.id))
      .innerJoin(organizations, eq(organizations.id, operatorMemberships.organizationId))
      .where(eq(operators.emailNormalized, normalizedEmail))
      .orderBy(asc(organizations.createdAt), asc(organizations.id))
      .limit(1);
    return record ?? null;
  }

  async rotateSession(input: {
    previousTokenHash: string | null;
    session: CreateSessionRecord;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      if (input.previousTokenHash) {
        await transaction
          .update(operatorSessions)
          .set({ revokedAt: input.session.createdAt })
          .where(
            and(
              eq(operatorSessions.tokenHash, input.previousTokenHash),
              isNull(operatorSessions.revokedAt),
            ),
          );
      }
      const [membership] = await transaction
        .select({ organizationId: operatorMemberships.organizationId })
        .from(operatorMemberships)
        .where(eq(operatorMemberships.operatorId, input.session.operatorId))
        .orderBy(asc(operatorMemberships.createdAt), asc(operatorMemberships.id))
        .limit(1);
      if (!membership) throw new Error("Cannot create a session without an organization membership.");
      await transaction.insert(operatorSessions).values({
        ...input.session,
        organizationId: membership.organizationId,
      });
    });
  }

  async findAuthoritativeSession(
    tokenHash: string,
    now: Date,
  ): Promise<AuthoritativeSessionRecord | null> {
    const [record] = await this.database
      .select({
        sessionId: operatorSessions.id,
        operatorId: operators.id,
        organizationId: organizations.id,
        organizationName: organizations.name,
        id: operators.id,
        emailNormalized: operators.emailNormalized,
        displayName: operators.displayName,
        passwordHash: operators.passwordHash,
        state: operators.state,
        role: operatorMemberships.role,
        csrfHash: operatorSessions.csrfHash,
        idleExpiresAt: operatorSessions.idleExpiresAt,
        absoluteExpiresAt: operatorSessions.absoluteExpiresAt,
      })
      .from(operatorSessions)
      .innerJoin(operators, eq(operators.id, operatorSessions.operatorId))
      .innerJoin(
        operatorMemberships,
        and(
          eq(operatorMemberships.operatorId, operators.id),
          eq(operatorMemberships.organizationId, operatorSessions.organizationId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, operatorSessions.organizationId))
      .where(
        and(
          eq(operatorSessions.tokenHash, tokenHash),
          isNull(operatorSessions.revokedAt),
          gt(operatorSessions.idleExpiresAt, now),
          gt(operatorSessions.absoluteExpiresAt, now),
        ),
      )
      .limit(1);
    return record ?? null;
  }

  async refreshSession(input: {
    sessionId: string;
    lastSeenAt: Date;
    idleExpiresAt: Date;
  }): Promise<void> {
    await this.database
      .update(operatorSessions)
      .set({ lastSeenAt: input.lastSeenAt, idleExpiresAt: input.idleExpiresAt })
      .where(and(eq(operatorSessions.id, input.sessionId), isNull(operatorSessions.revokedAt)));
  }

  async replaceSessionCsrf(input: { sessionId: string; csrfHash: string }): Promise<void> {
    await this.database
      .update(operatorSessions)
      .set({ csrfHash: input.csrfHash })
      .where(and(eq(operatorSessions.id, input.sessionId), isNull(operatorSessions.revokedAt)));
  }

  async revokeSessionByTokenHash(tokenHash: string, revokedAt: Date): Promise<void> {
    await this.database
      .update(operatorSessions)
      .set({ revokedAt })
      .where(and(eq(operatorSessions.tokenHash, tokenHash), isNull(operatorSessions.revokedAt)));
  }

  async revokeAllSessionsForOperator(operatorId: string, revokedAt: Date): Promise<void> {
    await this.database
      .update(operatorSessions)
      .set({ revokedAt })
      .where(and(eq(operatorSessions.operatorId, operatorId), isNull(operatorSessions.revokedAt)));
  }

  async listOperators(
    organizationId: string,
    query: ListOperatorsQuery,
  ): Promise<OperatorListResponse> {
    const filters = [eq(operatorMemberships.organizationId, organizationId)];
    if (query.cursor) filters.push(gt(operators.id, query.cursor));
    if (query.role) filters.push(eq(operatorMemberships.role, query.role));
    if (query.state) filters.push(eq(operators.state, query.state));
    if (query.search) {
      const search = `%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      filters.push(or(ilike(operators.emailNormalized, search), ilike(operators.displayName, search))!);
    }

    const records = await this.database
      .select({
        id: operators.id,
        email: operators.emailNormalized,
        displayName: operators.displayName,
        state: operators.state,
        role: operatorMemberships.role,
        createdAt: operators.createdAt,
        updatedAt: operators.updatedAt,
      })
      .from(operatorMemberships)
      .innerJoin(operators, eq(operators.id, operatorMemberships.operatorId))
      .where(and(...filters))
      .orderBy(asc(operators.id))
      .limit(query.limit + 1);
    const visible = records.slice(0, query.limit);
    const lastAccess = await this.lastAccessByOperator(visible.map((record) => record.id));
    return {
      items: visible.map((record) => toOperatorSummary(record, lastAccess.get(record.id) ?? null)),
      nextCursor: records.length > query.limit ? visible.at(-1)?.id ?? null : null,
    };
  }

  async provisionOperator(input: {
    id: string;
    organizationId: string;
    emailNormalized: string;
    displayName: string;
    passwordHash: string;
    role: OperatorRole;
    state: "active";
    now: Date;
  }): Promise<ProvisionOperatorResult> {
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(operators)
        .values({
          id: input.id,
          emailNormalized: input.emailNormalized,
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          state: input.state,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({ target: operators.emailNormalized })
        .returning({ id: operators.id });
      if (inserted.length === 0) return { kind: "email_conflict" };
      await transaction.insert(operatorMemberships).values({
        organizationId: input.organizationId,
        operatorId: input.id,
        role: input.role,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return {
        kind: "created",
        operator: toOperatorSummary(
          {
            id: input.id,
            email: input.emailNormalized,
            displayName: input.displayName,
            state: input.state,
            role: input.role,
            createdAt: input.now,
            updatedAt: input.now,
          },
          null,
        ),
      };
    });
  }

  async updateOperator(input: {
    organizationId: string;
    operatorId: string;
    displayName?: string;
    passwordHash?: string;
    role?: OperatorRole;
    state?: OperatorState;
    now: Date;
  }): Promise<UpdateOperatorResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${organizations} where ${organizations.id} = ${input.organizationId} for update`,
      );
      const [target] = await transaction
        .select({
          id: operators.id,
          email: operators.emailNormalized,
          displayName: operators.displayName,
          state: operators.state,
          role: operatorMemberships.role,
          createdAt: operators.createdAt,
          updatedAt: operators.updatedAt,
        })
        .from(operatorMemberships)
        .innerJoin(operators, eq(operators.id, operatorMemberships.operatorId))
        .where(
          and(
            eq(operatorMemberships.organizationId, input.organizationId),
            eq(operators.id, input.operatorId),
          ),
        )
        .limit(1);
      if (!target) return { kind: "not_found" };

      const removesActiveAdmin =
        target.role === "admin" &&
        target.state === "active" &&
        (input.role === "data_operator" || input.state === "disabled");
      if (removesActiveAdmin) {
        const [activeAdminCount] = await transaction
          .select({ count: sql<number>`count(*)::integer` })
          .from(operatorMemberships)
          .innerJoin(operators, eq(operators.id, operatorMemberships.operatorId))
          .where(
            and(
              eq(operatorMemberships.organizationId, input.organizationId),
              eq(operatorMemberships.role, "admin"),
              eq(operators.state, "active"),
            ),
          );
        if ((activeAdminCount?.count ?? 0) <= 1) return { kind: "last_active_admin" };
      }

      await transaction
        .update(operators)
        .set({
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.passwordHash === undefined ? {} : { passwordHash: input.passwordHash }),
          ...(input.state === undefined ? {} : { state: input.state }),
          updatedAt: input.now,
        })
        .where(eq(operators.id, input.operatorId));
      if (input.role !== undefined) {
        await transaction
          .update(operatorMemberships)
          .set({ role: input.role, updatedAt: input.now })
          .where(
            and(
              eq(operatorMemberships.organizationId, input.organizationId),
              eq(operatorMemberships.operatorId, input.operatorId),
            ),
          );
      }
      if (input.passwordHash !== undefined || input.role !== undefined || input.state !== undefined) {
        await transaction
          .update(operatorSessions)
          .set({ revokedAt: input.now })
          .where(and(eq(operatorSessions.operatorId, input.operatorId), isNull(operatorSessions.revokedAt)));
      }
      return {
        kind: "updated",
        operator: toOperatorSummary(
          {
            ...target,
            displayName: input.displayName ?? target.displayName,
            state: input.state ?? target.state,
            role: input.role ?? target.role,
            updatedAt: input.now,
          },
          await this.lastAccessForOperator(transaction, input.operatorId),
        ),
      };
    });
  }

  private async lastAccessByOperator(operatorIds: readonly string[]): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    for (const operatorId of operatorIds) {
      const access = await this.lastAccessForOperator(this.database, operatorId);
      if (access) result.set(operatorId, access);
    }
    return result;
  }

  private async lastAccessForOperator(
    database: PackscoutDatabase<TQueryResult>,
    operatorId: string,
  ): Promise<Date | null> {
    const [record] = await database
      .select({ lastSeenAt: operatorSessions.lastSeenAt })
      .from(operatorSessions)
      .where(eq(operatorSessions.operatorId, operatorId))
      .orderBy(desc(operatorSessions.lastSeenAt))
      .limit(1);
    return record?.lastSeenAt ?? null;
  }
}

export interface AuthAuditEventInput {
  organizationId: string | null;
  actorId: string | null;
  action: "auth.login" | "auth.logout" | "operator.provision" | "operator.update";
  subjectId: string | null;
  outcome: "success" | "failure" | "blocked";
  occurredAt: Date;
  metadata: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export class DrizzleAuthAuditSink<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async append(event: AuthAuditEventInput): Promise<void> {
    await this.database.insert(auditEvents).values({
      organizationId: event.organizationId,
      actorKey: event.actorId ?? "anonymous",
      action: event.action,
      subjectType: event.action.startsWith("operator.") ? "operator" : "session",
      subjectId: event.subjectId,
      outcome: event.outcome,
      metadataJson: sanitizeAuthAuditMetadata(event.metadata),
      occurredAt: event.occurredAt,
    });
  }
}

export class DatabaseLoginAttemptLimiter<TQueryResult extends PgQueryResultHKT> {
  constructor(
    private readonly database: PackscoutDatabase<TQueryResult>,
    private readonly options: {
      windowMs: number;
      blockMs: number;
      maximumFailures: number;
    },
  ) {
    if (options.windowMs <= 0 || options.blockMs <= 0 || options.maximumFailures <= 0) {
      throw new Error("Rate limiter configuration must be positive.");
    }
  }

  async retryAt(bucketKeys: readonly string[], now: Date): Promise<Date | null> {
    let latest: Date | null = null;
    for (const bucketKey of new Set(bucketKeys)) {
      const [record] = await this.database
        .select({ blockedUntil: authRateLimits.blockedUntil })
        .from(authRateLimits)
        .where(eq(authRateLimits.bucketKey, bucketKey))
        .limit(1);
      if (record?.blockedUntil && record.blockedUntil > now && (!latest || record.blockedUntil > latest)) {
        latest = record.blockedUntil;
      }
    }
    return latest;
  }

  async recordFailure(bucketKeys: readonly string[], now: Date): Promise<Date | null> {
    return this.database.transaction(async (transaction) => {
      let latest: Date | null = null;
      for (const bucketKey of new Set(bucketKeys)) {
        await transaction
          .insert(authRateLimits)
          .values({ bucketKey, windowStartedAt: now, attemptCount: 0, updatedAt: now })
          .onConflictDoNothing();
        const [bucket] = await transaction
          .select()
          .from(authRateLimits)
          .where(eq(authRateLimits.bucketKey, bucketKey))
          .for("update")
          .limit(1);
        if (!bucket) continue;
        const inWindow = now.getTime() - bucket.windowStartedAt.getTime() < this.options.windowMs;
        const attemptCount = (inWindow ? bucket.attemptCount : 0) + 1;
        const blockedUntil =
          attemptCount >= this.options.maximumFailures
            ? new Date(now.getTime() + this.options.blockMs)
            : bucket.blockedUntil && bucket.blockedUntil > now
              ? bucket.blockedUntil
              : null;
        await transaction
          .update(authRateLimits)
          .set({
            windowStartedAt: inWindow ? bucket.windowStartedAt : now,
            attemptCount,
            blockedUntil,
            updatedAt: now,
          })
          .where(eq(authRateLimits.bucketKey, bucketKey));
        if (blockedUntil && (!latest || blockedUntil > latest)) latest = blockedUntil;
      }
      return latest;
    });
  }

  async clear(bucketKeys: readonly string[]): Promise<void> {
    for (const bucketKey of new Set(bucketKeys)) {
      await this.database.delete(authRateLimits).where(eq(authRateLimits.bucketKey, bucketKey));
    }
  }
}
