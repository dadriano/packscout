import {
  EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH,
  emailOutboxIdempotencyKeySchema,
  emailOutboxSourceSchema,
  type EmailDeliverySkipReason,
  type EmailMessageAttemptOutcome,
  type EmailMessageIntentState,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralTransactionClient,
} from "./central-database.ts";
import type {
  ClaimedEmailMessageIntent,
  EmailMessageAttemptOutcomeInput,
  EmailMessageAttemptRecord,
  EmailMessageIntentCounts,
  EmailMessageIntentCursor,
  EmailMessageIntentPage,
  EmailMessageIntentRecord,
  EnqueueEmailMessageIntentInput,
  EnqueueEmailMessageIntentResult,
  RecordEmailMessageOutcomeResult,
} from "./email-message-outbox-repository.ts";

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

interface LockedIntentRow {
  readonly id: string;
  readonly row_version: bigint;
  readonly updated_at: Date;
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

function nextTimestamp(current: Date, requested: Date): Date {
  return new Date(Math.max(requested.getTime(), current.getTime() + 1));
}

export async function enqueueCentralEmailMessageIntent(
  transaction: CentralTransactionClient,
  input: Readonly<{
    kind: string;
    recipient: string;
    idempotencyKey: string;
    source: string;
    serializedInput: string;
    dueAt: Date;
    now: Date;
    sourceActiveLimit: number;
  }>,
): Promise<EnqueueEmailMessageIntentResult> {
  await transaction.$executeRaw(CentralPrisma.sql`
    select pg_advisory_xact_lock(
      hashtextextended('email_message_outbox:' || ${input.source}, 0)
    )
  `);
  const [existing] = await transaction.$queryRaw<readonly { id: string }[]>(
    CentralPrisma.sql`
      select id
      from email_message_intents
      where idempotency_key = ${input.idempotencyKey}
      limit 1
    `,
  );
  if (existing !== undefined) {
    return {
      status: "enqueued",
      intentId: existing.id,
      deduplicated: true,
    };
  }
  const [active] = await transaction.$queryRaw<
    readonly { active: bigint }[]
  >(CentralPrisma.sql`
    select count(*)::bigint as active
    from email_message_intents
    where source = ${input.source}
      and state in (
        'pending'::email_message_intent_state,
        'retrying'::email_message_intent_state
      )
  `);
  const activeCount = count(active?.active);
  if (activeCount >= input.sourceActiveLimit) {
    return {
      status: "rejected",
      errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      activeCount,
    };
  }
  const inserted = await transaction.$queryRaw<readonly { id: string }[]>(
    CentralPrisma.sql`
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
  if (inserted[0] !== undefined) {
    return {
      status: "enqueued",
      intentId: inserted[0].id,
      deduplicated: false,
    };
  }
  const converged = await transaction.email_message_intents.findUnique({
    where: { idempotency_key: input.idempotencyKey },
    select: { id: true },
  });
  if (converged === null) {
    throw new Error("Email outbox idempotency lookup failed.");
  }
  return {
    status: "enqueued",
    intentId: converged.id,
    deduplicated: true,
  };
}

export class CentralEmailMessageOutboxRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async enqueue(
    input: EnqueueEmailMessageIntentInput,
  ): Promise<EnqueueEmailMessageIntentResult> {
    if (!kindPattern.test(input.kind)) {
      throw new RangeError("Email message kind is invalid.");
    }
    if (
      typeof input.recipient !== "string"
      || input.recipient.length > 320
      || !recipientPattern.test(input.recipient)
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
      serializedInput === undefined
      || serializedInput.length > EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH
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
    const existing = await this.central.email_message_intents.findUnique({
      where: { idempotency_key: input.idempotencyKey },
      select: { id: true },
    });
    if (existing !== null) {
      return {
        status: "enqueued",
        intentId: existing.id,
        deduplicated: true,
      };
    }
    return this.central.$transaction(
      (transaction) => enqueueCentralEmailMessageIntent(transaction, {
        ...input,
        sourceActiveLimit,
        serializedInput,
      }),
      CENTRAL_TRANSACTION_OPTIONS,
    );
  }

  async claimDueBatch(input: Readonly<{
    workerId: string;
    now: Date;
    limit: number;
    perRecipientLimit: number;
    leaseMilliseconds: number;
  }>): Promise<readonly ClaimedEmailMessageIntent[]> {
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
    return this.central.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<readonly ClaimedRow[]>(
        CentralPrisma.sql`
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
            select intents.id, intents.row_version,
                   intents.due_at, intents.created_at
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
                row_version = intents.row_version + 1,
                updated_at = greatest(
                  intents.updated_at + interval '1 microsecond',
                  ${input.now}
                )
            from candidates
            where intents.id = candidates.id
              and intents.row_version = candidates.row_version
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
          order by candidates.due_at asc,
                   candidates.created_at asc,
                   candidates.id asc
        `,
      );
      return rows.map((row) => ({
        intentId: row.id,
        kind: row.kind,
        input: row.input_json,
        recipient: row.recipient,
        claimToken: row.claim_token,
        attemptNumber: row.attempt_count,
      }));
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async recordAttemptOutcome(input: Readonly<{
    intentId: string;
    claimToken: string;
    attemptNumber: number;
    occurredAt: Date;
    outcome: EmailMessageAttemptOutcomeInput;
  }>): Promise<RecordEmailMessageOutcomeResult> {
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
    if (input.outcome.status === "failed") {
      if (!errorCodePattern.test(input.outcome.errorCode)) {
        throw new RangeError("Email outbox error code is invalid.");
      }
      if (input.outcome.errorMessage.length > 200) {
        throw new RangeError("Email outbox error message is unbounded.");
      }
      assertTimestamp(input.outcome.retryAt, "Email outbox retry time");
      boundedInteger(
        input.outcome.maximumAttempts,
        1,
        20,
        "Email outbox maximum attempts",
      );
    }
    if (
      input.outcome.status === "skipped"
      && !skipReasons.has(input.outcome.reason)
    ) {
      throw new RangeError("Email outbox skip reason is invalid.");
    }
    return this.central.$transaction(async (transaction) => {
      const updated = await this.transitionIntent(transaction, input);
      if (updated === null) return "lost";
      const outcome = input.outcome;
      await transaction.email_message_attempts.create({
        data: {
          intent_id: input.intentId,
          attempt_number: attemptNumber,
          attempted_at: input.occurredAt,
          outcome: outcome.status,
          provider: outcome.provider,
          provider_message_id: outcome.status === "sent"
            ? outcome.providerMessageId
            : null,
          error_code: outcome.status === "failed" ? outcome.errorCode : null,
          error_message:
            outcome.status === "failed" && outcome.errorMessage.length > 0
              ? outcome.errorMessage
              : null,
          error_retryable: outcome.status === "failed"
            ? outcome.retryable
            : null,
          skip_reason: outcome.status === "skipped" ? outcome.reason : null,
        },
      });
      return updated;
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  private async transitionIntent(
    transaction: CentralTransactionClient,
    input: Readonly<{
      intentId: string;
      claimToken: string;
      occurredAt: Date;
      outcome: EmailMessageAttemptOutcomeInput;
    }>,
  ): Promise<Exclude<RecordEmailMessageOutcomeResult, "lost"> | null> {
    const [row] = await transaction.$queryRaw<readonly LockedIntentRow[]>(
      CentralPrisma.sql`
        select id, row_version, updated_at, attempt_count
        from email_message_intents
        where id = ${input.intentId}::uuid
          and claim_token = ${input.claimToken}::uuid
          and state in (
            'pending'::email_message_intent_state,
            'retrying'::email_message_intent_state
          )
        for update
      `,
    );
    if (row === undefined) return null;
    const outcome = input.outcome;
    const terminal = outcome.status !== "failed"
      || !outcome.retryable
      || row.attempt_count >= outcome.maximumAttempts;
    const state = outcome.status === "failed"
      ? terminal ? "failed" : "retrying"
      : outcome.status;
    const updated = await transaction.email_message_intents.updateMany({
      where: {
        id: input.intentId,
        claim_token: input.claimToken,
        row_version: row.row_version,
        state: { in: ["pending", "retrying"] },
      },
      data: {
        state,
        ...(outcome.status === "failed" && !terminal
          ? { due_at: outcome.retryAt }
          : {}),
        claim_owner: null,
        claim_token: null,
        claim_expires_at: null,
        last_provider: outcome.provider,
        last_error_code: outcome.status === "failed"
          ? outcome.errorCode
          : null,
        last_skip_reason: outcome.status === "skipped" ? outcome.reason : null,
        last_attempted_at: input.occurredAt,
        finalized_at: terminal ? input.occurredAt : null,
        row_version: { increment: 1 },
        updated_at: nextTimestamp(row.updated_at, input.occurredAt),
      },
    });
    return updated.count === 1 ? state : null;
  }

  async countIntents(input: Readonly<{
    now: Date;
  }>): Promise<EmailMessageIntentCounts> {
    assertTimestamp(input.now, "Email outbox count time");
    const [row] = await this.central.$queryRaw<readonly CountsRow[]>(
      CentralPrisma.sql`
        select
          count(*) filter (where state = 'pending') as pending,
          count(*) filter (where state = 'retrying') as retrying,
          count(*) filter (
            where state in ('pending', 'retrying')
              and due_at <= ${input.now}
              and (claim_expires_at is null or claim_expires_at <= ${input.now})
          ) as due,
          count(*) filter (
            where state in ('pending', 'retrying')
              and claim_expires_at is not null
              and claim_expires_at > ${input.now}
          ) as claimed,
          count(*) filter (where state = 'failed') as failed,
          count(*) filter (where state = 'sent') as sent,
          count(*) filter (where state = 'skipped') as skipped,
          min(due_at) filter (where state in ('pending', 'retrying'))
            as oldest_due_at
        from email_message_intents
      `,
    );
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

  async listIntents(input: Readonly<{
    limit: number;
    state?: EmailMessageIntentState;
    kind?: string;
    recipient?: string;
    before?: EmailMessageIntentCursor;
  }>): Promise<EmailMessageIntentPage> {
    const limit = boundedInteger(input.limit, 1, 50, "Email outbox page limit");
    if (input.kind !== undefined && !kindPattern.test(input.kind)) {
      throw new RangeError("Email message kind is invalid.");
    }
    if (
      input.recipient !== undefined
      && (input.recipient.length < 1 || input.recipient.length > 320)
    ) {
      throw new RangeError("Email message recipient filter is invalid.");
    }
    const rows = await this.central.email_message_intents.findMany({
      where: {
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.recipient === undefined
          ? {}
          : { recipient: input.recipient }),
        ...(input.before === undefined
          ? {}
          : {
              OR: [
                { created_at: { lt: input.before.createdAt } },
                {
                  created_at: input.before.createdAt,
                  id: { lt: input.before.id },
                },
              ],
            }),
      },
      select: intentSelection,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map(toIntentRecord),
      hasMore: rows.length > limit,
    };
  }

  async getIntent(intentId: string): Promise<EmailMessageIntentRecord | null> {
    if (!uuidPattern.test(intentId)) {
      throw new RangeError("Email outbox intent ID is invalid.");
    }
    const row = await this.central.email_message_intents.findUnique({
      where: { id: intentId },
      select: intentSelection,
    });
    return row === null ? null : toIntentRecord(row);
  }

  async listAttempts(
    intentId: string,
  ): Promise<readonly EmailMessageAttemptRecord[]> {
    if (!uuidPattern.test(intentId)) {
      throw new RangeError("Email outbox intent ID is invalid.");
    }
    const rows = await this.central.email_message_attempts.findMany({
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

  async pruneHistory(input: Readonly<{
    cutoffAt: Date;
    limit: number;
  }>): Promise<number> {
    assertTimestamp(input.cutoffAt, "Email outbox prune cutoff");
    const limit = boundedInteger(
      input.limit,
      1,
      10_000,
      "Email outbox prune limit",
    );
    return this.central.$transaction(async (transaction) => {
      const pruned = await transaction.$queryRaw<readonly { id: string }[]>(
        CentralPrisma.sql`
          with prunable as (
            select id
            from email_message_intents
            where state in ('sent', 'skipped', 'failed')
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
        `,
      );
      return pruned.length;
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async requeueTerminalIntent(input: Readonly<{
    intentId: string;
    now: Date;
  }>): Promise<EmailMessageIntentRecord | null> {
    if (!uuidPattern.test(input.intentId)) {
      throw new RangeError("Email outbox intent ID is invalid.");
    }
    assertTimestamp(input.now, "Email outbox requeue time");
    return this.central.$transaction(async (transaction) => {
      const [row] = await transaction.$queryRaw<readonly LockedIntentRow[]>(
        CentralPrisma.sql`
          select id, row_version, updated_at, attempt_count
          from email_message_intents
          where id = ${input.intentId}::uuid
            and state = 'failed'::email_message_intent_state
          for update
        `,
      );
      if (row === undefined) return null;
      const updated = await transaction.email_message_intents.updateMany({
        where: {
          id: input.intentId,
          row_version: row.row_version,
          state: "failed",
        },
        data: {
          state: "pending",
          due_at: input.now,
          finalized_at: null,
          claim_owner: null,
          claim_token: null,
          claim_expires_at: null,
          row_version: { increment: 1 },
          updated_at: nextTimestamp(row.updated_at, input.now),
        },
      });
      if (updated.count !== 1) return null;
      const requeued = await transaction.email_message_intents.findUnique({
        where: { id: input.intentId },
        select: intentSelection,
      });
      return requeued === null ? null : toIntentRecord(requeued);
    }, CENTRAL_TRANSACTION_OPTIONS);
  }
}
