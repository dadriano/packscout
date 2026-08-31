import { createHash, randomUUID } from "node:crypto";
import type { ProviderTransactionClient } from "./provider-database.ts";

export type ProviderLocalAuditOutcome = "success" | "failure" | "blocked";
export type ProviderLocalSeverity = "info" | "warning" | "critical";

export type ProviderSafeEvidenceValue = string | number | boolean | null;
export type ProviderSafeEvidence = Readonly<Record<string, ProviderSafeEvidenceValue>>;

const safeTextPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const protectedKeyPattern = /(?:authorization|bearer|candidate|credential|cursor|database[_-]?url|evidence|password|payload|secret|(?:api|access|refresh|auth|bearer)[_-]?token|api[_-]?key)/i;
const localAuditEvidenceKeys = new Set([
  "alreadyExpiredCount",
  "schemaVersion", "headPageId", "configVersionId", "checkpointHash", "batchNumber", "phase",
  "packAfterId", "collectibleAfterId", "packScanDone", "collectibleScanDone",
  "quarantineAfterId", "quarantineAfterAt",
  "commandType",
  "consumerKey",
  "durationMilliseconds",
  "expiredCount",
  "fromState",
  "lastConfirmedSequence",
  "leaseFence",
  "normalizedRecordCount",
  "pageNumber",
  "quarantineId",
  "reasonCode",
  "remainingCount",
  "requestLeaseId",
  "responseBytes",
  "responseLimitTrigger",
  "maximumResponseBytes",
  "reportedResponseBytes",
  "resultCode",
  "runId",
  "selectedCount",
  "sourceRecordCount",
  "stateGeneration",
  "toState",
  "workerRole",
]);
const activityEvidenceKeys = new Set([
  "attemptNumber",
  "expiredCount",
  "failureCode",
  "generation",
  "priorRunId",
  "quarantineState",
  "retentionState",
  "runState",
  "selectedCount",
  "state",
]);

function safeText(value: string, field: string): string {
  if (!safeTextPattern.test(value)) {
    throw new RangeError(`${field} is outside the provider evidence contract.`);
  }
  return value;
}

function safeSentence(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  const containsControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    normalized.length < 1
    || normalized.length > maximumLength
    || containsControlCharacter
  ) throw new RangeError(`${field} is outside the provider evidence contract.`);
  return normalized;
}

function safeEvidence(
  input: ProviderSafeEvidence,
  allowedKeys: ReadonlySet<string>,
): Record<string, ProviderSafeEvidenceValue> {
  const keys = Object.keys(input).sort();
  if (
    keys.length > 24
    || keys.some((key) => !allowedKeys.has(key) || protectedKeyPattern.test(key))
  ) {
    throw new RangeError("Provider evidence contains an unsafe key.");
  }
  const normalized: Record<string, ProviderSafeEvidenceValue> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      value === undefined
      || (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
      || (typeof value === "string" && value.length > 256)
    ) {
      throw new RangeError("Provider evidence contains an unsafe value.");
    }
    normalized[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 4_096) {
    throw new RangeError("Provider evidence exceeds its byte limit.");
  }
  return normalized;
}

export async function appendProviderLocalAudit(
  transaction: ProviderTransactionClient,
  input: {
    readonly commandId?: string | null;
    readonly actorOperatorId?: string | null;
    readonly correlationId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly outcome: ProviderLocalAuditOutcome;
    readonly details?: ProviderSafeEvidence;
    readonly occurredAt: Date;
  },
): Promise<void> {
  if (!uuidPattern.test(input.correlationId)) {
    throw new RangeError("Audit correlation ID is outside the provider evidence contract.");
  }
  if (
    input.commandId !== undefined
    && input.commandId !== null
    && !uuidPattern.test(input.commandId)
  ) throw new RangeError("Audit command ID is outside the provider evidence contract.");
  if (
    input.actorOperatorId !== undefined
    && input.actorOperatorId !== null
    && !uuidPattern.test(input.actorOperatorId)
  ) throw new RangeError("Audit operator ID is outside the provider evidence contract.");
  await transaction.local_audit_events.create({
    data: {
      command_id: input.commandId ?? null,
      actor_operator_id: input.actorOperatorId ?? null,
      correlation_id: input.correlationId,
      action: safeText(input.action, "Audit action"),
      target_type: safeText(input.targetType, "Audit target type"),
      target_id: safeText(input.targetId, "Audit target ID"),
      outcome: input.outcome,
      details: safeEvidence(input.details ?? {}, localAuditEvidenceKeys),
      occurred_at: input.occurredAt,
    },
  });
}

export async function appendProviderActivityOutbox(
  transaction: ProviderTransactionClient,
  input: {
    readonly eventType: string;
    readonly severity: ProviderLocalSeverity;
    readonly dedupeKey: string;
    readonly recoveryKey: string;
    readonly localRunId?: string | null;
    readonly localQuarantineId?: string | null;
    readonly title: string;
    readonly summary: string;
    readonly evidence?: ProviderSafeEvidence;
    readonly eventAt: Date;
  },
): Promise<string> {
  if (
    input.localRunId !== undefined
    && input.localRunId !== null
    && !uuidPattern.test(input.localRunId)
  ) throw new RangeError("Activity run ID is outside the provider evidence contract.");
  if (
    input.localQuarantineId !== undefined
    && input.localQuarantineId !== null
    && !uuidPattern.test(input.localQuarantineId)
  ) throw new RangeError("Activity quarantine ID is outside the provider evidence contract.");
  const id = randomUUID();
  const evidence = safeEvidence(input.evidence ?? {}, activityEvidenceKeys);
  const title = safeSentence(input.title, "Activity title", 160);
  const summary = safeSentence(input.summary, "Activity summary", 500);
  const identity = {
    id,
    eventType: safeText(input.eventType, "Activity event type"),
    severity: input.severity,
    dedupeKey: safeText(input.dedupeKey, "Activity dedupe key"),
    recoveryKey: safeText(input.recoveryKey, "Activity recovery key"),
    localRunId: input.localRunId ?? null,
    localQuarantineId: input.localQuarantineId ?? null,
    title,
    summary,
    evidence,
    eventAt: input.eventAt.toISOString(),
  };
  const eventDigest = createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex");
  await transaction.provider_activity_outbox.create({
    data: {
      id,
      event_digest: eventDigest,
      event_type: identity.eventType,
      severity: input.severity,
      dedupe_key: identity.dedupeKey,
      recovery_key: identity.recoveryKey,
      local_run_id: identity.localRunId,
      local_quarantine_id: identity.localQuarantineId,
      title,
      summary,
      evidence,
      event_at: input.eventAt,
    },
  });
  return id;
}
