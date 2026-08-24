import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import type {
  ClaimedConnectionTestWork,
  ClaimedPageReadWork,
  ClaimedSourceTestWork,
} from "./provider-source-supervisor-work-repository.ts";

export interface ProviderSourceSupervisorQueueCandidate {
  readonly kind: "connection_test" | "source_test" | "page_read";
  readonly id: string;
  readonly queuedAt: Date;
}

export interface ProviderSourceSupervisorClaimIdentity {
  readonly epochId: string;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimLeaseId: string;
}

/**
 * Atomically claims one global-FIFO candidate using the database transaction
 * and timestamp selected by the supervisor work repository.
 */
export async function claimProviderSourceSupervisorCandidate(
  transaction: PackscoutTransactionClient,
  candidate: ProviderSourceSupervisorQueueCandidate,
  input: ProviderSourceSupervisorClaimIdentity,
  databaseNow: Date,
  expiresAt: Date,
): Promise<boolean> {
  if (candidate.kind === "connection_test") {
    return (await transaction.source_connection_test_jobs.updateMany({
      where: { id: candidate.id, state: "queued" },
      data: {
        state: "running",
        claim_owner: input.claimOwner,
        claim_token: input.claimToken,
        claim_expires_at: expiresAt,
        supervisor_epoch_id: input.epochId,
        started_at: databaseNow,
      },
    })).count === 1;
  }
  if (candidate.kind === "source_test") {
    return (await transaction.provider_source_test_jobs.updateMany({
      where: { id: candidate.id, state: "queued" },
      data: {
        state: "running",
        claim_owner: input.claimOwner,
        claim_token: input.claimToken,
        claim_expires_at: expiresAt,
        supervisor_epoch_id: input.epochId,
        started_at: databaseNow,
      },
    })).count === 1;
  }
  return await transaction.$executeRaw(Prisma.sql`
    update public.import_runs
    set state = 'running'::public.import_run_state,
        lease_owner = ${input.claimOwner},
        lease_token = cast(${input.claimToken} as uuid),
        claim_lease_id = cast(${input.claimLeaseId} as uuid),
        lease_expires_at = ${expiresAt},
        heartbeat_at = ${databaseNow},
        started_at = coalesce(started_at, ${databaseNow}),
        attempt = attempt + 1
    where id = cast(${candidate.id} as uuid)
      and state = 'queued'::public.import_run_state
      and source_instance_id is not null
  `) === 1;
}

/**
 * Terminalizes a claimed candidate whose immutable pins are no longer
 * eligible. Lifecycle changes retain their explicit wait state; only an
 * otherwise-active lane becomes action-required.
 */
export async function fenceStaleProviderSourceSupervisorCandidate(
  transaction: PackscoutTransactionClient,
  candidate: ProviderSourceSupervisorQueueCandidate,
  databaseNow: Date,
): Promise<void> {
  if (candidate.kind === "connection_test") {
    await transaction.source_connection_test_jobs.updateMany({
      where: { id: candidate.id, state: "running" },
      data: { state: "fenced", finished_at: databaseNow },
    });
    return;
  }
  if (candidate.kind === "source_test") {
    const jobs = await transaction.provider_source_test_jobs.findMany({
      where: { id: candidate.id, state: "running" },
      select: {
        source_instance_id: true,
        organization_id: true,
        connection_profile_id: true,
        connection_revision_id: true,
      },
    });
    await transaction.provider_source_test_jobs.updateMany({
      where: { id: candidate.id, state: "running" },
      data: { state: "fenced", finished_at: databaseNow },
    });
    if (jobs[0]) {
      await setStaleLaneState(transaction, jobs[0], databaseNow);
    }
    return;
  }
  const runs = await transaction.import_runs.findMany({
    where: { id: candidate.id, state: "running" },
    select: {
      source_instance_id: true,
      organization_id: true,
      connection_profile_id: true,
      connection_revision_id: true,
    },
  });
  await transaction.import_runs.updateMany({
    where: { id: candidate.id, state: "running" },
    data: {
      state: "failed",
      failure_code: "STALE_QUEUED_WORK",
      failure_summary: "Queued source work lost an immutable pin.",
      finished_at: databaseNow,
      lease_owner: null,
      lease_token: null,
      claim_lease_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
    },
  });
  const run = runs[0];
  if (
    run?.source_instance_id &&
    run.connection_profile_id &&
    run.connection_revision_id
  ) {
    await setStaleLaneState(transaction, {
      source_instance_id: run.source_instance_id,
      organization_id: run.organization_id,
      connection_profile_id: run.connection_profile_id,
      connection_revision_id: run.connection_revision_id,
    }, databaseNow);
  }
}

