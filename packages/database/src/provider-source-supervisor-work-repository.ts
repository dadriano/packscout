import { Prisma } from "@prisma/client";
import {
  launchProviderKeySchema,
  providerSourceRunBounds,
  providerSourceSingletonTiming,
  providerSourceTransientRetryPolicy,
} from "@packscout/contracts";
import {
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from
  "./provider-source-database-clock.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { appendProviderSourceSupervisorWorkDiagnostic } from
  "./provider-source-supervisor-work-diagnostic.ts";
import {
  ProviderSourceSupervisorClaimRecoveryRepository,
  type ProviderSourceSupervisorRecoverableClaim,
} from "./provider-source-supervisor-claim-recovery-repository.ts";
import {
  releaseProviderSourceSupervisorUnstartedClaim,
  type ProviderSourceUnstartedWaitReason,
} from "./provider-source-supervisor-unstarted-repository.ts";
import {
  markProviderSourceSupervisorAdmissionState,
  type ProviderSourceAdmissionWaitReason,
} from "./provider-source-supervisor-admission-state-repository.ts";
import { upsertProviderSourceRuntimeLane } from
  "./provider-source-supervisor-lane-state-repository.ts";
import { PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION } from
  "./provider-source-persistence-types.ts";
import {
  claimProviderSourceSupervisorCandidate,
  fenceStaleProviderSourceSupervisorCandidate,
  finishFencedProviderSourceSupervisorPageClaim,
  finishProviderSourceSupervisorTestClaim,
  type ProviderSourceSupervisorQueueCandidate,
} from "./provider-source-supervisor-work-claim-repository.ts";
import { findProviderSourceSupervisorClaimReplay } from
  "./provider-source-supervisor-claim-replay-repository.ts";
import { rolloverExpiredQueuedProviderSourceRun } from
  "./provider-source-supervisor-queued-rollover-repository.ts";
import {
  providerSourceBoundedCounter as boundedCounter,
  providerSourceCheckpointValue as checkpointValue,
} from "./provider-source-supervisor-work-values.ts";
import type {
  ClaimedConnectionTestWork,
  ClaimedPageReadWork,
  ClaimedSourceTestWork,
  ProviderSourceDueLane,
  ProviderSourcePageTurnDecision,
  ProviderSourceSupervisorClaimedWork,
  ProviderSourceSupervisorEpochFence,
} from "./provider-source-supervisor-work-types.ts";
export type {
  ClaimedConnectionTestWork,
  ClaimedPageReadWork,
  ClaimedSourceTestWork,
  ProviderSourceDueLane,
  ProviderSourceEncryptedConnectionConfiguration,
  ProviderSourcePageTurnDecision,
  ProviderSourceSupervisorClaimedWork,
  ProviderSourceSupervisorEpochFence,
} from "./provider-source-supervisor-work-types.ts";

export type { ProviderSourceSupervisorRecoverableClaim } from
  "./provider-source-supervisor-claim-recovery-repository.ts";

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

function claimExpiry(databaseNow: Date): Date {
  return new Date(
    databaseNow.getTime() + providerSourceSingletonTiming.leaseSeconds * 1_000,
  );
}

/**
 * DB-time queue, claim, recovery, and one-page-turn boundary for the one
 * source supervisor. Transport configuration stays encrypted in this layer.
 */
export class ProviderSourceSupervisorWorkRepository {
  readonly #runs: ProviderSourceImportRunRepository;
  readonly #claimRecovery: ProviderSourceSupervisorClaimRecoveryRepository;
  readonly #diagnostics: ProviderSourceDiagnosticRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    this.#runs = new ProviderSourceImportRunRepository(database);
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
    this.#claimRecovery = new ProviderSourceSupervisorClaimRecoveryRepository(
      database,
    );
  }

  async listDueSources(input: ProviderSourceSupervisorEpochFence & Readonly<{
    limit: number;
  }>): Promise<readonly ProviderSourceDueLane[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("Due-source limit is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      return transaction.$queryRaw<ProviderSourceDueLane[]>(Prisma.sql`
        select schedule.organization_id as "organizationId",
               schedule.provider_id as "providerId",
               schedule.source_instance_id as "sourceInstanceId",
               source.active_revision_id as "sourceRevisionId",
               schedule.next_due_at as "dueAt"
        from public.provider_source_schedules as schedule
        join public.provider_source_instances as source
          on source.id = schedule.source_instance_id
         and source.organization_id = schedule.organization_id
         and source.provider_id = schedule.provider_id
        join public.source_connection_profiles as profile
          on profile.id = source.connection_profile_id
         and profile.organization_id = source.organization_id
        join public.source_connection_revisions as connection_revision
          on connection_revision.id = profile.active_revision_id
         and connection_revision.organization_id = profile.organization_id
         and connection_revision.connection_profile_id = profile.id
        left join public.provider_source_runtime_states as runtime
          on runtime.source_instance_id = source.id
         and runtime.organization_id = source.organization_id
        where schedule.next_due_at <= ${databaseNow}
          and source.state = 'active'::public.provider_source_instance_state
          and source.active_revision_id is not null
          and source.pause_requested_at is null
          and profile.state = 'active'::public.connection_profile_state
          and connection_revision.state = 'active'::public.connection_revision_state
          and connection_revision.revoked_at is null
          and (runtime.retry_not_before is null or runtime.retry_not_before <= ${databaseNow})
          and coalesce(runtime.activity, 'inactive') <> 'action_required'
          and not exists (
            select 1 from public.source_connection_health_episodes as episode
            where episode.organization_id = source.organization_id
              and episode.connection_profile_id = source.connection_profile_id
              and episode.closed_at is null
          )
          and not exists (
            select 1 from public.import_runs as active_run
            where active_run.organization_id = source.organization_id
              and active_run.source_instance_id = source.id
              and active_run.state in (
                'queued'::public.import_run_state,
                'running'::public.import_run_state
              )
          )
        order by schedule.next_due_at, schedule.source_instance_id
        limit ${input.limit}
      `);
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async materializeScheduledRun(input:
    ProviderSourceSupervisorEpochFence & ProviderSourceDueLane & Readonly<{
      runId: string;
    }>,
  ): Promise<"created" | "coalesced" | "unavailable"> {
    return this.database.$transaction(async (transaction) => {
      const requestedAt = await this.#assertActiveEpoch(transaction, input);
      const stillDue = await transaction.provider_source_schedules.findFirst({
        where: {
          source_instance_id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          next_due_at: { lte: requestedAt },
        },
        select: { source_instance_id: true },
      });
      if (!stillDue) return "unavailable";
      const result = await this.#runs.requestRunInTransaction(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        runId: input.runId,
        trigger: "scheduled",
        requestedByActorKey: null,
        requestedAt: input.dueAt,
        scheduledDueAt: input.dueAt,
        transitionAt: requestedAt,
        expectedSourceRevisionId: input.sourceRevisionId,
      });
      if (result.kind === "created") return "created";
      if (result.kind === "active") return "coalesced";
      return "unavailable";
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async listReconcilablePredecessorAttempts(
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<readonly Readonly<{
    organizationId: string;
    requestAttemptId: string;
  }>[]> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      return transaction.$queryRaw<Array<{
        organizationId: string;
        requestAttemptId: string;
      }>>(Prisma.sql`
        select attempt.organization_id as "organizationId",
               attempt.id as "requestAttemptId"
        from public.source_request_attempts as attempt
        join public.source_supervisor_epochs as predecessor
          on predecessor.id = attempt.supervisor_epoch_id
        join public.source_supervisor_epochs as current
          on current.id = cast(${input.epochId} as uuid)
        where attempt.state = 'in_flight'::public.source_request_attempt_state
          and predecessor.environment_key = current.environment_key
          and predecessor.epoch_number < current.epoch_number
          and (
            (predecessor.state = 'released'::public.supervisor_epoch_state
              and predecessor.released_at <= ${databaseNow})
            or
            (predecessor.state = 'expired'::public.supervisor_epoch_state
              and predecessor.takeover_not_before <= ${databaseNow})
          )
        order by predecessor.epoch_number, attempt.started_at, attempt.id
      `);
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async recoverExpiredClaims(
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<Readonly<{
    connectionTests: number;
    sourceTests: number;
    runs: number;
  }>> {
    return this.#claimRecovery.recoverAll(input);
  }

  async listRecoverableClaims(
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<readonly ProviderSourceSupervisorRecoverableClaim[]> {
    return this.#claimRecovery.list(input);
  }

  async recoverClaim(
    input: ProviderSourceSupervisorEpochFence & Readonly<{
      claim: ProviderSourceSupervisorRecoverableClaim;
    }>,
  ): Promise<void> {
    await this.#claimRecovery.recoverOne(input);
  }

  async claimNext(input: ProviderSourceSupervisorEpochFence & Readonly<{
    claimOwner: string;
    claimToken: string;
    claimLeaseId: string;
    excludedProfiles?: readonly Readonly<{
      organizationId: string;
      connectionProfileId: string;
    }>[];
    excludedSourceInstanceIds?: readonly string[];
    skipPageReads?: boolean;
  }>): Promise<ProviderSourceSupervisorClaimedWork | null> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select pg_advisory_xact_lock(
          hashtextextended(${input.claimToken}, 719_008)
        )::text as locked
      `);
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const replay = await findProviderSourceSupervisorClaimReplay(
        transaction,
        { ...input, epochId: input.epochId },
      );
      if (replay) {
        try {
          // The command already committed this exact claim. Reconstruct its
          // immutable pins without applying mutable eligibility a second
          // time; request.begin owns the zero-call pause/revoke/episode fence.
          return await this.#loadClaimed(
            transaction,
            replay.candidate,
            input,
            databaseNow,
            replay.expiresAt,
            true,
          );
        } catch (error) {
          if (!(error instanceof PersistenceError)) throw error;
          await fenceStaleProviderSourceSupervisorCandidate(
            transaction,
            replay.candidate,
            databaseNow,
          );
          return null;
        }
      }
      // Select the global FIFO before immutable-pin validation. A stale oldest
      // row is claimed and fenced below, then selection continues, so it can
      // never starve later independent work. Temporary retry/action/pause
      // boundaries remain ineligible rather than being misclassified stale.
      const excludedProfiles = input.excludedProfiles ?? [];
      const excludedSources = input.excludedSourceInstanceIds ?? [];
      const excludeTestProfiles = excludedProfiles.length === 0
        ? Prisma.empty
        : Prisma.sql`and not (${Prisma.join(excludedProfiles.map((profile) =>
            Prisma.sql`(
              job.organization_id = cast(${profile.organizationId} as uuid)
              and job.connection_profile_id = cast(${profile.connectionProfileId} as uuid)
            )`
          ), " or ")})`;
      const excludeRunProfiles = excludedProfiles.length === 0
        ? Prisma.empty
        : Prisma.sql`and not (${Prisma.join(excludedProfiles.map((profile) =>
            Prisma.sql`(
              run.organization_id = cast(${profile.organizationId} as uuid)
              and run.connection_profile_id = cast(${profile.connectionProfileId} as uuid)
            )`
          ), " or ")})`;
      const excludeTestSources = excludedSources.length === 0
        ? Prisma.empty
        : Prisma.sql`and job.source_instance_id not in (
            ${Prisma.join(excludedSources.map((sourceId) =>
              Prisma.sql`cast(${sourceId} as uuid)`
            ))}
          )`;
      const excludeRunSources = excludedSources.length === 0
        ? Prisma.empty
        : Prisma.sql`and run.source_instance_id not in (
            ${Prisma.join(excludedSources.map((sourceId) =>
              Prisma.sql`cast(${sourceId} as uuid)`
            ))}
          )`;
      const candidates = await transaction.$queryRaw<
        ProviderSourceSupervisorQueueCandidate[]
      >(Prisma.sql`
        select candidate.kind, candidate.id, candidate."queuedAt"
        from (
          select 'connection_test'::text as kind,
                 job.id,
                 job.queued_at as "queuedAt"
          from public.source_connection_test_jobs as job
          where job.state = 'queued'::public.source_test_job_state
            ${excludeTestProfiles}
          union all
          select 'source_test'::text as kind,
                 job.id,
                 job.queued_at as "queuedAt"
          from public.provider_source_test_jobs as job
          where job.state = 'queued'::public.source_test_job_state
            ${excludeTestProfiles}
            ${excludeTestSources}
          union all
          select 'page_read'::text as kind,
                 run.id,
                 coalesce(runtime.queued_at, run.created_at) as "queuedAt"
          from public.import_runs as run
          left join public.provider_source_runtime_states as runtime
            on runtime.source_instance_id = run.source_instance_id
           and runtime.organization_id = run.organization_id
          left join public.provider_source_instances as source
            on source.id = run.source_instance_id
           and source.organization_id = run.organization_id
          where run.state = 'queued'::public.import_run_state
            and run.source_instance_id is not null
            ${input.skipPageReads ? Prisma.sql`and false` : Prisma.empty}
            and (runtime.retry_not_before is null
              or runtime.retry_not_before <= ${databaseNow})
            and coalesce(runtime.activity, 'inactive') <> 'action_required'
            and (source.id is null or source.pause_requested_at is null)
            ${excludeRunProfiles}
            ${excludeRunSources}
        ) as candidate
        order by candidate."queuedAt", candidate.kind, candidate.id
        limit 100
      `);
      const expiresAt = claimExpiry(databaseNow);
      for (const candidate of candidates) {
        if (
          await rolloverExpiredQueuedProviderSourceRun(
            transaction,
            this.#runs,
            candidate,
            databaseNow,
          )
        ) continue;
        const claimed = await claimProviderSourceSupervisorCandidate(
          transaction,
          candidate,
          input,
          databaseNow,
          expiresAt,
        );
        if (!claimed) continue;
        try {
          const work = await this.#loadClaimed(
            transaction,
            candidate,
            input,
            databaseNow,
            expiresAt,
          );
          if (work.kind !== "connection_test") {
            await upsertProviderSourceRuntimeLane(transaction, work, input.epochId, {
              phase: "claimed",
              activity: "running",
              waitReason: null,
              actionRequiredCode: null,
              currentRunId: work.kind === "page_read" ? work.runId : null,
              retryAttempt: work.kind === "page_read" ? work.retryAttempt : 0,
              retryNotBefore: null,
              runLeaseAcquiredAt: databaseNow,
              runLeaseExpiresAt: expiresAt,
              ...(work.kind === "page_read"
                ? {
                    pagesCommitted: work.committedPages,
                    recordsCommitted: work.committedRecords,
                  }
                : {}),
              updatedAt: databaseNow,
            });
          }
          await appendProviderSourceSupervisorWorkDiagnostic(
            transaction,
            this.#diagnostics,
            { work, transition: "work_claimed", occurredAt: databaseNow },
          );
          return work;
        } catch (error) {
          if (!(error instanceof PersistenceError)) throw error;
          await fenceStaleProviderSourceSupervisorCandidate(
            transaction,
            candidate,
            databaseNow,
          );
        }
      }
      return null;
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async releaseUnstartedClaim(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ProviderSourceSupervisorClaimedWork;
      waitReason: ProviderSourceUnstartedWaitReason;
      releasedAt: Date;
    }>,
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      await releaseProviderSourceSupervisorUnstartedClaim(
        transaction,
        this.#diagnostics,
        input,
        databaseNow,
      );
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async renewClaim(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ProviderSourceSupervisorClaimedWork;
    }>,
  ): Promise<Date | null> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const expiresAt = claimExpiry(databaseNow);
      const { work } = input;
      let renewed = 0;
      if (work.kind === "connection_test") {
        renewed = (await transaction.source_connection_test_jobs.updateMany({
          where: {
            id: work.id,
            organization_id: work.organizationId,
            state: "running",
            claim_owner: work.claimOwner,
            claim_token: work.claimToken,
            claim_expires_at: { gt: databaseNow },
            supervisor_epoch_id: input.epochId,
          },
          data: { claim_expires_at: expiresAt },
        })).count;
      } else if (work.kind === "source_test") {
        renewed = (await transaction.provider_source_test_jobs.updateMany({
          where: {
            id: work.id,
            organization_id: work.organizationId,
            source_instance_id: work.sourceInstanceId,
            source_revision_id: work.sourceRevisionId,
            state: "running",
            claim_owner: work.claimOwner,
            claim_token: work.claimToken,
            claim_expires_at: { gt: databaseNow },
            supervisor_epoch_id: input.epochId,
          },
          data: { claim_expires_at: expiresAt },
        })).count;
      } else {
        renewed = (await transaction.import_runs.updateMany({
          where: {
            id: work.runId,
            organization_id: work.organizationId,
            source_instance_id: work.sourceInstanceId,
            source_revision_id: work.sourceRevisionId,
            state: "running",
            lease_owner: work.claimOwner,
            lease_token: work.claimToken,
            claim_lease_id: work.claimLeaseId,
            lease_expires_at: { gt: databaseNow },
          },
          data: {
            lease_expires_at: expiresAt,
            heartbeat_at: databaseNow,
          },
        })).count;
      }
      if (renewed !== 1) {
        // A renewal may race the exact result/page finalization transaction.
        // Once the same claim has a permanent terminal request proof, the
        // non-running work row is an acknowledged terminal boundary rather
        // than lease loss. The active epoch assertion above still makes
        // genuine supervisor replacement fail closed.
        const terminalProof = await transaction.compact_source_request_attempts
          .findFirst({
            where: {
              organization_id: work.organizationId,
              supervisor_epoch_id: input.epochId,
              claim_owner: work.claimOwner,
              claim_token: work.claimToken,
              ...(work.kind === "connection_test"
                ? {
                    operation_kind: "connection_test" as const,
                    connection_test_job_id: work.id,
                  }
                : work.kind === "source_test"
                  ? {
                      operation_kind: "source_test" as const,
                      source_test_job_id: work.id,
                    }
                  : {
                      operation_kind: "page_read" as const,
                      run_id: work.runId,
                      page_number: work.pageNumber,
                      checkpoint_generation: work.checkpointGeneration,
                      requested_checkpoint_key:
                        work.requestedCheckpointFingerprint ?? "initial",
                    }),
            },
            select: { request_attempt_id: true },
          });
        if (terminalProof) return databaseNow;
        await appendProviderSourceSupervisorWorkDiagnostic(
          transaction,
          this.#diagnostics,
          {
            work,
            transition: "lease_lost",
            occurredAt: databaseNow,
            safeCode: "WORK_CLAIM_RENEWAL_LOST",
            severity: "warning",
          },
        );
        return null;
      }
      if (work.kind !== "connection_test") {
        await transaction.provider_source_runtime_states.updateMany({
          where: {
            source_instance_id: work.sourceInstanceId,
            organization_id: work.organizationId,
            source_revision_id: work.sourceRevisionId,
            connection_profile_id: work.connectionProfileId,
            connection_revision_id: work.connectionRevisionId,
            supervisor_epoch_id: input.epochId,
            activity: { in: ["running", "waiting"] },
          },
          data: {
            run_lease_expires_at: expiresAt,
            updated_at: databaseNow,
          },
        });
      }
      return expiresAt;
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async markAdmissionWaiting(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ProviderSourceSupervisorClaimedWork;
      reason: ProviderSourceAdmissionWaitReason;
    }>,
  ): Promise<void> {
    return this.#markAdmissionState(input, {
      kind: "waiting",
      reason: input.reason,
    });
  }

  async markAdmissionGranted(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ProviderSourceSupervisorClaimedWork;
    }>,
  ): Promise<void> {
    return this.#markAdmissionState(input, { kind: "granted" });
  }

  async finishTestClaim(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ClaimedConnectionTestWork | ClaimedSourceTestWork;
      outcome: "failed" | "fenced";
      safeCode: string;
    }>,
  ): Promise<void> {
    if (!SAFE_CODE.test(input.safeCode)) {
      throw new TypeError("Test-claim safe code is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const connectionBlocked = await finishProviderSourceSupervisorTestClaim(
        transaction,
        input,
        databaseNow,
      );
      if (!connectionBlocked) await appendProviderSourceSupervisorWorkDiagnostic(
        transaction,
        this.#diagnostics,
        {
          work: input.work,
          transition: "terminal",
          occurredAt: databaseNow,
          safeCode: input.safeCode,
          severity: input.outcome === "failed" ? "warning" : "info",
        },
      );
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async finishFencedPageClaim(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ClaimedPageReadWork;
    }>,
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const outcome = await finishFencedProviderSourceSupervisorPageClaim(
        transaction,
        input,
        databaseNow,
      );
      if (outcome !== "connection_blocked") {
        await appendProviderSourceSupervisorWorkDiagnostic(
          transaction,
          this.#diagnostics,
          {
            work: input.work,
            transition: outcome === "paused" ? "pause_completed" : "terminal",
            occurredAt: databaseNow,
            safeCode: outcome === "paused"
              ? "SOURCE_PAUSED"
              : "STALE_WORK_FENCED",
          },
        );
      }
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async finishPageTurn(input:
    ProviderSourceSupervisorEpochFence & Readonly<{
      work: ClaimedPageReadWork;
      decision: ProviderSourcePageTurnDecision;
    }>,
  ): Promise<ProviderSourcePageTurnDecision> {
    if (
      "safeCode" in input.decision &&
      !SAFE_CODE.test(input.decision.safeCode)
    ) {
      throw new TypeError("Page-turn safe code is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const run = await transaction.import_runs.findFirst({
        where: {
          id: input.work.runId,
          organization_id: input.work.organizationId,
          source_instance_id: input.work.sourceInstanceId,
          source_revision_id: input.work.sourceRevisionId,
          state: "running",
          lease_owner: input.work.claimOwner,
          lease_token: input.work.claimToken,
          claim_lease_id: input.work.claimLeaseId,
          lease_expires_at: { gt: databaseNow },
        },
      });
      if (!run) {
        throw new PersistenceError("SOURCE_FENCED", "Page-turn claim was lost.");
      }
      const sourceRows = await transaction.$queryRaw<Array<{
        id: string;
        state: "draft" | "active" | "paused" | "disabled" | "replaced";
        pauseRequestedAt: Date | null;
      }>>(Prisma.sql`
        select id, state, pause_requested_at as "pauseRequestedAt"
        from public.provider_source_instances
        where id = cast(${input.work.sourceInstanceId} as uuid)
          and organization_id = cast(${input.work.organizationId} as uuid)
          and provider_id = cast(${input.work.providerId} as uuid)
          and active_revision_id = cast(${input.work.sourceRevisionId} as uuid)
        for update
      `);
      const source = sourceRows[0];
      if (!source) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Page-turn source pins changed before the safe boundary.",
        );
      }
      const clearLease = {
        lease_owner: null,
        lease_token: null,
        claim_lease_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
      } as const;
      const requestProof = input.decision.kind === "retrying" ||
          input.decision.kind === "action_required"
        ? await transaction.compact_source_request_attempts.findFirst({
            where: {
              organization_id: input.work.organizationId,
              supervisor_epoch_id: input.epochId,
              claim_owner: input.work.claimOwner,
              claim_token: input.work.claimToken,
              operation_kind: "page_read",
              run_id: input.work.runId,
              page_number: input.work.pageNumber,
              checkpoint_generation: input.work.checkpointGeneration,
              requested_checkpoint_key:
                input.work.requestedCheckpointFingerprint ?? "initial",
            },
            orderBy: [
              { terminal_at: "desc" },
              { request_attempt_id: "desc" },
            ],
            select: {
              request_attempt_id: true,
              duration_ms: true,
              response_bytes: true,
              terminal_state: true,
            },
          })
        : null;

      if (
        input.decision.kind === "paused" ||
        source.pauseRequestedAt !== null ||
        source.state === "paused"
      ) {
        await Promise.all([
          transaction.import_runs.update({
            where: { id: run.id },
            data: {
              state: "incomplete",
              finished_at: databaseNow,
              ...clearLease,
            },
          }),
          transaction.provider_source_instances.update({
            where: { id: input.work.sourceInstanceId },
            data: {
              state: "paused",
              pause_requested_at: null,
              paused_at: databaseNow,
              updated_at: databaseNow,
            },
          }),
        ]);
        await upsertProviderSourceRuntimeLane(transaction, input.work, input.epochId, {
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
        });
        const applied = { kind: "paused" as const };
        await appendProviderSourceSupervisorWorkDiagnostic(
          transaction,
          this.#diagnostics,
          {
            work: input.work,
            transition: "pause_completed",
            occurredAt: databaseNow,
            disposition: applied,
          },
        );
        return applied;
      }

      if (
        input.decision.kind === "continued" ||
        input.decision.kind === "reached_head"
      ) {
        if (
          boundedCounter(run.counters_json, "pages") !==
            input.decision.pagesCommitted ||
          boundedCounter(run.counters_json, "records") !==
            input.decision.recordsCommitted ||
          run.current_checkpoint_fingerprint !==
            input.decision.checkpointFingerprint
        ) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Page-turn completion does not match durable run progress.",
          );
        }
      }

      if (input.decision.kind === "continued") {
        const pagesCommitted = boundedCounter(run.counters_json, "pages");
        const recordsCommitted = boundedCounter(run.counters_json, "records");
        if (
          pagesCommitted !== input.decision.pagesCommitted ||
          recordsCommitted !== input.decision.recordsCommitted ||
          run.current_checkpoint_fingerprint !==
            input.decision.checkpointFingerprint
        ) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Page-turn completion does not match durable run progress.",
          );
        }
        const startedAt = run.started_at ?? databaseNow;
        const shouldRollover =
          pagesCommitted >= providerSourceRunBounds.maximumCommittedPages ||
          databaseNow.getTime() - startedAt.getTime() >=
            providerSourceRunBounds.maximumElapsedMilliseconds;
        if (!shouldRollover) {
          await transaction.import_runs.update({
            where: { id: run.id },
            data: { state: "queued", ...clearLease },
          });
          await upsertProviderSourceRuntimeLane(transaction, input.work, input.epochId, {
            phase: "queued",
            activity: "queued",
            waitReason: null,
            actionRequiredCode: null,
            currentRunId: run.id,
            retryAttempt: 0,
            retryNotBefore: null,
            runLeaseAcquiredAt: null,
            runLeaseExpiresAt: null,
            checkpointFingerprint: input.decision.checkpointFingerprint,
            continuationKind: "continue",
            continuationMinimumDelaySeconds: null,
            pagesCommitted,
            recordsCommitted,
            lastProgressAt: databaseNow,
            queuedAt: databaseNow,
            updatedAt: databaseNow,
          });
          await appendProviderSourceSupervisorWorkDiagnostic(
            transaction,
            this.#diagnostics,
            {
              work: input.work,
              transition: "continuation_queued",
              occurredAt: databaseNow,
              disposition: input.decision,
            },
          );
          return input.decision;
        }
        await transaction.import_runs.update({
          where: { id: run.id },
          data: {
            state: "incomplete",
            finished_at: databaseNow,
            failure_code: null,
            failure_summary: null,
            ...clearLease,
          },
        });
        const continuation = await this.#runs.requestRunInTransaction(
          transaction,
          {
            organizationId: input.work.organizationId,
            providerId: input.work.providerId,
            runId: input.decision.continuationRunId,
            trigger: "continuation",
            requestedByActorKey: null,
            requestedAt: databaseNow,
            expectedSourceRevisionId: input.work.sourceRevisionId,
          },
        );
        if (continuation.kind !== "created") {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Continuation run did not win its exact queue transition.",
          );
        }
        await upsertProviderSourceRuntimeLane(transaction, input.work, input.epochId, {
          phase: "queued",
          activity: "queued",
          waitReason: null,
          actionRequiredCode: null,
          currentRunId: continuation.run.id,
          retryAttempt: 0,
          retryNotBefore: null,
          runLeaseAcquiredAt: null,
          runLeaseExpiresAt: null,
          checkpointFingerprint: input.decision.checkpointFingerprint,
          continuationKind: "continue",
          continuationMinimumDelaySeconds: null,
          pagesCommitted,
          recordsCommitted,
          lastProgressAt: databaseNow,
          queuedAt: databaseNow,
          updatedAt: databaseNow,
        });
        await appendProviderSourceSupervisorWorkDiagnostic(
          transaction,
          this.#diagnostics,
          {
            work: input.work,
            transition: "continuation_queued",
            occurredAt: databaseNow,
            disposition: input.decision,
          },
        );
        return input.decision;
      }

      if (input.decision.kind === "reached_head") {
        if (
          !Number.isSafeInteger(input.decision.minimumDelaySeconds) ||
          input.decision.minimumDelaySeconds < 0 ||
          input.decision.minimumDelaySeconds > 86_400
        ) {
          throw new TypeError("Poll-after minimum delay is invalid.");
        }
        const schedule = await transaction.provider_source_schedules.findUnique({
          where: { source_instance_id: input.work.sourceInstanceId },
          select: { active_schedule_revision_id: true },
        });
        if (!schedule) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Page-turn schedule was removed before the safe boundary.",
          );
        }
        const currentIntervalSeconds = await this.#sourceIntervalSeconds(
          transaction,
          schedule.active_schedule_revision_id,
        );
        const nextDueAt = new Date(
          databaseNow.getTime() +
            Math.max(
              currentIntervalSeconds,
              input.decision.minimumDelaySeconds,
            ) * 1_000,
        );
        await Promise.all([
          transaction.import_runs.update({
            where: { id: run.id },
            data: {
              state: "succeeded",
              reached_provider_head: true,
              finished_at: databaseNow,
              ...clearLease,
            },
          }),
          transaction.provider_source_schedules.update({
            where: { source_instance_id: input.work.sourceInstanceId },
            data: {
              next_due_at: nextDueAt,
              last_due_at: databaseNow,
              last_outcome: "reached_head",
              last_run_id: run.id,
              updated_at: databaseNow,
            },
          }),
          transaction.provider_source_health_states.update({
            where: { source_instance_id: input.work.sourceInstanceId },
            data: {
              last_head_reached_at: databaseNow,
              consecutive_failures: 0,
              latest_failure_code: null,
              recovered_at: databaseNow,
              updated_at: databaseNow,
            },
          }),
        ]);
        await upsertProviderSourceRuntimeLane(transaction, input.work, input.epochId, {
          phase: "reached_head",
          activity: "waiting",
          waitReason: "not_due",
          actionRequiredCode: null,
          currentRunId: null,
          retryAttempt: 0,
          retryNotBefore: null,
          runLeaseAcquiredAt: null,
          runLeaseExpiresAt: null,
          checkpointFingerprint: input.decision.checkpointFingerprint,
          continuationKind: "poll_after",
          continuationMinimumDelaySeconds:
            input.decision.minimumDelaySeconds,
          pagesCommitted: input.decision.pagesCommitted,
          recordsCommitted: input.decision.recordsCommitted,
          lastProgressAt: databaseNow,
          nextDueAt,
          queuedAt: null,
          updatedAt: databaseNow,
        });
        await appendProviderSourceSupervisorWorkDiagnostic(
          transaction,
          this.#diagnostics,
          {
            work: input.work,
            transition: "head_reached",
            occurredAt: databaseNow,
            disposition: input.decision,
          },
        );
        return input.decision;
      }


      if (input.decision.kind === "retrying") {
        if (
          !Number.isSafeInteger(input.decision.retryAttempt) ||
          input.decision.retryAttempt < 1 ||
          input.decision.retryAttempt >
            providerSourceTransientRetryPolicy.maximumAttempts
        ) {
          throw new TypeError("Source retry attempt is invalid.");
        }
        const retryDelay = providerSourceTransientRetryPolicy
          .backoffMilliseconds[input.decision.retryAttempt - 1]!;
        if (input.decision.retryDelayMilliseconds !== retryDelay) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Source retry delay does not match the versioned policy.",
          );
        }
        const retryNotBefore = new Date(databaseNow.getTime() + retryDelay);
        await transaction.import_runs.update({
          where: { id: run.id },
          data: { state: "queued", ...clearLease },
        });
        await upsertProviderSourceRuntimeLane(transaction, input.work, input.epochId, {
          phase: "retry_wait",
          activity: "waiting",
          waitReason: "retry_backoff",
          actionRequiredCode: null,
          currentRunId: run.id,
          retryAttempt: input.decision.retryAttempt,
          retryNotBefore,
          runLeaseAcquiredAt: null,
          runLeaseExpiresAt: null,
          queuedAt: databaseNow,
          updatedAt: databaseNow,
        });
        await appendProviderSourceSupervisorWorkDiagnostic(
          transaction,
          this.#diagnostics,
          {
            work: input.work,
            transition: "retry_scheduled",
            occurredAt: databaseNow,
            disposition: input.decision,
            requestAttemptId: requestProof?.request_attempt_id,
            durationMs: requestProof?.duration_ms,
            responseBytes: requestProof?.response_bytes,
            evidence: requestProof
              ? { attempt_state: requestProof.terminal_state }
              : undefined,
          },
        );
        return input.decision;
      }

      await Promise.all([
        transaction.import_runs.update({
          where: { id: run.id },
          data: {
            state: "failed",
            failure_code: input.decision.safeCode,
            failure_summary: "Source action required.",
            finished_at: databaseNow,
            ...clearLease,
          },
        }),
        transaction.provider_source_health_states.update({
          where: { source_instance_id: input.work.sourceInstanceId },
          data: {
            health_generation: { increment: 1n },
            last_attempted_at: databaseNow,
            consecutive_failures: { increment: 1 },
            latest_failure_code: input.decision.safeCode,
            updated_at: databaseNow,
          },
        }),
      ]);
      await upsertProviderSourceRuntimeLane(transaction, input.work, input.epochId, {
        phase: "action_required",
        activity: "action_required",
        waitReason: null,
        actionRequiredCode: input.decision.safeCode,
        currentRunId: null,
        retryAttempt: 0,
        retryNotBefore: null,
        runLeaseAcquiredAt: null,
        runLeaseExpiresAt: null,
        queuedAt: null,
        updatedAt: databaseNow,
      });
      await appendProviderSourceSupervisorWorkDiagnostic(
        transaction,
        this.#diagnostics,
        {
          work: input.work,
          transition: "terminal",
          occurredAt: databaseNow,
          disposition: input.decision,
          requestAttemptId: requestProof?.request_attempt_id,
          durationMs: requestProof?.duration_ms,
          responseBytes: requestProof?.response_bytes,
          evidence: requestProof
            ? { attempt_state: requestProof.terminal_state }
            : undefined,
        },
      );
      return input.decision;
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  /**
   * A page commit advances the run/checkpoint atomically before the supervisor
   * records the fair-turn disposition. If the owner dies in that narrow gap,
   * finalize the already committed page from durable page metadata. Never
   * requeue it for another adapter request.
   */

  async #assertActiveEpoch(
    transaction: PackscoutTransactionClient,
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<Date> {
    const epochs = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select id
      from public.source_supervisor_epochs
      where id = cast(${input.epochId} as uuid)
        and owner_key = ${input.ownerKey}
        and lease_token = cast(${input.leaseToken} as uuid)
        and state = 'active'::public.supervisor_epoch_state
        and lease_expires_at > clock_timestamp()
      for share
    `);
    if (!epochs[0]) {
      throw new PersistenceError(
        "SUPERVISOR_OWNERSHIP_LOST",
        "Supervisor epoch is not active.",
      );
    }
    return providerSourceTransactionTime(transaction);
  }

  async #markAdmissionState(
    input: ProviderSourceSupervisorEpochFence & Readonly<{
      work: ProviderSourceSupervisorClaimedWork;
    }>,
    state:
      | Readonly<{
          kind: "waiting";
          reason: ProviderSourceAdmissionWaitReason;
        }>
      | Readonly<{ kind: "granted" }>,
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      await markProviderSourceSupervisorAdmissionState(
        transaction,
        { ...input, state },
        databaseNow,
      );
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async #loadClaimed(
    transaction: PackscoutTransactionClient,
    candidate: ProviderSourceSupervisorQueueCandidate,
    input: ProviderSourceSupervisorEpochFence & Readonly<{
      claimOwner: string;
      claimToken: string;
      claimLeaseId: string;
    }>,
    databaseNow: Date,
    expiresAt: Date,
    replayCommitted = false,
  ): Promise<ProviderSourceSupervisorClaimedWork> {
    const connectionJob = candidate.kind === "connection_test"
      ? await transaction.source_connection_test_jobs.findUnique({
          where: { id: candidate.id },
        })
      : null;
    const sourceJob = candidate.kind === "source_test"
      ? await transaction.provider_source_test_jobs.findUnique({
          where: { id: candidate.id },
        })
      : null;
    const run = candidate.kind === "page_read"
      ? await transaction.import_runs.findUnique({ where: { id: candidate.id } })
      : null;
    const organizationId = connectionJob?.organization_id
      ?? sourceJob?.organization_id
      ?? run?.organization_id;
    const connectionProfileId = connectionJob?.connection_profile_id
      ?? sourceJob?.connection_profile_id
      ?? run?.connection_profile_id;
    const connectionRevisionId = connectionJob?.connection_revision_id
      ?? sourceJob?.connection_revision_id
      ?? run?.connection_revision_id;
    if (!organizationId || !connectionProfileId || !connectionRevisionId) {
      throw new PersistenceError("SOURCE_FENCED", "Claimed work lost its pins.");
    }
    const [profile, connectionRevision] = await Promise.all([
      transaction.source_connection_profiles.findFirst({
        where: {
          id: connectionProfileId,
          organization_id: organizationId,
        },
      }),
      transaction.source_connection_revisions.findFirst({
        where: {
          id: connectionRevisionId,
          organization_id: organizationId,
          connection_profile_id: connectionProfileId,
        },
      }),
    ]);
    if (
      !profile ||
      !connectionRevision ||
      connectionRevision.source_type_key !== profile.source_type_key
    ) {
      throw new PersistenceError("SOURCE_FENCED", "Connection pins changed.");
    }
    const common = {
      id: candidate.id,
      queuedAt: candidate.queuedAt,
      organizationId,
      sourceTypeKey: connectionRevision.source_type_key,
      sourceAdapterVersion: connectionRevision.source_adapter_version,
      connectionProfileId,
      connectionRevisionId,
      connectionHealthGeneration: connectionRevision.health_generation,
      profileRequestLimit: profile.request_limit,
      connectionConfiguration: {
        ciphertext: new Uint8Array(connectionRevision.configuration_ciphertext),
        nonce: new Uint8Array(connectionRevision.configuration_nonce),
        authTag: new Uint8Array(connectionRevision.configuration_auth_tag),
        keyVersion: connectionRevision.encryption_key_version,
      },
      claimOwner: input.claimOwner,
      claimToken: input.claimToken,
      claimLeaseId: input.claimLeaseId,
      claimExpiresAt: expiresAt,
    } as const;
    if (candidate.kind === "connection_test" && connectionJob) {
      const [openEpisodes, latestCandidate] = await Promise.all([
        transaction.source_connection_health_episodes.findMany({
          where: {
            organization_id: organizationId,
            connection_profile_id: connectionProfileId,
            closed_at: null,
          },
          orderBy: [{ opened_at: "asc" }, { id: "asc" }],
          take: 2,
        }),
        transaction.source_connection_revisions.findFirst({
          where: {
            organization_id: organizationId,
            connection_profile_id: connectionProfileId,
            state: "candidate",
            revoked_at: null,
          },
          orderBy: [{ revision_number: "desc" }, { id: "desc" }],
          select: { id: true },
        }),
      ]);
      const recoveryEpisode = connectionJob.blocking_episode_id === null
        ? null
        : openEpisodes.find(
          (episode) => episode.id === connectionJob.blocking_episode_id,
        ) ?? null;
      const normalEligible = connectionJob.blocking_episode_id === null &&
        openEpisodes.length === 0 &&
        profile.state === "active" &&
        connectionRevision.revoked_at === null &&
        connectionRevision.id ===
          (latestCandidate?.id ?? profile.active_revision_id) &&
        (connectionRevision.state === "candidate" ||
          connectionRevision.state === "active");
      const recoveryEligible = recoveryEpisode !== null &&
        connectionJob.recovery_blocked_revision_id ===
          recoveryEpisode.connection_revision_id &&
        (profile.state === "active" || profile.state === "disabled") &&
        connectionRevision.revoked_at === null &&
        (connectionRevision.state === "candidate" ||
          (connectionRevision.id === recoveryEpisode.connection_revision_id &&
            connectionRevision.state === "active"));
      if (
        !replayCommitted && (
          (!normalEligible && !recoveryEligible) ||
          connectionJob.expected_health_generation !==
            connectionRevision.health_generation
        )
      ) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Connection-test eligibility changed before execution.",
        );
      }
      return {
        ...common,
        kind: "connection_test",
        connectionHealthGeneration: connectionJob.expected_health_generation,
        recoveryEpisodeId: connectionJob.blocking_episode_id,
      };
    }
    const providerId = sourceJob?.provider_id ?? run?.provider_id;
    const sourceInstanceId = sourceJob?.source_instance_id ?? run?.source_instance_id;
    const sourceRevisionId = sourceJob?.source_revision_id ?? run?.source_revision_id;
    if (!providerId || !sourceInstanceId || !sourceRevisionId) {
      throw new PersistenceError("SOURCE_FENCED", "Source work pins are incomplete.");
    }
    const [provider, source, sourceRevision, schedule, runtime, openEpisode] =
      await Promise.all([
      transaction.provider_sources.findFirst({
        where: { id: providerId, organization_id: organizationId },
      }),
      transaction.provider_source_instances.findFirst({
        where: {
          id: sourceInstanceId,
          organization_id: organizationId,
          provider_id: providerId,
        },
      }),
      transaction.provider_source_revisions.findFirst({
        where: {
          id: sourceRevisionId,
          organization_id: organizationId,
          provider_id: providerId,
          source_instance_id: sourceInstanceId,
          connection_profile_id: connectionProfileId,
        },
      }),
      transaction.provider_source_schedules.findFirst({
        where: { source_instance_id: sourceInstanceId },
      }),
      transaction.provider_source_runtime_states.findFirst({
        where: { source_instance_id: sourceInstanceId },
        select: {
          retry_attempt: true,
          retry_not_before: true,
          activity: true,
        },
      }),
      transaction.source_connection_health_episodes.findFirst({
        where: {
          organization_id: organizationId,
          connection_profile_id: connectionProfileId,
          closed_at: null,
        },
      }),
    ]);
    const providerKey = launchProviderKeySchema.safeParse(provider?.platform_key);
    if (
      !provider ||
      !source ||
      !sourceRevision ||
      !providerKey.success ||
      (!replayCommitted && source.active_revision_id !== sourceRevisionId) ||
      (!replayCommitted && source.connection_profile_id !== connectionProfileId) ||
      sourceRevision.source_type_key !== connectionRevision.source_type_key ||
      sourceRevision.source_adapter_version !==
        connectionRevision.source_adapter_version
    ) {
      throw new PersistenceError("SOURCE_FENCED", "Source revision pins changed.");
    }
    const sourceCommon = {
      ...common,
      providerId,
      provider: providerKey.data,
      sourceInstanceId,
      sourceRevisionId,
      normalizedContractVersion: sourceRevision.normalized_contract_version,
      mapperKey: sourceRevision.mapper_key,
      mapperVersion: sourceRevision.mapper_version,
      identityNamespaceKey: sourceRevision.identity_namespace_key,
      checkpointCodecVersion: sourceRevision.checkpoint_codec_version,
      sourceConfiguration: sourceRevision.configuration_json,
      recordIdScopes: sourceRevision.record_id_scopes_json,
    } as const;
    if (candidate.kind === "source_test" && sourceJob) {
      if (
        !replayCommitted && (
          !["draft", "paused", "active", "disabled"].includes(source.state) ||
          profile.state !== "active" ||
          profile.active_revision_id !== connectionRevisionId ||
          connectionRevision.state !== "active" ||
          connectionRevision.revoked_at !== null ||
          sourceJob.expected_health_generation !==
            connectionRevision.health_generation ||
          openEpisode !== null
        )
      ) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Source-test eligibility changed before execution.",
        );
      }
      return {
        ...sourceCommon,
        kind: "source_test",
        connectionHealthGeneration: sourceJob.expected_health_generation,
      };
    }
    if (!run || run.checkpoint_generation === null || run.next_page_number === null) {
      throw new PersistenceError("SOURCE_FENCED", "Page work pins are incomplete.");
    }
    const immutableRunPinsChanged =
      run.source_type_key !== sourceRevision.source_type_key ||
      run.source_adapter_version !== sourceRevision.source_adapter_version ||
      run.normalized_contract_version !==
        sourceRevision.normalized_contract_version ||
      run.mapper_key !== sourceRevision.mapper_key ||
      run.mapper_version !== sourceRevision.mapper_version ||
      run.identity_namespace_key !== sourceRevision.identity_namespace_key;
    const mutableEligibilityChanged = !replayCommitted && (
      provider.state !== "active" ||
      source.state !== "active" ||
      source.pause_requested_at !== null ||
      (profile.state !== "active" &&
        !(profile.state === "disabled" &&
          connectionRevision.state === "retired")) ||
      (connectionRevision.state !== "active" &&
        connectionRevision.state !== "retired") ||
      connectionRevision.revoked_at !== null ||
      openEpisode !== null ||
      runtime?.activity === "action_required" ||
      (runtime?.retry_not_before !== null &&
        runtime?.retry_not_before !== undefined &&
        runtime.retry_not_before > databaseNow)
    );
    if (
      mutableEligibilityChanged ||
      immutableRunPinsChanged
    ) {
      throw new PersistenceError(
        "SOURCE_FENCED",
        "Page-read eligibility changed before execution.",
      );
    }
    return {
      ...sourceCommon,
      kind: "page_read",
      runId: run.id,
      runTrigger: run.trigger,
      runStartedAt: run.started_at ?? candidate.queuedAt,
      committedPages: boundedCounter(run.counters_json, "pages"),
      committedRecords: boundedCounter(run.counters_json, "records"),
      retryAttempt: runtime?.retry_attempt ?? 0,
      pageNumber: run.next_page_number,
      checkpointGeneration: run.checkpoint_generation,
      requestedCheckpointValue: checkpointValue(run.current_checkpoint),
      requestedCheckpointFingerprint: run.current_checkpoint_fingerprint,
      sourceIntervalSeconds: schedule
        ? await this.#sourceIntervalSeconds(transaction, schedule.active_schedule_revision_id)
        : 60,
    };
  }

  async #sourceIntervalSeconds(
    transaction: PackscoutTransactionClient,
    revisionId: string,
  ): Promise<number> {
    const revision = await transaction.provider_source_schedule_revisions.findUnique({
      where: { id: revisionId },
      select: { interval_seconds: true },
    });
    return revision?.interval_seconds ?? 60;
  }

}
