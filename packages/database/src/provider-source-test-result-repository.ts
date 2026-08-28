import { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import type { PackscoutPrismaClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import { PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION } from "./provider-source-persistence-types.ts";
import { SourceConnectionRecoveryRepository } from
  "./source-connection-recovery-repository.ts";
import { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { lockProviderSourceSupervisorActiveEpoch } from
  "./provider-source-supervisor-environment-lock.ts";
import { providerSourceSupervisorTransitionDiagnosticId } from
  "./provider-source-supervisor-work-diagnostic.ts";

const SAFE_CODE_PATTERN = /^(?:[A-Z][A-Z0-9_]{0,127}|[a-z][a-z0-9_-]{0,127})$/u;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

function safeCode(value: string | null | undefined): string | null {
  if (value && !SAFE_CODE_PATTERN.test(value)) {
    throw new TypeError("Test result code is invalid.");
  }
  return value ?? null;
}

function safeResponseStatus(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new TypeError("Connection-test response status must be an integer from 100 through 599.");
  }
  return value;
}

function safeLatency(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSTGRES_INTEGER) {
    throw new TypeError("Connection-test latency must be a nonnegative 32-bit integer.");
  }
  return value;
}

function measurements(value: Readonly<Record<string, number>> | undefined): Prisma.InputJsonValue {
  const normalized = value ?? {};
  if (Object.keys(normalized).length > 32) {
    throw new TypeError("Test measurements exceed 32 entries.");
  }
  for (const [key, measurement] of Object.entries(normalized)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(key)
      || !Number.isSafeInteger(measurement)
      || measurement < 0) {
      throw new TypeError("Test measurements must be bounded nonnegative counters.");
    }
  }
  return normalized as Prisma.InputJsonValue;
}

interface CompleteTestFence {
  readonly organizationId: string;
  readonly jobId: string;
  readonly requestAttemptId: string;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly supervisorEpochId: string;
  readonly supervisorOwnerKey: string;
  readonly supervisorLeaseToken: string;
  readonly outcome: "success" | "failure";
  readonly safeCode?: string | null;
  readonly measurements?: Readonly<Record<string, number>>;
  readonly completedAt: Date;
}

