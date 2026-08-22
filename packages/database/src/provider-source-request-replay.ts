import type { SourceRequestOperation } from
  "./provider-source-persistence-types.ts";

/** Exact durable identity comparison for an ambiguously acknowledged begin. */
export function isExactProviderSourceRequestBeginReplay(
  existing: Readonly<{
    organization_id: string;
    operation_kind: string;
    state: string;
    request_lease_id: string;
    claim_owner: string;
    claim_token: string;
    supervisor_epoch_id: string;
    connection_profile_id: string;
    connection_revision_id: string;
    expected_health_generation: bigint;
    provider_id: string | null;
    source_instance_id: string | null;
    source_revision_id: string | null;
    connection_test_job_id: string | null;
    source_test_job_id: string | null;
    run_id: string | null;
    page_number: number | null;
    cursor_generation: bigint | null;
    requested_cursor_fingerprint: string | null;
    requested_cursor_key: string | null;
    blocking_episode_id: string | null;
  }>,
  input: Readonly<{
    organizationId: string;
    requestLeaseId: string;
    claimOwner: string;
    claimToken: string;
    supervisorEpochId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    operation: SourceRequestOperation;
  }>,
): boolean {
  const operation = input.operation;
  return existing.state === "in_flight" &&
    existing.organization_id === input.organizationId &&
    existing.operation_kind === operation.kind &&
    existing.request_lease_id === input.requestLeaseId &&
    existing.claim_owner === input.claimOwner &&
    existing.claim_token === input.claimToken &&
    existing.supervisor_epoch_id === input.supervisorEpochId &&
    existing.connection_profile_id === input.connectionProfileId &&
    existing.connection_revision_id === input.connectionRevisionId &&
    existing.expected_health_generation === input.expectedHealthGeneration &&
    existing.provider_id === (operation.kind === "connection_test"
      ? null
      : operation.providerId) &&
    existing.source_instance_id === (operation.kind === "connection_test"
      ? null
      : operation.sourceInstanceId) &&
    existing.source_revision_id === (operation.kind === "connection_test"
      ? null
      : operation.sourceRevisionId) &&
    existing.connection_test_job_id === (operation.kind === "connection_test"
      ? operation.connectionTestJobId
      : null) &&
    existing.source_test_job_id === (operation.kind === "source_test"
      ? operation.sourceTestJobId
      : null) &&
    existing.run_id === (operation.kind === "page_read" ? operation.runId : null) &&
    existing.page_number === (operation.kind === "page_read"
      ? operation.pageNumber
      : null) &&
    existing.cursor_generation === (operation.kind === "page_read"
      ? operation.cursorGeneration
      : null) &&
    existing.requested_cursor_fingerprint === (operation.kind === "page_read"
      ? operation.requestedCursorFingerprint
      : null) &&
    existing.requested_cursor_key === (operation.kind === "page_read"
      ? operation.requestedCursorFingerprint ?? "initial"
      : null) &&
    existing.blocking_episode_id === (operation.kind === "connection_test"
      ? operation.blockingEpisodeId ?? null
      : null);
}
