import type { PackscoutTransactionClient } from "./database.ts";
import type { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { upsertProviderSourceRuntimeLane } from
  "./provider-source-supervisor-lane-state-repository.ts";
import { appendProviderSourceSupervisorWorkDiagnostic } from
  "./provider-source-supervisor-work-diagnostic.ts";
import type {
  ProviderSourceSupervisorClaimedWork,
  ProviderSourceSupervisorEpochFence,
} from "./provider-source-supervisor-work-repository.ts";

export type ProviderSourceUnstartedWaitReason =
  | "capacity_blocked"
  | "connection_blocked"
  | "graceful_shutdown"
  | "source_lane_busy";

/** Requeue an exact claimed operation and clear its process ownership. */
export async function releaseProviderSourceSupervisorUnstartedClaim(
  transaction: PackscoutTransactionClient,
  diagnostics: ProviderSourceDiagnosticRepository,
  input: ProviderSourceSupervisorEpochFence & Readonly<{
    work: ProviderSourceSupervisorClaimedWork;
    waitReason: ProviderSourceUnstartedWaitReason;
  }>,
  databaseNow: Date,
): Promise<void> {
  const { work } = input;
  const episode = await transaction.source_connection_health_episodes.findFirst({
    where: {
      organization_id: work.organizationId,
      connection_profile_id: work.connectionProfileId,
      closed_at: null,
    },
    select: {
      id: true,
      connection_revision_id: true,
      opened_health_generation: true,
    },
  });
  const exactRecovery = work.kind === "connection_test" &&
    work.recoveryEpisodeId !== null &&
    work.recoveryEpisodeId === episode?.id;
  if (work.kind === "page_read" && !episode) {
    const source = await transaction.provider_source_instances.findFirst({
      where: {
        id: work.sourceInstanceId,
        organization_id: work.organizationId,
        provider_id: work.providerId,
        active_revision_id: work.sourceRevisionId,
      },
      select: { id: true, state: true, pause_requested_at: true },
    });
    if (source && (source.state === "paused" || source.pause_requested_at)) {
      const closed = await transaction.import_runs.updateMany({
        where: {
          id: work.runId,
          state: "running",
          lease_owner: work.claimOwner,
          lease_token: work.claimToken,
          claim_lease_id: work.claimLeaseId,
        },
        data: {
          state: "incomplete",
          failure_code: "SOURCE_PAUSED",
          failure_summary: "Source paused before the request boundary.",
          finished_at: databaseNow,
          lease_owner: null,
          lease_token: null,
          claim_lease_id: null,
          lease_expires_at: null,
          heartbeat_at: null,
        },
      });
      if (closed.count === 1) {
        await Promise.all([
          transaction.provider_source_instances.update({
            where: { id: source.id },
            data: {
              state: "paused",
              pause_requested_at: null,
              paused_at: databaseNow,
              updated_at: databaseNow,
            },
          }),
          upsertProviderSourceRuntimeLane(transaction, work, input.epochId, {
            phase: "paused",
            activity: "paused",
            waitReason: null,
            actionRequiredCode: null,
            currentRunId: null,
            retryAttempt: 0,
            retryNotBefore: null,
            runLeaseAcquiredAt: null,
            runLeaseExpiresAt: null,
            queuedAt: null,
            updatedAt: databaseNow,
          }),
          appendProviderSourceSupervisorWorkDiagnostic(
            transaction,
            diagnostics,
            {
              work,
              transition: "pause_completed",
              occurredAt: databaseNow,
              safeCode: "SOURCE_PAUSED",
            },
          ),
        ]);
      }
      return;
    }
  }
  if (episode && !exactRecovery) {
    if (work.kind === "connection_test") {
      await transaction.source_connection_test_jobs.updateMany({
        where: {
          id: work.id,
          state: "running",
          claim_owner: work.claimOwner,
          claim_token: work.claimToken,
          supervisor_epoch_id: input.epochId,
        },
        data: { state: "cancelled", finished_at: databaseNow },
      });
      return;
    }
    if (work.kind === "source_test") {
      await transaction.provider_source_test_jobs.updateMany({
        where: {
          id: work.id,
          state: "running",
          claim_owner: work.claimOwner,
          claim_token: work.claimToken,
          supervisor_epoch_id: input.epochId,
        },
        data: { state: "cancelled", finished_at: databaseNow },
      });
    } else {
      await transaction.import_runs.updateMany({
        where: {
          id: work.runId,
          state: "running",
          lease_owner: work.claimOwner,
          lease_token: work.claimToken,
          claim_lease_id: work.claimLeaseId,
        },
        data: {
          state: "incomplete",
          failure_code: "CONNECTION_BLOCKED",
          failure_summary: "Connection recovery is required.",
          finished_at: databaseNow,
          lease_owner: null,
          lease_token: null,
          claim_lease_id: null,
          lease_expires_at: null,
          heartbeat_at: null,
        },
      });
    }
    await transaction.provider_source_runtime_states.updateMany({
      where: {
        source_instance_id: work.sourceInstanceId,
        organization_id: work.organizationId,
        connection_profile_id: work.connectionProfileId,
      },
      data: {
        supervisor_epoch_id: input.epochId,
        phase: "waiting",
        activity: "waiting",
        wait_reason: "connection_blocked",
        action_required_code: null,
        current_run_id: null,
        connection_revision_id: episode.connection_revision_id,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        blocking_episode_id: episode.id,
        blocking_health_generation: episode.opened_health_generation,
        queued_at: null,
        updated_at: databaseNow,
      },
    });
    return;
  }
  if (work.kind === "connection_test") {
    await transaction.source_connection_test_jobs.updateMany({
      where: {
        id: work.id,
        state: "running",
        claim_owner: work.claimOwner,
        claim_token: work.claimToken,
        supervisor_epoch_id: input.epochId,
      },
      data: {
        state: "queued",
        queued_at: databaseNow,
        claim_owner: null,
        claim_token: null,
        claim_expires_at: null,
        supervisor_epoch_id: null,
        started_at: null,
      },
    });
  } else if (work.kind === "source_test") {
    await transaction.provider_source_test_jobs.updateMany({
      where: {
        id: work.id,
        state: "running",
        claim_owner: work.claimOwner,
        claim_token: work.claimToken,
        supervisor_epoch_id: input.epochId,
      },
      data: {
        state: "queued",
        queued_at: databaseNow,
        claim_owner: null,
        claim_token: null,
        claim_expires_at: null,
        supervisor_epoch_id: null,
        started_at: null,
      },
    });
  } else {
    await transaction.import_runs.updateMany({
      where: {
        id: work.runId,
        state: "running",
        lease_owner: work.claimOwner,
        lease_token: work.claimToken,
        claim_lease_id: work.claimLeaseId,
      },
      data: {
        state: "queued",
        lease_owner: null,
        lease_token: null,
        claim_lease_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
      },
    });
  }
  if (work.kind !== "connection_test") {
    await upsertProviderSourceRuntimeLane(transaction, work, input.epochId, {
      phase: "waiting",
      activity: "waiting",
      waitReason: input.waitReason,
      actionRequiredCode: null,
      currentRunId: work.kind === "page_read" ? work.runId : null,
      retryAttempt: 0,
      retryNotBefore: null,
      runLeaseAcquiredAt: null,
      runLeaseExpiresAt: null,
      // This operation consumed its fair turn even though no provider resource
      // was granted. A fresh DB timestamp lets older independent work advance
      // instead of repeatedly reclaiming the same saturated-profile waiter.
      queuedAt: databaseNow,
      updatedAt: databaseNow,
    });
  }
}
