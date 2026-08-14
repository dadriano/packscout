import type {
  ListOperatorsQuery,
  OperatorListResponse,
  OperatorRole,
  OperatorState,
  OperatorSummary,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
import { isPrismaUniqueConstraintError } from "./prisma-error.ts";
import type {
  PackscoutPrismaClient,
  PackscoutQueryClient,
} from "./database.ts";
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

interface LockedRateLimitRow {
  bucket_key: string;
  window_started_at: Date;
  attempt_count: number;
  blocked_until: Date | null;
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

export class PrismaAuthRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async findOperatorForLogin(normalizedEmail: string): Promise<LoginOperatorRecord | null> {
    const membership = await this.database.operator_memberships.findFirst({
      where: { operators: { email_normalized: normalizedEmail } },
      orderBy: [
        { organizations: { created_at: "asc" } },
        { organizations: { id: "asc" } },
      ],
      select: {
        organization_id: true,
        role: true,
        organizations: { select: { name: true } },
        operators: {
          select: {
            id: true,
            email_normalized: true,
            display_name: true,
            password_hash: true,
            state: true,
          },
        },
      },
    });
    if (!membership) return null;
    return {
      id: membership.operators.id,
      organizationId: membership.organization_id,
      organizationName: membership.organizations.name,
      emailNormalized: membership.operators.email_normalized,
      displayName: membership.operators.display_name,
      passwordHash: membership.operators.password_hash,
      state: membership.operators.state,
      role: membership.role,
    };
  }

  async rotateSession(input: {
    previousTokenHash: string | null;
    session: CreateSessionRecord;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      if (input.previousTokenHash) {
        await transaction.operator_sessions.updateMany({
          where: {
            token_hash: input.previousTokenHash,
            revoked_at: null,
          },
          data: { revoked_at: input.session.createdAt },
        });
      }
      const membership = await transaction.operator_memberships.findFirst({
        where: { operator_id: input.session.operatorId },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        select: { organization_id: true },
      });
      if (!membership) {
        throw new Error("Cannot create a session without an organization membership.");
      }
      await transaction.operator_sessions.create({
        data: {
          id: input.session.id,
          organization_id: membership.organization_id,
          operator_id: input.session.operatorId,
          token_hash: input.session.tokenHash,
          csrf_hash: input.session.csrfHash,
          created_at: input.session.createdAt,
          last_seen_at: input.session.lastSeenAt,
          idle_expires_at: input.session.idleExpiresAt,
          absolute_expires_at: input.session.absoluteExpiresAt,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async findAuthoritativeSession(
    tokenHash: string,
    now: Date,
  ): Promise<AuthoritativeSessionRecord | null> {
    const session = await this.database.operator_sessions.findFirst({
      where: {
        token_hash: tokenHash,
        revoked_at: null,
        idle_expires_at: { gt: now },
        absolute_expires_at: { gt: now },
      },
      select: {
        id: true,
        csrf_hash: true,
        idle_expires_at: true,
        absolute_expires_at: true,
        organizations: { select: { id: true, name: true } },
        operators: {
          select: {
            id: true,
            email_normalized: true,
            display_name: true,
            password_hash: true,
            state: true,
          },
        },
        operator_memberships: { select: { role: true } },
      },
    });
    if (!session) return null;
    return {
      sessionId: session.id,
      operatorId: session.operators.id,
      id: session.operators.id,
      organizationId: session.organizations.id,
      organizationName: session.organizations.name,
      emailNormalized: session.operators.email_normalized,
      displayName: session.operators.display_name,
      passwordHash: session.operators.password_hash,
      state: session.operators.state,
      role: session.operator_memberships.role,
      csrfHash: session.csrf_hash,
      idleExpiresAt: session.idle_expires_at,
      absoluteExpiresAt: session.absolute_expires_at,
    };
  }

  async refreshSession(input: {
    sessionId: string;
    lastSeenAt: Date;
    idleExpiresAt: Date;
  }): Promise<void> {
    await this.database.operator_sessions.updateMany({
      where: { id: input.sessionId, revoked_at: null },
      data: {
        last_seen_at: input.lastSeenAt,
        idle_expires_at: input.idleExpiresAt,
      },
    });
  }

  async revokeSessionByTokenHash(tokenHash: string, revokedAt: Date): Promise<void> {
    await this.database.operator_sessions.updateMany({
      where: { token_hash: tokenHash, revoked_at: null },
      data: { revoked_at: revokedAt },
    });
  }

  async revokeAllSessionsForOperator(operatorId: string, revokedAt: Date): Promise<void> {
    await this.database.operator_sessions.updateMany({
      where: { operator_id: operatorId, revoked_at: null },
      data: { revoked_at: revokedAt },
    });
  }

  async listOperators(
    organizationId: string,
    query: ListOperatorsQuery,
  ): Promise<OperatorListResponse> {
    const memberships = await this.database.operator_memberships.findMany({
      where: {
        organization_id: organizationId,
        ...(query.role ? { role: query.role } : {}),
        operators: {
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          ...(query.state ? { state: query.state } : {}),
          ...(query.search
            ? {
                OR: [
                  { email_normalized: { contains: query.search, mode: "insensitive" } },
                  { display_name: { contains: query.search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
      },
      orderBy: { operators: { id: "asc" } },
      take: query.limit + 1,
      select: {
        role: true,
        operators: {
          select: {
            id: true,
            email_normalized: true,
            display_name: true,
            state: true,
            created_at: true,
            updated_at: true,
          },
        },
      },
    });
    const visible = memberships.slice(0, query.limit);
    const lastAccess = await this.lastAccessByOperator(
      visible.map(({ operators: operator }) => operator.id),
    );
    return {
      items: visible.map(({ role, operators: operator }) =>
        toOperatorSummary(
          {
            id: operator.id,
            email: operator.email_normalized,
            displayName: operator.display_name,
            state: operator.state,
            role,
            createdAt: operator.created_at,
            updatedAt: operator.updated_at,
          },
          lastAccess.get(operator.id) ?? null,
        ),
      ),
      nextCursor:
        memberships.length > query.limit
          ? visible.at(-1)?.operators.id ?? null
          : null,
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
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.operators.create({
          data: {
            id: input.id,
            email_normalized: input.emailNormalized,
            display_name: input.displayName,
            password_hash: input.passwordHash,
            state: input.state,
            created_at: input.now,
            updated_at: input.now,
          },
        });
        await transaction.operator_memberships.create({
          data: {
            organization_id: input.organizationId,
            operator_id: input.id,
            role: input.role,
            created_at: input.now,
            updated_at: input.now,
          },
        });
        return {
          kind: "created" as const,
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
      }, PACKSCOUT_TRANSACTION_OPTIONS);
    } catch (error) {
      if (
        isPrismaUniqueConstraintError(error, {
          fields: ["email_normalized"],
          constraintNames: ["operators_email_normalized_unique"],
        })
      ) {
        return { kind: "email_conflict" };
      }
      throw error;
    }
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
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`select id from organizations where id = ${input.organizationId}::uuid for update`,
      );
      const membership = await transaction.operator_memberships.findUnique({
        where: {
          organization_id_operator_id: {
            organization_id: input.organizationId,
            operator_id: input.operatorId,
          },
        },
        select: {
          role: true,
          operators: {
            select: {
              id: true,
              email_normalized: true,
              display_name: true,
              state: true,
              created_at: true,
              updated_at: true,
            },
          },
        },
      });
      if (!membership) return { kind: "not_found" };
      const target = {
        id: membership.operators.id,
        email: membership.operators.email_normalized,
        displayName: membership.operators.display_name,
        state: membership.operators.state,
        role: membership.role,
        createdAt: membership.operators.created_at,
        updatedAt: membership.operators.updated_at,
      };

      const removesActiveAdmin =
        target.role === "admin" &&
        target.state === "active" &&
        (input.role === "data_operator" || input.state === "disabled");
      if (removesActiveAdmin) {
        const activeAdminCount = await transaction.operator_memberships.count({
          where: {
            organization_id: input.organizationId,
            role: "admin",
            operators: { state: "active" },
          },
        });
        if (activeAdminCount <= 1) return { kind: "last_active_admin" };
      }

      await transaction.operators.update({
        where: { id: input.operatorId },
        data: {
          ...(input.displayName === undefined
            ? {}
            : { display_name: input.displayName }),
          ...(input.passwordHash === undefined
            ? {}
            : { password_hash: input.passwordHash }),
          ...(input.state === undefined ? {} : { state: input.state }),
          updated_at: input.now,
        },
      });
      if (input.role !== undefined) {
        await transaction.operator_memberships.update({
          where: {
            organization_id_operator_id: {
              organization_id: input.organizationId,
              operator_id: input.operatorId,
            },
          },
          data: { role: input.role, updated_at: input.now },
        });
      }
      if (
        input.passwordHash !== undefined ||
        input.role !== undefined ||
        input.state !== undefined
      ) {
        await transaction.operator_sessions.updateMany({
          where: { operator_id: input.operatorId, revoked_at: null },
          data: { revoked_at: input.now },
        });
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
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private async lastAccessByOperator(
    operatorIds: readonly string[],
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    for (const operatorId of operatorIds) {
      const access = await this.lastAccessForOperator(this.database, operatorId);
      if (access) result.set(operatorId, access);
    }
    return result;
  }

  private async lastAccessForOperator(
    database: PackscoutQueryClient,
    operatorId: string,
  ): Promise<Date | null> {
    const session = await database.operator_sessions.findFirst({
      where: { operator_id: operatorId },
      orderBy: { last_seen_at: "desc" },
      select: { last_seen_at: true },
    });
    return session?.last_seen_at ?? null;
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

export class PrismaAuthAuditSink {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async append(event: AuthAuditEventInput): Promise<void> {
    await this.database.audit_events.create({
      data: {
        organization_id: event.organizationId,
        actor_key: event.actorId ?? "anonymous",
        action: event.action,
        subject_type: event.action.startsWith("operator.") ? "operator" : "session",
        subject_id: event.subjectId,
        outcome: event.outcome,
        metadata_json: sanitizeAuthAuditMetadata(event.metadata) as Prisma.InputJsonValue,
        occurred_at: event.occurredAt,
      },
    });
  }
}

export class DatabaseLoginAttemptLimiter {
  constructor(
    private readonly database: PackscoutPrismaClient,
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
    const buckets = await this.database.auth_rate_limits.findMany({
      where: { bucket_key: { in: [...new Set(bucketKeys)] } },
      select: { blocked_until: true },
    });
    let latest: Date | null = null;
    for (const bucket of buckets) {
      if (
        bucket.blocked_until &&
        bucket.blocked_until > now &&
        (!latest || bucket.blocked_until > latest)
      ) {
        latest = bucket.blocked_until;
      }
    }
    return latest;
  }

  async recordFailure(bucketKeys: readonly string[], now: Date): Promise<Date | null> {
    return this.database.$transaction(async (transaction) => {
      let latest: Date | null = null;
      for (const bucketKey of new Set(bucketKeys)) {
        await transaction.$executeRaw(
          Prisma.sql`
            insert into auth_rate_limits (
              bucket_key,
              window_started_at,
              attempt_count,
              updated_at
            ) values (${bucketKey}, ${now}, 0, ${now})
            on conflict (bucket_key) do nothing
          `,
        );
        const [bucket] = await transaction.$queryRaw<LockedRateLimitRow[]>(
          Prisma.sql`
            select bucket_key, window_started_at, attempt_count, blocked_until
            from auth_rate_limits
            where bucket_key = ${bucketKey}
            for update
          `,
        );
        if (!bucket) continue;
        const inWindow =
          now.getTime() - bucket.window_started_at.getTime() < this.options.windowMs;
        const attemptCount = (inWindow ? bucket.attempt_count : 0) + 1;
        const blockedUntil =
          attemptCount >= this.options.maximumFailures
            ? new Date(now.getTime() + this.options.blockMs)
            : bucket.blocked_until && bucket.blocked_until > now
              ? bucket.blocked_until
              : null;
        await transaction.auth_rate_limits.update({
          where: { bucket_key: bucketKey },
          data: {
            window_started_at: inWindow ? bucket.window_started_at : now,
            attempt_count: attemptCount,
            blocked_until: blockedUntil,
            updated_at: now,
          },
        });
        if (blockedUntil && (!latest || blockedUntil > latest)) latest = blockedUntil;
      }
      return latest;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async clear(bucketKeys: readonly string[]): Promise<void> {
    await this.database.auth_rate_limits.deleteMany({
      where: { bucket_key: { in: [...new Set(bucketKeys)] } },
    });
  }
}
