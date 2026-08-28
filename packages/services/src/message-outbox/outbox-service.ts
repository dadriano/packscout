import {
  EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH,
  emailMessageKindSchema,
  emailOutboxIdempotencyKeySchema,
  emailOutboxSourceSchema,
} from "@packscout/contracts";
import { z } from "zod";
import type { ProviderClock } from "../provider-configuration-service.ts";

/**
 * The enqueue side of the durable email outbox. Enqueueing records the intent
 * to send one message and returns; it performs no network work, resolves no
 * provider, and renders nothing, so a caller's own operation succeeds or
 * fails on its own merits whatever later happens to the message. Delivery is
 * the drain's job (`drain-service.ts`), on its own schedule.
 *
 * Consumers — alert routing, access decisions, welcome, account links —
 * enqueue here and never call the delivery boundary directly.
 */

const recipientSchema = z.string().trim().max(320).email();

/** Structural subset of the database outbox repository the enqueue side uses. */
export interface EmailMessageOutboxEnqueueQueue {
  enqueue(input: {
    readonly kind: string;
    readonly input: unknown;
    readonly recipient: string;
    readonly idempotencyKey: string;
    readonly source: string;
    readonly dueAt: Date;
    readonly now: Date;
    readonly sourceActiveLimit: number;
  }): Promise<
    | { readonly status: "enqueued"; readonly intentId: string; readonly deduplicated: boolean }
    | {
        readonly status: "rejected";
        readonly errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED";
        readonly activeCount: number;
      }
  >;
}

export interface EnqueueEmailMessageCommand {
  /** A message kind the catalogue can render. */
  readonly kind: string;
  /** The typed rendering input, stored as bounded JSON. Never a rendered body. */
  readonly input: unknown;
  readonly recipient: string;
  /** Derived from the triggering event; duplicates converge on one intent. */
  readonly idempotencyKey: string;
  /** The triggering source the per-source volume bound applies to. */
  readonly source: string;
  /** When the message becomes due; defaults to immediately. */
  readonly dueAt?: Date;
}

export type EnqueueEmailMessageResult =
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
    }
  | {
      readonly status: "invalid";
      readonly errorCode: "EMAIL_OUTBOX_REQUEST_INVALID";
      /** Static, content-free description of what failed validation. */
      readonly reason: string;
    };

export interface EmailMessageOutboxServiceOptions {
  readonly queue: EmailMessageOutboxEnqueueQueue;
  readonly clock?: ProviderClock;
  /**
   * Active (pending or retrying) intents one source may hold before further
   * enqueues are rejected. This is the queue's protection against a
   * misbehaving caller filling it without bound; a rejected enqueue is an
   * explicit result the caller sees, not a silent drop.
   */
  readonly sourceActiveLimit?: number;
}

const DEFAULT_SOURCE_ACTIVE_LIMIT = 10_000;

export class EmailMessageOutboxService {
  readonly #queue: EmailMessageOutboxEnqueueQueue;
  readonly #clock: ProviderClock;
  readonly #sourceActiveLimit: number;

  constructor(options: EmailMessageOutboxServiceOptions) {
    const limit = options.sourceActiveLimit ?? DEFAULT_SOURCE_ACTIVE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw new RangeError("Email outbox source limit is out of bounds.");
    }
    this.#queue = options.queue;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#sourceActiveLimit = limit;
  }

  /**
   * Records one message intent durably and returns its identity. Validation
   * failures are explicit results rather than exceptions, so a caller can
   * record the refusal without treating it as its own outage.
   */
  async enqueueEmailMessage(
    command: EnqueueEmailMessageCommand,
  ): Promise<EnqueueEmailMessageResult> {
    const invalid = (reason: string): EnqueueEmailMessageResult => ({
      status: "invalid",
      errorCode: "EMAIL_OUTBOX_REQUEST_INVALID",
      reason,
    });
    if (!emailMessageKindSchema.safeParse(command.kind).success) {
      return invalid("The message kind is not a valid catalogue kind name.");
    }
    const recipient = recipientSchema.safeParse(command.recipient);
    if (!recipient.success) {
      return invalid("The recipient is not a valid bounded email address.");
    }
    if (
      !emailOutboxIdempotencyKeySchema.safeParse(command.idempotencyKey).success
    ) {
      return invalid("The idempotency key is missing or out of bounds.");
    }
    if (!emailOutboxSourceSchema.safeParse(command.source).success) {
      return invalid("The source is not a valid source name.");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(command.input ?? null);
    } catch {
      return invalid("The rendering input is not serializable JSON.");
    }
    if (
      serialized === undefined ||
      serialized.length > EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH
    ) {
      return invalid("The rendering input exceeds the stored JSON bound.");
    }
    if (
      command.dueAt !== undefined &&
      (!(command.dueAt instanceof Date) ||
        !Number.isFinite(command.dueAt.getTime()))
    ) {
      return invalid("The due time is not a valid instant.");
    }
    const now = this.#clock.now();
    return this.#queue.enqueue({
      kind: command.kind,
      input: command.input ?? null,
      recipient: recipient.data,
      idempotencyKey: command.idempotencyKey,
      source: command.source,
      dueAt: command.dueAt ?? now,
      now,
      sourceActiveLimit: this.#sourceActiveLimit,
    });
  }
}
