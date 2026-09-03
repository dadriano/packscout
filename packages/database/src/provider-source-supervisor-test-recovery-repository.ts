import type { PackscoutTransactionClient } from "./database.ts";
import type { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { providerSourceSupervisorTransitionDiagnosticId } from
  "./provider-source-supervisor-work-diagnostic.ts";
import type { ProviderSourceSupervisorEpochFence } from
  "./provider-source-supervisor-work-repository.ts";

type TerminalAttempt = Awaited<ReturnType<
  PackscoutTransactionClient["compact_source_request_attempts"]["findFirst"]
>>;

/** Recover expired operational tests from their exact durable request proof. */
export async function recoverExpiredProviderSourceSupervisorTests(
  transaction: PackscoutTransactionClient,
  diagnostics: ProviderSourceDiagnosticRepository,
  input: ProviderSourceSupervisorEpochFence,
  databaseNow: Date,
  only?: Readonly<{
    kind: "connection_test" | "source_test";
    id: string;
  }>,
): Promise<Readonly<{ connectionTests: number; sourceTests: number }>> {
  const expiredConnectionJobs = only?.kind === "source_test"
    ? []
    : await transaction.source_connection_test_jobs.findMany({
        where: {
          state: "running",
          claim_expires_at: { lte: databaseNow },
          ...(only ? { id: only.id } : {}),
        },
        orderBy: [{ claim_expires_at: "asc" }, { id: "asc" }],
        ...(only ? { take: 1 } : {}),
      });
  let connectionTests = 0;
  for (const job of expiredConnectionJobs) {
    const inFlight = await transaction.source_request_attempts.findFirst({
      where: { connection_test_job_id: job.id, state: "in_flight" },
      select: { id: true },
    });
    if (inFlight) continue;
    const attempt = await transaction.compact_source_request_attempts.findFirst({
      where: { connection_test_job_id: job.id },
      orderBy: [{ terminal_at: "desc" }, { request_attempt_id: "desc" }],
    });
    // A compact terminal attempt proves that the request boundary closed, but
    // its protected response bytes are intentionally absent. Reissuing an
    // operational test would create a second request for one already-terminal
    // job, while publishing success would fabricate interpretation evidence.
    // Fence the exact job with one immutable failed result instead.
    const terminalGap = attempt !== null;
    const capturedGap = attempt?.terminal_state === "captured";
    const updated = await transaction.source_connection_test_jobs.updateMany({
      where: {
        id: job.id,
        state: "running",
        claim_expires_at: { lte: databaseNow },
      },
      data: terminalGap
        ? {
            state: capturedGap ? "fenced" : "failed",
            finished_at: databaseNow,
          }
        : {
            state: "queued",
            queued_at: databaseNow,
            claim_owner: null,
            claim_token: null,
            claim_expires_at: null,
            supervisor_epoch_id: null,
            started_at: null,
          },
    });
    if (updated.count !== 1) continue;
    if (terminalGap) {
      await synthesizeConnectionTestResult(transaction, job, attempt);
    }
    const revision = await transaction.source_connection_revisions.findUniqueOrThrow({
      where: { id: job.connection_revision_id },
      select: { source_type_key: true, source_adapter_version: true },
    });
    await diagnostics.appendInTransaction(transaction, {
      id: providerSourceSupervisorTransitionDiagnosticId({
        organizationId: job.organization_id,
        kind: "connection_test",
        id: job.id,
        claimToken: job.claim_token!,
      }, "work_recovered"),
      organizationId: job.organization_id,
      scope: "connection",
      correlationKind: "connection_test",
      eventKind: "connection_test",
      severity: terminalGap ? "warning" : "info",
      phase: "work_recovered",
      safeCode: terminalGap
        ? "TEST_RESULT_PUBLICATION_RECOVERED"
        : "WORK_RECOVERED",
      occurredAt: databaseNow,
      sourceTypeKey: revision.source_type_key,
      sourceAdapterVersion: revision.source_adapter_version,
      connectionProfileId: job.connection_profile_id,
      connectionRevisionId: job.connection_revision_id,
      connectionTestJobId: job.id,
      blockingEpisodeId: job.blocking_episode_id,
      requestAttemptId: attempt?.request_attempt_id,
      durationMs: attempt?.duration_ms,
      responseBytes: attempt?.response_bytes,
      evidence: { recovery_state: terminalGap ? "failed" : "queued" },
    });
    connectionTests += 1;
  }

  const expiredSourceJobs = only?.kind === "connection_test"
    ? []
    : await transaction.provider_source_test_jobs.findMany({
        where: {
          state: "running",
          claim_expires_at: { lte: databaseNow },
          ...(only ? { id: only.id } : {}),
        },
        orderBy: [{ claim_expires_at: "asc" }, { id: "asc" }],
        ...(only ? { take: 1 } : {}),
      });
  let sourceTests = 0;
  for (const job of expiredSourceJobs) {
    const inFlight = await transaction.source_request_attempts.findFirst({
      where: { source_test_job_id: job.id, state: "in_flight" },
      select: { id: true },
    });
    if (inFlight) continue;
    const attempt = await transaction.compact_source_request_attempts.findFirst({
      where: { source_test_job_id: job.id },
      orderBy: [{ terminal_at: "desc" }, { request_attempt_id: "desc" }],
    });
    const terminalGap = attempt !== null;
    const capturedGap = attempt?.terminal_state === "captured";
    const updated = await transaction.provider_source_test_jobs.updateMany({
      where: {
        id: job.id,
        state: "running",
        claim_expires_at: { lte: databaseNow },
      },
      data: terminalGap
        ? {
            state: capturedGap ? "fenced" : "failed",
            finished_at: databaseNow,
          }
        : {
            state: "queued",
            queued_at: databaseNow,
            claim_owner: null,
            claim_token: null,
            claim_expires_at: null,
            supervisor_epoch_id: null,
            started_at: null,
          },
    });
    if (updated.count !== 1) continue;
    if (terminalGap) await synthesizeSourceTestResult(transaction, job, attempt);
    await transaction.provider_source_runtime_states.updateMany({
      where: {
        source_instance_id: job.source_instance_id,
        organization_id: job.organization_id,
        source_revision_id: job.source_revision_id,
        connection_profile_id: job.connection_profile_id,
      },
      data: terminalGap ? {
        supervisor_epoch_id: input.epochId,
        phase: "action_required",
        activity: "action_required",
        wait_reason: null,
        action_required_code: "TEST_RESULT_PUBLICATION_INCOMPLETE",
        current_run_id: null,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        queued_at: null,
        updated_at: databaseNow,
      } : {
        supervisor_epoch_id: input.epochId,
        phase: "queued",
        activity: "queued",
        wait_reason: null,
        action_required_code: null,
        current_run_id: null,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        queued_at: databaseNow,
        updated_at: databaseNow,
      },
    });
    const revision = await transaction.provider_source_revisions.findUniqueOrThrow({
      where: { id: job.source_revision_id },
      select: {
        source_type_key: true,
        source_adapter_version: true,
        normalized_contract_version: true,
      },
    });
    await diagnostics.appendInTransaction(transaction, {
      id: providerSourceSupervisorTransitionDiagnosticId({
        organizationId: job.organization_id,
        kind: "source_test",
        id: job.id,
        claimToken: job.claim_token!,
      }, "work_recovered"),
      organizationId: job.organization_id,
      scope: "source",
      correlationKind: "source_test",
      eventKind: "source_test",
      severity: terminalGap ? "warning" : "info",
      phase: "work_recovered",
      safeCode: terminalGap
        ? "TEST_RESULT_PUBLICATION_RECOVERED"
        : "WORK_RECOVERED",
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
      requestAttemptId: attempt?.request_attempt_id,
      durationMs: attempt?.duration_ms,
      responseBytes: attempt?.response_bytes,
      evidence: { recovery_state: terminalGap ? "failed" : "queued" },
    });
    sourceTests += 1;
  }
  return { connectionTests, sourceTests };
}

async function synthesizeConnectionTestResult(
  transaction: PackscoutTransactionClient,
  job: Awaited<ReturnType<
    PackscoutTransactionClient["source_connection_test_jobs"]["findFirstOrThrow"]
  >>,
  attempt: NonNullable<TerminalAttempt>,
): Promise<void> {
  const existing = await transaction.source_connection_test_results.findUnique({
    where: { job_id: job.id },
    select: { request_attempt_id: true },
  });
  if (existing) {
    if (existing.request_attempt_id !== attempt.request_attempt_id) {
      throw new TypeError("Recovered connection-test result has conflicting request proof.");
    }
    return;
  }
  await transaction.source_connection_test_results.create({
    data: {
      organization_id: job.organization_id,
      job_id: job.id,
      connection_profile_id: job.connection_profile_id,
      connection_revision_id: job.connection_revision_id,
      request_attempt_id: attempt.request_attempt_id,
      request_terminal_state: attempt.terminal_state,
      supervisor_epoch_id: attempt.supervisor_epoch_id,
      pre_test_health_generation: job.expected_health_generation,
      resulting_health_generation: attempt.expected_health_generation,
      outcome: "failure",
      safe_code: "TEST_RESULT_PUBLICATION_INCOMPLETE",
      response_status: null,
      latency_ms: attempt.duration_ms,
      measurements_json: {
        duration_ms: attempt.duration_ms ?? 0,
        response_bytes: attempt.response_bytes ?? 0,
      },
      tested_by_actor_key: job.requested_by_actor_key,
      tested_at: attempt.terminal_at,
    },
  });
}

async function synthesizeSourceTestResult(
  transaction: PackscoutTransactionClient,
  job: Awaited<ReturnType<
    PackscoutTransactionClient["provider_source_test_jobs"]["findFirstOrThrow"]
  >>,
  attempt: NonNullable<TerminalAttempt>,
): Promise<void> {
  const existing = await transaction.provider_source_test_results.findUnique({
    where: { job_id: job.id },
    select: { request_attempt_id: true },
  });
  if (existing) {
    if (existing.request_attempt_id !== attempt.request_attempt_id) {
      throw new TypeError("Recovered source-test result has conflicting request proof.");
    }
    return;
  }
  await transaction.provider_source_test_results.create({
    data: {
      organization_id: job.organization_id,
      provider_id: job.provider_id,
      job_id: job.id,
      source_instance_id: job.source_instance_id,
      source_revision_id: job.source_revision_id,
      connection_profile_id: job.connection_profile_id,
      connection_revision_id: job.connection_revision_id,
      request_attempt_id: attempt.request_attempt_id,
      request_terminal_state: attempt.terminal_state,
      supervisor_epoch_id: attempt.supervisor_epoch_id,
      pre_test_health_generation: job.expected_health_generation,
      resulting_health_generation: attempt.expected_health_generation,
      outcome: "failure",
      safe_code: "TEST_RESULT_PUBLICATION_INCOMPLETE",
      measurements_json: {
        duration_ms: attempt.duration_ms ?? 0,
        response_bytes: attempt.response_bytes ?? 0,
      },
      tested_by_actor_key: job.requested_by_actor_key,
      tested_at: attempt.terminal_at,
    },
  });
}
