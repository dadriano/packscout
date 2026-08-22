import type { PackscoutTransactionClient } from "./database.ts";
import type { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { providerSourceSupervisorTransitionDiagnosticId } from
  "./provider-source-supervisor-work-diagnostic.ts";

interface TerminalRequestDiagnosticAttempt {
  readonly id: string;
  readonly operationKind: "connection_test" | "source_test" | "page_read";
  readonly claimToken: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly providerId: string | null;
  readonly sourceInstanceId: string | null;
  readonly sourceRevisionId: string | null;
  readonly connectionTestJobId: string | null;
  readonly sourceTestJobId: string | null;
  readonly runId: string | null;
  readonly blockingEpisodeId: string | null;
  readonly startedAt: Date;
}

/** Backfill request-start from durable start time in terminalization's tx. */
export async function appendTerminalRequestStartDiagnostic(
  transaction: PackscoutTransactionClient,
  diagnostics: ProviderSourceDiagnosticRepository,
  input: Readonly<{
    organizationId: string;
    attempt: TerminalRequestDiagnosticAttempt;
  }>,
): Promise<string> {
  const { attempt } = input;
  const connectionRevision = await transaction.source_connection_revisions
    .findFirst({
      where: {
        id: attempt.connectionRevisionId,
        organization_id: input.organizationId,
        connection_profile_id: attempt.connectionProfileId,
      },
      select: { source_type_key: true, source_adapter_version: true },
    });
  if (!connectionRevision) {
    throw new TypeError("Request-start connection revision is unavailable.");
  }
  const workId = attempt.operationKind === "connection_test"
    ? attempt.connectionTestJobId
    : attempt.operationKind === "source_test"
      ? attempt.sourceTestJobId
      : attempt.runId;
  if (!workId) throw new TypeError("Request-start work identity is incomplete.");
  const common = {
    id: providerSourceSupervisorTransitionDiagnosticId({
      organizationId: input.organizationId,
      kind: attempt.operationKind,
      id: workId,
      claimToken: attempt.claimToken,
    }, "adapter_request_started"),
    organizationId: input.organizationId,
    severity: "info" as const,
    phase: "adapter_request_started",
    safeCode: "ADAPTER_REQUEST_STARTED",
    occurredAt: attempt.startedAt,
    sourceTypeKey: connectionRevision.source_type_key,
    sourceAdapterVersion: connectionRevision.source_adapter_version,
    connectionProfileId: attempt.connectionProfileId,
    connectionRevisionId: attempt.connectionRevisionId,
    requestAttemptId: attempt.id,
  };
  if (attempt.operationKind === "connection_test") {
    return diagnostics.appendInTransaction(transaction, {
      ...common,
      scope: "connection",
      correlationKind: "connection_test",
      eventKind: "connection_test",
      connectionTestJobId: attempt.connectionTestJobId!,
      blockingEpisodeId: attempt.blockingEpisodeId,
    });
  }
  const sourceRevision = await transaction.provider_source_revisions.findFirst({
    where: {
      id: attempt.sourceRevisionId ?? undefined,
      organization_id: input.organizationId,
      provider_id: attempt.providerId ?? undefined,
      source_instance_id: attempt.sourceInstanceId ?? undefined,
      connection_profile_id: attempt.connectionProfileId,
    },
    select: { normalized_contract_version: true },
  });
  if (
    !sourceRevision || !attempt.providerId || !attempt.sourceInstanceId ||
    !attempt.sourceRevisionId
  ) throw new TypeError("Request-start source revision is unavailable.");
  const source = {
    ...common,
    scope: "source" as const,
    normalizedContractVersion: sourceRevision.normalized_contract_version,
    providerId: attempt.providerId,
    sourceInstanceId: attempt.sourceInstanceId,
    sourceRevisionId: attempt.sourceRevisionId,
  };
  if (attempt.operationKind === "source_test") {
    return diagnostics.appendInTransaction(transaction, {
      ...source,
      correlationKind: "source_test",
      eventKind: "source_test",
      sourceTestJobId: attempt.sourceTestJobId!,
    });
  }
  const run = await transaction.import_runs.findFirst({
    where: {
      id: attempt.runId ?? undefined,
      organization_id: input.organizationId,
      source_instance_id: attempt.sourceInstanceId,
      source_revision_id: attempt.sourceRevisionId,
    },
    select: { trigger: true },
  });
  if (!run || !attempt.runId) {
    throw new TypeError("Request-start run identity is unavailable.");
  }
  return diagnostics.appendInTransaction(transaction, {
    ...source,
    correlationKind: "page",
    eventKind: "source_page",
    runId: attempt.runId,
    runTrigger: run.trigger,
  });
}
