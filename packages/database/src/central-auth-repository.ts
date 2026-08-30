import type {
  ListOperatorsQuery,
  OperatorListResponse,
  OperatorRole,
  OperatorState,
  OperatorSummary,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralQueryClient,
  type CentralTransactionClient,
} from "./central-database.ts";

export interface CentralCreateSessionRecord {
  readonly id: string;
  readonly operatorId: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface CentralLoginOperatorRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly emailNormalized: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly state: OperatorState;
  readonly role: OperatorRole;
}

export interface CentralAuthoritativeSessionRecord
  extends CentralLoginOperatorRecord {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly csrfHash: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export type CentralProvisionOperatorResult =
  | Readonly<{ kind: "created"; operator: OperatorSummary }>
  | Readonly<{ kind: "email_conflict" }>;

export type CentralUpdateOperatorResult =
  | Readonly<{ kind: "updated"; operator: OperatorSummary }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "last_active_admin" }>
  | Readonly<{ kind: "not_activated" }>;

export type CentralActivateInvitedOperatorResult =
  | Readonly<{ kind: "activated"; operator: OperatorSummary }>
  | Readonly<{ kind: "not_pending" }>;

export type CentralCancelInvitedOperatorResult =
  | Readonly<{ kind: "cancelled"; operator: OperatorSummary }>
  | Readonly<{ kind: "not_pending" }>;

interface OperatorProjection {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly state: OperatorState;
  readonly role: OperatorRole;
  readonly rowVersion: bigint;
  readonly createdAt: Date;
  readonly operatorUpdatedAt: Date;
  readonly membershipUpdatedAt: Date;
}

interface MembershipProjection {
  readonly role: OperatorRole;
  readonly updated_at: Date;
  readonly operator: {
    readonly id: string;
    readonly email_normalized: string;
    readonly display_name: string;
    readonly password_hash: string | null;
    readonly state: OperatorState;
    readonly row_version: bigint;
    readonly created_at: Date;
    readonly updated_at: Date;
  };
}

interface LockedOperatorRow {
  readonly id: string;
  readonly row_version: bigint;
}

function latestTimestamp(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function nextTimestamp(current: Date, requested: Date): Date {
  return new Date(Math.max(requested.getTime(), current.getTime() + 1));
}

function toOperatorSummary(
  row: OperatorProjection,
  lastAccessAt: Date | null,
): OperatorSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    state: row.state,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    updatedAt: latestTimestamp(
      row.operatorUpdatedAt,
      row.membershipUpdatedAt,
    ).toISOString(),
    lastAccessAt: lastAccessAt?.toISOString() ?? null,
  };
}

function isCentralUniqueConstraintError(error: unknown): boolean {
  return error instanceof CentralPrisma.PrismaClientKnownRequestError
    && error.code === "P2002";
}

async function lockOperator(
  transaction: CentralTransactionClient,
  operatorId: string,
): Promise<LockedOperatorRow | null> {
  const [row] = await transaction.$queryRaw<readonly LockedOperatorRow[]>(
    CentralPrisma.sql`
      select id, row_version
      from operators
      where id = ${operatorId}::uuid
      for update
    `,
  );
  return row ?? null;
}

/**
 * Authentication and operator persistence for the central control database.
 * The browser/service contracts intentionally match the authoritative admin;
 * only the owning database and concurrency discipline change.
 */
