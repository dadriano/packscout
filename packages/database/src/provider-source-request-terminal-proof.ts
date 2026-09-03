import type { PackscoutTransactionClient } from "./database.ts";
import {
  PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS,
  type RequestAttemptTerminalState,
} from "./provider-source-persistence-types.ts";
import type { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { appendTerminalRequestStartDiagnostic } from
  "./provider-source-request-diagnostic.ts";

export interface KnownRequestAttempt {
  readonly id: string;
  readonly operationKind: "connection_test" | "source_test" | "page_read";
  readonly requestLeaseId: string;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly expectedHealthGeneration: bigint;
  readonly providerId: string | null;
  readonly sourceInstanceId: string | null;
  readonly sourceRevisionId: string | null;
  readonly connectionTestJobId: string | null;
  readonly sourceTestJobId: string | null;
  readonly runId: string | null;
  readonly pageNumber: number | null;
  readonly cursorGeneration: bigint | null;
  readonly requestedCursorFingerprint: string | null;
  readonly blockingEpisodeId: string | null;
  readonly blockingEpisodeConnectionRevisionId: string | null;
  readonly startedAt: Date;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function requestedCursorKey(
  operationKind: KnownRequestAttempt["operationKind"],
  fingerprint: string | null,
): string | null {
  return operationKind === "page_read" ? fingerprint ?? "initial" : null;
}

export async function persistKnownRequestTerminalization(
  transaction: PackscoutTransactionClient,
  input: Readonly<{
    organizationId: string;
    supervisorEpochId: string;
    attempt: KnownRequestAttempt;
    state: Exclude<RequestAttemptTerminalState, "connection_outcome_uncertain">;
    outcomeClass: string;
    safeCode: string | null;
    safeOutcomeHash: string;
    responseStatus: number | null;
    responseBytes: number | null;
    durationMs: number | null;
    databaseNow: Date;
    diagnostics: ProviderSourceDiagnosticRepository;
  }>,
): Promise<void> {
  const attempt = input.attempt;
  const cursorKey = requestedCursorKey(
    attempt.operationKind,
    attempt.requestedCursorFingerprint,
  );
  await transaction.compact_source_request_attempts.create({
    data: {
      request_attempt_id: attempt.id,
      organization_id: input.organizationId,
      operation_kind: attempt.operationKind,
      terminal_state: input.state,
      outcome_class: input.outcomeClass,
      safe_outcome_hash: input.safeOutcomeHash,
      request_lease_id: attempt.requestLeaseId,
      claim_owner: attempt.claimOwner,
      claim_token: attempt.claimToken,
      supervisor_epoch_id: input.supervisorEpochId,
      connection_profile_id: attempt.connectionProfileId,
      connection_revision_id: attempt.connectionRevisionId,
      expected_health_generation: attempt.expectedHealthGeneration,
      provider_id: attempt.providerId,
      source_instance_id: attempt.sourceInstanceId,
      source_revision_id: attempt.sourceRevisionId,
      connection_test_job_id: attempt.connectionTestJobId,
      source_test_job_id: attempt.sourceTestJobId,
      run_id: attempt.runId,
      page_number: attempt.pageNumber,
      cursor_generation: attempt.cursorGeneration,
      requested_cursor_fingerprint: attempt.requestedCursorFingerprint,
      requested_cursor_key: cursorKey,
      response_bytes: input.responseBytes,
      duration_ms: input.durationMs,
      blocking_episode_id: attempt.blockingEpisodeId,
      blocking_episode_connection_revision_id:
        attempt.blockingEpisodeConnectionRevisionId,
      started_at: attempt.startedAt,
      terminal_at: input.databaseNow,
      compacted_at: null,
    },
  });
  await appendTerminalRequestStartDiagnostic(transaction, input.diagnostics, {
    organizationId: input.organizationId,
    attempt,
  });
  await transaction.source_request_attempts.update({
    where: { id: attempt.id },
    data: {
      state: input.state,
      outcome_class: input.outcomeClass,
      safe_code: input.safeCode,
      safe_outcome_hash: input.safeOutcomeHash,
      response_status: input.responseStatus,
      response_bytes: input.responseBytes,
      duration_ms: input.durationMs,
      terminal_at: input.databaseNow,
      expires_at: addDays(
        input.databaseNow,
        PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS,
      ),
    },
  });
}
