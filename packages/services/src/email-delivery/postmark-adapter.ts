import {
  EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH,
  type RenderedEmailMessage,
} from "@packscout/contracts";
import type {
  EmailAdapterSendContext,
  EmailAdapterSendResult,
  EmailDeliveryAdapter,
} from "./adapter.ts";
import {
  isRetryableEmailTransportStatus,
  sanitizeEmailProviderErrorText,
} from "./transport.ts";

/**
 * The Postmark delivery adapter: one provider behind the message delivery
 * boundary. It is deliberately thin — no queueing, no retries, no templates,
 * no knowledge of what any message means. It posts one rendered message to
 * Postmark's email endpoint through the injected transport and classifies the
 * answer into the boundary's closed result vocabulary. Nothing outside this
 * module refers to the provider by name.
 *
 * The wire contract coded against (pinned again by this adapter's tests):
 *
 *     POST https://api.postmarkapp.com/email
 *     Accept: application/json
 *     Content-Type: application/json
 *     X-Postmark-Server-Token: <server token>
 *     { "From", "To", "Subject", "TextBody", "HtmlBody", "MessageStream",
 *       "ReplyTo"? }
 *
 * Success is an OK status whose body carries `"ErrorCode": 0` alongside
 * `"MessageID"` and `"Message"`. Failures surface a numeric `ErrorCode` and a
 * `Message` — sometimes inside a success-shaped response, which is still a
 * failure carrying that code.
 */

export const POSTMARK_EMAIL_ADAPTER_NAME = "postmark";
export const POSTMARK_EMAIL_API_URL = "https://api.postmarkapp.com/email";

/** Server-side configuration only. The token is a secret and is never logged. */
export const POSTMARK_SERVER_TOKEN_VARIABLE = "POSTMARK_SERVER_TOKEN";
export const POSTMARK_FROM_EMAIL_VARIABLE = "POSTMARK_FROM_EMAIL";
export const POSTMARK_REPLY_TO_EMAIL_VARIABLE = "POSTMARK_REPLY_TO_EMAIL";
export const POSTMARK_MESSAGE_STREAM_VARIABLE = "POSTMARK_MESSAGE_STREAM";

/**
 * Postmark's default transactional stream. Transactional and broadcast
 * streams behave differently for deliverability and reporting, so the stream
 * is configurable and defaults to the transactional one when unset.
 */
export const POSTMARK_DEFAULT_MESSAGE_STREAM = "outbound";

export const POSTMARK_UNCONFIGURED_ERROR_CODE = "EMAIL_POSTMARK_UNCONFIGURED";
export const POSTMARK_TRANSPORT_ERROR_CODE = "EMAIL_POSTMARK_TRANSPORT_FAILED";
export const POSTMARK_RESPONSE_INVALID_ERROR_CODE =
  "EMAIL_POSTMARK_RESPONSE_INVALID";
/**
 * Provider-evaluated failures carry `EMAIL_POSTMARK_ERROR_<code>`, where the
 * number is Postmark's body `ErrorCode` when it supplied one (300 invalid
 * email request, 406 inactive recipient, ...) and the HTTP status otherwise —
 * so the provider's own code is preserved as the stable code.
 */
export const POSTMARK_PROVIDER_ERROR_CODE_PREFIX = "EMAIL_POSTMARK_ERROR_";

/**
 * A successful Postmark send narrows the contract's sent result with the
 * resolved message stream, so later delivery investigation can correlate the
 * provider's message identifier with the stream it went out on. The failed
 * variant is exactly the contract's; this adapter adds nothing to the
 * boundary's closed outcome vocabulary.
 */
export type PostmarkEmailSendResult =
  | (Extract<EmailAdapterSendResult, { status: "sent" }> & {
      readonly messageStream: string;
    })
  | Extract<EmailAdapterSendResult, { status: "failed" }>;

export interface PostmarkEmailDeliveryAdapter extends EmailDeliveryAdapter {
  send(
    message: RenderedEmailMessage,
    context: EmailAdapterSendContext,
  ): Promise<PostmarkEmailSendResult>;
}

function configuredValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The names of the required variables absent from the environment, in a
 * stable order. Names only — never a value.
 */
export function missingPostmarkConfiguration(
  env: NodeJS.ProcessEnv,
): readonly string[] {
  return [POSTMARK_SERVER_TOKEN_VARIABLE, POSTMARK_FROM_EMAIL_VARIABLE].filter(
    (name) => configuredValue(env, name) === null,
  );
}

/** The stream a send would use: the configured one, else the transactional default. */
export function resolvePostmarkMessageStream(env: NodeJS.ProcessEnv): string {
  return (
    configuredValue(env, POSTMARK_MESSAGE_STREAM_VARIABLE) ??
    POSTMARK_DEFAULT_MESSAGE_STREAM
  );
}

const postmarkMissingConfigurationDescription = {
  errorCode: POSTMARK_UNCONFIGURED_ERROR_CODE,
  message: `Set ${POSTMARK_SERVER_TOKEN_VARIABLE} and ${POSTMARK_FROM_EMAIL_VARIABLE} to enable the Postmark email adapter.`,
} as const;

