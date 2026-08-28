import {
  operationalSeveritySchema,
  type OperationalSeverity,
} from "@packscout/contracts";
import { z } from "zod";

/**
 * Server-side configuration for routing operational alerts to operator email.
 * The values are resolved from the environment at publish time — not once at
 * process start — so removing a departed operator from the recipient list
 * takes effect on the next alert, matching how the message catalogue resolves
 * its origins.
 *
 * Resolution never throws and never disables alerting by accident: an
 * unreadable value falls back to its default and is reported as a bounded
 * problem code the publisher surfaces through the existing operational
 * observability. Only the explicit off switch turns routing off.
 */

/** Off switch. Unset means enabled; "0", "false", or "off" disables routing. */
export const ALERT_EMAIL_ENABLED_VARIABLE = "PACKSCOUT_ALERT_EMAIL_ENABLED";

/** Comma-separated operator addresses. Unset means no recipient is configured. */
export const ALERT_EMAIL_RECIPIENTS_VARIABLE =
  "PACKSCOUT_ALERT_EMAIL_RECIPIENTS";

/** Comma-separated severities that produce email. Default: critical,warning. */
export const ALERT_EMAIL_SEVERITIES_VARIABLE =
  "PACKSCOUT_ALERT_EMAIL_SEVERITIES";

/** Flood-control window in milliseconds: one message per alert per window. */
export const ALERT_EMAIL_WINDOW_MS_VARIABLE = "PACKSCOUT_ALERT_EMAIL_WINDOW_MS";

/** Informational alerts stay in the admin unless explicitly configured in. */
export const ALERT_EMAIL_DEFAULT_SEVERITIES: readonly OperationalSeverity[] =
  Object.freeze(["warning", "critical"]);

/** Six hours: a persistent condition resurfaces a few times a day, not hourly. */
export const ALERT_EMAIL_DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1_000;

const WINDOW_MINIMUM_MS = 60_000;
const WINDOW_MAXIMUM_MS = 7 * 24 * 60 * 60 * 1_000;

/** Bounds enqueue volume per alert occurrence: one message per recipient. */
export const ALERT_EMAIL_MAXIMUM_RECIPIENTS = 16;

/** Mirrors the outbox recipient bound so a configured address never bounces
 * off enqueue validation later. */
const recipientSchema = z.string().trim().max(320).email();

export type AlertEmailSettingsProblem =
  | "ALERT_EMAIL_ENABLED_INVALID"
  | "ALERT_EMAIL_RECIPIENTS_INVALID"
  | "ALERT_EMAIL_RECIPIENTS_TRUNCATED"
  | "ALERT_EMAIL_SEVERITIES_INVALID"
  | "ALERT_EMAIL_WINDOW_INVALID";

export interface AlertEmailRoutingSettings {
  readonly enabled: boolean;
  readonly severities: ReadonlySet<OperationalSeverity>;
  readonly recipients: readonly string[];
  readonly windowMs: number;
  /** Static codes for values that fell back to defaults; never value content. */
  readonly problems: readonly AlertEmailSettingsProblem[];
}

function resolveEnabled(
  value: string | undefined,
  problems: AlertEmailSettingsProblem[],
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return true;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  // A typo must not silence alerting: unrecognized stays enabled, visibly.
  problems.push("ALERT_EMAIL_ENABLED_INVALID");
  return true;
}

function resolveSeverities(
  value: string | undefined,
  problems: AlertEmailSettingsProblem[],
): ReadonlySet<OperationalSeverity> {
  const fallback = new Set(ALERT_EMAIL_DEFAULT_SEVERITIES);
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return fallback;
  const parsed = new Set<OperationalSeverity>();
  for (const entry of normalized.split(",")) {
    const severity = operationalSeveritySchema.safeParse(
      entry.trim().toLowerCase(),
    );
    if (!severity.success) {
      // Half a routing rule is less predictable than the default one.
      problems.push("ALERT_EMAIL_SEVERITIES_INVALID");
      return fallback;
    }
    parsed.add(severity.data);
  }
  return parsed;
}

function resolveRecipients(
  value: string | undefined,
  problems: AlertEmailSettingsProblem[],
): readonly string[] {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return Object.freeze([]);
  const recipients: string[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const entry of normalized.split(",")) {
    const candidate = recipientSchema.safeParse(entry);
    if (!candidate.success) {
      if (entry.trim() !== "") dropped = true;
      continue;
    }
    const identity = candidate.data.toLowerCase();
    if (seen.has(identity)) continue;
    if (recipients.length >= ALERT_EMAIL_MAXIMUM_RECIPIENTS) {
      problems.push("ALERT_EMAIL_RECIPIENTS_TRUNCATED");
      break;
    }
    seen.add(identity);
    recipients.push(candidate.data);
  }
  if (dropped) problems.push("ALERT_EMAIL_RECIPIENTS_INVALID");
  return Object.freeze(recipients);
}

function resolveWindowMs(
  value: string | undefined,
  problems: AlertEmailSettingsProblem[],
): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    return ALERT_EMAIL_DEFAULT_WINDOW_MS;
  }
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    problems.push("ALERT_EMAIL_WINDOW_INVALID");
    return ALERT_EMAIL_DEFAULT_WINDOW_MS;
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < WINDOW_MINIMUM_MS ||
    parsed > WINDOW_MAXIMUM_MS
  ) {
    problems.push("ALERT_EMAIL_WINDOW_INVALID");
    return ALERT_EMAIL_DEFAULT_WINDOW_MS;
  }
  return parsed;
}

/**
 * Resolves the alert email routing settings from server-side configuration.
 * This is the alert email path's only environment read; the publisher calls
 * it per published event so recipients are resolved at send time.
 */
export function resolveAlertEmailRoutingSettings(
  env: NodeJS.ProcessEnv = process.env,
): AlertEmailRoutingSettings {
  const problems: AlertEmailSettingsProblem[] = [];
  const enabled = resolveEnabled(env[ALERT_EMAIL_ENABLED_VARIABLE], problems);
  const severities = resolveSeverities(
    env[ALERT_EMAIL_SEVERITIES_VARIABLE],
    problems,
  );
  const recipients = resolveRecipients(
    env[ALERT_EMAIL_RECIPIENTS_VARIABLE],
    problems,
  );
  const windowMs = resolveWindowMs(env[ALERT_EMAIL_WINDOW_MS_VARIABLE], problems);
  return Object.freeze({
    enabled,
    severities,
    recipients,
    windowMs,
    problems: Object.freeze(problems),
  });
}
