import { createHash } from "node:crypto";
import { providerSourceSuccessfulCaptureCanonicalJson } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import type { ProviderSourceAtomicPagePersistenceInput } from "./provider-source-page-validation.ts";

function fenced(message: string): never {
  throw new PersistenceError("SOURCE_FENCED", message);
}

/**
 * Locks every mutable page authority in global order:
 * epoch -> provider -> source -> profile -> source revision -> connection
 * revision -> run -> cursor. Episode creators serialize on the profile.
 */
export async function lockProviderSourcePageOwnership(
  transaction: PackscoutTransactionClient,
  input: ProviderSourceAtomicPagePersistenceInput,
): Promise<Date> {
  const { pins } = input;
  const epochs = await transaction.$queryRaw<Array<{
    id: string;
    leaseExpiresAt: Date;
  }>>(Prisma.sql`
    select id, lease_expires_at as "leaseExpiresAt"
    from public.source_supervisor_epochs
    where id = ${pins.supervisorEpochId}::uuid
      and epoch_number = ${BigInt(pins.singletonFencingEpoch)}
      and owner_key = ${pins.supervisorOwnerKey}
      and lease_token = ${pins.supervisorLeaseToken}::uuid
      and state = 'active'::public.supervisor_epoch_state
    for share
  `);
  if (!epochs[0]) fenced("Atomic page supervisor epoch is no longer active.");

  const providers = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select id
    from public.provider_sources
    where id = ${pins.providerId}::uuid
      and organization_id = ${pins.organizationId}::uuid
      and platform_key = ${pins.provider}
      and state = 'active'::public.provider_state
    for share
  `);
  if (!providers[0]) fenced("Atomic page provider is no longer active.");

  const sources = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select id
    from public.provider_source_instances
    where id = ${pins.sourceInstanceId}::uuid
      and organization_id = ${pins.organizationId}::uuid
      and provider_id = ${pins.providerId}::uuid
      and active_revision_id = ${pins.sourceRevisionId}::uuid
      and connection_profile_id = ${pins.connectionProfileId}::uuid
      and source_type_key = ${pins.sourceTypeKey}
      and state = 'active'::public.provider_source_instance_state
    for share
  `);
  if (!sources[0]) fenced("Atomic page source is no longer active.");

  const profiles = await transaction.$queryRaw<Array<{
    id: string;
    state: "active" | "disabled";
  }>>(Prisma.sql`
    select id, state::text
    from public.source_connection_profiles
    where id = ${pins.connectionProfileId}::uuid
      and organization_id = ${pins.organizationId}::uuid
      and source_type_key = ${pins.sourceTypeKey}
      and state in (
        'active'::public.connection_profile_state,
        'disabled'::public.connection_profile_state
      )
    for share
  `);
  if (!profiles[0]) fenced("Atomic page connection profile is unavailable.");

  const sourceRevisions = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select id
    from public.provider_source_revisions
    where id = ${pins.sourceRevisionId}::uuid
      and organization_id = ${pins.organizationId}::uuid
      and provider_id = ${pins.providerId}::uuid
      and source_instance_id = ${pins.sourceInstanceId}::uuid
      and connection_profile_id = ${pins.connectionProfileId}::uuid
      and source_type_key = ${pins.sourceTypeKey}
      and source_adapter_version = ${pins.sourceAdapterVersion}
      and normalized_contract_version = ${pins.normalizedContractVersion}
      and mapper_key = ${pins.mapperKey}
      and mapper_version = ${pins.mapperVersion}
      and identity_namespace_key = ${pins.identityNamespaceKey}
      and cursor_codec_version = ${pins.cursorCodecVersion}
    for share
  `);
  if (!sourceRevisions[0]) fenced("Atomic page source revision pins changed.");

  const connectionRevisions = await transaction.$queryRaw<Array<{
    id: string;
    state: "active" | "retired";
  }>>(
    Prisma.sql`
      select id, state::text
      from public.source_connection_revisions
      where id = ${pins.connectionRevisionId}::uuid
        and organization_id = ${pins.organizationId}::uuid
        and connection_profile_id = ${pins.connectionProfileId}::uuid
        and source_type_key = ${pins.sourceTypeKey}
        and source_adapter_version = ${pins.sourceAdapterVersion}
        and state in (
          'active'::public.connection_revision_state,
          'retired'::public.connection_revision_state
        )
        and revoked_at is null
        and health_generation = ${pins.connectionHealthGeneration}
      for share
    `,
  );
  if (!connectionRevisions[0]) {
    fenced("Atomic page connection revision is stale or revoked.");
  }
  if (
    profiles[0]!.state === "disabled" &&
    connectionRevisions[0]!.state !== "retired"
  ) {
    fenced("Disabled connection profile does not preserve this page pin.");
  }

  const runs = await transaction.$queryRaw<Array<{
    id: string;
    leaseExpiresAt: Date;
  }>>(Prisma.sql`
    select id, lease_expires_at as "leaseExpiresAt"
    from public.import_runs
    where id = ${pins.runId}::uuid
      and organization_id = ${pins.organizationId}::uuid
      and provider_id = ${pins.providerId}::uuid
      and config_revision_id is null
      and trigger = cast(${pins.runTrigger} as public.import_trigger)
      and state = 'running'::public.import_run_state
      and source_instance_id = ${pins.sourceInstanceId}::uuid
      and source_revision_id = ${pins.sourceRevisionId}::uuid
      and source_type_key = ${pins.sourceTypeKey}
      and source_adapter_version = ${pins.sourceAdapterVersion}
      and normalized_contract_version = ${pins.normalizedContractVersion}
      and mapper_key = ${pins.mapperKey}
      and mapper_version = ${pins.mapperVersion}
      and identity_namespace_key = ${pins.identityNamespaceKey}
      and connection_profile_id = ${pins.connectionProfileId}::uuid
      and connection_revision_id = ${pins.connectionRevisionId}::uuid
      and cursor_codec_version = ${pins.cursorCodecVersion}
      and cursor_generation = ${pins.cursorGeneration}
      and current_cursor_fingerprint is not distinct from
        ${pins.requestedCursorFingerprint}
      and current_cursor_key =
        ${pins.requestedCursorFingerprint ?? "initial"}
      and current_cursor is not distinct from
        ${pins.requestedCursor.value}
      and next_page_number = ${pins.pageNumber}
      and lease_owner = ${pins.runLeaseOwner}
      and lease_token = ${pins.runLeaseToken}::uuid
      and claim_lease_id = ${pins.runClaimLeaseId}::uuid
    for update
  `);
  if (!runs[0]) fenced("Atomic page run claim pins changed.");

  const cursors = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      select source_instance_id as id
      from public.provider_source_cursors
      where source_instance_id = ${pins.sourceInstanceId}::uuid
        and organization_id = ${pins.organizationId}::uuid
        and provider_id = ${pins.providerId}::uuid
        and source_revision_id = ${pins.sourceRevisionId}::uuid
        and source_adapter_version = ${pins.sourceAdapterVersion}
        and cursor_codec_version = ${pins.cursorCodecVersion}
        and cursor_generation = ${pins.cursorGeneration}
        and cursor_fingerprint is not distinct from
          ${pins.requestedCursorFingerprint}
        and cursor is not distinct from
          ${pins.requestedCursor.value}
      for update
    `,
  );
  if (!cursors[0]) fenced("Atomic page cursor pins changed.");

  const captureHash = createHash("sha256")
    .update(providerSourceSuccessfulCaptureCanonicalJson({
      protectedRawResponseSha256: input.protectedRawResponseSha256,
      responseBytes: input.plan.normalizedPage.measurements.responseBytes,
      durationMilliseconds:
        input.plan.normalizedPage.measurements.durationMilliseconds,
    }))
    .digest("hex");
  const attempts = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select request_attempt_id as id
    from public.compact_source_request_attempts
    where request_attempt_id = ${pins.requestAttemptId}::uuid
      and organization_id = ${pins.organizationId}::uuid
      and operation_kind = 'page_read'::public.source_request_operation_kind
      and terminal_state = 'captured'::public.source_request_attempt_state
      and outcome_class = 'response_captured'
      and safe_outcome_hash = ${captureHash}
      and response_bytes = ${input.plan.normalizedPage.measurements.responseBytes}
      and duration_ms = ${input.plan.normalizedPage.measurements.durationMilliseconds}
      and request_lease_id = ${pins.requestLeaseId}::uuid
      and claim_owner = ${pins.runLeaseOwner}
      and claim_token = ${pins.runLeaseToken}::uuid
      and supervisor_epoch_id = ${pins.supervisorEpochId}::uuid
      and connection_profile_id = ${pins.connectionProfileId}::uuid
      and connection_revision_id = ${pins.connectionRevisionId}::uuid
      and expected_health_generation = ${pins.connectionHealthGeneration}
      and provider_id = ${pins.providerId}::uuid
      and source_instance_id = ${pins.sourceInstanceId}::uuid
      and source_revision_id = ${pins.sourceRevisionId}::uuid
      and run_id = ${pins.runId}::uuid
      and page_number = ${pins.pageNumber}
      and cursor_generation = ${pins.cursorGeneration}
      and requested_cursor_fingerprint is not distinct from
        ${pins.requestedCursorFingerprint}
      and requested_cursor_key =
        ${pins.requestedCursorFingerprint ?? "initial"}
    for share
  `);
  if (!attempts[0]) fenced("Atomic page request capture proof is unavailable.");

  const openEpisodes = await transaction.source_connection_health_episodes.count({
    where: {
      organization_id: pins.organizationId,
      connection_profile_id: pins.connectionProfileId,
      closed_at: null,
    },
  });
  if (openEpisodes !== 0) fenced("Atomic page connection revision is blocked.");

  const databaseNow = await providerSourceTransactionTime(transaction);
  if (
    epochs[0]!.leaseExpiresAt <= databaseNow ||
    runs[0]!.leaseExpiresAt <= databaseNow
  ) {
    fenced("Atomic page supervisor or run lease expired before commit.");
  }
  return databaseNow;
}
