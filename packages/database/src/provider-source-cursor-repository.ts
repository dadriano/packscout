import { OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import type { OpaqueCursor } from "./provider-source-persistence-types.ts";

function validateOpaqueCursor(
  cursor: string | null,
  fingerprint: string | null,
): void {
  if (cursor === null || fingerprint === null) {
    if (cursor !== null || fingerprint !== null) {
      throw new TypeError("Opaque cursor and fingerprint must both be null or present.");
    }
    return;
  }
  const utf8Bytes = new TextEncoder().encode(cursor).byteLength;
  if (utf8Bytes < 1 || utf8Bytes > OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES) {
    throw new TypeError(
      `Opaque cursor must contain from 1 through ${OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES} bytes.`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new TypeError("Opaque cursor fingerprint must be a keyed lowercase digest.");
  }
}

interface LockedCursor {
  sourceRevisionId: string;
  sourceAdapterVersion: string;
  cursorCodecVersion: string;
  cursorGeneration: bigint;
  cursor: string | null;
  cursorFingerprint: string | null;
}

export interface AdvanceProviderSourceCursorInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceAdapterVersion: string;
  readonly cursorCodecVersion: string;
  readonly cursorGeneration: bigint;
  readonly expectedCursorFingerprint: string | null;
  readonly nextCursor: string | null;
  readonly nextCursorFingerprint: string | null;
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

export class ProviderSourceCursorRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async read(input: Readonly<{
    organizationId: string;
    sourceInstanceId: string;
  }>): Promise<OpaqueCursor | null> {
    const row = await this.database.provider_source_cursors.findFirst({
      where: {
        organization_id: input.organizationId,
        source_instance_id: input.sourceInstanceId,
      },
    });
    if (!row) return null;
    return {
      cursor: row.cursor,
      fingerprint: row.cursor_fingerprint,
      generation: row.cursor_generation,
      codecVersion: row.cursor_codec_version,
    };
  }

  /**
   * Advances only inside task 006's page transaction. The page, captured request,
   * live run claim, connection generation, and supervisor epoch are one fence.
   */
  async advanceInTransaction(
    transaction: PackscoutTransactionClient,
    input: AdvanceProviderSourceCursorInput,
  ): Promise<{ fingerprint: string | null }> {
    validateOpaqueCursor(input.nextCursor, input.nextCursorFingerprint);
    if (
      input.expectedCursorFingerprint
      && !/^[0-9a-f]{64}$/.test(input.expectedCursorFingerprint)
    ) {
      throw new TypeError("Expected cursor fingerprint must be a keyed lowercase digest.");
    }
    if (
      !Number.isSafeInteger(input.pageNumber) ||
      input.pageNumber < 1 ||
      input.pageNumber >= 2_147_483_647
    ) {
      throw new TypeError("Cursor page number must be a positive safe integer.");
    }
    const nextFingerprint = input.nextCursorFingerprint;
    if (input.continuation.kind === "continue" && nextFingerprint === null) {
      throw new TypeError("Continue requires a nonnull cursor.");
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
        "Cursor commit epoch is no longer active.",
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
        "Cursor commit connection revision is no longer active.",
      );
    }
    const rows = await transaction.$queryRaw<LockedCursor[]>(Prisma.sql`
        select source_revision_id as "sourceRevisionId",
               source_adapter_version as "sourceAdapterVersion",
               cursor_codec_version as "cursorCodecVersion",
               cursor_generation as "cursorGeneration",
               cursor,
               cursor_fingerprint as "cursorFingerprint"
        from public.provider_source_cursors
        where source_instance_id = cast(${input.sourceInstanceId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
        for update
      `);
      const current = rows[0];
      const databaseNow = await providerSourceTransactionTime(transaction);
      if (!current) {
        throw new PersistenceError("TENANT_SCOPE_VIOLATION", "Source cursor is outside tenant scope.");
      }
      if (
        current.sourceRevisionId !== input.sourceRevisionId
        || current.sourceAdapterVersion !== input.sourceAdapterVersion
        || current.cursorCodecVersion !== input.cursorCodecVersion
        || current.cursorGeneration !== input.cursorGeneration
      ) {
        throw new PersistenceError("SOURCE_FENCED", "Cursor pins no longer own the source.");
      }
      if (current.cursorFingerprint !== input.expectedCursorFingerprint) {
        throw new PersistenceError("SOURCE_FENCED", "Requested cursor no longer owns the source.");
      }

      const requestedCursorKey = input.expectedCursorFingerprint ?? "initial";
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
         and a.cursor_generation = p.cursor_generation
         and a.requested_cursor_key = p.requested_cursor_key
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
          and p.cursor_codec_version = ${input.cursorCodecVersion}
          and p.cursor_generation = ${input.cursorGeneration}
          and p.requested_cursor_fingerprint is not distinct from ${input.expectedCursorFingerprint}
          and p.requested_cursor_key = ${requestedCursorKey}
          and p.requested_cursor is not distinct from ${current.cursor}
          and p.next_cursor is not distinct from ${input.nextCursor}
          and p.next_cursor_fingerprint is not distinct from ${nextFingerprint}
          and r.state = 'running'::public.import_run_state
          and r.lease_owner = ${input.runLeaseOwner}
          and r.lease_token = cast(${input.runLeaseToken} as uuid)
          and r.lease_expires_at > ${databaseNow}
          and r.connection_profile_id = cast(${input.connectionProfileId} as uuid)
          and r.connection_revision_id = cast(${input.connectionRevisionId} as uuid)
          and r.cursor_generation = ${input.cursorGeneration}
          and r.current_cursor_fingerprint is not distinct from ${input.expectedCursorFingerprint}
          and r.current_cursor_key = ${requestedCursorKey}
          and r.current_cursor is not distinct from ${current.cursor}
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
          "Cursor advancement requires the current owned page transaction.",
        );
      }
      if (
        input.continuation.kind === "continue" &&
        current.cursorFingerprint === nextFingerprint
      ) {
        throw new PersistenceError(
          "CURSOR_CYCLE_DETECTED",
          "The adapter repeated the requested cursor.",
        );
      }

      const previous = nextFingerprint === null
        ? null
        : await transaction.provider_source_cursor_fingerprints.findUnique({
          where: {
            source_instance_id_cursor_generation_cursor_fingerprint: {
              source_instance_id: input.sourceInstanceId,
              cursor_generation: input.cursorGeneration,
              cursor_fingerprint: nextFingerprint,
            },
          },
          select: { id: true },
        });
      if (previous && input.continuation.kind === "continue") {
        throw new PersistenceError(
          "CURSOR_CYCLE_DETECTED",
          "The adapter returned a cursor already committed in this generation.",
        );
      }

      if (nextFingerprint !== null && !previous) {
        await transaction.provider_source_cursor_fingerprints.create({
          data: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_instance_id: input.sourceInstanceId,
            source_revision_id: input.sourceRevisionId,
            cursor_generation: input.cursorGeneration,
            source_adapter_version: input.sourceAdapterVersion,
            cursor_codec_version: input.cursorCodecVersion,
            cursor_fingerprint: nextFingerprint,
            first_committed_run_id: input.runId,
            first_committed_page_id: input.pageId,
            committed_at: databaseNow,
          },
        });
      }
      await transaction.provider_source_cursors.update({
        where: { source_instance_id: input.sourceInstanceId },
        data: {
          cursor: input.nextCursor,
          cursor_fingerprint: nextFingerprint,
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
          cursor_generation: input.cursorGeneration,
          current_cursor_fingerprint: input.expectedCursorFingerprint,
          current_cursor_key: requestedCursorKey,
          next_page_number: input.pageNumber,
          state: "running",
          lease_owner: input.runLeaseOwner,
          lease_token: input.runLeaseToken,
        },
        data: {
          current_cursor: input.nextCursor,
          current_cursor_fingerprint: nextFingerprint,
          current_cursor_key: nextFingerprint ?? "initial",
          next_page_number: input.pageNumber + 1,
        },
      });
      if (advancedRun.count !== 1) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Run page-turn authority changed before cursor advancement.",
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
          "Cursor reset requires a paused or disabled source in tenant scope.",
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
          "Cursor reset requires every run and request lease to be terminal.",
        );
      }
      const nextGeneration = input.expectedGeneration + 1n;
      const updated = await transaction.provider_source_cursors.updateMany({
        where: {
          source_instance_id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          cursor_generation: input.expectedGeneration,
          source_revision_id: input.expectedSourceRevisionId,
          cursor_fingerprint: input.expectedFingerprint,
        },
        data: {
          cursor_generation: nextGeneration,
          cursor: null,
          cursor_fingerprint: null,
          advanced_by_run_id: null,
          advanced_by_page_id: null,
          updated_at: input.resetAt,
        },
      });
      if (updated.count !== 1) {
        throw new PersistenceError("SOURCE_FENCED", "Cursor generation changed before reset.");
      }
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider_source.cursor_reset",
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
