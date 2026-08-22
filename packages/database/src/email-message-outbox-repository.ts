import { Prisma } from "@prisma/client";
import {
  EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH,
  emailOutboxIdempotencyKeySchema,
  emailOutboxSourceSchema,
  type EmailDeliverySkipReason,
  type EmailMessageAttemptOutcome,
  type EmailMessageIntentState,
} from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";

/**
 * Durable email outbox persistence. An intent is the recorded decision to
 * send one message: enqueueing writes only this row and performs no network
 * work, so the caller's own operation never waits on delivery. The drain
 * claims due intents with the pipeline's lease discipline and records every
 * try as an attempt row.
 *
 * At-least-once by design: an intent whose provider call succeeded while the
 * claim was lost (worker death between send and acknowledgement) may be
 * delivered again by the next claimant. The idempotency key makes duplicate
 * *triggering events* converge on one intent; the lost-acknowledgement window
 * is the accepted bounded duplicate exposure.
 */

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const kindPattern = /^[a-z][a-z0-9_]{0,63}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recipientPattern = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const skipReasons: ReadonlySet<string> = new Set([
  "delivery_disabled",
  "console_mode",
  "missing_configuration",
]);

export interface EnqueueEmailMessageIntentInput {
  readonly kind: string;
  readonly input: unknown;
  readonly recipient: string;
  readonly idempotencyKey: string;
  readonly source: string;
  readonly dueAt: Date;
  readonly now: Date;
  /** Active (pending or retrying) intents one source may hold at once. */
  readonly sourceActiveLimit: number;
}

export type EnqueueEmailMessageIntentResult =
  | {
      readonly status: "enqueued";
      readonly intentId: string;
      /** True when an intent for the same triggering event already existed. */
      readonly deduplicated: boolean;
    }
  | {
      readonly status: "rejected";
      readonly errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED";
      readonly activeCount: number;
    };

export interface ClaimedEmailMessageIntent {
  readonly intentId: string;
  readonly kind: string;
  readonly input: unknown;
  readonly recipient: string;
  readonly claimToken: string;
  /** The attempt number this claim is entitled to record. */
  readonly attemptNumber: number;
}

export type EmailMessageAttemptOutcomeInput =
  | {
      readonly status: "sent";
      readonly provider: string;
      readonly providerMessageId: string | null;
    }
  | {
      readonly status: "skipped";
      readonly provider: string | null;
      readonly reason: EmailDeliverySkipReason;
    }
  | {
      readonly status: "failed";
      readonly provider: string | null;
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly retryable: boolean;
      /** When a retryable failure becomes due again. */
      readonly retryAt: Date;
      readonly maximumAttempts: number;
    };

export type RecordEmailMessageOutcomeResult =
  | "sent"
  | "skipped"
  | "retrying"
  | "failed"
  | "lost";

export interface EmailMessageIntentCounts {
  readonly pending: number;
  readonly retrying: number;
  /** Live intents that are due now and unclaimed. */
  readonly due: number;
  /** Live intents currently held under an unexpired claim. */
  readonly claimed: number;
  readonly failed: number;
  readonly sent: number;
  readonly skipped: number;
  readonly oldestDueAt: Date | null;
}

