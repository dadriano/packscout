import { z } from "zod";
import {
  emailMessageIntentStateSchema,
  type EmailMessageIntentState,
} from "./email-outbox.ts";
import type { EmailDeliverySkipReason } from "./email-delivery.ts";

/**
 * Shared message-delivery vocabulary for the admin surface.
 *
 * The durable email outbox records every delivery intent and attempt; this is
 * the vocabulary the admin server (which reads the queue) and the admin
 * browser (which renders the delivery history) agree on. Nothing here can
 * carry a message body: the queue's read model never exposes the stored
 * rendering input, and no shape below has a field one could ride in on.
 *
 * Recipient addresses are personal data, so every request shape travels in a
 * POST body — a recipient search can never appear in a URL, a query string,
 * browser history, or an access log — and every stable code describes a
 * failure without echoing an address.
 */

/** The listing page size, matching the queue read model's bounded page. */
export const MESSAGE_DELIVERY_PAGE_SIZE = 20;
/** Recipient addresses are bounded at enqueue time; restated for requests. */
export const MESSAGE_DELIVERY_MAX_RECIPIENT_LENGTH = 320;
/** Message kinds share the catalogue's bounded identifier alphabet. */
export const MESSAGE_DELIVERY_MAX_KIND_LENGTH = 64;
/** Listing cursors are opaque server-issued values, bounded for transport. */
export const MESSAGE_DELIVERY_MAX_CURSOR_LENGTH = 512;
/** Enqueue sources share the message-kind alphabet. */
export const MESSAGE_DELIVERY_MAX_SOURCE_LENGTH = 64;
/** Provider adapter names, bounded as the delivery boundary bounds them. */
export const MESSAGE_DELIVERY_MAX_PROVIDER_LENGTH = 64;
/** Provider-assigned message identifiers, bounded as stored. */
export const MESSAGE_DELIVERY_MAX_PROVIDER_MESSAGE_ID_LENGTH = 256;
/** Stable delivery error codes, bounded as the queue stores them. */
export const MESSAGE_DELIVERY_MAX_ERROR_CODE_LENGTH = 128;
/** Sanitized failure text recorded per attempt, bounded as stored. */
export const MESSAGE_DELIVERY_MAX_ERROR_MESSAGE_LENGTH = 200;

const messageKindField = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "Message kinds are lowercase identifiers.",
  );

const intentIdField = z
  .string()
  .trim()
  .uuid("Choose a delivery record.");

/**
 * The listing request. The recipient filter is an exact, full address — the
 * queue matches the stored recipient verbatim — and travels in the body so
 * an address can never be expressed as a URL.
 */
export const listMessageDeliveriesRequestSchema = z
  .object({
    state: emailMessageIntentStateSchema.optional(),
    kind: messageKindField.optional(),
    recipient: z
      .string()
      .trim()
      .min(3, "Enter a full recipient address.")
      .max(MESSAGE_DELIVERY_MAX_RECIPIENT_LENGTH)
      .optional(),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(MESSAGE_DELIVERY_MAX_CURSOR_LENGTH)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MESSAGE_DELIVERY_PAGE_SIZE)
      .default(MESSAGE_DELIVERY_PAGE_SIZE),
  })
  .strict();

export type ListMessageDeliveriesRequest = z.input<
  typeof listMessageDeliveriesRequestSchema
>;
export type NormalizedListMessageDeliveriesRequest = z.output<
  typeof listMessageDeliveriesRequestSchema
>;

/** Queue-state counts take no parameters; the body is an empty object. */
export const messageDeliveryCountsRequestSchema = z.object({}).strict();

/** One intent's detail — its identity is an opaque queue UUID, not personal. */
export const messageDeliveryDetailRequestSchema = z
  .object({ intentId: intentIdField })
  .strict();

export type MessageDeliveryDetailRequest = z.input<
  typeof messageDeliveryDetailRequestSchema
>;

export const retryMessageDeliveryRequestSchema = z
  .object({ intentId: intentIdField })
  .strict();

export type RetryMessageDeliveryRequest = z.input<
  typeof retryMessageDeliveryRequestSchema
>;

/**
 * One delivery intent as the history lists it: what kind of message, to whom,
 * and what has happened to it. Deliberately no field for the message content
 * — the log shows what kind of message it was, never what it said.
 */
export interface MessageDeliveryIntentRow {
  /** The queue's opaque intent id; safe in memory and in a route path. */
  readonly intentId: string;
  readonly kind: string;
  /** The resolved recipient address. Shown for diagnosis; never in a URL. */
  readonly recipient: string;
  /** The triggering source the intent was enqueued for. Never personal. */
  readonly source: string;
  readonly state: EmailMessageIntentState;
  readonly attemptCount: number;
  readonly createdAt: string;
  /** When the intent is or was next due; retries move it forward. */
  readonly dueAt: string;
  readonly lastAttemptedAt: string | null;
  readonly lastProvider: string | null;
  /** The stable error code of the most recent failure, when there is one. */
  readonly lastErrorCode: string | null;
  readonly lastSkipReason: EmailDeliverySkipReason | null;
  /** When a terminal state was reached; null while the intent is live. */
  readonly finalizedAt: string | null;
}

export interface MessageDeliveryListPage {
  readonly items: readonly MessageDeliveryIntentRow[];
  /** Opaque continuation handle; null when the listing is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * One delivery attempt: when it ran, which provider, what came of it, and the
 * provider's own message identifier on success — the value that correlates a
 * PackScout attempt with the provider's records.
 */
export interface MessageDeliveryAttemptRow {
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly outcome: "sent" | "skipped" | "failed";
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  /** The stable error code on failure; never raw provider text. */
  readonly errorCode: string | null;
  /** Sanitized, bounded failure detail recorded by the delivery boundary. */
  readonly errorMessage: string | null;
  readonly skipReason: EmailDeliverySkipReason | null;
}

export interface MessageDeliveryDetail {
  readonly intent: MessageDeliveryIntentRow;
  readonly attempts: readonly MessageDeliveryAttemptRow[];
}

/**
 * Queue depth by state, answerable without paging the history: a stuck queue
 * is noticed from these numbers rather than discovered by scrolling.
 */
export interface MessageDeliveryCounts {
  readonly pending: number;
  readonly retrying: number;
  /** Live intents due now and unclaimed. */
  readonly due: number;
  /** Live intents currently held under an unexpired drain claim. */
  readonly claimed: number;
  /** Terminally failed intents — the ones an operator can retry. */
  readonly failed: number;
  readonly sent: number;
  readonly skipped: number;
  readonly oldestDueAt: string | null;
}

/** A successful retry returns the intent as re-queued. */
export interface MessageDeliveryRetryResponse {
  readonly intent: MessageDeliveryIntentRow;
}

/**
 * The admin's stable message-delivery failure codes. Every failure the
 * browser can see resolves to one of these; no database or upstream error
 * detail is ever restated, and no code or message carries an address.
 */
export const messageDeliveryAdminErrorCodes = [
  "MESSAGE_DELIVERY_UNAVAILABLE",
  "MESSAGE_DELIVERY_INTENT_NOT_FOUND",
  "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL",
  "INVALID_MESSAGE_DELIVERY_REQUEST",
  "INVALID_MESSAGE_DELIVERY_CURSOR",
] as const;

export type MessageDeliveryAdminErrorCode =
  (typeof messageDeliveryAdminErrorCodes)[number];
