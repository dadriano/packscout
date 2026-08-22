import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  providerSourceRunBounds,
  providerSourceTransientRetryPolicy,
} from "@packscout/contracts";
import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import type { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { providerSourceSupervisorTransitionDiagnosticId } from
  "./provider-source-supervisor-work-diagnostic.ts";
import type { ProviderSourceSupervisorEpochFence } from
  "./provider-source-supervisor-work-repository.ts";

function boundedCounter(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  const candidate = (value as Record<string, unknown>)[key];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : 0;
}

const clearRunLease = {
  lease_owner: null,
  lease_token: null,
  claim_lease_id: null,
  lease_expires_at: null,
  heartbeat_at: null,
} as const;

/** Finalizes the page-commit/turn-finalization crash window without refetching. */
export class ProviderSourceSupervisorRecoveryRepository {
  constructor(
    private readonly runs: ProviderSourceImportRunRepository,
    private readonly diagnostics: ProviderSourceDiagnosticRepository,
  ) {}

  async recoverExpiredPageClaims(
    transaction: PackscoutTransactionClient,
    input: ProviderSourceSupervisorEpochFence,
    databaseNow: Date,
    runId?: string,
  ): Promise<number> {
    const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select run.id
      from public.import_runs as run
      where run.state = 'running'::public.import_run_state
        and run.source_instance_id is not null
        and run.lease_expires_at <= ${databaseNow}
        ${runId
          ? Prisma.sql`and run.id = cast(${runId} as uuid)`
          : Prisma.empty}
        and not exists (
          select 1 from public.source_request_attempts as attempt
          where attempt.run_id = run.id
            and attempt.state = 'in_flight'::public.source_request_attempt_state
        )
      order by run.lease_expires_at, run.id
      for update
    `);
    let recovered = 0;
    for (const candidate of candidates) {
      const run = await transaction.import_runs.findUnique({
        where: { id: candidate.id },
      });
      if (
        !run?.source_instance_id ||
        !run.source_revision_id ||
        !run.connection_profile_id ||
        !run.connection_revision_id ||
        run.next_page_number === null
      ) continue;
      const source = await transaction.provider_source_instances.findFirst({
        where: {
          id: run.source_instance_id,
          organization_id: run.organization_id,
          provider_id: run.provider_id,
          active_revision_id: run.source_revision_id,
          connection_profile_id: run.connection_profile_id,
          state: { in: ["active", "paused"] },
        },
      });
      const runtime = await transaction.provider_source_runtime_states.findFirst({
        where: {
          source_instance_id: run.source_instance_id,
          organization_id: run.organization_id,
          provider_id: run.provider_id,
          source_revision_id: run.source_revision_id,
          connection_profile_id: run.connection_profile_id,
          connection_revision_id: run.connection_revision_id,
        },
      });
      const pagesCommitted = boundedCounter(run.counters_json, "pages");
      const recordsCommitted = boundedCounter(run.counters_json, "records");
      const page = pagesCommitted > (runtime?.pages_committed ?? 0)
        ? await transaction.import_pages.findFirst({
            where: {
              run_id: run.id,
              organization_id: run.organization_id,
              provider_id: run.provider_id,
              source_instance_id: run.source_instance_id,
              source_revision_id: run.source_revision_id,
              page_number: run.next_page_number - 1,
            },
          })
        : null;
      const terminalAttempt = page === null
        ? await transaction.compact_source_request_attempts.findFirst({
            where: {
              organization_id: run.organization_id,
              operation_kind: "page_read",
              provider_id: run.provider_id,
              source_instance_id: run.source_instance_id,
              source_revision_id: run.source_revision_id,
              connection_profile_id: run.connection_profile_id,
              connection_revision_id: run.connection_revision_id,
              run_id: run.id,
              page_number: run.next_page_number,
              checkpoint_generation: run.checkpoint_generation,
              requested_checkpoint_key:
                run.current_checkpoint_fingerprint ?? "initial",
            },
            orderBy: [{ terminal_at: "desc" }, { request_attempt_id: "desc" }],
          })
        : null;
      if (!source) {
        await transaction.import_runs.update({
          where: { id: run.id },
          data: {
            state: "failed",
            failure_code: "STALE_RECOVERED_WORK",
            failure_summary: "Recovered work no longer matches active source pins.",
            finished_at: databaseNow,
            ...clearRunLease,
          },
        });
        await this.#appendRecoveredDiagnostic(transaction, run, databaseNow);
        recovered += 1;
        continue;
      }
      if (
        terminalAttempt &&
        await this.#recoverTerminalRequestBoundary(transaction, {
          epochId: input.epochId,
          databaseNow,
          run,
          sourceInstanceId: source.id,
          sourcePaused: source.pause_requested_at !== null ||
            source.state === "paused",
          retryAttempt: runtime?.retry_attempt ?? 0,
          attempt: terminalAttempt,
        })
      ) {
        await this.#appendRecoveredDiagnostic(transaction, run, databaseNow);
        recovered += 1;
        continue;
      }
      if (!page?.continuation_kind) {
        // Only a claim with no request proof is eligible to refetch directly.
        await transaction.import_runs.update({
          where: { id: run.id },
          data: { state: "queued", ...clearRunLease },
        });
        await this.#setQueued(transaction, {
          epochId: input.epochId,
          sourceInstanceId: source.id,
          runId: run.id,
          queuedAt: databaseNow,
          updatedAt: databaseNow,
        });
        await this.#appendRecoveredDiagnostic(transaction, run, databaseNow);
        recovered += 1;
        continue;
      }
      const progress = {
        pages_committed: pagesCommitted,
        records_committed: recordsCommitted,
        last_progress_at: page.committed_at,
        checkpoint_fingerprint: page.next_checkpoint_fingerprint,
        continuation_kind: page.continuation_kind,
        continuation_minimum_delay_seconds: page.minimum_delay_seconds,
      } as const;
      if (source.pause_requested_at !== null || source.state === "paused") {
        await Promise.all([
          transaction.import_runs.update({
            where: { id: run.id },
            data: {
              state: "incomplete",
              finished_at: databaseNow,
              ...clearRunLease,
            },
          }),
          transaction.provider_source_instances.update({
            where: { id: source.id },
            data: {
              state: "paused",
              pause_requested_at: null,
              paused_at: databaseNow,
              updated_at: databaseNow,
            },
          }),
        ]);
        await transaction.provider_source_runtime_states.updateMany({
          where: { source_instance_id: source.id },
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
            ...progress,
            queued_at: null,
            updated_at: databaseNow,
          },
        });
        await this.#appendRecoveredDiagnostic(transaction, run, databaseNow);
        recovered += 1;
        continue;
      }
      if (page.continuation_kind === "poll_after") {
        const schedule = await transaction.provider_source_schedules.findUnique({
          where: { source_instance_id: source.id },
        });
        if (!schedule) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Recovered head transition lost its schedule.",
          );
        }
        const revision = await transaction.provider_source_schedule_revisions
          .findUnique({
            where: { id: schedule.active_schedule_revision_id },
            select: { interval_seconds: true },
          });
        const minimumDelaySeconds = page.minimum_delay_seconds ?? 0;
        const nextDueAt = new Date(
          page.committed_at.getTime() +
            Math.max(revision?.interval_seconds ?? 60, minimumDelaySeconds) * 1_000,
        );
        await Promise.all([
          transaction.import_runs.update({
            where: { id: run.id },
            data: {
              state: "succeeded",
              reached_provider_head: true,
              finished_at: databaseNow,
              ...clearRunLease,
            },
          }),
          transaction.provider_source_schedules.update({
            where: { source_instance_id: source.id },
            data: {
              next_due_at: nextDueAt,
              last_due_at: page.committed_at,
              last_outcome: "reached_head",
              last_run_id: run.id,
              updated_at: databaseNow,
            },
          }),
          transaction.provider_source_health_states.update({
            where: { source_instance_id: source.id },
            data: {
              last_head_reached_at: page.committed_at,
              consecutive_failures: 0,
              latest_failure_code: null,
              recovered_at: databaseNow,
              updated_at: databaseNow,
            },
          }),
        ]);
        await transaction.provider_source_runtime_states.updateMany({
          where: { source_instance_id: source.id },
          data: {
            supervisor_epoch_id: input.epochId,
            phase: "reached_head",
            activity: "waiting",
            wait_reason: "not_due",
            action_required_code: null,
            current_run_id: null,
            run_lease_acquired_at: null,
            run_lease_expires_at: null,
            retry_attempt: 0,
            retry_not_before: null,
            ...progress,
            next_due_at: nextDueAt,
            queued_at: null,
            updated_at: databaseNow,
          },
        });
        await this.#appendRecoveredDiagnostic(transaction, run, databaseNow);
        recovered += 1;
        continue;
      }
      const startedAt = run.started_at ?? databaseNow;
      const rollover =
        pagesCommitted >= providerSourceRunBounds.maximumCommittedPages ||
        databaseNow.getTime() - startedAt.getTime() >=
          providerSourceRunBounds.maximumElapsedMilliseconds;
      let nextRunId = run.id;
      if (rollover) {
        await transaction.import_runs.update({
          where: { id: run.id },
          data: {
            state: "incomplete",
            finished_at: databaseNow,
            failure_code: null,
            failure_summary: null,
            ...clearRunLease,
          },
        });
        const continuation = await this.runs.requestRunInTransaction(
          transaction,
          {
            organizationId: run.organization_id,
            providerId: run.provider_id,
            runId: randomUUID(),
            trigger: "continuation",
            requestedByActorKey: null,
            requestedAt: databaseNow,
            expectedSourceRevisionId: run.source_revision_id,
          },
        );
        if (continuation.kind !== "created") {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Recovered continuation did not win its exact queue transition.",
          );
        }
        nextRunId = continuation.run.id;
      } else {
        await transaction.import_runs.update({
          where: { id: run.id },
          data: { state: "queued", ...clearRunLease },
        });
      }
      await this.#setQueued(transaction, {
        epochId: input.epochId,
        sourceInstanceId: source.id,
        runId: nextRunId,
        queuedAt: databaseNow,
        updatedAt: databaseNow,
        progress,
      });
      await this.#appendRecoveredDiagnostic(transaction, run, databaseNow);
      recovered += 1;
    }
    return recovered;
  }

  async #recoverTerminalRequestBoundary(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      epochId: string;
      databaseNow: Date;
      sourceInstanceId: string;
      sourcePaused: boolean;
      retryAttempt: number;
      run: Readonly<{
        id: string;
        organization_id: string;
        connection_profile_id: string | null;
        connection_revision_id: string | null;
      }>;
      attempt: Readonly<{
        terminal_state: "in_flight" | "captured" | "failed" |
          "connection_outcome_uncertain";
        outcome_class: string;
        blocking_episode_id: string | null;
      }>;
    }>,
  ): Promise<boolean> {
    const { attempt, run } = input;
    if (
      attempt.outcome_class === "connection_action_required" ||
      attempt.terminal_state === "connection_outcome_uncertain" ||
      attempt.blocking_episode_id !== null
    ) {
      const episode = attempt.blocking_episode_id
        ? await transaction.source_connection_health_episodes.findFirst({
            where: {
              id: attempt.blocking_episode_id,
              organization_id: run.organization_id,
              connection_profile_id: run.connection_profile_id ?? undefined,
              closed_at: null,
            },
            select: {
              id: true,
              connection_revision_id: true,
              opened_health_generation: true,
            },
          })
        : null;
      await transaction.import_runs.update({
        where: { id: run.id },
        data: {
          state: "incomplete",
          failure_code: episode
            ? "CONNECTION_BLOCKED"
            : "RECOVERED_CONNECTION_BOUNDARY_STALE",
          failure_summary: "Recovered request requires connection review.",
          finished_at: input.databaseNow,
          ...clearRunLease,
        },
      });
      await transaction.provider_source_runtime_states.updateMany({
        where: { source_instance_id: input.sourceInstanceId },
        data: episode
          ? {
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
              updated_at: input.databaseNow,
            }
          : {
              supervisor_epoch_id: input.epochId,
              phase: "action_required",
              activity: "action_required",
              wait_reason: null,
              action_required_code: "RECOVERED_CONNECTION_BOUNDARY_STALE",
              current_run_id: null,
              run_lease_acquired_at: null,
              run_lease_expires_at: null,
              retry_attempt: 0,
              retry_not_before: null,
              queued_at: null,
              updated_at: input.databaseNow,
            },
      });
      return true;
    }
    if (attempt.terminal_state === "captured") {
      if (input.sourcePaused) {
        await transaction.import_runs.update({
          where: { id: run.id },
          data: {
            state: "incomplete",
            finished_at: input.databaseNow,
            ...clearRunLease,
          },
        });
        await transaction.provider_source_instances.update({
          where: { id: input.sourceInstanceId },
          data: {
            state: "paused",
            pause_requested_at: null,
            paused_at: input.databaseNow,
            updated_at: input.databaseNow,
          },
        });
        await transaction.provider_source_runtime_states.updateMany({
          where: { source_instance_id: input.sourceInstanceId },
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
            updated_at: input.databaseNow,
          },
        });
        return true;
      }
      // The bounded response body is process-local. Once the old claim has
      // expired, safely refetch from the unchanged committed checkpoint.
      await transaction.import_runs.update({
        where: { id: run.id },
        data: { state: "queued", ...clearRunLease },
      });
      await this.#setQueued(transaction, {
        epochId: input.epochId,
        sourceInstanceId: input.sourceInstanceId,
        runId: run.id,
        queuedAt: input.databaseNow,
        updatedAt: input.databaseNow,
      });
      return true;
    }
    if (attempt.outcome_class === "retryable") {
      const retryAttempt = input.retryAttempt + 1;
      if (retryAttempt <= providerSourceTransientRetryPolicy.maximumAttempts) {
        const retryNotBefore = new Date(
          input.databaseNow.getTime() +
            providerSourceTransientRetryPolicy
              .backoffMilliseconds[retryAttempt - 1]!,
        );
        await transaction.import_runs.update({
          where: { id: run.id },
          data: { state: "queued", ...clearRunLease },
        });
        await transaction.provider_source_runtime_states.updateMany({
          where: { source_instance_id: input.sourceInstanceId },
          data: {
            supervisor_epoch_id: input.epochId,
            phase: "retry_wait",
            activity: "waiting",
            wait_reason: "retry_backoff",
            action_required_code: null,
            current_run_id: run.id,
            run_lease_acquired_at: null,
            run_lease_expires_at: null,
            retry_attempt: retryAttempt,
            retry_not_before: retryNotBefore,
            queued_at: input.databaseNow,
            updated_at: input.databaseNow,
          },
        });
        return true;
      }
    }
    const actionCode = attempt.outcome_class === "retryable"
      ? "TRANSIENT_RETRIES_EXHAUSTED"
      : "RECOVERED_SOURCE_REQUEST_ACTION_REQUIRED";
    await transaction.import_runs.update({
      where: { id: run.id },
      data: {
        state: "failed",
        failure_code: actionCode,
        failure_summary: "Recovered request requires source review.",
        finished_at: input.databaseNow,
        ...clearRunLease,
      },
    });
    await transaction.provider_source_runtime_states.updateMany({
      where: { source_instance_id: input.sourceInstanceId },
      data: {
        supervisor_epoch_id: input.epochId,
        phase: "action_required",
        activity: "action_required",
        wait_reason: null,
        action_required_code: actionCode,
        current_run_id: null,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        queued_at: null,
        updated_at: input.databaseNow,
      },
    });
    return true;
  }

  async #setQueued(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      epochId: string;
      sourceInstanceId: string;
      runId: string;
      queuedAt: Date;
      updatedAt: Date;
      progress?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void> {
    await transaction.provider_source_runtime_states.updateMany({
      where: { source_instance_id: input.sourceInstanceId },
      data: {
        supervisor_epoch_id: input.epochId,
        phase: "queued",
        activity: "queued",
        wait_reason: null,
        action_required_code: null,
        current_run_id: input.runId,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        ...(input.progress ?? {}),
        queued_at: input.queuedAt,
        updated_at: input.updatedAt,
      },
    });
  }

  async #appendRecoveredDiagnostic(
    transaction: PackscoutTransactionClient,
    run: Readonly<{
      id: string;
      organization_id: string;
      provider_id: string;
      source_instance_id: string | null;
      source_revision_id: string | null;
      connection_profile_id: string | null;
      connection_revision_id: string | null;
      source_type_key: string | null;
      source_adapter_version: string | null;
      normalized_contract_version: string | null;
      trigger: "scheduled" | "manual" | "continuation" | "recovery";
      current_checkpoint_fingerprint: string | null;
      lease_token: string | null;
    }>,
    occurredAt: Date,
  ): Promise<void> {
    if (
      !run.source_instance_id || !run.source_revision_id ||
      !run.connection_profile_id || !run.connection_revision_id ||
      !run.source_type_key || !run.source_adapter_version ||
      !run.normalized_contract_version || !run.lease_token
    ) {
      throw new TypeError("Recovered page claim lost its diagnostic pins.");
    }
    await this.diagnostics.appendInTransaction(transaction, {
      id: providerSourceSupervisorTransitionDiagnosticId({
        organizationId: run.organization_id,
        kind: "page_read",
        id: run.id,
        claimToken: run.lease_token,
      }, "work_recovered"),
      organizationId: run.organization_id,
      scope: "source",
      correlationKind: "run",
      eventKind: "source_run",
      severity: "info",
      phase: "work_recovered",
      safeCode: "WORK_RECOVERED",
      occurredAt,
      sourceTypeKey: run.source_type_key,
      sourceAdapterVersion: run.source_adapter_version,
      normalizedContractVersion: run.normalized_contract_version,
      providerId: run.provider_id,
      sourceInstanceId: run.source_instance_id,
      sourceRevisionId: run.source_revision_id,
      connectionProfileId: run.connection_profile_id,
      connectionRevisionId: run.connection_revision_id,
      runId: run.id,
      runTrigger: run.trigger,
      checkpointFingerprint: run.current_checkpoint_fingerprint,
    });
  }
}
