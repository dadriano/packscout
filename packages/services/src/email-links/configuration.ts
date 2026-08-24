import {
  EMAIL_LINK_PURPOSES,
  type EmailLinkPurpose,
} from "@packscout/contracts";

/**
 * Server-side configuration for the one-time link mechanism: per-purpose
 * lifetimes, per-purpose issuance rate limits, and the rooted admin paths a
 * redeemable link lands on. Everything resolves once at composition time —
 * following the message catalogue's origin convention — and the resolved
 * value is handed to the service, which never reads the environment itself.
 */

/** Keys the verifier HMAC; at least 32 bytes. Never defaulted, never logged. */
export const EMAIL_LINK_TOKEN_SECRET_VARIABLE = "PACKSCOUT_EMAIL_LINK_TOKEN_SECRET";

export const EMAIL_LINK_RESET_LIFETIME_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_RESET_LIFETIME_MS";
export const EMAIL_LINK_INVITATION_LIFETIME_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_INVITATION_LIFETIME_MS";
export const EMAIL_LINK_ISSUANCE_WINDOW_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_ISSUANCE_WINDOW_MS";
export const EMAIL_LINK_ISSUANCE_BLOCK_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_ISSUANCE_BLOCK_MS";
export const EMAIL_LINK_RESET_ADDRESS_MAX_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_RESET_ADDRESS_MAX_PER_WINDOW";
export const EMAIL_LINK_RESET_SOURCE_MAX_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_RESET_SOURCE_MAX_PER_WINDOW";
export const EMAIL_LINK_INVITATION_ADDRESS_MAX_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_INVITATION_ADDRESS_MAX_PER_WINDOW";
export const EMAIL_LINK_INVITATION_SOURCE_MAX_VARIABLE =
  "PACKSCOUT_EMAIL_LINK_INVITATION_SOURCE_MAX_PER_WINDOW";

/** A reset link is short-lived: one hour by default. */
export const DEFAULT_RESET_LIFETIME_MS = 60 * 60_000;
/** An invitation waits for a human to get to their mail: seven days. */
export const DEFAULT_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_ISSUANCE_WINDOW_MS = 15 * 60_000;
export const DEFAULT_ISSUANCE_BLOCK_MS = 15 * 60_000;
export const DEFAULT_ADDRESS_MAX_PER_WINDOW = 5;
export const DEFAULT_SOURCE_MAX_PER_WINDOW = 30;

const LIFETIME_BOUNDS_MS = { minimum: 60_000, maximum: 90 * 24 * 60 * 60_000 };
const WINDOW_BOUNDS_MS = { minimum: 10_000, maximum: 24 * 60 * 60_000 };
const BLOCK_BOUNDS_MS = { minimum: 10_000, maximum: 7 * 24 * 60 * 60_000 };
const MAX_PER_WINDOW_BOUNDS = { minimum: 1, maximum: 10_000 };

/**
 * The rooted admin path each purpose redeems on. The presented token rides
 * in the URL *fragment*, not the query string: a fragment is the one part of
 * a URL browsers never put on the wire, so a one-time operator credential
 * stays out of server access logs and out of the `Referer` header the
 * redemption screen would otherwise send on every same-origin asset and API
 * request. messaging/009 and /010 mount their redemption screens on these
 * paths, read the token from the fragment, and strip it from history; the
 * message catalogue re-anchors the path to the configured admin origin
 * without ever inspecting it.
 */
export const EMAIL_LINK_REDEMPTION_PATHS: Readonly<
  Record<EmailLinkPurpose, string>
> = Object.freeze({
  operator_password_reset: "/reset-password",
  operator_invitation: "/accept-invitation",
});

/** The fragment key carrying the presented token on a redemption path. */
export const EMAIL_LINK_TOKEN_FRAGMENT_KEY = "token";

export interface EmailLinkIssuanceRateLimitConfiguration {
  readonly windowMs: number;
  readonly blockMs: number;
  readonly addressMaxPerWindow: number;
  readonly sourceMaxPerWindow: number;
}

export interface EmailLinkPurposeConfiguration {
  readonly lifetimeMs: number;
  readonly rateLimit: EmailLinkIssuanceRateLimitConfiguration;
}

export type EmailLinkTokenConfiguration = Readonly<
  Record<EmailLinkPurpose, EmailLinkPurposeConfiguration>
>;

function boundedSetting(
  raw: string | undefined,
  fallback: number,
  bounds: { minimum: number; maximum: number },
  variable: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < bounds.minimum ||
    value > bounds.maximum
  ) {
    throw new RangeError(`${variable} is outside its safe bounds.`);
  }
  return value;
}

