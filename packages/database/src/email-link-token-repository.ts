import { Prisma } from "@prisma/client";
import {
  EMAIL_LINK_SELECTOR_PATTERN,
  EMAIL_LINK_VERIFIER_HASH_PATTERN,
  emailLinkPurposeSchema,
  type EmailLinkPurpose,
} from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";

/**
 * One-time email-link token persistence. A row is one issued link: the
 * selector is the indexed lookup half, and the verifier exists here only as
 * a keyed hash — a database read can never yield a usable token, and this
 * repository never sees, returns, or logs one. Verification (the constant-
 * time comparison) belongs to the services layer; this layer guarantees the
 * database-level properties: the selector is unique, issuance atomically
 * supersedes prior outstanding rows for the same subject and purpose, and
 * redemption consumes a row through a single guarded UPDATE so concurrent
 * redemptions resolve to exactly one success.
 */

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const addressPattern = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const auditReasonPattern = /^[a-z][a-z0-9_]{0,63}$/;
const actorKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const bucketKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

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
  if (!parsed.success) {
    throw new RangeError("Email link purpose is invalid.");
  }
  return parsed.data;
}

function assertSubjectId(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new RangeError("Email link subject identifier is invalid.");
  }
  return value;
}

export interface IssueEmailLinkTokenInput {
  /** Caller-generated row identity (uuid). */
  readonly id: string;
  readonly purpose: EmailLinkPurpose;
  readonly subjectId: string;
  readonly addressNormalized: string;
  /** The plaintext lookup selector; unique across all live and settled rows. */
  readonly selector: string;
  /** The verifier's keyed hash — never the verifier itself. */
  readonly verifierHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface IssueEmailLinkTokenResult {
  readonly tokenId: string;
  /** Prior outstanding tokens for the same subject and purpose now superseded. */
  readonly supersededCount: number;
}

/**
 * A stored token row as redemption reads it. `verifierHash` is the stored
 * digest for the services layer's constant-time comparison; it is never a
 * usable credential on its own.
 */
export interface EmailLinkTokenRecord {
  readonly id: string;
  readonly purpose: EmailLinkPurpose;
  readonly selector: string;
  readonly verifierHash: string;
  readonly subjectId: string;
  readonly addressNormalized: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly redeemedAt: Date | null;
  readonly supersededAt: Date | null;
}

/** The latest unsettled token for a subject and purpose, without its hash. */
export interface OutstandingEmailLinkToken {
  readonly tokenId: string;
  readonly addressNormalized: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

function validateIssueInput(input: IssueEmailLinkTokenInput): void {
  if (!uuidPattern.test(input.id)) {
    throw new RangeError("Email link token identifier is invalid.");
  }
  assertPurpose(input.purpose);
  assertSubjectId(input.subjectId);
  if (
    input.addressNormalized.length > 320 ||
    !addressPattern.test(input.addressNormalized) ||
    input.addressNormalized !== input.addressNormalized.toLowerCase()
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

/**
 * Issues one token inside an already-open transaction, so a caller whose own
 * work must land atomically with issuance — enqueueing the message that
 * carries the link, say — composes both into one commit: either the token
 * exists and its message intent is recorded, or neither is.
 *
 * Same-subject issuance serializes on a transaction-scoped advisory lock so
 * supersession cannot race: two concurrent issues for one subject and purpose
 * leave exactly one outstanding token, whichever commits second.
 */
export async function issueEmailLinkToken(
  transaction: PackscoutTransactionClient,
  input: IssueEmailLinkTokenInput,
): Promise<IssueEmailLinkTokenResult> {
  validateIssueInput(input);
  await transaction.$executeRaw(Prisma.sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        'email_link_tokens:' || ${input.purpose} || ':' || ${input.subjectId},
        0
      )
    )
  `);
  // `greatest` keeps the settled-after-issued invariant even when the row
  // being superseded was written by a marginally faster clock.
  const superseded = await transaction.$executeRaw(Prisma.sql`
    update email_link_tokens
    set superseded_at = greatest(issued_at, ${input.issuedAt}),
        updated_at = ${input.issuedAt}
    where purpose = ${input.purpose}::email_link_purpose
      and subject_id = ${input.subjectId}::uuid
      and redeemed_at is null
      and superseded_at is null
  `);
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
  return { tokenId: input.id, supersededCount: superseded };
}

export class PrismaEmailLinkTokenRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /** Issues one token in its own transaction; see {@link issueEmailLinkToken}. */
  async issue(
    input: IssueEmailLinkTokenInput,
  ): Promise<IssueEmailLinkTokenResult> {
    return this.database.$transaction(
      (transaction) => issueEmailLinkToken(transaction, input),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
  }

  /**
   * Looks up one row by its selector — the indexed half of a presented
   * token. Returns the row whatever its state; liveness is enforced by
   * {@link consume}, and the caller performs the constant-time verifier
   * comparison before ever calling it.
   */
  async findBySelector(selector: string): Promise<EmailLinkTokenRecord | null> {
    if (!EMAIL_LINK_SELECTOR_PATTERN.test(selector)) return null;
    const row = await this.database.email_link_tokens.findUnique({
      where: { selector },
    });
    if (!row) return null;
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

  /**
   * Consumes one verified token: a single UPDATE whose WHERE clause requires
   * the row to still be unredeemed, unsuperseded, unexpired, and of the
   * presented purpose. Exactly one of any number of concurrent redemptions
   * can match, so single-use holds at the database, not in application
   * ordering; every loser observes `unavailable`. Nothing ever clears
   * `redeemed_at` — a consumed token stays consumed whatever happens to the
   * caller's follow-on work.
   */
  async consume(input: {
    readonly tokenId: string;
    readonly purpose: EmailLinkPurpose;
    readonly now: Date;
  }): Promise<"consumed" | "unavailable"> {
    if (!uuidPattern.test(input.tokenId)) {
      throw new RangeError("Email link token identifier is invalid.");
    }
    assertPurpose(input.purpose);
    assertTimestamp(input.now, "Email link redemption time");
    const updated = await this.database.$executeRaw(Prisma.sql`
      update email_link_tokens
      set redeemed_at = greatest(issued_at, ${input.now}),
          updated_at = ${input.now}
      where id = ${input.tokenId}::uuid
        and purpose = ${input.purpose}::email_link_purpose
        and redeemed_at is null
        and superseded_at is null
        and expires_at > ${input.now}
    `);
    return updated === 1 ? "consumed" : "unavailable";
  }

  /**
   * Marks every outstanding token for a subject and purpose superseded
   * without issuing a replacement — cancelling a pending invitation, say.
   */
  async supersedeOutstanding(input: {
    readonly purpose: EmailLinkPurpose;
    readonly subjectId: string;
    readonly now: Date;
  }): Promise<number> {
    assertPurpose(input.purpose);
    assertSubjectId(input.subjectId);
    assertTimestamp(input.now, "Email link supersession time");
    return this.database.$executeRaw(Prisma.sql`
      update email_link_tokens
      set superseded_at = greatest(issued_at, ${input.now}),
          updated_at = ${input.now}
      where purpose = ${input.purpose}::email_link_purpose
        and subject_id = ${input.subjectId}::uuid
        and redeemed_at is null
        and superseded_at is null
    `);
  }

  /**
   * The latest unsettled token for a subject and purpose, hash excluded —
   * enough for an admin surface to say whether a link is outstanding, when
   * it was sent, and whether it has expired. Never exposes token material.
   */
  async findOutstanding(input: {
    readonly purpose: EmailLinkPurpose;
    readonly subjectId: string;
  }): Promise<OutstandingEmailLinkToken | null> {
    assertPurpose(input.purpose);
    assertSubjectId(input.subjectId);
    const row = await this.database.email_link_tokens.findFirst({
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
    if (!row) return null;
    return {
      tokenId: row.id,
      addressNormalized: row.address_normalized,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Ages out expired tokens: rows whose expiry lies at or before the cutoff,
   * at most `limit` per call. A live token — unexpired, unredeemed,
   * unsuperseded — is never eligible, because expiry is the only criterion
   * and a live token has not reached it; the WHERE clause is the guarantee,
   * not the caller's cutoff arithmetic.
   */
  async prune(input: { cutoffAt: Date; limit: number }): Promise<number> {
    assertTimestamp(input.cutoffAt, "Email link prune cutoff");
    const limit = boundedInteger(input.limit, 1, 10_000, "Email link prune limit");
    return this.database.$transaction(async (transaction) => {
      const pruned = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
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
      `);
      return pruned.length;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}

export type EmailLinkAuditAction = "email_link.issue" | "email_link.redeem";

export interface EmailLinkAuditEventInput {
  readonly action: EmailLinkAuditAction;
  readonly purpose: EmailLinkPurpose;
  /** The bound subject when one is known; null keeps unknowns unenumerable. */
  readonly subjectId: string | null;
  readonly outcome: "success" | "failure" | "blocked";
  /** Closed lower-snake detail word; never free text, never token material. */
  readonly reason: string;
  readonly occurredAt: Date;
  /** The acting operator for administrator-triggered issuance, if any. */
  readonly actorKey?: string;
}

const emailLinkAuditActions: ReadonlySet<string> = new Set([
  "email_link.issue",
  "email_link.redeem",
]);

/**
 * The subject vocabulary per purpose. Adding a purpose means declaring what
 * kind of subject its audit rows point at.
 */
const subjectTypeForPurpose: Readonly<Record<EmailLinkPurpose, string>> = {
  operator_password_reset: "operator",
  operator_invitation: "operator",
};

/**
 * Appends one issuance or redemption attempt to the shared audit ledger.
 * Every field is validated against a closed shape before it is written, so a
 * token value cannot structurally reach an audit row: the reason is a closed
 * word, the purpose is an enum, and the subject is a uuid or absent.
 */
export class PrismaEmailLinkAuditSink {
  constructor(private readonly database: PackscoutPrismaClient) {}

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
    await this.database.audit_events.create({
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

interface LockedRateLimitRow {
  bucket_key: string;
  window_started_at: Date;
  attempt_count: number;
  blocked_until: Date | null;
}

export interface EmailLinkRateLimitOptions {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly blockMs: number;
}

function validateRateLimitOptions(
  options: EmailLinkRateLimitOptions,
): EmailLinkRateLimitOptions {
  boundedInteger(options.windowMs, 1_000, 24 * 60 * 60_000, "Email link rate window");
  boundedInteger(options.maxRequests, 1, 100_000, "Email link rate maximum");
  boundedInteger(options.blockMs, 1_000, 7 * 24 * 60 * 60_000, "Email link rate block");
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

/**
 * Issuance throttling over the shared `auth_rate_limits` buckets. Unlike the
 * login limiter — which counts only failures — every issuance request counts
 * here, because the thing being bounded is how often mail can be triggered
 * for an address or from a source, not how often something goes wrong.
 * Recording and deciding are one atomic step per bucket: the first request
 * past the window's maximum sets the block and is itself refused, and
 * requests during a block never extend it. The caller supplies the window
 * per call, so limits stay purpose-specific configuration without one
 * limiter instance per purpose.
 */
export class DatabaseEmailLinkRateLimiter {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /**
   * Records one request against every bucket and returns the latest block
   * expiry when any bucket refuses it, or null when the request is allowed.
   */
  async recordRequest(
    bucketKeys: readonly string[],
    now: Date,
    options: EmailLinkRateLimitOptions,
  ): Promise<Date | null> {
    const keys = validateBucketKeys(bucketKeys);
    validateRateLimitOptions(options);
    assertTimestamp(now, "Email link rate request time");
    return this.database.$transaction(async (transaction) => {
      let latest: Date | null = null;
      for (const bucketKey of keys) {
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
        if (bucket.blocked_until && bucket.blocked_until > now) {
          if (!latest || bucket.blocked_until > latest) {
            latest = bucket.blocked_until;
          }
          continue;
        }
        const inWindow =
          now.getTime() - bucket.window_started_at.getTime() < options.windowMs;
        const attemptCount = (inWindow ? bucket.attempt_count : 0) + 1;
        const blockedUntil =
          attemptCount > options.maxRequests
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
        if (blockedUntil && (!latest || blockedUntil > latest)) {
          latest = blockedUntil;
        }
      }
      return latest;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  /** Reads the latest active block without recording anything. */
  async retryAt(bucketKeys: readonly string[], now: Date): Promise<Date | null> {
    const keys = validateBucketKeys(bucketKeys);
    assertTimestamp(now, "Email link rate read time");
    const buckets = await this.database.auth_rate_limits.findMany({
      where: { bucket_key: { in: [...keys] } },
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

  /** Removes buckets outright — an operational reset, never a request path. */
  async clear(bucketKeys: readonly string[]): Promise<void> {
    await this.database.auth_rate_limits.deleteMany({
      where: { bucket_key: { in: [...validateBucketKeys(bucketKeys)] } },
    });
  }
}
