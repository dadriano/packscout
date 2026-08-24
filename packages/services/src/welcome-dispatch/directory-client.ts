import type { WelcomeDispatchIntegrationConfig } from "./settings.ts";

/**
 * The welcome dispatcher's server-to-server client for the product backend's
 * admin-integration surface (messaging/007) — the same POST-plus-bearer
 * surface the admin's directory reader uses, speaking to the two welcome
 * routes. The secret is read from server configuration, held here, and sent
 * as a request header; it never reaches a log line or an error. Subjects and
 * addresses travel only in JSON bodies, never in a URL, and upstream
 * failures collapse into stable codes so no upstream body propagates.
 */

export const WELCOME_DISPATCH_CLAIM_PATH = "/admin/product-users/welcome/claim";
export const WELCOME_DISPATCH_SETTLE_PATH =
  "/admin/product-users/welcome/settle";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SUBJECT_LENGTH = 1_024;
const MAX_EMAIL_LENGTH = 320;

/** One identity the dispatcher holds an exclusive, expiring claim on. */
export interface ClaimedWelcome {
  readonly subject: string;
  readonly email: string | null;
}

export type WelcomeSettleOutcome = "sent" | "no_verified_email";

export type WelcomeSettleResult =
  | "settled"
  | "already_settled"
  | "nothing_to_settle";

/** The discovery-and-settlement surface the dispatch service runs against. */
export interface WelcomeDispatchDirectoryPort {
  claimDueWelcomes(input: {
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }): Promise<readonly ClaimedWelcome[]>;
  settleWelcome(input: {
    readonly subject: string;
    readonly outcome: WelcomeSettleOutcome;
  }): Promise<WelcomeSettleResult>;
}

export type WelcomeDispatchDirectoryErrorCode =
  | "WELCOME_DIRECTORY_UNAVAILABLE"
  | "WELCOME_DIRECTORY_REQUEST_INVALID"
  | "WELCOME_DIRECTORY_RESPONSE_INVALID";

export class WelcomeDispatchDirectoryError extends Error {
  constructor(readonly code: WelcomeDispatchDirectoryErrorCode) {
    super("The welcome-dispatch directory request failed safely.");
    this.name = "WelcomeDispatchDirectoryError";
  }
}

export interface WelcomeDispatchDirectoryClientInput {
  readonly config: WelcomeDispatchIntegrationConfig;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

function unavailable(): WelcomeDispatchDirectoryError {
  return new WelcomeDispatchDirectoryError("WELCOME_DIRECTORY_UNAVAILABLE");
}

function responseInvalid(): WelcomeDispatchDirectoryError {
  return new WelcomeDispatchDirectoryError("WELCOME_DIRECTORY_RESPONSE_INVALID");
}

function readClaims(payload: unknown): readonly ClaimedWelcome[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { claims?: unknown }).claims)
  ) {
    throw responseInvalid();
  }
  const claims: ClaimedWelcome[] = [];
  for (const entry of (payload as { claims: unknown[] }).claims) {
    if (typeof entry !== "object" || entry === null) throw responseInvalid();
    const subject = (entry as { subject?: unknown }).subject;
    const email = (entry as { email?: unknown }).email ?? null;
    if (
      typeof subject !== "string" ||
      subject.length === 0 ||
      subject.length > MAX_SUBJECT_LENGTH ||
      (email !== null &&
        (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH))
    ) {
      throw responseInvalid();
    }
    claims.push({ subject, email });
  }
  return claims;
}

function readSettleResult(payload: unknown): WelcomeSettleResult {
  const outcome =
    typeof payload === "object" && payload !== null
      ? (payload as { outcome?: unknown }).outcome
      : undefined;
  if (
    outcome === "settled" ||
    outcome === "already_settled" ||
    outcome === "nothing_to_settle"
  ) {
    return outcome;
  }
  throw responseInvalid();
}

export function createWelcomeDispatchDirectoryClient(
  input: WelcomeDispatchDirectoryClientInput,
): WelcomeDispatchDirectoryPort {
  const call = input.fetchImplementation ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { baseUrl, token } = input.config;

  /**
   * One authenticated POST. Every failure mode — network trouble, a
   * timeout, a rejected secret, an unreadable body — collapses into a
   * stable code; a 400 is distinguished because it means the dispatcher
   * itself sent something out of bounds, which retrying will not fix.
   */
  async function post(path: string, body: unknown): Promise<unknown> {
    const deadline = new AbortController();
    const expiry = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await call(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            // The only place the integration secret is ever used.
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        });
      } catch {
        throw unavailable();
      }
      if (response.status === 400) {
        throw new WelcomeDispatchDirectoryError(
          "WELCOME_DIRECTORY_REQUEST_INVALID",
        );
      }
      if (!response.ok) throw unavailable();
      try {
        return await response.json();
      } catch {
        throw responseInvalid();
      }
    } finally {
      clearTimeout(expiry);
    }
  }

  return {
    async claimDueWelcomes(request) {
      return readClaims(
        await post(WELCOME_DISPATCH_CLAIM_PATH, {
          limit: request.limit,
          leaseMilliseconds: request.leaseMilliseconds,
        }),
      );
    },
    async settleWelcome(request) {
      return readSettleResult(
        await post(WELCOME_DISPATCH_SETTLE_PATH, {
          subject: request.subject,
          outcome: request.outcome,
        }),
      );
    },
  };
}
