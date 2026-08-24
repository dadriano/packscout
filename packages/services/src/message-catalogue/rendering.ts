import {
  renderedEmailMessageSchema,
  type RenderedEmailMessage,
} from "@packscout/contracts";

/**
 * The rendering core every message kind shares: the explicit render-result
 * vocabulary, HTML escaping for interpolated values, the unsafe-content
 * refusal that keeps credential-shaped text out of outgoing mail, the
 * deterministic UTC timestamp presentation, absolute link construction, and
 * the final gate that proves a rendered message satisfies the delivery
 * contract before anyone is allowed to send it. Nothing in this module reads
 * a clock, the environment, or the network; rendering stays pure.
 */

/** No public origin is configured for the links this message needs. */
export const EMAIL_MESSAGE_ORIGIN_MISSING_ERROR_CODE =
  "EMAIL_MESSAGE_ORIGIN_MISSING";
/** A required input value is missing or fails its structural validation. */
export const EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE =
  "EMAIL_MESSAGE_INPUT_INVALID";
/** An interpolated value looks like a credential, token, or raw secret. */
export const EMAIL_MESSAGE_CONTENT_UNSAFE_ERROR_CODE =
  "EMAIL_MESSAGE_CONTENT_UNSAFE";
/** The rendered subject or a body exceeds the delivery contract bounds. */
export const EMAIL_MESSAGE_BOUNDS_EXCEEDED_ERROR_CODE =
  "EMAIL_MESSAGE_BOUNDS_EXCEEDED";

export type EmailMessageRenderErrorCode =
  | typeof EMAIL_MESSAGE_ORIGIN_MISSING_ERROR_CODE
  | typeof EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE
  | typeof EMAIL_MESSAGE_CONTENT_UNSAFE_ERROR_CODE
  | typeof EMAIL_MESSAGE_BOUNDS_EXCEEDED_ERROR_CODE;

export interface EmailMessageRendered {
  readonly status: "rendered";
  /** A message the delivery boundary accepts as-is. */
  readonly message: RenderedEmailMessage;
}

export interface EmailMessageRenderFailure {
  readonly status: "failed";
  readonly errorCode: EmailMessageRenderErrorCode;
  /**
   * A static, content-free explanation. Never echoes an input value, a
   * recipient address, or a link, so a failure is always safe to record.
   */
  readonly reason: string;
}

/**
 * Rendering reports an explicit failure — it never throws and never emits a
 * partial message — when a required value is missing, an interpolated value
 * looks unsafe, or no public origin is configured.
 */
export type EmailMessageRenderResult =
  | EmailMessageRendered
  | EmailMessageRenderFailure;

/** Builds the explicit failure result every renderer reports instead of throwing. */
export function emailMessageRenderFailure(
  errorCode: EmailMessageRenderErrorCode,
  reason: string,
): EmailMessageRenderFailure {
  return { status: "failed", errorCode, reason };
}

/**
 * Credential-shaped content refused in every interpolated prose value. The
 * first pattern is the operational notification contract's unsafe-text rule
 * verbatim; the rest extend it with the token shapes the delivery transport
 * already redacts: assignments, API keys, hex blobs, JWT-looking values, and
 * long opaque character runs. Refusal errs toward refusing too much.
 */
const unsafeEmailMessagePatterns: readonly RegExp[] = [
  /(?:authorization|bearer\s+|cookie|password|secret(?:\s|=|:)|0x[0-9a-f]{16,})/i,
  /\btoken\b\s*[:=]/i,
  /\bapi[-_]?key\b/i,
  /\b[a-f0-9]{32,}\b/i,
  /eyJ[A-Za-z0-9_-]{8,}/,
  /[A-Za-z0-9+/=_-]{40,}/,
];

/** Whether a prose value looks like it carries a credential or token. */
export function unsafeEmailMessageContent(value: string): boolean {
  return unsafeEmailMessagePatterns.some((pattern) => pattern.test(value));
}

/** Control characters other than ordinary whitespace invalidate an input. */
const forbiddenControlCharacters =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * Normalizes one interpolated prose value: whitespace runs collapse to single
 * spaces and the result is trimmed. Returns null — an invalid input — for
 * non-strings, disallowed control characters, emptiness, or excess length.
 */
export function normalizeEmailMessageProse(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  if (forbiddenControlCharacters.test(value)) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized.length > maximumLength) return null;
  return normalized;
}

/**
 * Escapes a value for interpolation into HTML content or attributes. Every
 * interpolated value passes through this; untrusted text is never markup.
 */
export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const utcMonthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Presents an instant deterministically, without locale or clock access:
 * "20 Aug 2026, 14:03 UTC". Timestamps arrive as inputs; rendering never
 * consults a clock. Returns null for values that do not parse.
 */
export function formatEmailInstantUtc(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const instant = new Date(parsed);
  const hours = String(instant.getUTCHours()).padStart(2, "0");
  const minutes = String(instant.getUTCMinutes()).padStart(2, "0");
  return `${instant.getUTCDate()} ${utcMonthNames[instant.getUTCMonth()]} ${instant.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

/** One-time link paths are bounded like any other recorded value. */
export const EMAIL_MESSAGE_LINK_PATH_MAX_LENGTH = 2048;

/**
 * Builds an absolute link from a configured public origin and a rooted path.
 * The path must start with "/" (and not "//"), carry no whitespace, control
 * characters, quotes, angle brackets, or backslashes, and must still resolve
 * inside the given origin. Returns null — never a relative or cross-origin
 * link — when any of that fails. The path may carry an opaque one-time token;
 * the catalogue never inspects, generates, or logs it.
 */
export function absoluteEmailMessageLink(
  origin: string,
  path: unknown,
): string | null {
  if (typeof path !== "string") return null;
  if (path.length === 0 || path.length > EMAIL_MESSAGE_LINK_PATH_MAX_LENGTH) {
    return null;
  }
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001F\u007F<>"'\\`]/.test(path)) return null;
  try {
    const resolved = new URL(path, origin);
    if (resolved.origin !== origin) return null;
    if (resolved.username || resolved.password) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * The final gate: a candidate message either satisfies the delivery
 * contract's rendered-message schema — bounds included — or rendering fails
 * explicitly. No partial message ever leaves the catalogue.
 */
export function finalizeRenderedEmailMessage(candidate: {
  readonly kind: string;
  readonly toEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}): EmailMessageRenderResult {
  const parsed = renderedEmailMessageSchema.safeParse(candidate);
  if (parsed.success) {
    return { status: "rendered", message: parsed.data };
  }
  const exceedsBounds = parsed.error.issues.some(
    (issue) =>
      issue.code === "too_big" &&
      (issue.path[0] === "subject" ||
        issue.path[0] === "textBody" ||
        issue.path[0] === "htmlBody"),
  );
  return exceedsBounds
    ? emailMessageRenderFailure(
        EMAIL_MESSAGE_BOUNDS_EXCEEDED_ERROR_CODE,
        "The rendered subject or body exceeds the delivery contract bounds.",
      )
    : emailMessageRenderFailure(
        EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE,
        "A required message value is missing or invalid.",
      );
}
