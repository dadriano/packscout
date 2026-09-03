import { createHash } from "node:crypto";

export type ProviderActivitySeverity = "info" | "warning" | "critical";
export type ProviderActivityEvidenceValue = string | number | boolean | null;

export interface ProviderActivityEvent {
  readonly id: string;
  readonly eventDigest: string;
  readonly eventType: string;
  readonly severity: ProviderActivitySeverity;
  readonly dedupeKey: string;
  readonly recoveryKey: string;
  readonly localRunId: string | null;
  readonly localQuarantineId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, ProviderActivityEvidenceValue>>;
  readonly eventAt: Date;
  readonly deliveryAttemptCount: number;
  readonly lastFailureCode: string | null;
}

export type ProviderObservedRuntimeState =
  | "idle"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export interface ProviderLocalHealthObservation {
  readonly providerId: string;
  readonly observedState: ProviderObservedRuntimeState;
  readonly freshnessState: string;
  readonly qualityState: string;
  readonly consecutiveFailures: number;
  readonly openQuarantineCount: number;
  readonly lastAttemptedAt: Date | null;
  readonly lastHeadReachedAt: Date | null;
  readonly recoveredAt: Date | null;
  readonly lastRunnerHeartbeatAt: Date | null;
  readonly latestFailureCode: string | null;
  readonly recoveryHint: string | null;
  readonly publicationLag: bigint;
  readonly observedAt: Date;
}

