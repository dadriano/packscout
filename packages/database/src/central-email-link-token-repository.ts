import {
  EMAIL_LINK_SELECTOR_PATTERN,
  EMAIL_LINK_VERIFIER_HASH_PATTERN,
  emailLinkPurposeSchema,
  type EmailLinkPurpose,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralTransactionClient,
} from "./central-database.ts";
import type {
  EmailLinkAuditEventInput,
  EmailLinkRateLimitOptions,
  EmailLinkTokenRecord,
  IssueEmailLinkTokenInput,
  IssueEmailLinkTokenResult,
  OutstandingEmailLinkToken,
} from "./email-link-token-repository.ts";
import { PersistenceError } from "./persistence-error.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const addressPattern = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const auditReasonPattern = /^[a-z][a-z0-9_]{0,63}$/;
const actorKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const bucketKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

interface LockedTokenRow {
  readonly id: string;
  readonly row_version: bigint;
  readonly issued_at: Date;
  readonly updated_at: Date;
}

interface LockedRateLimitRow {
  readonly bucket_key: string;
  readonly window_started_at: Date;
  readonly attempt_count: number;
  readonly blocked_until: Date | null;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return value;
}

function assertTimestamp(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} is invalid.`);
  }
  return value;
}

function assertPurpose(value: string): EmailLinkPurpose {
  const parsed = emailLinkPurposeSchema.safeParse(value);
  if (!parsed.success) throw new RangeError("Email link purpose is invalid.");
  return parsed.data;
}

function assertSubjectId(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new RangeError("Email link subject identifier is invalid.");
  }
  return value;
}

function validateIssueInput(input: IssueEmailLinkTokenInput): void {
  if (!uuidPattern.test(input.id)) {
    throw new RangeError("Email link token identifier is invalid.");
  }
  assertPurpose(input.purpose);
  assertSubjectId(input.subjectId);
  if (
    input.addressNormalized.length > 320
    || !addressPattern.test(input.addressNormalized)
    || input.addressNormalized !== input.addressNormalized.toLowerCase()
  ) {
    throw new RangeError("Email link address is not a normalized address.");
  }
  if (!EMAIL_LINK_SELECTOR_PATTERN.test(input.selector)) {
    throw new RangeError("Email link selector is invalid.");
  }
  if (!EMAIL_LINK_VERIFIER_HASH_PATTERN.test(input.verifierHash)) {
    throw new RangeError("Email link verifier hash is invalid.");
  }
  assertTimestamp(input.issuedAt, "Email link issue time");
  assertTimestamp(input.expiresAt, "Email link expiry time");
  if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new RangeError("Email link expiry must follow issuance.");
  }
}

function nextTimestamp(current: Date, requested: Date): Date {
  return new Date(Math.max(requested.getTime(), current.getTime() + 1));
}

async function lockOutstanding(
  transaction: CentralTransactionClient,
  purpose: EmailLinkPurpose,
  subjectId: string,
): Promise<readonly LockedTokenRow[]> {
  return transaction.$queryRaw<readonly LockedTokenRow[]>(CentralPrisma.sql`
    select id, row_version, issued_at, updated_at
    from email_link_tokens
    where purpose = ${purpose}::email_link_purpose
      and subject_id = ${subjectId}::uuid
      and redeemed_at is null
      and superseded_at is null
    order by issued_at asc, id asc
    for update
  `);
}

async function supersedeLocked(
  transaction: CentralTransactionClient,
  rows: readonly LockedTokenRow[],
  requestedAt: Date,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    const updated = await transaction.email_link_tokens.updateMany({
      where: {
        id: row.id,
        row_version: row.row_version,
        redeemed_at: null,
        superseded_at: null,
      },
      data: {
        superseded_at: new Date(Math.max(
          row.issued_at.getTime(),
          requestedAt.getTime(),
        )),
        row_version: { increment: 1 },
        updated_at: nextTimestamp(row.updated_at, requestedAt),
      },
    });
    count += updated.count;
  }
  return count;
}

/** Transaction-composable central token issuance used by invitation/reset flows. */
export async function issueCentralEmailLinkToken(
  transaction: CentralTransactionClient,
  input: IssueEmailLinkTokenInput,
): Promise<IssueEmailLinkTokenResult> {
  validateIssueInput(input);
  await transaction.$executeRaw(CentralPrisma.sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        'email_link_tokens:' || ${input.purpose} || ':' || ${input.subjectId},
        0
      )
    )
  `);
  const supersededCount = await supersedeLocked(
    transaction,
    await lockOutstanding(transaction, input.purpose, input.subjectId),
    input.issuedAt,
  );
  await transaction.email_link_tokens.create({
    data: {
      id: input.id,
      purpose: input.purpose,
      selector: input.selector,
      verifier_hash: input.verifierHash,
      subject_id: input.subjectId,
      address_normalized: input.addressNormalized,
      issued_at: input.issuedAt,
      expires_at: input.expiresAt,
      created_at: input.issuedAt,
      updated_at: input.issuedAt,
    },
    select: { id: true },
  });
  return { tokenId: input.id, supersededCount };
}

export class CentralEmailLinkTokenRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async issue(
    input: IssueEmailLinkTokenInput,
  ): Promise<IssueEmailLinkTokenResult> {
    return this.central.$transaction(
      (transaction) => issueCentralEmailLinkToken(transaction, input),
      CENTRAL_TRANSACTION_OPTIONS,
    );
  }

  async findBySelector(selector: string): Promise<EmailLinkTokenRecord | null> {
    if (!EMAIL_LINK_SELECTOR_PATTERN.test(selector)) return null;
    const row = await this.central.email_link_tokens.findUnique({
      where: { selector },
    });
    if (row === null) return null;
    return {
      id: row.id,
      purpose: row.purpose,
      selector: row.selector,
      verifierHash: row.verifier_hash,
      subjectId: row.subject_id,
      addressNormalized: row.address_normalized,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      redeemedAt: row.redeemed_at,
      supersededAt: row.superseded_at,
    };
  }

  async consume(input: Readonly<{
    tokenId: string;
    purpose: EmailLinkPurpose;
    now: Date;
  }>): Promise<"consumed" | "unavailable"> {
    if (!uuidPattern.test(input.tokenId)) {
      throw new RangeError("Email link token identifier is invalid.");
    }
    assertPurpose(input.purpose);
    assertTimestamp(input.now, "Email link redemption time");
    return this.central.$transaction(async (transaction) => {
      const [row] = await transaction.$queryRaw<readonly LockedTokenRow[]>(
        CentralPrisma.sql`
          select id, row_version, issued_at, updated_at
          from email_link_tokens
          where id = ${input.tokenId}::uuid
            and purpose = ${input.purpose}::email_link_purpose
            and redeemed_at is null
            and superseded_at is null
            and expires_at > ${input.now}
          for update
        `,
      );
      if (row === undefined) return "unavailable";
      const updated = await transaction.email_link_tokens.updateMany({
        where: {
          id: input.tokenId,
          row_version: row.row_version,
          redeemed_at: null,
          superseded_at: null,
          expires_at: { gt: input.now },
        },
        data: {
          redeemed_at: new Date(Math.max(
            row.issued_at.getTime(),
            input.now.getTime(),
          )),
          row_version: { increment: 1 },
          updated_at: nextTimestamp(row.updated_at, input.now),
        },
      });
      return updated.count === 1 ? "consumed" : "unavailable";
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async supersedeOutstanding(input: Readonly<{
    purpose: EmailLinkPurpose;
    subjectId: string;
    now: Date;
  }>): Promise<number> {
    assertPurpose(input.purpose);
    assertSubjectId(input.subjectId);
    assertTimestamp(input.now, "Email link supersession time");
    return this.central.$transaction(async (transaction) => {
      await transaction.$executeRaw(CentralPrisma.sql`
        select pg_advisory_xact_lock(
          hashtextextended(
            'email_link_tokens:' || ${input.purpose} || ':' || ${input.subjectId},
            0
          )
        )
      `);
      return supersedeLocked(
        transaction,
        await lockOutstanding(transaction, input.purpose, input.subjectId),
        input.now,
      );
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async findOutstanding(input: Readonly<{
    purpose: EmailLinkPurpose;
    subjectId: string;
  }>): Promise<OutstandingEmailLinkToken | null> {
    assertPurpose(input.purpose);
    assertSubjectId(input.subjectId);
    const row = await this.central.email_link_tokens.findFirst({
      where: {
        purpose: input.purpose,
        subject_id: input.subjectId,
        redeemed_at: null,
        superseded_at: null,
      },
      orderBy: [{ issued_at: "desc" }, { id: "desc" }],
      select: {
        id: true,
        address_normalized: true,
        issued_at: true,
        expires_at: true,
      },
    });
    return row === null ? null : {
      tokenId: row.id,
      addressNormalized: row.address_normalized,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  async findOutstandingForSubjects(input: Readonly<{
    purpose: EmailLinkPurpose;
    subjectIds: readonly string[];
  }>): Promise<Map<string, OutstandingEmailLinkToken>> {
    assertPurpose(input.purpose);
    const subjectIds = [...new Set(input.subjectIds)];
    if (subjectIds.length === 0) return new Map();
    for (const subjectId of subjectIds) assertSubjectId(subjectId);
    const rows = await this.central.email_link_tokens.findMany({
      where: {
        purpose: input.purpose,
        subject_id: { in: subjectIds },
        redeemed_at: null,
        superseded_at: null,
      },
      orderBy: [{ issued_at: "desc" }, { id: "desc" }],
      select: {
        id: true,
        subject_id: true,
        address_normalized: true,
        issued_at: true,
        expires_at: true,
      },
    });
    const result = new Map<string, OutstandingEmailLinkToken>();
    for (const row of rows) {
      if (result.has(row.subject_id)) continue;
      result.set(row.subject_id, {
        tokenId: row.id,
        addressNormalized: row.address_normalized,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      });
    }
    return result;
  }

  async prune(input: Readonly<{
    cutoffAt: Date;
    limit: number;
  }>): Promise<number> {
    assertTimestamp(input.cutoffAt, "Email link prune cutoff");
    const limit = boundedInteger(
      input.limit,
      1,
      10_000,
      "Email link prune limit",
    );
    return this.central.$transaction(async (transaction) => {
      const pruned = await transaction.$queryRaw<readonly { id: string }[]>(
        CentralPrisma.sql`
          with prunable as (
            select id
            from email_link_tokens
            where expires_at <= ${input.cutoffAt}
            order by expires_at asc, id asc
            limit ${limit}
            for update skip locked
          )
          delete from email_link_tokens
          where id in (select id from prunable)
          returning id
        `,
      );
      return pruned.length;
    }, CENTRAL_TRANSACTION_OPTIONS);
  }
}

const emailLinkAuditActions: ReadonlySet<string> = new Set([
  "email_link.issue",
  "email_link.redeem",
]);

const subjectTypeForPurpose: Readonly<Record<EmailLinkPurpose, string>> = {
  operator_password_reset: "operator",
  operator_invitation: "operator",
};

export class CentralEmailLinkAuditSink {
  constructor(private readonly central: CentralPrismaClient) {}

  async append(event: EmailLinkAuditEventInput): Promise<void> {
    if (!emailLinkAuditActions.has(event.action)) {
      throw new PersistenceError(
        "UNSAFE_AUDIT_METADATA",
        "Email link audit action is not allowlisted.",
      );
    }
    const purpose = assertPurpose(event.purpose);
    if (event.subjectId !== null && !uuidPattern.test(event.subjectId)) {
      throw new PersistenceError(
        "UNSAFE_AUDIT_METADATA",
        "Email link audit subject is not an identifier.",
      );
    }
    if (!auditReasonPattern.test(event.reason)) {
      throw new PersistenceError(
        "UNSAFE_AUDIT_METADATA",
        "Email link audit reason is not a closed word.",
      );
    }
    const actorKey = event.actorKey ?? "anonymous";
    if (!actorKeyPattern.test(actorKey)) {
      throw new PersistenceError(
        "UNSAFE_AUDIT_METADATA",
        "Email link audit actor key is invalid.",
      );
    }
    assertTimestamp(event.occurredAt, "Email link audit time");
    await this.central.audit_events.create({
      data: {
        organization_id: null,
        actor_key: actorKey,
        action: event.action,
        subject_type: subjectTypeForPurpose[purpose],
        subject_id: event.subjectId,
        outcome: event.outcome,
        metadata_json: { purpose, reason: event.reason },
        occurred_at: event.occurredAt,
      },
    });
  }
}

function validateRateLimitOptions(
  options: EmailLinkRateLimitOptions,
): EmailLinkRateLimitOptions {
  boundedInteger(
    options.windowMs,
    1_000,
    24 * 60 * 60_000,
    "Email link rate window",
  );
  boundedInteger(
    options.maxRequests,
    1,
    100_000,
    "Email link rate maximum",
  );
  boundedInteger(
    options.blockMs,
    1_000,
    7 * 24 * 60 * 60_000,
    "Email link rate block",
  );
  return options;
}

function validateBucketKeys(bucketKeys: readonly string[]): readonly string[] {
  const unique = [...new Set(bucketKeys)];
  if (unique.length === 0 || unique.length > 8) {
    throw new RangeError("Email link rate bucket set is out of bounds.");
  }
  for (const key of unique) {
    if (!bucketKeyPattern.test(key)) {
      throw new RangeError("Email link rate bucket key is invalid.");
    }
  }
  return unique;
}

export class CentralEmailLinkRateLimiter {
  constructor(private readonly central: CentralPrismaClient) {}

  async recordRequest(
    bucketKeys: readonly string[],
    now: Date,
    options: EmailLinkRateLimitOptions,
  ): Promise<Date | null> {
    const keys = validateBucketKeys(bucketKeys);
    validateRateLimitOptions(options);
    assertTimestamp(now, "Email link rate request time");
    return this.central.$transaction(async (transaction) => {
      let latest: Date | null = null;
      for (const bucketKey of keys) {
        await transaction.$executeRaw(CentralPrisma.sql`
          insert into auth_rate_limits (
            bucket_key,
            window_started_at,
            attempt_count,
            updated_at
          ) values (${bucketKey}, ${now}, 0, ${now})
          on conflict (bucket_key) do nothing
        `);
        const [bucket] = await transaction.$queryRaw<
          readonly LockedRateLimitRow[]
        >(CentralPrisma.sql`
          select bucket_key, window_started_at, attempt_count, blocked_until
          from auth_rate_limits
          where bucket_key = ${bucketKey}
          for update
        `);
        if (bucket === undefined) continue;
        if (bucket.blocked_until !== null && bucket.blocked_until > now) {
          if (latest === null || bucket.blocked_until > latest) {
            latest = bucket.blocked_until;
          }
          continue;
        }
        const inWindow = now.getTime()
          - bucket.window_started_at.getTime() < options.windowMs;
        const attemptCount = (inWindow ? bucket.attempt_count : 0) + 1;
        const blockedUntil = attemptCount > options.maxRequests
          ? new Date(now.getTime() + options.blockMs)
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

  async retryAt(
    bucketKeys: readonly string[],
    now: Date,
  ): Promise<Date | null> {
    const keys = validateBucketKeys(bucketKeys);
    assertTimestamp(now, "Email link rate read time");
    const buckets = await this.central.auth_rate_limits.findMany({
      where: { bucket_key: { in: [...keys] } },
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

  async clear(bucketKeys: readonly string[]): Promise<void> {
    await this.central.auth_rate_limits.deleteMany({
      where: {
        bucket_key: { in: [...validateBucketKeys(bucketKeys)] },
      },
    });
  }
}