export class ProviderSourceTestResultRepository {
  readonly #recovery: SourceConnectionRecoveryRepository;
  readonly #diagnostics: ProviderSourceDiagnosticRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    this.#recovery = new SourceConnectionRecoveryRepository(database);
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
  }

  async completeConnectionTest(input: CompleteTestFence & Readonly<{
    responseStatus?: number | null;
    latencyMs?: number | null;
  }>): Promise<{
    resultId: string;
    resultingHealthGeneration: bigint;
    episodeClosed: boolean;
    resumedRunIds: readonly string[];
  }> {
    const resultCode = safeCode(input.safeCode);
    const responseStatus = safeResponseStatus(input.responseStatus);
    const latencyMs = safeLatency(input.latencyMs);
    return this.database.$transaction(async (transaction) => {
      const epoch = await lockProviderSourceSupervisorActiveEpoch(
        transaction,
        {
          epochId: input.supervisorEpochId,
          ownerKey: input.supervisorOwnerKey,
          leaseToken: input.supervisorLeaseToken,
        },
      );
      if (!epoch) {
        throw new PersistenceError("SUPERVISOR_OWNERSHIP_LOST", "Connection-test epoch was lost.");
      }
      const jobScope = await transaction.source_connection_test_jobs.findFirst({
        where: { id: input.jobId, organization_id: input.organizationId },
        select: { connection_profile_id: true },
      });
      if (!jobScope) {
        throw new PersistenceError("SOURCE_FENCED", "Connection-test job is outside tenant scope.");
      }
      // Preserve the global recovery lock order before taking the profile
      // lock: provider -> source lane -> connection profile.
      await transaction.$queryRaw(Prisma.sql`
        select provider.id
        from public.provider_sources as provider
        join public.provider_source_instances as source
          on source.provider_id = provider.id
         and source.organization_id = provider.organization_id
        where source.organization_id = cast(${input.organizationId} as uuid)
          and source.connection_profile_id = cast(${jobScope.connection_profile_id} as uuid)
        order by provider.id, source.id
        for update of provider, source
      `);
      const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_connection_profiles
        where id = cast(${jobScope.connection_profile_id} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      if (!lockedProfiles[0]) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Connection profile is outside tenant scope.",
        );
      }
      await transaction.$queryRaw(Prisma.sql`
        select id from public.source_connection_test_jobs
        where id = cast(${input.jobId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const databaseNow = await providerSourceTransactionTime(transaction);
      const job = await transaction.source_connection_test_jobs.findFirst({
        where: {
          id: input.jobId,
          organization_id: input.organizationId,
          claim_owner: input.claimOwner,
          claim_token: input.claimToken,
          supervisor_epoch_id: input.supervisorEpochId,
        },
      });
      if (!job) throw new PersistenceError("SOURCE_FENCED", "Connection-test claim was lost.");
      const expectedMeasurements = measurements(input.measurements);
      const existingResult = await transaction.source_connection_test_results
        .findUnique({ where: { job_id: job.id } });
      if (existingResult) {
        if (
          existingResult.request_attempt_id !== input.requestAttemptId ||
          existingResult.supervisor_epoch_id !== input.supervisorEpochId ||
          existingResult.pre_test_health_generation !==
            job.expected_health_generation ||
          existingResult.outcome !== input.outcome ||
          existingResult.safe_code !== resultCode ||
          existingResult.response_status !== responseStatus ||
          existingResult.latency_ms !== latencyMs ||
          !isDeepStrictEqual(
            existingResult.measurements_json,
            expectedMeasurements,
          ) ||
          job.state !== (input.outcome === "success" ? "succeeded" : "failed")
        ) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Connection-test result replay conflicts with immutable proof.",
          );
        }
        const closedEpisode = await transaction.source_connection_health_episodes
          .findFirst({
            where: { closed_by_test_result_id: existingResult.id },
            select: { id: true },
          });
        const resumedRunIds = closedEpisode
          ? (await transaction.import_runs.findMany({
              where: {
                organization_id: input.organizationId,
                connection_profile_id: job.connection_profile_id,
                trigger: "recovery",
                created_at: existingResult.tested_at,
              },
              orderBy: [{ id: "asc" }],
              select: { id: true },
            })).map((run) => run.id)
          : [];
        return {
          resultId: existingResult.id,
          resultingHealthGeneration:
            existingResult.resulting_health_generation,
          episodeClosed: closedEpisode !== null,
          resumedRunIds,
        };
      }
      if (
        job.state !== "running" ||
        !job.claim_expires_at ||
        job.claim_expires_at <= databaseNow
      ) {
        throw new PersistenceError("SOURCE_FENCED", "Connection-test claim was lost.");
      }
      const openEpisode = await transaction.source_connection_health_episodes
        .findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: job.connection_profile_id,
            closed_at: null,
          },
        });
      if ((openEpisode?.id ?? null) !== (job.blocking_episode_id ?? null)) {
        throw new PersistenceError(
          "CONNECTION_BLOCKED",
          "Connection-test result is outside the current profile episode.",
        );
      }
      const [attempt, revision] = await Promise.all([
        transaction.compact_source_request_attempts.findFirst({
          where: {
            request_attempt_id: input.requestAttemptId,
            organization_id: input.organizationId,
            operation_kind: "connection_test",
            connection_test_job_id: job.id,
            connection_profile_id: job.connection_profile_id,
            connection_revision_id: job.connection_revision_id,
            expected_health_generation: job.expected_health_generation,
            supervisor_epoch_id: input.supervisorEpochId,
            claim_owner: input.claimOwner,
            claim_token: input.claimToken,
            terminal_state: input.outcome === "success"
              ? "captured"
              : { in: ["captured", "failed"] },
          },
          select: { request_attempt_id: true, terminal_state: true },
        }),
        transaction.source_connection_revisions.findFirst({
          where: {
            id: job.connection_revision_id,
            organization_id: input.organizationId,
            connection_profile_id: job.connection_profile_id,
            health_generation: job.expected_health_generation,
            revoked_at: null,
          },
          select: {
            health_generation: true,
            source_type_key: true,
            source_adapter_version: true,
          },
        }),
      ]);
      if (!attempt || !revision) {
        throw new PersistenceError("HEALTH_GENERATION_STALE", "Connection-test result fence changed.");
      }

      let resultingHealthGeneration = job.expected_health_generation;
      let episodeClosed = false;
      let episodeId: string | null = null;
      if (job.blocking_episode_id) {
        const episode = openEpisode;
        if (
          !episode
          || (
            episode.connection_revision_id === job.connection_revision_id
            && episode.opened_health_generation !== job.expected_health_generation
          )
        ) {
          throw new PersistenceError("HEALTH_GENERATION_STALE", "Recovery episode fence changed.");
        }
        episodeId = episode.id;
        if (input.outcome === "success" && episode.connection_revision_id === job.connection_revision_id) {
          resultingHealthGeneration = job.expected_health_generation + 1n;
          const advanced = await transaction.source_connection_revisions.updateMany({
            where: {
              id: job.connection_revision_id,
              organization_id: input.organizationId,
              connection_profile_id: job.connection_profile_id,
              health_generation: job.expected_health_generation,
              revoked_at: null,
            },
            data: { health_generation: resultingHealthGeneration },
          });
          if (advanced.count !== 1) {
            throw new PersistenceError("HEALTH_GENERATION_STALE", "Recovery health changed.");
          }
          episodeClosed = true;
        }
      }

      const result = await transaction.source_connection_test_results.create({
        data: {
          organization_id: input.organizationId,
          job_id: job.id,
          connection_profile_id: job.connection_profile_id,
          connection_revision_id: job.connection_revision_id,
          request_attempt_id: input.requestAttemptId,
          request_terminal_state: attempt.terminal_state,
          supervisor_epoch_id: input.supervisorEpochId,
          pre_test_health_generation: job.expected_health_generation,
          resulting_health_generation: resultingHealthGeneration,
          outcome: input.outcome,
          safe_code: resultCode,
          response_status: responseStatus,
          latency_ms: latencyMs,
          measurements_json: expectedMeasurements,
          tested_by_actor_key: job.requested_by_actor_key,
          tested_at: databaseNow,
        },
        select: { id: true },
      });
      if (episodeClosed && episodeId) {
        await transaction.source_connection_health_episodes.update({
          where: { id: episodeId },
          data: {
            closed_health_generation: resultingHealthGeneration,
            closed_by_test_result_id: result.id,
            closed_at: databaseNow,
          },
        });
      }
      const resumedRunIds = episodeClosed && episodeId
        ? await this.#recovery.resumeSameRevisionRecoveryInTransaction(
            transaction,
            {
              organizationId: input.organizationId,
              connectionProfileId: job.connection_profile_id,
              connectionRevisionId: job.connection_revision_id,
              blockingEpisodeId: episodeId,
              actorKey: job.requested_by_actor_key,
              supervisorEpochId: input.supervisorEpochId,
              resumedAt: databaseNow,
            },
          )
        : [];
      await this.#diagnostics.appendInTransaction(transaction, {
        id: providerSourceSupervisorTransitionDiagnosticId({
          organizationId: input.organizationId,
          kind: "connection_test",
          id: job.id,
          claimToken: input.claimToken,
        }, "terminal"),
        organizationId: input.organizationId,
        scope: "connection",
        correlationKind: "connection_test",
        eventKind: "connection_test",
        severity: input.outcome === "failure" ? "warning" : "info",
        phase: "terminal",
        safeCode: resultCode?.toUpperCase() ?? "TERMINAL",
        occurredAt: databaseNow,
        sourceTypeKey: revision.source_type_key,
        sourceAdapterVersion: revision.source_adapter_version,
        connectionProfileId: job.connection_profile_id,
        connectionRevisionId: job.connection_revision_id,
        connectionTestJobId: job.id,
        blockingEpisodeId: job.blocking_episode_id,
        requestAttemptId: input.requestAttemptId,
        durationMs: input.measurements?.duration_ms ?? latencyMs,
        responseBytes: input.measurements?.response_bytes,
        counters: input.measurements,
      });
      await transaction.source_connection_test_jobs.update({
        where: { id: job.id },
        data: {
          state: input.outcome === "success" ? "succeeded" : "failed",
          finished_at: databaseNow,
        },
      });
      return {
        resultId: result.id,
        resultingHealthGeneration,
        episodeClosed,
        resumedRunIds,
      };
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async completeSourceTest(input: CompleteTestFence): Promise<{ resultId: string }> {
    const resultCode = safeCode(input.safeCode);
    return this.database.$transaction(async (transaction) => {
      const epoch = await lockProviderSourceSupervisorActiveEpoch(
        transaction,
        {
          epochId: input.supervisorEpochId,
          ownerKey: input.supervisorOwnerKey,
          leaseToken: input.supervisorLeaseToken,
        },
      );
      if (!epoch) {
        throw new PersistenceError("SUPERVISOR_OWNERSHIP_LOST", "Source-test epoch was lost.");
      }
      const jobScope = await transaction.provider_source_test_jobs.findFirst({
        where: { id: input.jobId, organization_id: input.organizationId },
        select: { connection_profile_id: true },
      });
      if (!jobScope) {
        throw new PersistenceError("SOURCE_FENCED", "Source-test job is outside tenant scope.");
      }
      const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_connection_profiles
        where id = cast(${jobScope.connection_profile_id} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      if (!lockedProfiles[0]) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Connection profile is outside tenant scope.",
        );
      }
      await transaction.$queryRaw(Prisma.sql`
        select id from public.provider_source_test_jobs
        where id = cast(${input.jobId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const databaseNow = await providerSourceTransactionTime(transaction);
      const job = await transaction.provider_source_test_jobs.findFirst({
        where: {
          id: input.jobId,
          organization_id: input.organizationId,
          claim_owner: input.claimOwner,
          claim_token: input.claimToken,
          supervisor_epoch_id: input.supervisorEpochId,
        },
      });
      if (!job) throw new PersistenceError("SOURCE_FENCED", "Source-test claim was lost.");
      const expectedMeasurements = measurements(input.measurements);
      const existingResult = await transaction.provider_source_test_results
        .findUnique({ where: { job_id: job.id } });
      if (existingResult) {
        if (
          existingResult.request_attempt_id !== input.requestAttemptId ||
          existingResult.supervisor_epoch_id !== input.supervisorEpochId ||
          existingResult.pre_test_health_generation !==
            job.expected_health_generation ||
          existingResult.outcome !== input.outcome ||
          existingResult.safe_code !== resultCode ||
          !isDeepStrictEqual(
            existingResult.measurements_json,
            expectedMeasurements,
          ) ||
          job.state !== (input.outcome === "success" ? "succeeded" : "failed")
        ) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Source-test result replay conflicts with immutable proof.",
          );
        }
        return { resultId: existingResult.id };
      }
      if (
        job.state !== "running" ||
        !job.claim_expires_at ||
        job.claim_expires_at <= databaseNow
      ) {
        throw new PersistenceError("SOURCE_FENCED", "Source-test claim was lost.");
      }
      const openEpisode = await transaction.source_connection_health_episodes
        .findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: job.connection_profile_id,
            closed_at: null,
          },
          select: { id: true },
        });
      if (openEpisode) {
        throw new PersistenceError(
          "CONNECTION_BLOCKED",
          "Source-test result is outside the current profile episode.",
        );
      }
      const [attempt, source, revision, profile, connection] = await Promise.all([
        transaction.compact_source_request_attempts.findFirst({
          where: {
            request_attempt_id: input.requestAttemptId,
            organization_id: input.organizationId,
            operation_kind: "source_test",
            source_test_job_id: job.id,
            provider_id: job.provider_id,
            source_instance_id: job.source_instance_id,
            source_revision_id: job.source_revision_id,
            connection_profile_id: job.connection_profile_id,
            connection_revision_id: job.connection_revision_id,
            expected_health_generation: job.expected_health_generation,
            supervisor_epoch_id: input.supervisorEpochId,
            claim_owner: input.claimOwner,
            claim_token: input.claimToken,
            terminal_state: input.outcome === "success"
              ? "captured"
              : { in: ["captured", "failed"] },
          },
          select: { request_attempt_id: true, terminal_state: true },
        }),
        transaction.provider_source_instances.findFirst({
          where: {
            id: job.source_instance_id,
            organization_id: input.organizationId,
            provider_id: job.provider_id,
            active_revision_id: job.source_revision_id,
            connection_profile_id: job.connection_profile_id,
            state: { in: ["draft", "paused", "active", "disabled"] },
          },
          select: { id: true, state: true, pause_requested_at: true },
        }),
        transaction.provider_source_revisions.findFirst({
          where: {
            id: job.source_revision_id,
            organization_id: input.organizationId,
            provider_id: job.provider_id,
            source_instance_id: job.source_instance_id,
            connection_profile_id: job.connection_profile_id,
          },
          select: {
            id: true,
            source_type_key: true,
            source_adapter_version: true,
            normalized_contract_version: true,
          },
        }),
        transaction.source_connection_profiles.findFirst({
          where: {
            id: job.connection_profile_id,
            organization_id: input.organizationId,
            state: { in: ["active", "disabled"] },
          },
          select: { id: true },
        }),
        transaction.source_connection_revisions.findFirst({
          where: {
            id: job.connection_revision_id,
            organization_id: input.organizationId,
            connection_profile_id: job.connection_profile_id,
            health_generation: job.expected_health_generation,
            revoked_at: null,
            state: { in: ["active", "retired"] },
          },
          select: { id: true },
        }),
      ]);
      if (!attempt || !source || !revision || !profile || !connection) {
        throw new PersistenceError("SOURCE_FENCED", "Source-test result fence changed.");
      }
      const result = await transaction.provider_source_test_results.create({
        data: {
          organization_id: input.organizationId,
          provider_id: job.provider_id,
          job_id: job.id,
          source_instance_id: job.source_instance_id,
          source_revision_id: job.source_revision_id,
          connection_profile_id: job.connection_profile_id,
          connection_revision_id: job.connection_revision_id,
          request_attempt_id: input.requestAttemptId,
          request_terminal_state: attempt.terminal_state,
          supervisor_epoch_id: input.supervisorEpochId,
          pre_test_health_generation: job.expected_health_generation,
          resulting_health_generation: job.expected_health_generation,
          outcome: input.outcome,
          safe_code: resultCode,
          measurements_json: expectedMeasurements,
          tested_by_actor_key: job.requested_by_actor_key,
          tested_at: databaseNow,
        },
        select: { id: true },
      });
      await transaction.provider_source_test_jobs.update({
        where: { id: job.id },
        data: {
          state: input.outcome === "success" ? "succeeded" : "failed",
          finished_at: databaseNow,
        },
      });
      const paused = source.state === "paused" ||
        source.pause_requested_at !== null;
      const inactive = source.state === "disabled";
      const failed = input.outcome === "failure";
      const runtimeFailureCode = failed && resultCode &&
          /^[A-Z][A-Z0-9_]{0,127}$/u.test(resultCode)
        ? resultCode
        : failed
          ? "SOURCE_TEST_FAILED"
          : null;
      await transaction.provider_source_runtime_states.updateMany({
        where: {
          source_instance_id: job.source_instance_id,
          organization_id: input.organizationId,
          provider_id: job.provider_id,
          source_revision_id: job.source_revision_id,
          connection_profile_id: job.connection_profile_id,
          connection_revision_id: job.connection_revision_id,
        },
        data: {
          supervisor_epoch_id: input.supervisorEpochId,
          phase: paused ? "paused"
            : inactive ? "terminal"
            : failed ? "action_required"
            : "idle",
          activity: paused ? "paused"
            : inactive ? "inactive"
            : failed ? "action_required"
            : "inactive",
          wait_reason: null,
          action_required_code: paused || inactive ? null : runtimeFailureCode,
          current_run_id: null,
          run_lease_acquired_at: null,
          run_lease_expires_at: null,
          retry_attempt: 0,
          retry_not_before: null,
          queued_at: null,
          updated_at: databaseNow,
        },
      });
      await this.#diagnostics.appendInTransaction(transaction, {
        id: providerSourceSupervisorTransitionDiagnosticId({
          organizationId: input.organizationId,
          kind: "source_test",
          id: job.id,
          claimToken: input.claimToken,
        }, "terminal"),
        organizationId: input.organizationId,
        scope: "source",
        correlationKind: "source_test",
        eventKind: "source_test",
        severity: input.outcome === "failure" ? "warning" : "info",
        phase: "terminal",
        safeCode: resultCode?.toUpperCase() ?? "TERMINAL",
        occurredAt: databaseNow,
        sourceTypeKey: revision.source_type_key,
        sourceAdapterVersion: revision.source_adapter_version,
        normalizedContractVersion: revision.normalized_contract_version,
        providerId: job.provider_id,
        sourceInstanceId: job.source_instance_id,
        sourceRevisionId: job.source_revision_id,
        connectionProfileId: job.connection_profile_id,
        connectionRevisionId: job.connection_revision_id,
        sourceTestJobId: job.id,
        requestAttemptId: input.requestAttemptId,
        durationMs: input.measurements?.duration_ms,
        responseBytes: input.measurements?.response_bytes,
        counters: input.measurements,
      });
      return { resultId: result.id };
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }
}
