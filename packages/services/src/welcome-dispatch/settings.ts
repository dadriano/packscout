/**
 * Server-side configuration for the welcome dispatcher (messaging/007).
 *
 * Two independent concerns resolve here, both from the environment at cycle
 * time rather than once at process start, matching the alert-email settings:
 *
 * - The welcome kind's own off switch. Turning it off stops welcome
 *   discovery and enqueueing and nothing else: alerts, access decisions,
 *   and operator links keep flowing through the same outbox untouched.
 * - The server-to-server operator integration the dispatcher discovers
 *   welcomes through. It is the same surface and deployment secret the
 *   admin uses for the product-user directory, so the variables are shared:
 *   one origin, one secret, configured once per environment. Unusable
 *   configuration leaves the dispatcher unconfigured rather than crashing
 *   the worker: the pipeline's other jobs never depend on this one.
 *
 * Resolution never throws. An unreadable switch stays enabled and is
 * reported as a bounded problem code — a typo must not silently disable a
 * message kind — while an unreadable origin or secret resolves to
 * unconfigured, reported the same way. Problem codes never carry values.
 */

/** Off switch. Unset means enabled; "0", "false", or "off" disables. */
export const WELCOME_EMAIL_ENABLED_VARIABLE = "PACKSCOUT_WELCOME_EMAIL_ENABLED";

/** Origin of the product backend's admin-integration surface. */
export const WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE =
  "PACKSCOUT_ADMIN_DIRECTORY_URL";

/** Bearer secret for that surface. Server-side only, never serialized. */
export const WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE =
  "PACKSCOUT_ADMIN_DIRECTORY_TOKEN";

/** Matches the surface's own minimum; anything shorter fails closed there. */
const MINIMUM_DIRECTORY_TOKEN_LENGTH = 32;

/**
 * Development origins that may be reached over cleartext. A request to any
 * of these never leaves the machine, mirroring the admin's directory reader.
 */
const CLEARTEXT_DIRECTORY_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

export type WelcomeDispatchSettingsProblem =
  | "WELCOME_EMAIL_ENABLED_INVALID"
  | "WELCOME_DISPATCH_DIRECTORY_URL_INVALID"
  | "WELCOME_DISPATCH_DIRECTORY_TOKEN_INVALID";

export interface WelcomeDispatchIntegrationConfig {
  /** Origin only; request paths are appended by the directory client. */
  readonly baseUrl: string;
  readonly token: string;
}

export interface WelcomeDispatchSettings {
  /** False only on the explicit off switch; never by accident. */
  readonly enabled: boolean;
  /** Null when the integration is not usable; the dispatcher then idles. */
  readonly integration: WelcomeDispatchIntegrationConfig | null;
  /** Static codes for values that fell back; never value content. */
  readonly problems: readonly WelcomeDispatchSettingsProblem[];
}

function resolveEnabled(
  value: string | undefined,
  problems: WelcomeDispatchSettingsProblem[],
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return true;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  problems.push("WELCOME_EMAIL_ENABLED_INVALID");
  return true;
}

function resolveIntegration(
  urlValue: string | undefined,
  tokenValue: string | undefined,
  problems: WelcomeDispatchSettingsProblem[],
): WelcomeDispatchIntegrationConfig | null {
  const token = tokenValue?.trim() ?? "";
  const candidate = urlValue?.trim() ?? "";
  // Both unset is the ordinary unconfigured deployment, not a problem.
  if (token.length === 0 && candidate.length === 0) return null;
  if (token.length < MINIMUM_DIRECTORY_TOKEN_LENGTH) {
    problems.push("WELCOME_DISPATCH_DIRECTORY_TOKEN_INVALID");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    problems.push("WELCOME_DISPATCH_DIRECTORY_URL_INVALID");
    return null;
  }
  if (parsed.protocol === "https:") return { baseUrl: parsed.origin, token };
  if (
    parsed.protocol === "http:" &&
    CLEARTEXT_DIRECTORY_HOSTS.has(parsed.hostname)
  ) {
    return { baseUrl: parsed.origin, token };
  }
  problems.push("WELCOME_DISPATCH_DIRECTORY_URL_INVALID");
  return null;
}

/**
 * Resolves the welcome dispatcher's settings from server-side configuration.
 * This is the dispatch path's only environment read; the worker's processor
 * calls it per cycle so the switch is configuration, not process state.
 */
export function resolveWelcomeDispatchSettings(
  env: NodeJS.ProcessEnv = process.env,
): WelcomeDispatchSettings {
  const problems: WelcomeDispatchSettingsProblem[] = [];
  const enabled = resolveEnabled(env[WELCOME_EMAIL_ENABLED_VARIABLE], problems);
  const integration = resolveIntegration(
    env[WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE],
    env[WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE],
    problems,
  );
  return Object.freeze({
    enabled,
    integration,
    problems: Object.freeze(problems),
  });
}
