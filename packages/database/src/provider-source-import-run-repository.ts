import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";

export interface ProviderSourceImportRunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly trigger: "scheduled" | "manual" | "continuation" | "recovery";
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly requestedCheckpointFingerprint: string | null;
  readonly createdAt: Date;
}

export type ProviderSourceImportRunRequestResult =
  | Readonly<{
      kind: "created" | "active";
      run: ProviderSourceImportRunRecord;
    }>
  | Readonly<{ kind: "not_found" | "source_unavailable" }>
  | Readonly<{
      kind: "revision_conflict";
      activeSourceRevisionId: string;
    }>;

export interface ProviderSourceImportRunRequestInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly runId: string;
  readonly trigger: "scheduled" | "manual" | "continuation" | "recovery";
  readonly requestedByActorKey: string | null;
  readonly requestedAt: Date;
  readonly expectedSourceRevisionId?: string;
  /** Durable schedule priority, present only for scheduler materialization. */
  readonly scheduledDueAt?: Date;
  /** Authoritative transaction occurrence time when queue priority is earlier. */
  readonly transitionAt?: Date;
}

function deterministicDiagnosticId(...parts: readonly string[]): string {
  const value = createHash("sha256")
    .update("packscout.provider-source-run-diagnostic.v1")
    .update("\0")
    .update(parts.join("\0"))
    .digest()
    .subarray(0, 16);
  value[6] = (value[6]! & 0x0f) | 0x50;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function copyBytes(value: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function runRecord(row: Readonly<{
  id: string;
  organization_id: string;
  provider_id: string;
  source_instance_id: string | null;
  source_revision_id: string | null;
  trigger: "scheduled" | "manual" | "continuation" | "recovery";
  state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  requested_checkpoint_fingerprint: string | null;
  created_at: Date;
}>): ProviderSourceImportRunRecord {
  if (!row.source_instance_id || !row.source_revision_id) {
    throw new TypeError("Source import run is missing immutable source pins.");
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    providerId: row.provider_id,
    sourceInstanceId: row.source_instance_id,
    sourceRevisionId: row.source_revision_id,
    trigger: row.trigger,
    state: row.state,
    requestedCheckpointFingerprint: row.requested_checkpoint_fingerprint,
    createdAt: row.created_at,
  };
}

/** Request-only source queue. Claiming and execution belong to task 007. */
export class ProviderSourceImportRunRepository {
  readonly #diagnostics: ProviderSourceDiagnosticRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
  }

  async requestRun(
    input: Readonly<ProviderSourceImportRunRequestInput>,
  ): Promise<ProviderSourceImportRunRequestResult> {
    if (!Number.isFinite(input.requestedAt.getTime())) {
      throw new TypeError("Import request time is invalid.");
    }
    return this.database.$transaction(
      (transaction) => this.requestRunInTransaction(transaction, input),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
  }

  /** Caller-owned transaction seam for atomic recovery activation. */
  async requestRunInTransaction(
    transaction: PackscoutTransactionClient,
    input: Readonly<ProviderSourceImportRunRequestInput>,
  ): Promise<ProviderSourceImportRunRequestResult> {
    if (!Number.isFinite(input.requestedAt.getTime())) {
      throw new TypeError("Import request time is invalid.");
    }
    if (
      input.scheduledDueAt &&
      (!Number.isFinite(input.scheduledDueAt.getTime()) || input.trigger !== "scheduled")
    ) throw new TypeError("Scheduled due time is invalid for this import trigger.");
    const transitionAt = input.transitionAt ?? input.requestedAt;
    if (!Number.isFinite(transitionAt.getTime())) {
      throw new TypeError("Import transition time is invalid.");
    }
      await transaction.$queryRaw(Prisma.sql`
        select id
        from public.provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const provider = await transaction.provider_sources.findFirst({
        where: {
          id: input.providerId,
          organization_id: input.organizationId,
        },
        select: { id: true, state: true },
      });
      if (!provider) return { kind: "not_found" };
      if (provider.state !== "active") return { kind: "source_unavailable" };

      // Cross-lifecycle lock order: provider -> source instance -> connection
      // profile -> source revision -> connection revision -> checkpoint. Source
      // pause/disable locks only the source; connection rotation locks only the
      // profile/revision, so neither path acquires these rows in reverse order.
      const lockedSources = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.provider_source_instances
        where organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
          and state = 'active'::public.provider_source_instance_state
          and active_revision_id is not null
          and pause_requested_at is null
        order by created_at, id
        limit 2
        for share
      `);
      if (lockedSources.length !== 1) return { kind: "source_unavailable" };
      const source = await transaction.provider_source_instances.findFirst({
        where: {
          id: lockedSources[0]!.id,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          state: "active",
          active_revision_id: { not: null },
          pause_requested_at: null,
        },
      });
      if (!source?.active_revision_id) return { kind: "source_unavailable" };
      if (
        input.expectedSourceRevisionId !== undefined &&
        input.expectedSourceRevisionId !== source.active_revision_id
      ) {
        return {
          kind: "revision_conflict",
          activeSourceRevisionId: source.active_revision_id,
        };
      }

      const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_connection_profiles
        where id = cast(${source.connection_profile_id} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and source_type_key = ${source.source_type_key}
          and state = 'active'::public.connection_profile_state
          and active_revision_id is not null
        for share
      `);
      if (!lockedProfiles[0]) return { kind: "source_unavailable" };
      const profile = await transaction.source_connection_profiles.findFirst({
        where: {
          id: source.connection_profile_id,
          organization_id: input.organizationId,
          source_type_key: source.source_type_key,
          state: "active",
          active_revision_id: { not: null },
        },
      });
      if (!profile?.active_revision_id) return { kind: "source_unavailable" };

      const lockedRevisions = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.provider_source_revisions
        where id = cast(${source.active_revision_id} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
          and source_instance_id = cast(${source.id} as uuid)
          and connection_profile_id = cast(${profile.id} as uuid)
          and source_type_key = ${source.source_type_key}
        for share
      `);
      if (!lockedRevisions[0]) return { kind: "source_unavailable" };
      const revision = await transaction.provider_source_revisions.findFirst({
        where: {
          id: source.active_revision_id,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: source.id,
          connection_profile_id: source.connection_profile_id,
          source_type_key: source.source_type_key,
        },
      });
      if (!revision) return { kind: "source_unavailable" };

      const lockedConnections = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_connection_revisions
        where id = cast(${profile.active_revision_id} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and connection_profile_id = cast(${profile.id} as uuid)
          and source_type_key = ${revision.source_type_key}
          and source_adapter_version = ${revision.source_adapter_version}
          and state = 'active'::public.connection_revision_state
          and revoked_at is null
        for share
      `);
      if (!lockedConnections[0]) return { kind: "source_unavailable" };
      const connectionRevision =
        await transaction.source_connection_revisions.findFirst({
          where: {
            id: profile.active_revision_id,
            organization_id: input.organizationId,
            connection_profile_id: profile.id,
            source_type_key: revision.source_type_key,
            source_adapter_version: revision.source_adapter_version,
            state: "active",
            revoked_at: null,
          },
          select: { id: true },
        });
      if (!connectionRevision) return { kind: "source_unavailable" };

      const lockedCheckpoints = await transaction.$queryRaw<Array<{ source_instance_id: string }>>(Prisma.sql`
        select source_instance_id
        from public.provider_source_checkpoints
        where source_instance_id = cast(${source.id} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
          and source_revision_id = cast(${revision.id} as uuid)
          and source_adapter_version = ${revision.source_adapter_version}
          and checkpoint_codec_version = ${revision.checkpoint_codec_version}
        for share
      `);
      if (!lockedCheckpoints[0]) return { kind: "source_unavailable" };
      const checkpoint =
        await transaction.provider_source_checkpoints.findFirst({
          where: {
            source_instance_id: source.id,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_revision_id: source.active_revision_id,
          },
        });
      if (!checkpoint) return { kind: "source_unavailable" };
      const openEpisode = await transaction.source_connection_health_episodes.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: source.connection_profile_id,
          closed_at: null,
        },
        select: { id: true },
      });
      if (openEpisode) return { kind: "source_unavailable" };

      const active = await transaction.import_runs.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: source.id,
          state: { in: ["queued", "running"] },
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });
      if (active) {
        if (input.scheduledDueAt) {
          await this.appendDueDiagnostic(transaction, {
            id: active.id,
            trigger: active.trigger,
            occurredAt: input.scheduledDueAt,
            dueAt: input.scheduledDueAt,
            requestedCheckpointFingerprint: active.requested_checkpoint_fingerprint,
            source,
            revision,
            connectionRevisionId: connectionRevision.id,
            status: active.state === "running" ? "running" : "queued",
          });
        }
        await this.appendRunDiagnostic(transaction, {
          id: active.id,
          trigger: active.trigger,
          requestedAt: transitionAt,
          requestedCheckpointFingerprint:
            active.requested_checkpoint_fingerprint,
          source,
          revision,
          connectionRevisionId: connectionRevision.id,
          safeCode: "RUN_COALESCED",
          status: active.state === "running" ? "running" : "queued",
        });
        return { kind: "active", run: runRecord(active) };
      }

      const created = await transaction.import_runs.create({
        data: {
          id: input.runId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          config_revision_id: null,
          trigger: input.trigger,
          state: "queued",
          requested_by_actor_key: input.requestedByActorKey,
          source_instance_id: source.id,
          source_revision_id: revision.id,
          source_type_key: revision.source_type_key,
          source_adapter_version: revision.source_adapter_version,
          normalized_contract_version: revision.normalized_contract_version,
          mapper_key: revision.mapper_key,
          mapper_version: revision.mapper_version,
          identity_namespace_key: revision.identity_namespace_key,
          connection_profile_id: profile.id,
          connection_revision_id: connectionRevision.id,
          checkpoint_codec_version: revision.checkpoint_codec_version,
          checkpoint_generation: checkpoint.checkpoint_generation,
          requested_checkpoint: copyBytes(checkpoint.checkpoint_bytes),
          requested_checkpoint_fingerprint: checkpoint.checkpoint_fingerprint,
          requested_checkpoint_key:
            checkpoint.checkpoint_fingerprint ?? "initial",
          current_checkpoint: copyBytes(checkpoint.checkpoint_bytes),
          current_checkpoint_fingerprint: checkpoint.checkpoint_fingerprint,
          current_checkpoint_key:
            checkpoint.checkpoint_fingerprint ?? "initial",
          next_page_number: 1,
          counters_json: {
            pages: 0,
            records: 0,
            catalog: 0,
            pulls: 0,
            trades: 0,
            inserted: 0,
            revised: 0,
            duplicate: 0,
            quarantined: 0,
            warnings: 0,
            unresolvedRelationships: 0,
            canonicalRevisions: 0,
            evRequests: 0,
          },
          created_at: input.requestedAt,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.requestedByActorKey ?? "system:scheduler",
          action: "provider_source.import.request",
          subject_type: "import_run",
          subject_id: created.id,
          outcome: "success",
          metadata_json: {
            providerId: input.providerId,
            sourceInstanceId: source.id,
            sourceRevisionId: revision.id,
            trigger: input.trigger,
          },
          occurred_at: transitionAt,
        },
      });
      if (input.scheduledDueAt) {
        await this.appendDueDiagnostic(transaction, {
          id: created.id,
          trigger: created.trigger,
          occurredAt: input.scheduledDueAt,
          dueAt: input.scheduledDueAt,
          requestedCheckpointFingerprint:
            created.requested_checkpoint_fingerprint,
          source,
          revision,
          connectionRevisionId: connectionRevision.id,
          status: "queued",
        });
      }
      await this.appendRunDiagnostic(transaction, {
        id: created.id,
        trigger: created.trigger,
        requestedAt: transitionAt,
        requestedCheckpointFingerprint:
          created.requested_checkpoint_fingerprint,
        source,
        revision,
        connectionRevisionId: connectionRevision.id,
        safeCode: "RUN_QUEUED",
        status: "queued",
      });
      return { kind: "created", run: runRecord(created) };
  }

  private async appendDueDiagnostic(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      id: string;
      trigger: "scheduled" | "manual" | "continuation" | "recovery";
      occurredAt: Date;
      dueAt: Date;
      requestedCheckpointFingerprint: string | null;
      source: Readonly<{
        id: string;
        organization_id: string;
        provider_id: string;
        connection_profile_id: string;
      }>;
      revision: Readonly<{
        id: string;
        source_type_key: string;
        source_adapter_version: string;
        normalized_contract_version: string;
      }>;
      connectionRevisionId: string;
      status: "queued" | "running";
    }>,
  ): Promise<string> {
    return this.#diagnostics.appendInTransaction(transaction, {
      id: deterministicDiagnosticId(
        input.source.organization_id,
        input.source.id,
        input.dueAt.toISOString(),
        input.id,
        "work_due",
      ),
      organizationId: input.source.organization_id,
      scope: "source",
      correlationKind: "run",
      eventKind: "source_run",
      severity: "info",
      phase: "work_due",
      safeCode: "WORK_DUE",
      occurredAt: input.occurredAt,
      sourceTypeKey: input.revision.source_type_key,
      sourceAdapterVersion: input.revision.source_adapter_version,
      normalizedContractVersion: input.revision.normalized_contract_version,
      providerId: input.source.provider_id,
      sourceInstanceId: input.source.id,
      sourceRevisionId: input.revision.id,
      connectionProfileId: input.source.connection_profile_id,
      connectionRevisionId: input.connectionRevisionId,
      runId: input.id,
      runTrigger: input.trigger,
      checkpointFingerprint: input.requestedCheckpointFingerprint,
      evidence: { status: input.status },
    });
  }

  private async appendRunDiagnostic(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      id: string;
      trigger: "scheduled" | "manual" | "continuation" | "recovery";
      requestedAt: Date;
      requestedCheckpointFingerprint: string | null;
      source: Readonly<{
        id: string;
        organization_id: string;
        provider_id: string;
        connection_profile_id: string;
      }>;
      revision: Readonly<{
        id: string;
        source_type_key: string;
        source_adapter_version: string;
        normalized_contract_version: string;
      }>;
      connectionRevisionId: string;
      safeCode: "RUN_QUEUED" | "RUN_COALESCED";
      status: "queued" | "running";
    }>,
  ): Promise<string> {
    return this.#diagnostics.appendInTransaction(transaction, {
      organizationId: input.source.organization_id,
      scope: "source",
      correlationKind: "run",
      eventKind: "source_run",
      severity: "info",
      phase: "queue",
      safeCode: input.safeCode,
      occurredAt: input.requestedAt,
      sourceTypeKey: input.revision.source_type_key,
      sourceAdapterVersion: input.revision.source_adapter_version,
      normalizedContractVersion: input.revision.normalized_contract_version,
      providerId: input.source.provider_id,
      sourceInstanceId: input.source.id,
      sourceRevisionId: input.revision.id,
      connectionProfileId: input.source.connection_profile_id,
      connectionRevisionId: input.connectionRevisionId,
      runId: input.id,
      runTrigger: input.trigger,
      checkpointFingerprint: input.requestedCheckpointFingerprint,
      evidence: { status: input.status },
    });
  }
}
