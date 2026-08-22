import { OPAQUE_CHECKPOINT_VALUE_MAXIMUM_UTF8_BYTES } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import type { OpaqueCheckpoint } from "./provider-source-persistence-types.ts";

function validateOpaqueCheckpoint(
  bytes: Uint8Array | null,
  fingerprint: string | null,
): void {
  if (bytes === null || fingerprint === null) {
    if (bytes !== null || fingerprint !== null) {
      throw new TypeError("Opaque checkpoint bytes and fingerprint must both be null or present.");
    }
    return;
  }
  if (bytes.byteLength < 1 || bytes.byteLength > OPAQUE_CHECKPOINT_VALUE_MAXIMUM_UTF8_BYTES) {
    throw new TypeError(
      `Opaque checkpoint must contain from 1 through ${OPAQUE_CHECKPOINT_VALUE_MAXIMUM_UTF8_BYTES} bytes.`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new TypeError("Opaque checkpoint fingerprint must be a keyed lowercase digest.");
  }
}

function asPrismaBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

interface LockedCheckpoint {
  sourceRevisionId: string;
  sourceAdapterVersion: string;
  checkpointCodecVersion: string;
  checkpointGeneration: bigint;
  checkpointBytes: Uint8Array | null;
  checkpointFingerprint: string | null;
}

export interface AdvanceProviderSourceCheckpointInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceAdapterVersion: string;
  readonly checkpointCodecVersion: string;
  readonly checkpointGeneration: bigint;
  readonly expectedCheckpointFingerprint: string | null;
  readonly nextCheckpoint: Uint8Array | null;
  readonly nextCheckpointFingerprint: string | null;
  readonly continuation:
    | Readonly<{ kind: "continue" }>
    | Readonly<{ kind: "poll_after"; minimumDelaySeconds: number }>;
  readonly runId: string;
  readonly pageId: string;
  readonly pageNumber: number;
  readonly requestAttemptId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly expectedHealthGeneration: bigint;
  readonly supervisorEpochId: string;
  readonly supervisorOwnerKey: string;
  readonly supervisorLeaseToken: string;
  readonly runLeaseOwner: string;
  readonly runLeaseToken: string;
  readonly committedAt: Date;
}

export class ProviderSourceCheckpointRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async read(input: Readonly<{
    organizationId: string;
    sourceInstanceId: string;
  }>): Promise<OpaqueCheckpoint | null> {
    const row = await this.database.provider_source_checkpoints.findFirst({
      where: {
        organization_id: input.organizationId,
        source_instance_id: input.sourceInstanceId,
      },
    });
    if (!row) return null;
    return {
      bytes: row.checkpoint_bytes,
      fingerprint: row.checkpoint_fingerprint,
      generation: row.checkpoint_generation,
      codecVersion: row.checkpoint_codec_version,
    };
  }

  /**
   * Advances only inside task 006's page transaction. The page, captured request,
   * live run claim, connection generation, and supervisor epoch are one fence.
   */
  async advanceInTransaction(
    transaction: PackscoutTransactionClient,
    input: AdvanceProviderSourceCheckpointInput,
  ): Promise<{ fingerprint: string | null }> {
    validateOpaqueCheckpoint(input.nextCheckpoint, input.nextCheckpointFingerprint);
    if (
      input.expectedCheckpointFingerprint
      && !/^[0-9a-f]{64}$/.test(input.expectedCheckpointFingerprint)
    ) {
      throw new TypeError("Expected checkpoint fingerprint must be a keyed lowercase digest.");
    }
    if (
      !Number.isSafeInteger(input.pageNumber) ||
      input.pageNumber < 1 ||
      input.pageNumber >= 2_147_483_647
    ) {
      throw new TypeError("Checkpoint page number must be a positive safe integer.");
    }
    const nextFingerprint = input.nextCheckpointFingerprint;
    if (input.continuation.kind === "continue" && nextFingerprint === null) {
      throw new TypeError("Continue requires a nonnull checkpoint.");
    }
    const epochs = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select id
      from public.source_supervisor_epochs
      where id = cast(${input.supervisorEpochId} as uuid)
        and owner_key = ${input.supervisorOwnerKey}
        and lease_token = cast(${input.supervisorLeaseToken} as uuid)
        and state = 'active'
        and lease_expires_at > clock_timestamp()
      for share
    `);
    if (!epochs[0]) {
      throw new PersistenceError(
        "SUPERVISOR_OWNERSHIP_LOST",
        "Checkpoint commit epoch is no longer active.",
      );
    }
    const profiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select id
      from public.source_connection_profiles
      where id = cast(${input.connectionProfileId} as uuid)
        and organization_id = cast(${input.organizationId} as uuid)
        and exists (
          select 1 from public.source_connection_revisions revision
          where revision.id = cast(${input.connectionRevisionId} as uuid)
            and revision.organization_id = cast(${input.organizationId} as uuid)
            and revision.connection_profile_id = cast(${input.connectionProfileId} as uuid)
            and revision.state in ('active', 'retired')
            and revision.revoked_at is null
            and revision.health_generation = ${input.expectedHealthGeneration}
            and (
              source_connection_profiles.state = 'active'::public.connection_profile_state
              or (
                source_connection_profiles.state = 'disabled'::public.connection_profile_state
                and revision.state = 'retired'::public.connection_revision_state
              )
            )
        )
      for share
    `);
    if (!profiles[0]) {
      throw new PersistenceError(
        "SOURCE_FENCED",
        "Checkpoint commit connection revision is no longer active.",
      );
    }
    const rows = await transaction.$queryRaw<LockedCheckpoint[]>(Prisma.sql`
        select source_revision_id as "sourceRevisionId",
               source_adapter_version as "sourceAdapterVersion",
               checkpoint_codec_version as "checkpointCodecVersion",
               checkpoint_generation as "checkpointGeneration",
               checkpoint_bytes as "checkpointBytes",
               checkpoint_fingerprint as "checkpointFingerprint"
        from public.provider_source_checkpoints
        where source_instance_id = cast(${input.sourceInstanceId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
        for update
      `);
      const current = rows[0];
      const databaseNow = await providerSourceTransactionTime(transaction);
      if (!current) {
        throw new PersistenceError("TENANT_SCOPE_VIOLATION", "Source checkpoint is outside tenant scope.");
      }
      if (
        current.sourceRevisionId !== input.sourceRevisionId
        || current.sourceAdapterVersion !== input.sourceAdapterVersion
        || current.checkpointCodecVersion !== input.checkpointCodecVersion
        || current.checkpointGeneration !== input.checkpointGeneration
      ) {
        throw new PersistenceError("SOURCE_FENCED", "Checkpoint pins no longer own the source.");
      }
      if (current.checkpointFingerprint !== input.expectedCheckpointFingerprint) {
        throw new PersistenceError("SOURCE_FENCED", "Requested checkpoint no longer owns the source.");
      }

      const requestedCheckpointKey = input.expectedCheckpointFingerprint ?? "initial";
      const ownedPage = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select p.id
        from public.import_pages p
        join public.import_runs r
          on r.id = p.run_id
         and r.organization_id = p.organization_id
         and r.provider_id = p.provider_id
         and r.source_instance_id = p.source_instance_id
         and r.source_revision_id = p.source_revision_id
        join public.compact_source_request_attempts a
          on a.request_attempt_id = p.request_attempt_id
         and a.organization_id = p.organization_id
         and a.provider_id = p.provider_id
         and a.source_instance_id = p.source_instance_id
         and a.source_revision_id = p.source_revision_id
         and a.run_id = p.run_id
         and a.page_number = p.page_number
         and a.supervisor_epoch_id = p.supervisor_epoch_id
         and a.connection_profile_id = p.connection_profile_id
         and a.connection_revision_id = p.connection_revision_id
         and a.expected_health_generation = p.connection_health_generation
         and a.checkpoint_generation = p.checkpoint_generation
         and a.requested_checkpoint_key = p.requested_checkpoint_key
        join public.source_supervisor_epochs e on e.id = p.supervisor_epoch_id
        join public.source_connection_profiles profile
          on profile.id = p.connection_profile_id
         and profile.organization_id = p.organization_id
        join public.source_connection_revisions connection_revision
          on connection_revision.id = p.connection_revision_id
         and connection_revision.organization_id = p.organization_id
         and connection_revision.connection_profile_id = p.connection_profile_id
        join public.provider_source_instances source
          on source.id = p.source_instance_id
         and source.organization_id = p.organization_id
         and source.provider_id = p.provider_id
        where p.id = cast(${input.pageId} as uuid)
          and p.organization_id = cast(${input.organizationId} as uuid)
          and p.provider_id = cast(${input.providerId} as uuid)
          and p.run_id = cast(${input.runId} as uuid)
          and p.page_number = ${input.pageNumber}
          and p.source_instance_id = cast(${input.sourceInstanceId} as uuid)
          and p.source_revision_id = cast(${input.sourceRevisionId} as uuid)
          and p.source_adapter_version = ${input.sourceAdapterVersion}
          and p.connection_profile_id = cast(${input.connectionProfileId} as uuid)
          and p.connection_revision_id = cast(${input.connectionRevisionId} as uuid)
          and p.connection_health_generation = ${input.expectedHealthGeneration}
          and p.request_attempt_id = cast(${input.requestAttemptId} as uuid)
          and p.supervisor_epoch_id = cast(${input.supervisorEpochId} as uuid)
          and p.checkpoint_codec_version = ${input.checkpointCodecVersion}
          and p.checkpoint_generation = ${input.checkpointGeneration}
          and p.requested_checkpoint_fingerprint is not distinct from ${input.expectedCheckpointFingerprint}
          and p.requested_checkpoint_key = ${requestedCheckpointKey}
          and p.requested_checkpoint is not distinct from ${current.checkpointBytes}
          and p.next_checkpoint is not distinct from ${input.nextCheckpoint === null
            ? null
            : asPrismaBytes(input.nextCheckpoint)}
          and p.next_checkpoint_fingerprint is not distinct from ${nextFingerprint}
          and r.state = 'running'::public.import_run_state
          and r.lease_owner = ${input.runLeaseOwner}
          and r.lease_token = cast(${input.runLeaseToken} as uuid)
          and r.lease_expires_at > ${databaseNow}
          and r.connection_profile_id = cast(${input.connectionProfileId} as uuid)
          and r.connection_revision_id = cast(${input.connectionRevisionId} as uuid)
          and r.checkpoint_generation = ${input.checkpointGeneration}
          and r.current_checkpoint_fingerprint is not distinct from ${input.expectedCheckpointFingerprint}
          and r.current_checkpoint_key = ${requestedCheckpointKey}
          and r.current_checkpoint is not distinct from ${current.checkpointBytes}
          and r.next_page_number = ${input.pageNumber}
          and a.terminal_state = 'captured'::public.source_request_attempt_state
          and a.claim_owner = ${input.runLeaseOwner}
          and a.claim_token = cast(${input.runLeaseToken} as uuid)
          and e.id = cast(${input.supervisorEpochId} as uuid)
          and e.state = 'active'::public.supervisor_epoch_state
          and e.owner_key = ${input.supervisorOwnerKey}
          and e.lease_token = cast(${input.supervisorLeaseToken} as uuid)
          and e.lease_expires_at > ${databaseNow}
          and (
            profile.state = 'active'::public.connection_profile_state
            or (
              profile.state = 'disabled'::public.connection_profile_state
              and connection_revision.state = 'retired'::public.connection_revision_state
            )
          )
          and connection_revision.state in (
            'active'::public.connection_revision_state,
            'retired'::public.connection_revision_state
          )
          and connection_revision.revoked_at is null
          and connection_revision.health_generation = ${input.expectedHealthGeneration}
          and source.state = 'active'::public.provider_source_instance_state
          and source.active_revision_id = cast(${input.sourceRevisionId} as uuid)
          and not exists (
            select 1
            from public.source_connection_health_episodes episode
            where episode.organization_id = p.organization_id
              and episode.connection_profile_id = p.connection_profile_id
              and episode.closed_at is null
          )
      `);
      if (!ownedPage[0]) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Checkpoint advancement requires the current owned page transaction.",
        );
      }
      if (
        input.continuation.kind === "continue" &&
        current.checkpointFingerprint === nextFingerprint
      ) {
        throw new PersistenceError(
          "CHECKPOINT_CYCLE_DETECTED",
          "The adapter repeated the requested checkpoint.",
        );
      }

      const previous = nextFingerprint === null
        ? null
        : await transaction.provider_source_checkpoint_fingerprints.findUnique({
          where: {
            source_instance_id_checkpoint_generation_checkpoint_fingerprint: {
              source_instance_id: input.sourceInstanceId,
              checkpoint_generation: input.checkpointGeneration,
              checkpoint_fingerprint: nextFingerprint,
            },
          },
          select: { id: true },
        });
      if (previous && input.continuation.kind === "continue") {
        throw new PersistenceError(
          "CHECKPOINT_CYCLE_DETECTED",
          "The adapter returned a checkpoint already committed in this generation.",
        );
      }

      if (nextFingerprint !== null && !previous) {
        await transaction.provider_source_checkpoint_fingerprints.create({
          data: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_instance_id: input.sourceInstanceId,
            source_revision_id: input.sourceRevisionId,
            checkpoint_generation: input.checkpointGeneration,
            source_adapter_version: input.sourceAdapterVersion,
            checkpoint_codec_version: input.checkpointCodecVersion,
            checkpoint_fingerprint: nextFingerprint,
            first_committed_run_id: input.runId,
            first_committed_page_id: input.pageId,
            committed_at: databaseNow,
          },
        });
      }
      await transaction.provider_source_checkpoints.update({
        where: { source_instance_id: input.sourceInstanceId },
        data: {
          checkpoint_bytes: input.nextCheckpoint === null
            ? null
            : asPrismaBytes(input.nextCheckpoint),
          checkpoint_fingerprint: nextFingerprint,
          advanced_by_run_id: input.runId,
          advanced_by_page_id: input.pageId,
          updated_at: databaseNow,
        },
      });
      const advancedRun = await transaction.import_runs.updateMany({
        where: {
          id: input.runId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: input.sourceInstanceId,
          source_revision_id: input.sourceRevisionId,
          checkpoint_generation: input.checkpointGeneration,
          current_checkpoint_fingerprint: input.expectedCheckpointFingerprint,
          current_checkpoint_key: requestedCheckpointKey,
          next_page_number: input.pageNumber,
          state: "running",
          lease_owner: input.runLeaseOwner,
          lease_token: input.runLeaseToken,
        },
        data: {
          current_checkpoint: input.nextCheckpoint === null
            ? null
            : asPrismaBytes(input.nextCheckpoint),
          current_checkpoint_fingerprint: nextFingerprint,
          current_checkpoint_key: nextFingerprint ?? "initial",
          next_page_number: input.pageNumber + 1,
        },
      });
      if (advancedRun.count !== 1) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Run page-turn authority changed before checkpoint advancement.",
        );
      }
      await transaction.provider_source_instances.updateMany({
        where: {
          id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          active_revision_id: input.sourceRevisionId,
          state: "active",
          pause_requested_at: { not: null },
        },
        data: {
          state: "paused",
          paused_at: databaseNow,
          pause_requested_at: null,
          updated_at: databaseNow,
        },
      });
    return { fingerprint: nextFingerprint };
  }

  async reset(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    expectedGeneration: bigint;
    expectedFingerprint: string | null;
    actorKey: string;
    resetAt: Date;
  }>): Promise<bigint> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select id
        from public.provider_source_instances
        where id = cast(${input.sourceInstanceId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
        for update
      `);
      const source = await transaction.provider_source_instances.findFirst({
        where: {
          id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          active_revision_id: input.expectedSourceRevisionId,
          state: { in: ["paused", "disabled"] },
        },
        select: { id: true },
      });
      if (!source) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Checkpoint reset requires a paused or disabled source in tenant scope.",
        );
      }
      const [activeRun, activeRequest] = await Promise.all([
        transaction.import_runs.findFirst({
          where: {
            organization_id: input.organizationId,
            source_instance_id: input.sourceInstanceId,
            state: { in: ["queued", "running"] },
          },
          select: { id: true },
        }),
        transaction.source_request_attempts.findFirst({
          where: {
            organization_id: input.organizationId,
            source_instance_id: input.sourceInstanceId,
            source_revision_id: input.expectedSourceRevisionId,
            state: "in_flight",
          },
          select: { id: true },
        }),
      ]);
      if (activeRun || activeRequest) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Checkpoint reset requires every run and request lease to be terminal.",
        );
      }
      const nextGeneration = input.expectedGeneration + 1n;
      const updated = await transaction.provider_source_checkpoints.updateMany({
        where: {
          source_instance_id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          checkpoint_generation: input.expectedGeneration,
          source_revision_id: input.expectedSourceRevisionId,
          checkpoint_fingerprint: input.expectedFingerprint,
        },
        data: {
          checkpoint_generation: nextGeneration,
          checkpoint_bytes: null,
          checkpoint_fingerprint: null,
          advanced_by_run_id: null,
          advanced_by_page_id: null,
          updated_at: input.resetAt,
        },
      });
      if (updated.count !== 1) {
        throw new PersistenceError("SOURCE_FENCED", "Checkpoint generation changed before reset.");
      }
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider_source.checkpoint_reset",
          subject_type: "provider_source",
          subject_id: input.sourceInstanceId,
          outcome: "success",
          metadata_json: {
            previousGeneration: input.expectedGeneration.toString(),
            resultingGeneration: nextGeneration.toString(),
          },
          occurred_at: input.resetAt,
        },
      });
      return nextGeneration;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
