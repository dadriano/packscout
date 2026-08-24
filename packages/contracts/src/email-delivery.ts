import { z } from "zod";
import { operationalStableCodeSchema } from "./operations.ts";

/**
 * Outbound email delivery vocabulary. This is the closed set of shapes the
 * message delivery boundary accepts and reports: the rendered message an
 * adapter is handed, and the sent / skipped / failed outcome every later
 * consumer branches on. Nothing here knows what any message says or which
 * provider is configured.
 */

/**
 * A message kind is a bounded identifier owned by the message catalogue, not a
 * closed list here, so adding a message never changes the delivery boundary.
 */
export const emailMessageKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Registered delivery adapter names share the repository's key alphabet. */
export const emailProviderNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/);

/** Delivery failure codes reuse the operational stable-code alphabet. */
export const emailDeliveryErrorCodeSchema = operationalStableCodeSchema;

/**
 * Sanitized provider error text recorded on a failed outcome never exceeds
 * this length, wherever it is stored or displayed.
 */
export const EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH = 200;

/** Provider-assigned message identifiers are stored bounded or not at all. */
export const EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH = 256;

const emailRecipientSchema = z
  .string()
  .trim()
  .max(320, "Recipient addresses are bounded to 320 characters.")
  .email("Recipient must be a valid email address.");

/**
 * The rendered message a delivery adapter is handed: the catalogue renders
 * content into this shape (messaging/003), and the boundary refuses anything
 * else before a provider is reached.
 */
export const renderedEmailMessageSchema = z
  .object({
    kind: emailMessageKindSchema,
    toEmail: emailRecipientSchema,
    subject: z.string().trim().min(1).max(200),
    textBody: z.string().min(1).max(100_000),
    htmlBody: z.string().min(1).max(500_000),
  })
  .strict();

export type RenderedEmailMessage = z.infer<typeof renderedEmailMessageSchema>;

export const emailDeliverySkipReasonSchema = z.enum([
  "delivery_disabled",
  "console_mode",
  "missing_configuration",
]);

export type EmailDeliverySkipReason = z.infer<
  typeof emailDeliverySkipReasonSchema
>;

export interface EmailDeliverySentResult {
  readonly status: "sent";
  /** The registered name of the adapter that delivered the message. */
  readonly provider: string;
  /** The provider's own message identifier when it supplied one. */
  readonly providerMessageId: string | null;
}

export interface EmailDeliverySkippedResult {
  readonly status: "skipped";
  readonly reason: EmailDeliverySkipReason;
}

export interface EmailDeliveryFailedResult {
  readonly status: "failed";
  /**
   * The resolved adapter's registered name, or null when the failure precedes
   * adapter resolution (an invalid rendered message, or no adapter at all).
   */
  readonly provider: string | null;
  /** A stable code matching {@link emailDeliveryErrorCodeSchema}. */
  readonly errorCode: string;
  /**
   * Sanitized, length-bounded human-readable detail. Never raw provider text,
   * and never a credential, token, recipient address, or message body.
   */
  readonly message: string;
  /**
   * Whether a retry could succeed: transport, network, timeout, rate-limit,
   * and provider server errors are retryable; a rejected recipient, a
   * malformed message, and missing configuration are not.
   */
  readonly retryable: boolean;
}

/**
 * The only outcome vocabulary delivery consumers branch on. Durable delivery
 * maps retryable failures to retries; the admin displays these outcomes.
 */
export type EmailDeliveryResult =
  | EmailDeliverySentResult
  | EmailDeliverySkippedResult
  | EmailDeliveryFailedResult;

export type EmailDeliveryStatus = EmailDeliveryResult["status"];
