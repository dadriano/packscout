import { z } from "zod";
import { emailDeliverySkipReasonSchema } from "./email-delivery.ts";

/**
 * Durable email outbox vocabulary. A message is enqueued as an intent, a
 * background drain delivers it through the delivery boundary, and every try
 * leaves an attempt record. These are the closed state and outcome words the
 * queue persists and the admin's delivery history displays; nothing here
 * knows what any message says.
 */

/**
 * An intent's lifecycle. `pending` and `retrying` are the live states a drain
 * may claim; `sent`, `skipped`, and `failed` are terminal and never revisited
 * by the drain itself — only an explicit operator retry re-enters the queue.
 */
export const emailMessageIntentStateSchema = z.enum([
  "pending",
  "retrying",
  "sent",
  "skipped",
  "failed",
]);

export type EmailMessageIntentState = z.infer<
  typeof emailMessageIntentStateSchema
>;

/** The terminal states, in the order the admin lists them. */
export const EMAIL_MESSAGE_INTENT_TERMINAL_STATES = Object.freeze([
  "sent",
  "skipped",
  "failed",
] as const);

export function isTerminalEmailMessageIntentState(
  state: EmailMessageIntentState,
): boolean {
  return (
    state === "sent" || state === "skipped" || state === "failed"
  );
}

/**
 * What one delivery attempt produced: the delivery boundary's own closed
 * result vocabulary, recorded per try.
 */
export const emailMessageAttemptOutcomeSchema = z.enum([
  "sent",
  "skipped",
  "failed",
]);

export type EmailMessageAttemptOutcome = z.infer<
  typeof emailMessageAttemptOutcomeSchema
>;

/** A skipped attempt records why, using the delivery boundary's skip reasons. */
export const emailMessageAttemptSkipReasonSchema = emailDeliverySkipReasonSchema;

/**
 * The triggering source an intent was enqueued for — the unit the queue's
 * per-source volume bound applies to, so one misbehaving caller cannot fill
 * the queue for everyone. Sources share the message-kind alphabet.
 */
export const emailOutboxSourceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * The idempotency key derived from a triggering event. Two enqueues carrying
 * the same key converge on one intent, whether they arrive concurrently or
 * minutes apart.
 */
export const emailOutboxIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);

/**
 * A stored rendering input is bounded when serialized so an intent row can
 * never grow past what one message could legitimately need.
 */
export const EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH = 16_384;
