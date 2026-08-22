import { createHash } from "node:crypto";
import type { PackscoutTransactionClient } from "./database.ts";
import { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import type {
  ProviderSourceSupervisorClaimedWork,
  ProviderSourcePageTurnDecision,
} from "./provider-source-supervisor-work-repository.ts";

export type ProviderSourceSupervisorAtomicTransition =
  | "work_claimed"
  | "work_recovered"
  | "continuation_queued"
  | "head_reached"
  | "lease_lost"
  | "pause_completed"
  | "retry_scheduled"
  | "terminal";

/** Stable UUID idempotency key shared by the atomic DB owner and mirror port. */
export function providerSourceSupervisorTransitionDiagnosticId(
  identity: Readonly<{
    organizationId: string;
    kind: ProviderSourceSupervisorClaimedWork["kind"];
    id: string;
    claimToken: string;
  }>,
  transition: string,
): string {
  const value = createHash("sha256")
    .update("packscout.provider-source-supervisor-diagnostic.v1")
    .update("\0")
    .update(identity.organizationId)
    .update("\0")
    .update(identity.kind)
    .update("\0")
    .update(identity.id)
    .update("\0")
    .update(identity.claimToken)
    .update("\0")
    .update(transition)
    .digest()
    .subarray(0, 16);
  value[6] = (value[6]! & 0x0f) | 0x50;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function providerSourceSupervisorDiagnosticId(
  work: ProviderSourceSupervisorClaimedWork,
  transition: string,
): string {
  return providerSourceSupervisorTransitionDiagnosticId(work, transition);
}

function transitionDetails(
  transition: ProviderSourceSupervisorAtomicTransition,
  disposition: ProviderSourcePageTurnDecision | undefined,
) {
  const safeCode = disposition && "safeCode" in disposition
    ? disposition.safeCode
    : transition.toUpperCase();
  return {
    severity: transition === "lease_lost" ||
        transition === "retry_scheduled" ||
        (transition === "terminal" && disposition?.kind === "action_required")
      ? "warning" as const
      : "info" as const,
    safeCode,
    retryDelayMs: disposition?.kind === "retrying"
      ? disposition.retryDelayMilliseconds
      : null,
    continuation: disposition?.kind === "continued"
      ? { kind: "continue" as const }
      : disposition?.kind === "reached_head"
        ? {
            kind: "poll_after" as const,
            minimumDelaySeconds: disposition.minimumDelaySeconds,
          }
        : null,
    cursorFingerprint: disposition &&
        "cursorFingerprint" in disposition
      ? disposition.cursorFingerprint
      : undefined,
  };
}

/** Append the transition in the exact transaction that changes work state. */
export async function appendProviderSourceSupervisorWorkDiagnostic(
  transaction: PackscoutTransactionClient,
  repository: ProviderSourceDiagnosticRepository,
  input: Readonly<{
    work: ProviderSourceSupervisorClaimedWork;
    transition: ProviderSourceSupervisorAtomicTransition;
    occurredAt: Date;
    disposition?: ProviderSourcePageTurnDecision;
    safeCode?: string;
    severity?: "info" | "warning" | "critical";
    requestAttemptId?: string;
    durationMs?: number | null;
    responseBytes?: number | null;
    counters?: Readonly<Record<string, number>>;
    evidence?: Readonly<Record<string, string | number | boolean | null>>;
  }>,
): Promise<string> {
  const details = transitionDetails(input.transition, input.disposition);
  const common = {
    id: providerSourceSupervisorDiagnosticId(input.work, input.transition),
    organizationId: input.work.organizationId,
    severity: input.severity ?? details.severity,
    phase: input.transition,
    safeCode: input.safeCode ?? details.safeCode,
    occurredAt: input.occurredAt,
    sourceTypeKey: input.work.sourceTypeKey,
    sourceAdapterVersion: input.work.sourceAdapterVersion,
    connectionProfileId: input.work.connectionProfileId,
    connectionRevisionId: input.work.connectionRevisionId,
    retryDelayMs: details.retryDelayMs,
    continuation: details.continuation,
    cursorFingerprint: details.cursorFingerprint ??
      (input.work.kind === "page_read"
        ? input.work.requestedCursorFingerprint
        : null),
    durationMs: input.durationMs,
    responseBytes: input.responseBytes,
    counters: input.counters,
    evidence: input.evidence,
  } as const;
  if (input.work.kind === "connection_test") {
    return repository.appendInTransaction(transaction, {
      ...common,
      scope: "connection",
      correlationKind: "connection_test",
      eventKind: "connection_test",
      connectionTestJobId: input.work.id,
      blockingEpisodeId: input.work.recoveryEpisodeId,
      requestAttemptId: input.requestAttemptId,
    });
  }
  if (input.work.kind === "source_test") {
    return repository.appendInTransaction(transaction, {
      ...common,
      scope: "source",
      correlationKind: "source_test",
      eventKind: "source_test",
      normalizedContractVersion: input.work.normalizedContractVersion,
      providerId: input.work.providerId,
      sourceInstanceId: input.work.sourceInstanceId,
      sourceRevisionId: input.work.sourceRevisionId,
      sourceTestJobId: input.work.id,
      requestAttemptId: input.requestAttemptId,
    });
  }
  if (input.requestAttemptId) {
    return repository.appendInTransaction(transaction, {
      ...common,
      scope: "source",
      correlationKind: "page",
      eventKind: "source_page",
      normalizedContractVersion: input.work.normalizedContractVersion,
      providerId: input.work.providerId,
      sourceInstanceId: input.work.sourceInstanceId,
      sourceRevisionId: input.work.sourceRevisionId,
      runId: input.work.runId,
      requestAttemptId: input.requestAttemptId,
      runTrigger: input.work.runTrigger,
    });
  }
  return repository.appendInTransaction(transaction, {
    ...common,
    scope: "source",
    correlationKind: "run",
    eventKind: "source_run",
    normalizedContractVersion: input.work.normalizedContractVersion,
    providerId: input.work.providerId,
    sourceInstanceId: input.work.sourceInstanceId,
    sourceRevisionId: input.work.sourceRevisionId,
    runId: input.work.runId,
    runTrigger: input.work.runTrigger,
  });
}