function providerErrorCode(code: number): string {
  return `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}${code}`;
}

function failedResult(
  errorCode: string,
  providerText: string,
  retryable: boolean,
): PostmarkEmailSendResult {
  return {
    status: "failed",
    errorCode,
    message: sanitizeEmailProviderErrorText(providerText),
    retryable,
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const candidate: unknown = JSON.parse(text);
    return typeof candidate === "object" && candidate !== null
      ? (candidate as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizePostmarkMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 &&
    trimmed.length <= EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH
    ? trimmed
    : null;
}

interface PostmarkResponseBody {
  /** Positive provider error code from the body, when it carried one. */
  readonly errorCode: number | null;
  /** True only when the body explicitly reports `ErrorCode: 0`. */
  readonly reportsSuccess: boolean;
  readonly messageId: string | null;
  /** The body `Message` when present, else the raw text for the sanitizer. */
  readonly providerText: string;
}

function readPostmarkResponseBody(text: string): PostmarkResponseBody {
  const body = parseJsonRecord(text);
  if (body === null) {
    return {
      errorCode: null,
      reportsSuccess: false,
      messageId: null,
      providerText: text,
    };
  }
  const rawCode = body.ErrorCode;
  return {
    errorCode:
      typeof rawCode === "number" && Number.isSafeInteger(rawCode) && rawCode > 0
        ? rawCode
        : null,
    reportsSuccess: rawCode === 0,
    messageId: normalizePostmarkMessageId(body.MessageID),
    providerText: typeof body.Message === "string" ? body.Message : text,
  };
}

async function sendThroughPostmark(
  message: RenderedEmailMessage,
  context: EmailAdapterSendContext,
): Promise<PostmarkEmailSendResult> {
  const token = configuredValue(context.env, POSTMARK_SERVER_TOKEN_VARIABLE);
  const from = configuredValue(context.env, POSTMARK_FROM_EMAIL_VARIABLE);
  if (token === null || from === null) {
    // Fail closed before any transport use, naming exactly what is absent —
    // names only, never a value.
    const missing = missingPostmarkConfiguration(context.env);
    return {
      status: "failed",
      errorCode: POSTMARK_UNCONFIGURED_ERROR_CODE,
      message: `Postmark email adapter is missing ${missing.join(" and ")}.`,
      retryable: false,
    };
  }
  const messageStream = resolvePostmarkMessageStream(context.env);
  const replyTo = configuredValue(context.env, POSTMARK_REPLY_TO_EMAIL_VARIABLE);
  const requestBody: Record<string, string> = {
    From: from,
    To: message.toEmail,
    Subject: message.subject,
    TextBody: message.textBody,
    HtmlBody: message.htmlBody,
    MessageStream: messageStream,
  };
  if (replyTo !== null) {
    requestBody.ReplyTo = replyTo;
  }
  let response: Response;
  let responseText: string;
  try {
    response = await context.fetchImpl(POSTMARK_EMAIL_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify(requestBody),
    });
    responseText = await response.text();
  } catch (error) {
    // Network failures and transport timeouts are retryable: a lost response
    // may still have delivered, and the durable outbox's idempotency accepts
    // that bounded duplicate risk by design. The closed result union gains no
    // new field for it.
    return failedResult(
      POSTMARK_TRANSPORT_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
  const body = readPostmarkResponseBody(responseText);
  if (response.ok) {
    if (body.reportsSuccess) {
      return {
        status: "sent",
        providerMessageId: body.messageId,
        messageStream,
      };
    }
    if (body.errorCode !== null) {
      // A success-shaped response carrying a provider error code is still a
      // failure: Postmark evaluated the request and refused it, so a retry
      // cannot change the answer.
      return failedResult(
        providerErrorCode(body.errorCode),
        body.providerText,
        false,
      );
    }
    // A success status whose body does not confirm `ErrorCode: 0` proves
    // nothing about delivery; retry with the same bounded duplicate risk as a
    // lost response.
    return failedResult(
      POSTMARK_RESPONSE_INVALID_ERROR_CODE,
      body.providerText,
      true,
    );
  }
  return failedResult(
    providerErrorCode(body.errorCode ?? response.status),
    body.providerText,
    isRetryableEmailTransportStatus(response.status),
  );
}

/**
 * Creates the Postmark adapter. Registering it is the single step that makes
 * it selectable — by its stable name or as the automatic default — with no
 * caller change anywhere:
 *
 *     registry.register(createPostmarkEmailDeliveryAdapter());
 */
export function createPostmarkEmailDeliveryAdapter(): PostmarkEmailDeliveryAdapter {
  return {
    name: POSTMARK_EMAIL_ADAPTER_NAME,
    missingConfiguration: postmarkMissingConfigurationDescription,
    isConfigured: (env) => missingPostmarkConfiguration(env).length === 0,
    send: sendThroughPostmark,
  };
}