/**
 * Resolves the mechanism's configuration from server-side settings. Unset
 * variables take the documented defaults; a present-but-invalid value fails
 * closed with an explicit error rather than silently becoming a default.
 * The secret is deliberately not resolved here — the composition root reads
 * {@link EMAIL_LINK_TOKEN_SECRET_VARIABLE} and passes it to the service so
 * configuration objects never carry secret material.
 */
export function resolveEmailLinkTokenConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): EmailLinkTokenConfiguration {
  const windowMs = boundedSetting(
    env[EMAIL_LINK_ISSUANCE_WINDOW_VARIABLE],
    DEFAULT_ISSUANCE_WINDOW_MS,
    WINDOW_BOUNDS_MS,
    EMAIL_LINK_ISSUANCE_WINDOW_VARIABLE,
  );
  const blockMs = boundedSetting(
    env[EMAIL_LINK_ISSUANCE_BLOCK_VARIABLE],
    DEFAULT_ISSUANCE_BLOCK_MS,
    BLOCK_BOUNDS_MS,
    EMAIL_LINK_ISSUANCE_BLOCK_VARIABLE,
  );
  return Object.freeze({
    operator_password_reset: {
      lifetimeMs: boundedSetting(
        env[EMAIL_LINK_RESET_LIFETIME_VARIABLE],
        DEFAULT_RESET_LIFETIME_MS,
        LIFETIME_BOUNDS_MS,
        EMAIL_LINK_RESET_LIFETIME_VARIABLE,
      ),
      rateLimit: {
        windowMs,
        blockMs,
        addressMaxPerWindow: boundedSetting(
          env[EMAIL_LINK_RESET_ADDRESS_MAX_VARIABLE],
          DEFAULT_ADDRESS_MAX_PER_WINDOW,
          MAX_PER_WINDOW_BOUNDS,
          EMAIL_LINK_RESET_ADDRESS_MAX_VARIABLE,
        ),
        sourceMaxPerWindow: boundedSetting(
          env[EMAIL_LINK_RESET_SOURCE_MAX_VARIABLE],
          DEFAULT_SOURCE_MAX_PER_WINDOW,
          MAX_PER_WINDOW_BOUNDS,
          EMAIL_LINK_RESET_SOURCE_MAX_VARIABLE,
        ),
      },
    },
    operator_invitation: {
      lifetimeMs: boundedSetting(
        env[EMAIL_LINK_INVITATION_LIFETIME_VARIABLE],
        DEFAULT_INVITATION_LIFETIME_MS,
        LIFETIME_BOUNDS_MS,
        EMAIL_LINK_INVITATION_LIFETIME_VARIABLE,
      ),
      rateLimit: {
        windowMs,
        blockMs,
        addressMaxPerWindow: boundedSetting(
          env[EMAIL_LINK_INVITATION_ADDRESS_MAX_VARIABLE],
          DEFAULT_ADDRESS_MAX_PER_WINDOW,
          MAX_PER_WINDOW_BOUNDS,
          EMAIL_LINK_INVITATION_ADDRESS_MAX_VARIABLE,
        ),
        sourceMaxPerWindow: boundedSetting(
          env[EMAIL_LINK_INVITATION_SOURCE_MAX_VARIABLE],
          DEFAULT_SOURCE_MAX_PER_WINDOW,
          MAX_PER_WINDOW_BOUNDS,
          EMAIL_LINK_INVITATION_SOURCE_MAX_VARIABLE,
        ),
      },
    },
  });
}

/**
 * Reads the token secret from server-side configuration, or null when it is
 * not configured. Whether null is fatal belongs to the composition root:
 * the flows that issue and redeem cannot run without it.
 */
export function resolveEmailLinkTokenSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[EMAIL_LINK_TOKEN_SECRET_VARIABLE];
  if (value === undefined || value.trim() === "") return null;
  return value;
}

/**
 * Builds the opaque rooted link path a purpose's message carries. The token
 * goes in the fragment, so it never reaches an access log and is never sent
 * as a referrer; the path stays a single opaque string to every consumer.
 */
export function emailLinkPathFor(
  purpose: EmailLinkPurpose,
  presentedToken: string,
): string {
  const path = EMAIL_LINK_REDEMPTION_PATHS[purpose];
  return `${path}#${EMAIL_LINK_TOKEN_FRAGMENT_KEY}=${presentedToken}`;
}

/** Every purpose has a redemption path; verified at module load in tests. */
export function assertEveryPurposeHasRedemptionPath(): void {
  for (const purpose of EMAIL_LINK_PURPOSES) {
    const path = EMAIL_LINK_REDEMPTION_PATHS[purpose];
    if (!path || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error(`Email link purpose ${purpose} lacks a rooted path.`);
    }
  }
}