export class CentralAuthRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async findOperatorForLogin(
    normalizedEmail: string,
  ): Promise<CentralLoginOperatorRecord | null> {
    const membership = await this.central.operator_memberships.findFirst({
      where: { operator: { email_normalized: normalizedEmail } },
      orderBy: [
        { organization: { created_at: "asc" } },
        { organization: { id: "asc" } },
      ],
      select: {
        organization_id: true,
        role: true,
        organization: { select: { name: true } },
        operator: {
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
    if (membership === null) return null;
    return {
      id: membership.operator.id,
      organizationId: membership.organization_id,
      organizationName: membership.organization.name,
      emailNormalized: membership.operator.email_normalized,
      displayName: membership.operator.display_name,
      passwordHash: membership.operator.password_hash,
      state: membership.operator.state,
      role: membership.role,
    };
  }

  async rotateSession(input: {
    readonly previousTokenHash: string | null;
    readonly session: CentralCreateSessionRecord;
  }): Promise<void> {
    await this.central.$transaction(async (transaction) => {
      if (input.previousTokenHash !== null) {
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
      if (membership === null) {
        throw new Error(
          "Cannot create a session without an organization membership.",
        );
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
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async findAuthoritativeSession(
    tokenHash: string,
    now: Date,
  ): Promise<CentralAuthoritativeSessionRecord | null> {
    const session = await this.central.operator_sessions.findFirst({
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
        organization: { select: { id: true, name: true } },
        operator: {
          select: {
            id: true,
            email_normalized: true,
            display_name: true,
            password_hash: true,
            state: true,
          },
        },
        membership: { select: { role: true } },
      },
    });
    if (session === null) return null;
    return {
      sessionId: session.id,
      operatorId: session.operator.id,
      id: session.operator.id,
      organizationId: session.organization.id,
      organizationName: session.organization.name,
      emailNormalized: session.operator.email_normalized,
      displayName: session.operator.display_name,
      passwordHash: session.operator.password_hash,
      state: session.operator.state,
      role: session.membership.role,
      csrfHash: session.csrf_hash,
      idleExpiresAt: session.idle_expires_at,
      absoluteExpiresAt: session.absolute_expires_at,
    };
  }

  async refreshSession(input: {
    readonly sessionId: string;
    readonly lastSeenAt: Date;
    readonly idleExpiresAt: Date;
  }): Promise<void> {
    await this.central.operator_sessions.updateMany({
      where: { id: input.sessionId, revoked_at: null },
      data: {
        last_seen_at: input.lastSeenAt,
        idle_expires_at: input.idleExpiresAt,
      },
    });
  }

  async revokeSessionByTokenHash(
    tokenHash: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.central.operator_sessions.updateMany({
      where: { token_hash: tokenHash, revoked_at: null },
      data: { revoked_at: revokedAt },
    });
  }

  async revokeAllSessionsForOperator(
    operatorId: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.central.operator_sessions.updateMany({
      where: { operator_id: operatorId, revoked_at: null },
      data: { revoked_at: revokedAt },
    });
  }

  async listOperators(
    organizationId: string,
    query: ListOperatorsQuery,
  ): Promise<OperatorListResponse> {
    const memberships = await this.central.operator_memberships.findMany({
      where: {
        organization_id: organizationId,
        ...(query.role === undefined ? {} : { role: query.role }),
        operator: {
          ...(query.cursor === undefined
            ? {}
            : { id: { gt: query.cursor } }),
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.search === undefined
            ? {}
            : {
                OR: [
                  {
                    email_normalized: {
                      contains: query.search,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    display_name: {
                      contains: query.search,
                      mode: "insensitive" as const,
                    },
                  },
                ],
              }),
        },
      },
      orderBy: { operator: { id: "asc" } },
      take: query.limit + 1,
      select: {
        role: true,
        updated_at: true,
        operator: {
          select: {
            id: true,
            email_normalized: true,
            display_name: true,
            password_hash: true,
            state: true,
            row_version: true,
            created_at: true,
            updated_at: true,
          },
        },
      },
    });
    const visible = memberships.slice(0, query.limit);
    const lastAccess = await this.lastAccessByOperator(
      visible.map(({ operator }) => operator.id),
    );
    return {
      items: visible.map((membership) => {
        const projection = this.operatorProjection(membership);
        return toOperatorSummary(
          projection,
          lastAccess.get(projection.id) ?? null,
        );
      }),
      nextCursor: memberships.length > query.limit
        ? visible.at(-1)?.operator.id ?? null
        : null,
    };
  }

  async findOperatorById(
    organizationId: string,
    operatorId: string,
  ): Promise<OperatorSummary | null> {
    const membership = await this.loadMembership(
      this.central,
      organizationId,
      operatorId,
    );
    if (membership === null) return null;
    const projection = this.operatorProjection(membership);
    return toOperatorSummary(
      projection,
      await this.lastAccessForOperator(this.central, operatorId),
    );
  }

  async provisionOperator(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly emailNormalized: string;
    readonly displayName: string;
    readonly passwordHash: string | null;
    readonly role: OperatorRole;
    readonly state: "active" | "pending";
    readonly now: Date;
  }): Promise<CentralProvisionOperatorResult> {
    try {
      return await this.central.$transaction(async (transaction) => {
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
          operator: toOperatorSummary({
            id: input.id,
            email: input.emailNormalized,
            displayName: input.displayName,
            passwordHash: input.passwordHash,
            state: input.state,
            role: input.role,
            rowVersion: 1n,
            createdAt: input.now,
            operatorUpdatedAt: input.now,
            membershipUpdatedAt: input.now,
          }, null),
        };
      }, CENTRAL_TRANSACTION_OPTIONS);
    } catch (error) {
      if (isCentralUniqueConstraintError(error)) {
        return { kind: "email_conflict" };
      }
      throw error;
    }
  }

  async updateOperator(input: {
    readonly organizationId: string;
    readonly operatorId: string;
    readonly displayName?: string;
    readonly passwordHash?: string;
    readonly role?: OperatorRole;
    readonly state?: OperatorState;
    readonly now: Date;
  }): Promise<CentralUpdateOperatorResult> {
    return this.central.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        CentralPrisma.sql`
          select id
          from organizations
          where id = ${input.organizationId}::uuid
          for update
        `,
      );
      await lockOperator(transaction, input.operatorId);
      const membership = await this.loadMembership(
        transaction,
        input.organizationId,
        input.operatorId,
      );
      if (membership === null) return { kind: "not_found" };
      const target = this.operatorProjection(membership);
      if (target.state === "pending" || target.state === "cancelled") {
        return { kind: "not_activated" };
      }

      const removesActiveAdmin = target.role === "admin"
        && target.state === "active"
        && (input.role === "data_operator" || input.state === "disabled");
      if (removesActiveAdmin) {
        const activeAdminCount = await transaction.operator_memberships.count({
          where: {
            organization_id: input.organizationId,
            role: "admin",
            operator: { state: "active" },
          },
        });
        if (activeAdminCount <= 1) return { kind: "last_active_admin" };
      }

      const operatorChanged =
        (input.displayName !== undefined
          && input.displayName !== target.displayName)
        || (input.passwordHash !== undefined
          && input.passwordHash !== target.passwordHash)
        || (input.state !== undefined && input.state !== target.state);
      const operatorUpdatedAt = operatorChanged
        ? nextTimestamp(target.operatorUpdatedAt, input.now)
        : target.operatorUpdatedAt;
      if (operatorChanged) {
        const updated = await transaction.operators.updateMany({
          where: {
            id: input.operatorId,
            row_version: target.rowVersion,
          },
          data: {
            ...(input.displayName === undefined
              ? {}
              : { display_name: input.displayName }),
            ...(input.passwordHash === undefined
              ? {}
              : { password_hash: input.passwordHash }),
            ...(input.state === undefined ? {} : { state: input.state }),
            row_version: { increment: 1 },
            updated_at: operatorUpdatedAt,
          },
        });
        if (updated.count !== 1) {
          throw new Error("Central operator changed concurrently.");
        }
      }

      const roleChanged = input.role !== undefined && input.role !== target.role;
      const membershipUpdatedAt = roleChanged
        ? nextTimestamp(target.membershipUpdatedAt, input.now)
        : target.membershipUpdatedAt;
      if (roleChanged) {
        await transaction.operator_memberships.update({
          where: {
            organization_id_operator_id: {
              organization_id: input.organizationId,
              operator_id: input.operatorId,
            },
          },
          data: { role: input.role, updated_at: membershipUpdatedAt },
        });
      }
      if (
        input.passwordHash !== undefined
        || roleChanged
        || (input.state !== undefined && input.state !== target.state)
      ) {
        await transaction.operator_sessions.updateMany({
          where: { operator_id: input.operatorId, revoked_at: null },
          data: { revoked_at: input.now },
        });
      }

      return {
        kind: "updated",
        operator: toOperatorSummary({
          ...target,
          displayName: input.displayName ?? target.displayName,
          passwordHash: input.passwordHash ?? target.passwordHash,
          state: input.state ?? target.state,
          role: input.role ?? target.role,
          rowVersion: operatorChanged
            ? target.rowVersion + 1n
            : target.rowVersion,
          operatorUpdatedAt: operatorChanged
            ? operatorUpdatedAt
            : target.operatorUpdatedAt,
          membershipUpdatedAt: roleChanged
            ? membershipUpdatedAt
            : target.membershipUpdatedAt,
        }, await this.lastAccessForOperator(transaction, input.operatorId)),
      };
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async activateInvitedOperator(input: {
    readonly organizationId: string;
    readonly operatorId: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<CentralActivateInvitedOperatorResult> {
    return this.central.$transaction(async (transaction) => {
      const locked = await lockOperator(transaction, input.operatorId);
      if (locked === null) return { kind: "not_pending" };
      const membership = await this.loadMembership(
        transaction,
        input.organizationId,
        input.operatorId,
      );
      if (membership === null || membership.operator.state !== "pending") {
        return { kind: "not_pending" };
      }
      const activated = await transaction.operators.updateMany({
        where: {
          id: input.operatorId,
          state: "pending",
          row_version: membership.operator.row_version,
        },
        data: {
          password_hash: input.passwordHash,
          state: "active",
          row_version: { increment: 1 },
          updated_at: nextTimestamp(
            membership.operator.updated_at,
            input.now,
          ),
        },
      });
      if (activated.count !== 1) return { kind: "not_pending" };
      return {
        kind: "activated",
        operator: toOperatorSummary({
          ...this.operatorProjection(membership),
          passwordHash: input.passwordHash,
          state: "active",
          rowVersion: membership.operator.row_version + 1n,
          operatorUpdatedAt: nextTimestamp(
            membership.operator.updated_at,
            input.now,
          ),
        }, await this.lastAccessForOperator(transaction, input.operatorId)),
      };
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async cancelInvitedOperator(input: {
    readonly organizationId: string;
    readonly operatorId: string;
    readonly now: Date;
  }): Promise<CentralCancelInvitedOperatorResult> {
    return this.central.$transaction(async (transaction) => {
      const locked = await lockOperator(transaction, input.operatorId);
      if (locked === null) return { kind: "not_pending" };
      const membership = await this.loadMembership(
        transaction,
        input.organizationId,
        input.operatorId,
      );
      if (membership === null || membership.operator.state !== "pending") {
        return { kind: "not_pending" };
      }
      const cancelled = await transaction.operators.updateMany({
        where: {
          id: input.operatorId,
          state: "pending",
          row_version: membership.operator.row_version,
        },
        data: {
          state: "cancelled",
          row_version: { increment: 1 },
          updated_at: nextTimestamp(
            membership.operator.updated_at,
            input.now,
          ),
        },
      });
      if (cancelled.count !== 1) return { kind: "not_pending" };
      return {
        kind: "cancelled",
        operator: toOperatorSummary({
          ...this.operatorProjection(membership),
          state: "cancelled",
          rowVersion: membership.operator.row_version + 1n,
          operatorUpdatedAt: nextTimestamp(
            membership.operator.updated_at,
            input.now,
          ),
        }, null),
      };
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  private loadMembership(
    database: CentralQueryClient,
    organizationId: string,
    operatorId: string,
  ): Promise<MembershipProjection | null> {
    return database.operator_memberships.findUnique({
      where: {
        organization_id_operator_id: {
          organization_id: organizationId,
          operator_id: operatorId,
        },
      },
      select: {
        role: true,
        updated_at: true,
        operator: {
          select: {
            id: true,
            email_normalized: true,
            display_name: true,
            password_hash: true,
            state: true,
            row_version: true,
            created_at: true,
            updated_at: true,
          },
        },
      },
    });
  }

  private operatorProjection(
    membership: MembershipProjection,
  ): OperatorProjection {
    return {
      id: membership.operator.id,
      email: membership.operator.email_normalized,
      displayName: membership.operator.display_name,
      passwordHash: membership.operator.password_hash,
      state: membership.operator.state,
      role: membership.role,
      rowVersion: membership.operator.row_version,
      createdAt: membership.operator.created_at,
      operatorUpdatedAt: membership.operator.updated_at,
      membershipUpdatedAt: membership.updated_at,
    };
  }

  private async lastAccessByOperator(
    operatorIds: readonly string[],
  ): Promise<Map<string, Date>> {
    const sessions = operatorIds.length === 0
      ? []
      : await this.central.operator_sessions.findMany({
          where: { operator_id: { in: [...operatorIds] } },
          orderBy: [
            { operator_id: "asc" },
            { last_seen_at: "desc" },
          ],
          distinct: ["operator_id"],
          select: { operator_id: true, last_seen_at: true },
        });
    return new Map(
      sessions.map((session) => [session.operator_id, session.last_seen_at]),
    );
  }

  private async lastAccessForOperator(
    database: CentralQueryClient,
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
