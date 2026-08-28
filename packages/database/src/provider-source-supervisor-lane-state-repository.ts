import type { PackscoutTransactionClient } from "./database.ts";
import type {
  ClaimedPageReadWork,
  ClaimedSourceTestWork,
} from "./provider-source-supervisor-work-repository.ts";

export interface ProviderSourceRuntimeLaneUpdate {
  readonly phase: string;
  readonly activity: string;
  readonly waitReason: string | null;
  readonly actionRequiredCode: string | null;
  readonly currentRunId: string | null;
  readonly retryAttempt: number;
  readonly retryNotBefore: Date | null;
  readonly runLeaseAcquiredAt?: Date | null;
  readonly runLeaseExpiresAt?: Date | null;
  readonly pagesCommitted?: number;
  readonly recordsCommitted?: number;
  readonly lastProgressAt?: Date | null;
  readonly cursorFingerprint?: string | null;
  readonly continuationKind?: "continue" | "poll_after" | null;
  readonly continuationMinimumDelaySeconds?: number | null;
  readonly queuedAt?: Date | null;
  readonly nextDueAt?: Date | null;
  readonly updatedAt: Date;
}

/** Exact source/revision/connection runtime-state projection for one lane. */
export async function upsertProviderSourceRuntimeLane(
  transaction: PackscoutTransactionClient,
  work: ClaimedSourceTestWork | ClaimedPageReadWork,
  epochId: string,
  state: Readonly<ProviderSourceRuntimeLaneUpdate>,
): Promise<void> {
  await transaction.provider_source_runtime_states.upsert({
    where: { source_instance_id: work.sourceInstanceId },
    create: {
      source_instance_id: work.sourceInstanceId,
      organization_id: work.organizationId,
      provider_id: work.providerId,
      source_revision_id: work.sourceRevisionId,
      connection_profile_id: work.connectionProfileId,
      connection_revision_id: work.connectionRevisionId,
      supervisor_epoch_id: epochId,
      phase: state.phase,
      activity: state.activity,
      wait_reason: state.waitReason,
      action_required_code: state.actionRequiredCode,
      current_run_id: state.currentRunId,
      run_lease_acquired_at: state.runLeaseAcquiredAt ?? null,
      run_lease_expires_at: state.runLeaseExpiresAt ?? null,
      retry_attempt: state.retryAttempt,
      retry_not_before: state.retryNotBefore,
      pages_committed: state.pagesCommitted ?? 0,
      records_committed: state.recordsCommitted ?? 0,
      last_progress_at: state.lastProgressAt ?? null,
      cursor_fingerprint: state.cursorFingerprint
        ?? (work.kind === "page_read"
          ? work.requestedCursorFingerprint
          : null),
      continuation_kind: state.continuationKind ?? null,
      continuation_minimum_delay_seconds:
        state.continuationMinimumDelaySeconds ?? null,
      next_due_at: state.nextDueAt ?? null,
      queued_at: state.queuedAt ?? null,
      updated_at: state.updatedAt,
    },
    update: {
      source_revision_id: work.sourceRevisionId,
      connection_profile_id: work.connectionProfileId,
      connection_revision_id: work.connectionRevisionId,
      supervisor_epoch_id: epochId,
      phase: state.phase,
      activity: state.activity,
      wait_reason: state.waitReason,
      action_required_code: state.actionRequiredCode,
      current_run_id: state.currentRunId,
      ...(state.runLeaseAcquiredAt === undefined
        ? {}
        : { run_lease_acquired_at: state.runLeaseAcquiredAt }),
      ...(state.runLeaseExpiresAt === undefined
        ? {}
        : { run_lease_expires_at: state.runLeaseExpiresAt }),
      retry_attempt: state.retryAttempt,
      retry_not_before: state.retryNotBefore,
      ...(state.pagesCommitted === undefined
        ? {}
        : { pages_committed: state.pagesCommitted }),
      ...(state.recordsCommitted === undefined
        ? {}
        : { records_committed: state.recordsCommitted }),
      ...(state.lastProgressAt === undefined
        ? {}
        : { last_progress_at: state.lastProgressAt }),
      ...(state.cursorFingerprint === undefined
        ? {}
        : { cursor_fingerprint: state.cursorFingerprint }),
      ...(state.continuationKind === undefined
        ? {}
        : { continuation_kind: state.continuationKind }),
      ...(state.continuationMinimumDelaySeconds === undefined
        ? {}
        : {
            continuation_minimum_delay_seconds:
              state.continuationMinimumDelaySeconds,
          }),
      ...(state.nextDueAt === undefined
        ? {}
        : { next_due_at: state.nextDueAt }),
      ...(state.queuedAt === undefined
        ? {}
        : { queued_at: state.queuedAt }),
      updated_at: state.updatedAt,
    },
  });
}
