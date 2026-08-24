import {
  EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH,
  emailDeliveryErrorCodeSchema,
} from "@packscout/contracts";

/**
 * Transport-side helpers shared by the delivery boundary and every adapter:
 * the deadline that bounds a send in time, the honest retryability rule for
 * HTTP statuses, and the sanitizer that keeps provider error text safe to
 * record. Adapters use these instead of inventing their own.
 */

export const EMAIL_TRANSPORT_TIMEOUT_ERROR_CODE = "EMAIL_TRANSPORT_TIMEOUT";

export class EmailTransportTimeoutError extends Error {
  readonly code = EMAIL_TRANSPORT_TIMEOUT_ERROR_CODE;

  constructor(timeoutMilliseconds: number) {
    super(`Email transport gave no response within ${timeoutMilliseconds}ms.`);
    this.name = "EmailTransportTimeoutError";
  }
}

/**
 * Retryable provider statuses: request timeout, rate limiting, and server
 * errors. Every other status (rejected recipient, malformed message,
 * authentication) is a terminal answer a retry cannot change.
 */
export function isRetryableEmailTransportStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

/**
 * Wraps a transport so every call settles within the deadline: the request is
 * aborted and the call rejects with {@link EmailTransportTimeoutError}, even
 * when the underlying implementation ignores abort signals.
 */
export function withEmailTransportDeadline(
  fetchImpl: typeof fetch,
  timeoutMilliseconds: number,
): typeof fetch {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 120_000
  ) {
    throw new RangeError("Email transport deadline is out of bounds.");
  }
  return (input, init) => {
    const controller = new AbortController();
    const abortUpstream = () => controller.abort();
    init?.signal?.addEventListener("abort", abortUpstream, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeout = new EmailTransportTimeoutError(timeoutMilliseconds);
        controller.abort(timeout);
        reject(timeout);
      }, timeoutMilliseconds);
    });
    const request = Promise.resolve(
      fetchImpl(input, { ...init, signal: controller.signal }),
    );
    return Promise.race([request, deadline]).finally(() => {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abortUpstream);
    });
  };
}

const WITHHELD_ERROR_TEXT = "Provider error text withheld.";
const controlCharacterPattern = /\p{Cc}+/gu;
const emailAddressPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const credentialAssignmentPattern =
  /\b(authorization|bearer|basic|cookie|token|secret|password|api[-_]?key|signature)\b(["'\s:=]*)[^\s"',;]+/gi;
const hexBlobPattern = /\b0x[0-9a-fA-F]{8,}\b/g;
const opaqueTokenPattern = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * Makes provider error text safe to record anywhere: control characters go,
 * email addresses and credential-shaped content are redacted, and the result
 * is length-bounded. Redaction errs toward removing too much.
 */
export function sanitizeEmailProviderErrorText(value: unknown): string {
  if (typeof value !== "string") return WITHHELD_ERROR_TEXT;
  const text = value
    .replace(controlCharacterPattern, " ")
    .replace(emailAddressPattern, "[address]")
    .replace(credentialAssignmentPattern, "$1$2[redacted]")
    .replace(hexBlobPattern, "[redacted]")
    .replace(opaqueTokenPattern, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return WITHHELD_ERROR_TEXT;
  return text.length > EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH - 3)}...`
    : text;
}

/** Returns the code when it matches the stable alphabet, else the fallback. */
export function normalizeEmailDeliveryErrorCode(
  code: unknown,
  fallback: string,
): string {
  return emailDeliveryErrorCodeSchema.safeParse(code).success
    ? (code as string)
    : fallback;
}