export interface ProviderActivityBatch {
  readonly providerId: string;
  readonly health: ProviderLocalHealthObservation;
  readonly events: readonly ProviderActivityEvent[];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const safeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const safeFailurePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const protectedTextPattern =
  /(?:authorization|bearer\s+|cookie|credential|cursor|database[_-]?url|password|payload|secret|(?:api|access|refresh|auth)[_-]?token|api[_-]?key|postgres(?:ql)?:\/\/)/i;
const activityEvidenceKeys = new Set([
  "catalogContentHash",
  "catalogVersionId",
  "coalescedCount",
  "completedThroughChangeSequence",
  "expiredCount",
  "failureCode",
  "generation",
  "overflowDigest",
  "overflowGeneration",
  "providerReleaseContentHash",
  "providerReleaseFingerprint",
  "providerReleaseId",
  "providerInvocationIdDigest",
  "providerInvocationProjectionDigest",
  "publicProviderReleaseId",
  "quarantineState",
  "retentionState",
  "runState",
  "selectedCount",
  "state",
  "terminalReceiptSha256",
]);

export interface ProviderReleaseCompletedActivityEvidence {
  readonly state: "complete" | "reused";
  readonly providerReleaseId: string;
  readonly publicProviderReleaseId: string;
  readonly catalogVersionId: string;
  readonly catalogContentHash: string;
  readonly providerReleaseContentHash: string;
  readonly providerReleaseFingerprint: string;
  readonly completedThroughChangeSequence: string;
  readonly terminalReceiptSha256: string;
}

export interface ProviderPromotionInvocationTerminalActivityEvidence {
  readonly providerInvocationIdDigest: string;
  readonly providerInvocationProjectionDigest: string;
}

const maximumPostgresBigint = 9_223_372_036_854_775_807n;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function sanitizeProviderActivityEvidence(
  value: unknown,
): Readonly<Record<string, ProviderActivityEvidenceValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider activity evidence must be an object.");
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (
    entries.length > 11
    || entries.some(([key]) => !activityEvidenceKeys.has(key))
  ) {
    throw new TypeError("Provider activity evidence has an invalid key.");
  }
  const output: Record<string, ProviderActivityEvidenceValue> = {};
  for (const [key, item] of entries) {
    if (
      item !== null
      && typeof item !== "string"
      && typeof item !== "number"
      && typeof item !== "boolean"
    ) {
      throw new TypeError("Provider activity evidence has an invalid value.");
    }
    if (
      typeof item === "number"
      && (!Number.isSafeInteger(item) || item < 0)
    ) {
      throw new TypeError("Provider activity evidence has an invalid number.");
    }
    if (
      typeof item === "string"
      && (
        item.length > 256
        || protectedTextPattern.test(item)
        || !safeKeyPattern.test(item)
      )
    ) {
      throw new TypeError("Provider activity evidence has an unsafe value.");
    }
    output[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > 2_048) {
    throw new TypeError("Provider activity evidence is too large.");
  }
  return Object.freeze(output);
}

const providerReleaseCompletedEvidenceKeys = [
  "catalogContentHash",
  "catalogVersionId",
  "completedThroughChangeSequence",
  "providerReleaseContentHash",
  "providerReleaseFingerprint",
  "providerReleaseId",
  "publicProviderReleaseId",
  "state",
  "terminalReceiptSha256",
] as const;

/** Strict typed evidence consumed by the central completion relay. */
export function providerReleaseCompletedActivityEvidence(
  event: Pick<ProviderActivityEvent, "eventType" | "evidence">,
): ProviderReleaseCompletedActivityEvidence {
  const evidence = sanitizeProviderActivityEvidence(event.evidence);
  if (
    event.eventType !== "provider_release_completed"
    || Object.keys(evidence).sort().join("\0") !==
      [...providerReleaseCompletedEvidenceKeys].sort().join("\0")
    || (evidence.state !== "complete" && evidence.state !== "reused")
    || typeof evidence.providerReleaseId !== "string"
    || !uuidPattern.test(evidence.providerReleaseId)
    || typeof evidence.publicProviderReleaseId !== "string"
    || !uuidPattern.test(evidence.publicProviderReleaseId)
    || typeof evidence.catalogVersionId !== "string"
    || !uuidPattern.test(evidence.catalogVersionId)
    || typeof evidence.catalogContentHash !== "string"
    || !digestPattern.test(evidence.catalogContentHash)
    || typeof evidence.providerReleaseContentHash !== "string"
    || !digestPattern.test(evidence.providerReleaseContentHash)
    || typeof evidence.providerReleaseFingerprint !== "string"
    || !digestPattern.test(evidence.providerReleaseFingerprint)
    || typeof evidence.completedThroughChangeSequence !== "string"
    || !/^[1-9][0-9]{0,18}$/u.test(
      evidence.completedThroughChangeSequence,
    )
    || BigInt(evidence.completedThroughChangeSequence) > maximumPostgresBigint
    || typeof evidence.terminalReceiptSha256 !== "string"
    || !digestPattern.test(evidence.terminalReceiptSha256)
  ) throw new TypeError("Provider release completion evidence is invalid.");
  return Object.freeze({
    state: evidence.state,
    providerReleaseId: evidence.providerReleaseId,
    publicProviderReleaseId: evidence.publicProviderReleaseId,
    catalogVersionId: evidence.catalogVersionId,
    catalogContentHash: evidence.catalogContentHash,
    providerReleaseContentHash: evidence.providerReleaseContentHash,
    providerReleaseFingerprint: evidence.providerReleaseFingerprint,
    completedThroughChangeSequence:
      evidence.completedThroughChangeSequence,
    terminalReceiptSha256: evidence.terminalReceiptSha256,
  });
}

/**
 * Validates the fixed provider-owned envelope as well as its typed evidence.
 * Central uses this before treating a general activity event as manifest work.
 */
export function assertProviderReleaseCompletedActivity(
  event: ProviderActivityEvent,
): ProviderReleaseCompletedActivityEvidence {
  const validated = assertProviderActivityEvent(event);
  const evidence = providerReleaseCompletedActivityEvidence(validated);
  const expectedSummary = evidence.state === "complete"
    ? "An immutable provider release completed publication."
    : "An unchanged immutable provider release confirmed a newer boundary.";
  if (
    validated.severity !== "info"
    || validated.localRunId !== null
    || validated.localQuarantineId !== null
    || validated.dedupeKey !==
      `provider-release-completed:${evidence.providerReleaseId}:${evidence.completedThroughChangeSequence}`
    || validated.recoveryKey !==
      `provider-release:${evidence.providerReleaseId}`
    || validated.title !== "Provider release publication completed"
    || validated.summary !== expectedSummary
  ) {
    throw new TypeError("Provider release completion envelope is invalid.");
  }
  return evidence;
}

const providerPromotionInvocationTerminalEvidenceKeys = [
  "providerInvocationIdDigest",
  "providerInvocationProjectionDigest",
] as const;

/** Strict opaque evidence used to fetch one provider-local terminal record. */
export function assertProviderPromotionInvocationTerminalActivity(
  event: ProviderActivityEvent,
): ProviderPromotionInvocationTerminalActivityEvidence {
  const validated = assertProviderActivityEvent(event);
  const evidence = sanitizeProviderActivityEvidence(validated.evidence);
  if (
    validated.eventType !== "provider_promotion_invocation_terminal"
    || Object.keys(evidence).sort().join("\0") !==
      [...providerPromotionInvocationTerminalEvidenceKeys].sort().join("\0")
    || typeof evidence.providerInvocationIdDigest !== "string"
    || !digestPattern.test(evidence.providerInvocationIdDigest)
    || typeof evidence.providerInvocationProjectionDigest !== "string"
    || !digestPattern.test(evidence.providerInvocationProjectionDigest)
    || validated.severity !== "info"
    || validated.localRunId !== null
    || validated.localQuarantineId !== null
    || validated.dedupeKey !==
      `provider-promotion-invocation:${evidence.providerInvocationIdDigest}`
    || validated.recoveryKey !==
      `provider-promotion-invocation:${evidence.providerInvocationIdDigest}`
    || validated.title !== "Provider promotion job finished"
    || validated.summary !==
      "A provider promotion invocation reached a terminal state."
  ) {
    throw new TypeError(
      "Provider promotion invocation terminal envelope is invalid.",
    );
  }
  return Object.freeze({
    providerInvocationIdDigest: evidence.providerInvocationIdDigest,
    providerInvocationProjectionDigest:
      evidence.providerInvocationProjectionDigest,
  });
}

function safeSentence(value: string, maximum: number): boolean {
  return value === value.trim()
    && value.length >= 1
    && value.length <= maximum
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
    && !protectedTextPattern.test(value);
}

export function providerActivityEventDigest(
  event: Omit<
    ProviderActivityEvent,
    "eventDigest" | "deliveryAttemptCount" | "lastFailureCode"
  >,
): string {
  const evidence = sanitizeProviderActivityEvidence(event.evidence);
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: event.id,
        eventType: event.eventType,
        severity: event.severity,
        dedupeKey: event.dedupeKey,
        recoveryKey: event.recoveryKey,
        localRunId: event.localRunId,
        localQuarantineId: event.localQuarantineId,
        title: event.title,
        summary: event.summary,
        evidence,
        eventAt: event.eventAt.toISOString(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function assertProviderActivityEvent(
  event: ProviderActivityEvent,
): ProviderActivityEvent {
  if (
    !uuidPattern.test(event.id)
    || !digestPattern.test(event.eventDigest)
    || !safeKeyPattern.test(event.eventType)
    || !safeKeyPattern.test(event.dedupeKey)
    || !safeKeyPattern.test(event.recoveryKey)
    || (event.localRunId !== null && !uuidPattern.test(event.localRunId))
    || (event.localQuarantineId !== null
      && !uuidPattern.test(event.localQuarantineId))
    || !safeSentence(event.title, 160)
    || !safeSentence(event.summary, 500)
    || !validDate(event.eventAt)
    || !Number.isInteger(event.deliveryAttemptCount)
    || event.deliveryAttemptCount < 0
    || (event.lastFailureCode !== null
      && !safeFailurePattern.test(event.lastFailureCode))
  ) {
    throw new TypeError("Provider activity event is invalid.");
  }
  const evidence = sanitizeProviderActivityEvidence(event.evidence);
  const expectedDigest = providerActivityEventDigest({
    ...event,
    evidence,
  });
  if (expectedDigest !== event.eventDigest) {
    throw new TypeError("Provider activity event digest does not match.");
  }
  return Object.freeze({ ...event, evidence });
}

export function assertProviderHealthObservation(
  health: ProviderLocalHealthObservation,
): ProviderLocalHealthObservation {
  const states = new Set<ProviderObservedRuntimeState>([
    "idle",
    "running",
    "paused",
    "stopped",
    "error",
  ]);
  if (
    !uuidPattern.test(health.providerId)
    || !states.has(health.observedState)
    || !safeKeyPattern.test(health.freshnessState)
    || !safeKeyPattern.test(health.qualityState)
    || !Number.isSafeInteger(health.consecutiveFailures)
    || health.consecutiveFailures < 0
    || !Number.isSafeInteger(health.openQuarantineCount)
    || health.openQuarantineCount < 0
    || health.publicationLag < 0n
    || !validDate(health.observedAt)
    || [
      health.lastAttemptedAt,
      health.lastHeadReachedAt,
      health.recoveredAt,
      health.lastRunnerHeartbeatAt,
    ].some((value) => value !== null && !validDate(value))
    || (health.latestFailureCode !== null
      && !safeFailurePattern.test(health.latestFailureCode))
    || (health.recoveryHint !== null
      && (!safeSentence(health.recoveryHint, 256)))
  ) {
    throw new TypeError("Provider health observation is invalid.");
  }
  return Object.freeze(health);
}