export interface EmailMessageIntentRecord {
  readonly id: string;
  readonly kind: string;
  readonly recipient: string;
  readonly source: string;
  readonly state: EmailMessageIntentState;
  readonly dueAt: Date;
  readonly attemptCount: number;
  readonly claimedBy: string | null;
  readonly claimExpiresAt: Date | null;
  readonly lastProvider: string | null;
  readonly lastErrorCode: string | null;
  readonly lastSkipReason: EmailDeliverySkipReason | null;
  readonly lastAttemptedAt: Date | null;
  readonly finalizedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EmailMessageAttemptRecord {
  readonly id: string;
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly attemptedAt: Date;
  readonly outcome: EmailMessageAttemptOutcome;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorRetryable: boolean | null;
  readonly skipReason: EmailDeliverySkipReason | null;
}

export interface EmailMessageIntentCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface EmailMessageIntentPage {
  readonly items: readonly EmailMessageIntentRecord[];
  readonly hasMore: boolean;
}

interface IntentRow {
  readonly id: string;
  readonly kind: string;
  readonly recipient: string;
  readonly source: string;
  readonly state: EmailMessageIntentState;
  readonly due_at: Date;
  readonly attempt_count: number;
  readonly claim_owner: string | null;
  readonly claim_expires_at: Date | null;
  readonly last_provider: string | null;
  readonly last_error_code: string | null;
  readonly last_skip_reason: string | null;
  readonly last_attempted_at: Date | null;
  readonly finalized_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ClaimedRow {
  readonly id: string;
  readonly kind: string;
  readonly input_json: unknown;
  readonly recipient: string;
  readonly claim_token: string;
  readonly attempt_count: number;
}

interface CountsRow {
  readonly pending: bigint;
  readonly retrying: bigint;
  readonly due: bigint;
  readonly claimed: bigint;
  readonly failed: bigint;
  readonly sent: bigint;
  readonly skipped: bigint;
  readonly oldest_due_at: Date | null;
}

const intentSelection = {
  id: true,
  kind: true,
  recipient: true,
  source: true,
  state: true,
  due_at: true,
  attempt_count: true,
  claim_owner: true,
  claim_expires_at: true,
  last_provider: true,
  last_error_code: true,
  last_skip_reason: true,
  last_attempted_at: true,
  finalized_at: true,
  created_at: true,
  updated_at: true,
} as const;

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

function count(value: bigint | number | null | undefined): number {
  return Number(value ?? 0);
}

function toIntentRecord(row: IntentRow): EmailMessageIntentRecord {
  return {
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    source: row.source,
    state: row.state,
    dueAt: row.due_at,
    attemptCount: row.attempt_count,
    claimedBy: row.claim_owner,
    claimExpiresAt: row.claim_expires_at,
    lastProvider: row.last_provider,
    lastErrorCode: row.last_error_code,
    lastSkipReason: (row.last_skip_reason ?? null) as
      | EmailDeliverySkipReason
      | null,
    lastAttemptedAt: row.last_attempted_at,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Records one message intent inside an already-open transaction, so a caller
 * whose own work must land atomically with the intent — issuing a one-time
 * token, say — composes both into one commit: an intent that was recorded
 * survives a crash, and one that was not recorded leaves no half-done send.
 *
 * Same-source enqueues serialize on a transaction-scoped advisory lock so
 * the per-source volume bound holds under concurrency without blocking other
 * sources; duplicate idempotency keys converge through the unique
 * constraint. Inputs are expected pre-validated (the repository method and
 * the services enqueue validate); `serializedInput` is the bounded JSON.
 */
export async function enqueueEmailMessageIntent(
  transaction: PackscoutTransactionClient,
  input: {
    readonly kind: string;
    readonly recipient: string;
    readonly idempotencyKey: string;
    readonly source: string;
    readonly serializedInput: string;
    readonly dueAt: Date;
    readonly now: Date;
    readonly sourceActiveLimit: number;
  },
): Promise<EnqueueEmailMessageIntentResult> {
  await transaction.$executeRaw(Prisma.sql`
    select pg_advisory_xact_lock(
      hashtextextended('email_message_outbox:' || ${input.source}, 0)
    )
  `);
  const [active] = await transaction.$queryRaw<Array<{ active: bigint }>>(
    Prisma.sql`
      select count(*)::bigint as active
      from email_message_intents
      where source = ${input.source}
        and state in (
          'pending'::email_message_intent_state,
          'retrying'::email_message_intent_state
        )
    `,
  );
  const activeCount = count(active?.active);
  if (activeCount >= input.sourceActiveLimit) {
    return {
      status: "rejected",
      errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      activeCount,
    };
  }
  const inserted = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      insert into email_message_intents (
        kind, input_json, recipient, idempotency_key, source,
        state, due_at, created_at, updated_at
      ) values (
        ${input.kind},
        ${input.serializedInput}::jsonb,
        ${input.recipient},
        ${input.idempotencyKey},
        ${input.source},
        'pending'::email_message_intent_state,
        ${input.dueAt},
        ${input.now},
        ${input.now}
      )
      on conflict (idempotency_key) do nothing
      returning id
    `,
  );
  if (inserted[0]) {
    return {
      status: "enqueued",
      intentId: inserted[0].id,
      deduplicated: false,
    };
  }
  // A concurrent enqueue for the same triggering event won the insert;
  // converge on its intent.
  const converged = await transaction.email_message_intents.findUnique({
    where: { idempotency_key: input.idempotencyKey },
    select: { id: true },
  });
  if (!converged) {
    throw new Error("Email outbox idempotency lookup failed.");
  }
  return { status: "enqueued", intentId: converged.id, deduplicated: true };
}

export class PrismaEmailMessageOutboxRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /**
   * Records one message intent durably and returns its identity. Performs no
   * network work. Duplicate idempotency keys converge on the first intent —
   * concurrently through the unique constraint, later through the lookup.
   * Enqueue volume is bounded per source: while a source already holds
   * `sourceActiveLimit` live intents, further enqueues are rejected rather
   * than allowed to grow the queue without bound. The check serializes
   * same-source enqueues on a transaction-scoped advisory lock so the bound
   * holds under concurrency without blocking other sources.
   */
  async enqueue(
    input: EnqueueEmailMessageIntentInput,
  ): Promise<EnqueueEmailMessageIntentResult> {
    if (!kindPattern.test(input.kind)) {
      throw new RangeError("Email message kind is invalid.");
    }
    if (
      typeof input.recipient !== "string" ||
      input.recipient.length > 320 ||
      !recipientPattern.test(input.recipient)
    ) {
      throw new RangeError("Email message recipient is invalid.");
    }
    if (!emailOutboxIdempotencyKeySchema.safeParse(input.idempotencyKey).success) {
      throw new RangeError("Email message idempotency key is invalid.");
    }
    if (!emailOutboxSourceSchema.safeParse(input.source).success) {
      throw new RangeError("Email outbox source is invalid.");
    }
    const serializedInput = JSON.stringify(input.input ?? null);
    if (
      serializedInput === undefined ||
      serializedInput.length > EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH
    ) {
      throw new RangeError("Email message input is not bounded JSON.");
    }
    assertTimestamp(input.dueAt, "Email message due time");
    assertTimestamp(input.now, "Email outbox enqueue time");
    const sourceActiveLimit = boundedInteger(
      input.sourceActiveLimit,
      1,
      1_000_000,
      "Email outbox source limit",
    );

    // Fast path: a repeat of an already-recorded triggering event needs no
    // lock and no capacity — it converges on the existing intent.
    const existing = await this.database.email_message_intents.findUnique({
      where: { idempotency_key: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return { status: "enqueued", intentId: existing.id, deduplicated: true };
    }

    return this.database.$transaction(
      (transaction) =>
        enqueueEmailMessageIntent(transaction, {
          ...input,
          sourceActiveLimit,
          serializedInput,
        }),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
  }

  /**
   * Claims a bounded batch of due intents for exclusive delivery. Eligible
   * rows are live (`pending` or `retrying`), due, and unclaimed or holding an
   * expired lease; `for update skip locked` keeps two concurrent drains from
   * ever claiming the same row. Fairness: within one claim, one recipient
   * contributes at most `perRecipientLimit` rows, so a single recipient's
   * backlog cannot monopolize the pass. The attempt counter increments at
   * claim time, so a claim that dies without recording an outcome still
   * consumes an attempt — a poisoned intent that kills its worker converges
   * on the attempt limit instead of looping forever.
   */
  async claimDueBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    perRecipientLimit: number;
    leaseMilliseconds: number;
  }): Promise<readonly ClaimedEmailMessageIntent[]> {
    if (!workerIdPattern.test(input.workerId)) {
      throw new RangeError("Email outbox worker ID is invalid.");
    }
    const limit = boundedInteger(input.limit, 1, 100, "Email outbox claim limit");
    const perRecipientLimit = boundedInteger(
      input.perRecipientLimit,
      1,
      100,
      "Email outbox per-recipient limit",
    );
    const leaseMilliseconds = boundedInteger(
      input.leaseMilliseconds,
      1_000,
      15 * 60_000,
      "Email outbox claim lease",
    );
    assertTimestamp(input.now, "Email outbox claim time");
    const claimExpiresAt = new Date(input.now.getTime() + leaseMilliseconds);
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRow[]>(Prisma.sql`
        with eligible as (
          select id, due_at, created_at,
                 row_number() over (
                   partition by recipient
                   order by due_at asc, created_at asc, id asc
                 ) as recipient_rank
          from email_message_intents
          where state in (
              'pending'::email_message_intent_state,
              'retrying'::email_message_intent_state
            )
            and due_at <= ${input.now}
            and (claim_expires_at is null or claim_expires_at <= ${input.now})
        ),
        candidates as (
          select intents.id, intents.due_at, intents.created_at
          from email_message_intents as intents
          where intents.id in (
              select id from eligible
              where recipient_rank <= ${perRecipientLimit}
              order by due_at asc, created_at asc, id asc
              limit ${limit}
            )
            and intents.state in (
              'pending'::email_message_intent_state,
              'retrying'::email_message_intent_state
            )
            and intents.due_at <= ${input.now}
            and (
              intents.claim_expires_at is null
              or intents.claim_expires_at <= ${input.now}
            )
          order by intents.due_at asc, intents.created_at asc, intents.id asc
          for update skip locked
        ),
        claimed as (
          update email_message_intents as intents
          set claim_owner = ${input.workerId},
              claim_token = gen_random_uuid(),
              claim_expires_at = ${claimExpiresAt},
              attempt_count = intents.attempt_count + 1,
              updated_at = ${input.now}
          from candidates
          where intents.id = candidates.id
          returning intents.id,
                    intents.kind,
                    intents.input_json,
                    intents.recipient,
                    intents.claim_token,
                    intents.attempt_count
        )
        select claimed.*
        from claimed
        inner join candidates on candidates.id = claimed.id
        order by candidates.due_at asc, candidates.created_at asc, candidates.id asc
      `);
      return rows.map((row) => ({
        intentId: row.id,
        kind: row.kind,
        input: row.input_json,
        recipient: row.recipient,
        claimToken: row.claim_token,
        attemptNumber: row.attempt_count,
      }));
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  /**
   * Records the outcome of one claimed delivery try: the attempt row and the
   * intent's transition in a single transaction, guarded by the claim token.
   * A write whose claim was already taken over reports `lost` and records
   * nothing — the new claimant owns the intent's history from here.
   */
  async recordAttemptOutcome(input: {
    intentId: string;
    claimToken: string;
    attemptNumber: number;
    occurredAt: Date;
    outcome: EmailMessageAttemptOutcomeInput;
  }): Promise<RecordEmailMessageOutcomeResult> {
    if (!uuidPattern.test(input.intentId) || !uuidPattern.test(input.claimToken)) {
      throw new RangeError("Email outbox claim identity is invalid.");
    }
    const attemptNumber = boundedInteger(
      input.attemptNumber,
      1,
      1_000_000,
      "Email outbox attempt number",
    );
    assertTimestamp(input.occurredAt, "Email outbox outcome time");
    const outcome = input.outcome;
    if (outcome.status === "failed") {
      if (!errorCodePattern.test(outcome.errorCode)) {
        throw new RangeError("Email outbox error code is invalid.");
      }
      if (
        typeof outcome.errorMessage !== "string" ||
        outcome.errorMessage.length > 200
      ) {
        throw new RangeError("Email outbox error message is unbounded.");
      }
      assertTimestamp(outcome.retryAt, "Email outbox retry time");
      boundedInteger(
        outcome.maximumAttempts,
        1,
        20,
        "Email outbox maximum attempts",
      );
    }
    if (outcome.status === "skipped" && !skipReasons.has(outcome.reason)) {
      throw new RangeError("Email outbox skip reason is invalid.");
    }

    return this.database.$transaction(async (transaction) => {
      const updated = await this.transitionIntent(transaction, input);
      if (updated === null) return "lost";
      await transaction.email_message_attempts.create({
        data: {
          intent_id: input.intentId,
          attempt_number: attemptNumber,
          attempted_at: input.occurredAt,
          outcome: outcome.status,
          provider: outcome.provider,
          provider_message_id:
            outcome.status === "sent" ? outcome.providerMessageId : null,
          error_code: outcome.status === "failed" ? outcome.errorCode : null,
          error_message:
            outcome.status === "failed" && outcome.errorMessage.length > 0
              ? outcome.errorMessage
              : null,
          error_retryable:
            outcome.status === "failed" ? outcome.retryable : null,
          skip_reason: outcome.status === "skipped" ? outcome.reason : null,
        },
      });
      return updated;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private async transitionIntent(
    transaction: Prisma.TransactionClient,
    input: {
      intentId: string;
      claimToken: string;
      occurredAt: Date;
      outcome: EmailMessageAttemptOutcomeInput;
    },
  ): Promise<Exclude<RecordEmailMessageOutcomeResult, "lost"> | null> {
    const guard = Prisma.sql`
      where id = ${input.intentId}::uuid
        and claim_token = ${input.claimToken}::uuid
        and state in (
          'pending'::email_message_intent_state,
          'retrying'::email_message_intent_state
        )
    `;
    const outcome = input.outcome;
    if (outcome.status === "sent") {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        update email_message_intents
        set state = 'sent'::email_message_intent_state,
            claim_owner = null,
            claim_token = null,
            claim_expires_at = null,
            last_provider = ${outcome.provider},
            last_error_code = null,
            last_skip_reason = null,
            last_attempted_at = ${input.occurredAt},
            finalized_at = ${input.occurredAt},
            updated_at = ${input.occurredAt}
        ${guard}
        returning id
      `);
      return rows[0] ? "sent" : null;
    }
    if (outcome.status === "skipped") {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        update email_message_intents
        set state = 'skipped'::email_message_intent_state,
            claim_owner = null,
            claim_token = null,
            claim_expires_at = null,
            last_provider = ${outcome.provider},
            last_error_code = null,
            last_skip_reason = ${outcome.reason},
            last_attempted_at = ${input.occurredAt},
            finalized_at = ${input.occurredAt},
            updated_at = ${input.occurredAt}
        ${guard}
        returning id
      `);
      return rows[0] ? "skipped" : null;
    }
    // Non-retryable failures rest terminally at once; retryable ones rest
    // only when the claim-incremented attempt counter has reached the limit.
    const terminalCondition = outcome.retryable
      ? Prisma.sql`attempt_count >= ${outcome.maximumAttempts}`
      : Prisma.sql`true`;
    const rows = await transaction.$queryRaw<Array<{ state: string }>>(Prisma.sql`
      update email_message_intents
      set state = case when ${terminalCondition}
            then 'failed'::email_message_intent_state
            else 'retrying'::email_message_intent_state
          end,
          due_at = case when ${terminalCondition}
            then due_at
            else ${outcome.retryAt}
          end,
          finalized_at = case when ${terminalCondition}
            then ${input.occurredAt}
            else null
          end,
          claim_owner = null,
          claim_token = null,
          claim_expires_at = null,
          last_provider = ${outcome.provider},
          last_error_code = ${outcome.errorCode},
          last_skip_reason = null,
          last_attempted_at = ${input.occurredAt},
          updated_at = ${input.occurredAt}
      ${guard}
      returning state::text as state
    `);
    if (!rows[0]) return null;
    return rows[0].state === "failed" ? "failed" : "retrying";
  }

  /**
   * Queue depth by state in one indexed aggregate — pending, retrying, due,
   * claimed, and terminal counts are answerable without paging or scanning
   * rows, the same way the recomputation queue reports its depth.
   */
  async countIntents(input: { now: Date }): Promise<EmailMessageIntentCounts> {
    assertTimestamp(input.now, "Email outbox count time");
    const [row] = await this.database.$queryRaw<CountsRow[]>(Prisma.sql`
      select
        count(*) filter (
          where state = 'pending'::email_message_intent_state
        ) as pending,
        count(*) filter (
          where state = 'retrying'::email_message_intent_state
        ) as retrying,
        count(*) filter (
          where state in (
              'pending'::email_message_intent_state,
              'retrying'::email_message_intent_state
            )
            and due_at <= ${input.now}
            and (claim_expires_at is null or claim_expires_at <= ${input.now})
        ) as due,
        count(*) filter (
          where state in (
              'pending'::email_message_intent_state,
              'retrying'::email_message_intent_state
            )
            and claim_expires_at is not null
            and claim_expires_at > ${input.now}
        ) as claimed,
        count(*) filter (
          where state = 'failed'::email_message_intent_state
        ) as failed,
        count(*) filter (
          where state = 'sent'::email_message_intent_state
        ) as sent,
        count(*) filter (
          where state = 'skipped'::email_message_intent_state
        ) as skipped,
        min(due_at) filter (
          where state in (
            'pending'::email_message_intent_state,
            'retrying'::email_message_intent_state
          )
        ) as oldest_due_at
      from email_message_intents
    `);
    return {
      pending: count(row?.pending),
      retrying: count(row?.retrying),
      due: count(row?.due),
      claimed: count(row?.claimed),
      failed: count(row?.failed),
      sent: count(row?.sent),
      skipped: count(row?.skipped),
      oldestDueAt: row?.oldest_due_at ?? null,
    };
  }

  /** Intents newest-first with bounded keyset pagination, for the admin. */
  async listIntents(input: {
    readonly limit: number;
    readonly state?: EmailMessageIntentState;
    readonly kind?: string;
    readonly recipient?: string;
    readonly before?: EmailMessageIntentCursor;
  }): Promise<EmailMessageIntentPage> {
    const limit = boundedInteger(input.limit, 1, 50, "Email outbox page limit");
    if (input.kind !== undefined && !kindPattern.test(input.kind)) {
      throw new RangeError("Email message kind is invalid.");
    }
    if (
      input.recipient !== undefined &&
      (input.recipient.length < 1 || input.recipient.length > 320)
    ) {
      throw new RangeError("Email message recipient filter is invalid.");
    }
    const rows = await this.database.email_message_intents.findMany({
      where: {
        ...(input.state ? { state: input.state } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.recipient ? { recipient: input.recipient } : {}),
        ...(input.before
          ? {
              OR: [
                { created_at: { lt: input.before.createdAt } },
                {
                  created_at: input.before.createdAt,
                  id: { lt: input.before.id },
                },
              ],
            }
          : {}),
      },
      select: intentSelection,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map((row) => toIntentRecord(row as IntentRow)),
      hasMore: rows.length > limit,
    };
  }

  async getIntent(intentId: string): Promise<EmailMessageIntentRecord | null> {
    if (!uuidPattern.test(intentId)) {
      throw new RangeError("Email outbox intent ID is invalid.");
    }
    const row = await this.database.email_message_intents.findUnique({
      where: { id: intentId },
      select: intentSelection,
    });
    return row ? toIntentRecord(row as IntentRow) : null;
  }

  /** One intent's attempt history in attempt order, for the admin. */
  async listAttempts(
    intentId: string,
  ): Promise<readonly EmailMessageAttemptRecord[]> {
    if (!uuidPattern.test(intentId)) {
      throw new RangeError("Email outbox intent ID is invalid.");
    }
    const rows = await this.database.email_message_attempts.findMany({
      where: { intent_id: intentId },
      orderBy: [{ attempt_number: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      intentId: row.intent_id,
      attemptNumber: row.attempt_number,
      attemptedAt: row.attempted_at,
      outcome: row.outcome as EmailMessageAttemptOutcome,
      provider: row.provider,
      providerMessageId: row.provider_message_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      errorRetryable: row.error_retryable,
      skipReason: (row.skip_reason ?? null) as EmailDeliverySkipReason | null,
    }));
  }

  /**
   * Ages out delivered history: terminal intents finalized before the cutoff
   * and their attempt records, at most `limit` intents per call. An intent
   * that is still pending or retrying is never eligible, whatever its age —
   * the state filter is the guarantee, not the caller's cutoff arithmetic.
   */
  async pruneHistory(input: {
    cutoffAt: Date;
    limit: number;
  }): Promise<number> {
    assertTimestamp(input.cutoffAt, "Email outbox prune cutoff");
    const limit = boundedInteger(input.limit, 1, 10_000, "Email outbox prune limit");
    return this.database.$transaction(async (transaction) => {
      const pruned = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        with prunable as (
          select id
          from email_message_intents
          where state in (
              'sent'::email_message_intent_state,
              'skipped'::email_message_intent_state,
              'failed'::email_message_intent_state
            )
            and finalized_at <= ${input.cutoffAt}
          order by finalized_at asc, id asc
          limit ${limit}
          for update skip locked
        ),
        deleted_attempts as (
          delete from email_message_attempts
          where intent_id in (select id from prunable)
          returning id
        )
        delete from email_message_intents
        where id in (select id from prunable)
        returning id
      `);
      return pruned.length;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
