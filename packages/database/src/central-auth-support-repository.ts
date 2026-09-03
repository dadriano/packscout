import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
} from "./central-database.ts";
import { sanitizeAuthAuditMetadata } from "./security.ts";

export interface CentralAuthAuditEventInput {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action:
    | "auth.login"
    | "auth.logout"
    | "operator.provision"
    | "operator.invite"
    | "operator.invitation_accept"
    | "operator.invitation_cancel"
    | "operator.invitation_reissue"
    | "operator.update"
    | "operator.password_reset";
  readonly subjectId: string | null;
  readonly outcome: "success" | "failure" | "blocked";
  readonly occurredAt: Date;
  readonly metadata: Readonly<
    Record<string, string | boolean | readonly string[]>
  >;
}

interface LockedRateLimitRow {
  readonly bucket_key: string;
  readonly window_started_at: Date;
  readonly attempt_count: number;
  readonly blocked_until: Date | null;
}

/** Central audit sink with the same bounded metadata contract as the current admin. */
export class CentralAuthAuditSink {
  constructor(private readonly central: CentralPrismaClient) {}

  async append(event: CentralAuthAuditEventInput): Promise<void> {
    await this.central.audit_events.create({
      data: {
        organization_id: event.organizationId,
        actor_key: event.actorId ?? "anonymous",
        action: event.action,
        subject_type: event.action.startsWith("operator.")
          ? "operator"
          : "session",
        subject_id: event.subjectId,
        outcome: event.outcome,
        metadata_json: sanitizeAuthAuditMetadata(
          event.metadata,
        ) as CentralPrisma.InputJsonValue,
        occurred_at: event.occurredAt,
      },
    });
  }
}

/** Login throttling remains central because it protects the shared admin identity plane. */
export class CentralLoginAttemptLimiter {
  constructor(
    private readonly central: CentralPrismaClient,
    private readonly options: Readonly<{
      windowMs: number;
      blockMs: number;
      maximumFailures: number;
    }>,
  ) {
    if (
      options.windowMs <= 0
      || options.blockMs <= 0
      || options.maximumFailures <= 0
    ) {
      throw new Error("Rate limiter configuration must be positive.");
    }
  }

  async retryAt(
    bucketKeys: readonly string[],
    now: Date,
  ): Promise<Date | null> {
    const buckets = await this.central.auth_rate_limits.findMany({
      where: { bucket_key: { in: [...new Set(bucketKeys)] } },
      select: { blocked_until: true },
    });
    let latest: Date | null = null;
    for (const bucket of buckets) {
      if (
        bucket.blocked_until !== null
        && bucket.blocked_until > now
        && (latest === null || bucket.blocked_until > latest)
      ) {
        latest = bucket.blocked_until;
      }
    }
    return latest;
  }

  async recordFailure(
    bucketKeys: readonly string[],
    now: Date,
  ): Promise<Date | null> {
    return this.central.$transaction(async (transaction) => {
      let latest: Date | null = null;
      for (const bucketKey of new Set(bucketKeys)) {
        await transaction.$executeRaw(
          CentralPrisma.sql`
            insert into auth_rate_limits (
              bucket_key,
              window_started_at,
              attempt_count,
              updated_at
            ) values (${bucketKey}, ${now}, 0, ${now})
            on conflict (bucket_key) do nothing
          `,
        );
        const [bucket] = await transaction.$queryRaw<
          readonly LockedRateLimitRow[]
        >(
          CentralPrisma.sql`
            select bucket_key, window_started_at, attempt_count, blocked_until
            from auth_rate_limits
            where bucket_key = ${bucketKey}
            for update
          `,
        );
        if (bucket === undefined) continue;
        const inWindow = now.getTime()
          - bucket.window_started_at.getTime() < this.options.windowMs;
        const attemptCount = (inWindow ? bucket.attempt_count : 0) + 1;
        const blockedUntil = attemptCount >= this.options.maximumFailures
          ? new Date(now.getTime() + this.options.blockMs)
          : bucket.blocked_until !== null && bucket.blocked_until > now
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
        if (
          blockedUntil !== null
          && (latest === null || blockedUntil > latest)
        ) {
          latest = blockedUntil;
        }
      }
      return latest;
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async clear(bucketKeys: readonly string[]): Promise<void> {
    await this.central.auth_rate_limits.deleteMany({
      where: { bucket_key: { in: [...new Set(bucketKeys)] } },
    });
  }
}