export async function finishProviderSourceSupervisorTestClaim(
  transaction: PackscoutTransactionClient,
  input: Readonly<{
    work: ClaimedConnectionTestWork | ClaimedSourceTestWork;
    epochId: string;
    outcome: "failed" | "fenced";
    safeCode: string;
  }>,
  databaseNow: Date,
): Promise<boolean> {
  const { work } = input;
  const updated = work.kind === "connection_test"
    ? await transaction.source_connection_test_jobs.updateMany({
        where: {
          id: work.id,
          organization_id: work.organizationId,
          state: "running",
          claim_owner: work.claimOwner,
          claim_token: work.claimToken,
          supervisor_epoch_id: input.epochId,
          claim_expires_at: { gt: databaseNow },
        },
        data: { state: input.outcome, finished_at: databaseNow },
      })
    : await transaction.provider_source_test_jobs.updateMany({
        where: {
          id: work.id,
          organization_id: work.organizationId,
          state: "running",
          claim_owner: work.claimOwner,
          claim_token: work.claimToken,
          supervisor_epoch_id: input.epochId,
          claim_expires_at: { gt: databaseNow },
        },
        data: { state: input.outcome, finished_at: databaseNow },
      });
  if (updated.count !== 1) return false;
  if (work.kind === "source_test") {
    const episode = await transaction.source_connection_health_episodes
      .findFirst({
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
    await transaction.provider_source_runtime_states.updateMany({
      where: {
        source_instance_id: work.sourceInstanceId,
        organization_id: work.organizationId,
        source_revision_id: work.sourceRevisionId,
        connection_profile_id: work.connectionProfileId,
      },
      data: episode ? {
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
      } : {
        supervisor_epoch_id: input.epochId,
        phase: input.outcome === "fenced" ? "terminal" : "action_required",
        activity: input.outcome === "fenced" ? "inactive" : "action_required",
        wait_reason: null,
        action_required_code:
          input.outcome === "fenced" ? null : input.safeCode,
        current_run_id: null,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        queued_at: null,
        updated_at: databaseNow,
      },
    });
    return episode !== null;
  }
  return false;
}

/**
 * Clears an exact still-owned page claim after a work-specific stale fence.
 * Supervisor ownership loss never reaches this boundary because the caller
 * first requires its active epoch.
 */
export async function finishFencedProviderSourceSupervisorPageClaim(
  transaction: PackscoutTransactionClient,
  input: Readonly<{
    work: ClaimedPageReadWork;
    epochId: string;
  }>,
  databaseNow: Date,
): Promise<"connection_blocked" | "paused" | "fenced"> {
  const { work } = input;
  const [episode, source] = await Promise.all([
    transaction.source_connection_health_episodes.findFirst({
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
    }),
    transaction.provider_source_instances.findFirst({
      where: {
        id: work.sourceInstanceId,
        organization_id: work.organizationId,
        provider_id: work.providerId,
        active_revision_id: work.sourceRevisionId,
      },
      select: { id: true, state: true, pause_requested_at: true },
    }),
  ]);
  const paused = episode === null && source !== null &&
    (source.state === "paused" || source.pause_requested_at !== null);
  const updated = await transaction.import_runs.updateMany({
    where: {
      id: work.runId,
      organization_id: work.organizationId,
      provider_id: work.providerId,
      source_instance_id: work.sourceInstanceId,
      source_revision_id: work.sourceRevisionId,
      connection_profile_id: work.connectionProfileId,
      connection_revision_id: work.connectionRevisionId,
      state: "running",
      lease_owner: work.claimOwner,
      lease_token: work.claimToken,
      claim_lease_id: work.claimLeaseId,
      lease_expires_at: { gt: databaseNow },
    },
    data: {
      state: episode || paused ? "incomplete" : "failed",
      failure_code: episode
        ? "CONNECTION_BLOCKED"
        : paused
          ? "SOURCE_PAUSED"
          : "STALE_WORK_FENCED",
      failure_summary: episode
        ? "Connection recovery is required."
        : paused
          ? "Source paused at the safe pre-request boundary."
        : "Source work lost an immutable execution fence.",
      finished_at: databaseNow,
      lease_owner: null,
      lease_token: null,
      claim_lease_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
    },
  });
  // Idempotent acknowledgement: another exact boundary may already have
  // terminalized this run, and must remain authoritative.
  if (updated.count !== 1) {
    return episode ? "connection_blocked" : paused ? "paused" : "fenced";
  }
  if (episode) {
    await transaction.provider_source_runtime_states.updateMany({
      where: {
        source_instance_id: work.sourceInstanceId,
        organization_id: work.organizationId,
        source_revision_id: work.sourceRevisionId,
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
    return "connection_blocked";
  }
  if (paused && source) {
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
      transaction.provider_source_runtime_states.updateMany({
        where: {
          source_instance_id: work.sourceInstanceId,
          organization_id: work.organizationId,
          source_revision_id: work.sourceRevisionId,
          connection_profile_id: work.connectionProfileId,
        },
        data: {
          supervisor_epoch_id: input.epochId,
          phase: "paused",
          activity: "paused",
          wait_reason: null,
          action_required_code: null,
          current_run_id: null,
          run_lease_acquired_at: null,
          run_lease_expires_at: null,
          retry_attempt: 0,
          retry_not_before: null,
          queued_at: null,
          updated_at: databaseNow,
        },
      }),
    ]);
    return "paused";
  }
  await setStaleLaneState(transaction, {
    source_instance_id: work.sourceInstanceId,
    organization_id: work.organizationId,
    connection_profile_id: work.connectionProfileId,
    connection_revision_id: work.connectionRevisionId,
  }, databaseNow);
  return "fenced";
}

async function setStaleLaneState(
  transaction: PackscoutTransactionClient,
  pins: Readonly<{
    source_instance_id: string;
    organization_id: string;
    connection_profile_id: string;
    connection_revision_id: string;
  }>,
  databaseNow: Date,
): Promise<void> {
  const [source, profile, revision, episode] = await Promise.all([
    transaction.provider_source_instances.findFirst({
      where: {
        id: pins.source_instance_id,
        organization_id: pins.organization_id,
      },
    }),
    transaction.source_connection_profiles.findFirst({
      where: {
        id: pins.connection_profile_id,
        organization_id: pins.organization_id,
      },
    }),
    transaction.source_connection_revisions.findFirst({
      where: {
        id: pins.connection_revision_id,
        organization_id: pins.organization_id,
        connection_profile_id: pins.connection_profile_id,
      },
    }),
    transaction.source_connection_health_episodes.findFirst({
      where: {
        organization_id: pins.organization_id,
        connection_profile_id: pins.connection_profile_id,
        closed_at: null,
      },
    }),
  ]);
  const paused = source !== null && source !== undefined &&
    (source.state === "paused" || source.pause_requested_at !== null);
  const inactive = source !== null && source !== undefined &&
    source.state !== "active" && !paused;
  const connectionBlocked = episode !== null || profile?.state === "disabled" ||
    revision?.revoked_at !== null;
  await transaction.provider_source_runtime_states.updateMany({
    where: {
      source_instance_id: pins.source_instance_id,
      organization_id: pins.organization_id,
      connection_profile_id: pins.connection_profile_id,
    },
    data: {
      supervisor_epoch_id: null,
      phase: paused ? "paused"
        : inactive ? "terminal"
        : connectionBlocked ? "waiting"
        : "action_required",
      activity: paused ? "paused"
        : inactive ? "inactive"
        : connectionBlocked ? "waiting"
        : "action_required",
      wait_reason: connectionBlocked ? "connection_blocked" : null,
      action_required_code:
        paused || inactive || connectionBlocked ? null : "STALE_QUEUED_WORK",
      current_run_id: null,
      connection_revision_id: episode?.connection_revision_id
        ?? pins.connection_revision_id,
      run_lease_acquired_at: null,
      run_lease_expires_at: null,
      retry_attempt: 0,
      retry_not_before: null,
      blocking_episode_id: episode?.id ?? null,
      blocking_health_generation: episode?.opened_health_generation ?? null,
      queued_at: null,
      updated_at: databaseNow,
    },
  });
}
