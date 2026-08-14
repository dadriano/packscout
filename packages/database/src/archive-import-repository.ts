import type { PackscoutPrismaClient } from "./database.ts";
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
import {
  PrismaImportRunRepository,
  type PersistedImportRun,
} from "./import-run-repository.ts";

export type ArchiveRecoveryPreflightResult =
  | { readonly kind: "ready"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" | "scope_conflict" | "state_conflict" };

/** Dedicated archive boundary; normal queue claims deliberately ignore these runs. */
export class PrismaArchiveImportRepository extends PrismaImportRunRepository {
  constructor(database: PackscoutPrismaClient) {
    super(database);
  }

  /** Read-only validation that must run before any explicit recovery mutation. */
  async preflightArchiveRecovery(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    runId: string;
    platformKey: string;
    mappingAdapterKey: string;
    actorPseudonymKeyFingerprint: string;
    archiveImporterBuildSha: string;
    archiveSha256: string;
  }): Promise<ArchiveRecoveryPreflightResult> {
    if (
      !input.platformKey.trim() ||
      !input.mappingAdapterKey.trim() ||
      !/^[0-9a-f]{64}$/.test(input.actorPseudonymKeyFingerprint) ||
      !/^[0-9a-f]{40}$/.test(input.archiveImporterBuildSha) ||
      !/^[0-9a-f]{64}$/.test(input.archiveSha256)
    ) {
      throw new RangeError("Archive recovery target metadata is invalid.");
    }

    const [run, provider, revision, recordedRecovery] = await Promise.all([
      this.getRun(input.organizationId, input.runId),
      this.database.provider_sources.findFirst({
        where: {
          id: input.providerId,
          organization_id: input.organizationId,
        },
        select: { platform_key: true, state: true },
      }),
      this.database.provider_config_revisions.findFirst({
        where: {
          id: input.configurationRevisionId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
        },
        select: {
          source_mode: true,
          adapter_key: true,
          mapping_adapter_key: true,
          actor_pseudonym_key_fingerprint: true,
          archive_importer_build_sha: true,
          endpoint_url: true,
        },
      }),
      this.database.audit_events.findFirst({
        where: {
          organization_id: input.organizationId,
          subject_type: "import_run",
          subject_id: input.runId,
          action: "provider.archive_import.requeue",
          outcome: "success",
        },
        select: { id: true },
      }),
    ]);

    if (!run) return { kind: "not_found" };
    if (
      run.organizationId !== input.organizationId ||
      run.providerId !== input.providerId ||
      run.configRevisionId !== input.configurationRevisionId ||
      run.trigger !== "archive" ||
      run.archiveSha256 !== input.archiveSha256 ||
      !provider ||
      provider.platform_key !== input.platformKey ||
      provider.state === "archived" ||
      !revision ||
      revision.source_mode !== "archive" ||
      revision.adapter_key !== "provider-archive-v2" ||
      revision.mapping_adapter_key !== input.mappingAdapterKey ||
      revision.actor_pseudonym_key_fingerprint !==
        input.actorPseudonymKeyFingerprint ||
      revision.archive_importer_build_sha !== input.archiveImporterBuildSha ||
      revision.endpoint_url !== `archive://sha256/${input.archiveSha256}`
    ) {
      return { kind: "scope_conflict" };
    }
    if (run.state !== "failed" && !recordedRecovery) {
      return { kind: "state_conflict" };
    }
    return { kind: "ready", run };
  }

  async ensureArchiveRevision(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    platformKey: string;
    mappingAdapterKey: string;
    actorPseudonymKeyFingerprint: string;
    archiveImporterBuildSha: string;
    archiveSha256: string;
    actorKey: string;
    createdAt: Date;
  }): Promise<{ created: boolean }> {
    if (
      !input.platformKey.trim() ||
      !input.mappingAdapterKey.trim() ||
      !input.actorKey.trim() ||
      !/^[0-9a-f]{64}$/.test(input.actorPseudonymKeyFingerprint) ||
      !/^[0-9a-f]{40}$/.test(input.archiveImporterBuildSha) ||
      !/^[0-9a-f]{64}$/.test(input.archiveSha256)
    ) {
      throw new RangeError("Archive target metadata is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        select id
        from provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `;
      const provider = await transaction.provider_sources.findFirst({
        where: { id: input.providerId, organization_id: input.organizationId },
      });
      if (!provider) {
        throw new Error("Archive target provider was not found.");
      }
      if (
        provider.platform_key !== input.platformKey ||
        provider.state === "archived"
      ) {
        throw new Error("Archive target provider does not match the explicit scope.");
      }

      const existing = await transaction.provider_config_revisions.findUnique({
        where: { id: input.configurationRevisionId },
      });
      if (existing) {
        if (
          existing.organization_id !== input.organizationId ||
          existing.provider_id !== input.providerId ||
          existing.source_mode !== "archive" ||
          existing.adapter_key !== "provider-archive-v2" ||
          existing.mapping_adapter_key !== input.mappingAdapterKey ||
          existing.actor_pseudonym_key_fingerprint !==
            input.actorPseudonymKeyFingerprint ||
          existing.archive_importer_build_sha !== input.archiveImporterBuildSha ||
          existing.endpoint_url !== `archive://sha256/${input.archiveSha256}`
        ) {
          throw new Error("Archive target revision does not match the explicit scope.");
        }
        return { created: false };
      }
      const digestRevision = await transaction.provider_config_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_mode: "archive",
          endpoint_url: `archive://sha256/${input.archiveSha256}`,
        },
        select: { id: true },
      });
      if (digestRevision) {
        throw new Error("Archive digest is already bound to another revision.");
      }
      const latest = await transaction.provider_config_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
        },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await transaction.provider_config_revisions.create({
        data: {
          id: input.configurationRevisionId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          version: (latest?.version ?? 0) + 1,
          adapter_key: "provider-archive-v2",
          mapping_adapter_key: input.mappingAdapterKey,
          actor_pseudonym_key_fingerprint: input.actorPseudonymKeyFingerprint,
          archive_importer_build_sha: input.archiveImporterBuildSha,
          endpoint_url: `archive://sha256/${input.archiveSha256}`,
          auth_mode: "none",
          schedule_seconds: 60,
          stale_after_seconds: 1,
          source_mode: "archive",
          tested_at: null,
          tested_by_actor_key: null,
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider.archive_revision.ensure",
          subject_type: "provider_source",
          subject_id: input.providerId,
          outcome: "success",
          metadata_json: {
            configurationRevisionId: input.configurationRevisionId,
            platformKey: input.platformKey,
            mappingAdapterKey: input.mappingAdapterKey,
            archiveImporterBuildSha: input.archiveImporterBuildSha,
          },
          occurred_at: input.createdAt,
        },
      });
      return { created: true };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async requeueFailedArchiveRun(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    archiveSha256: string;
    actorKey: string;
    requeuedAt: Date;
  }): Promise<
    | { readonly kind: "requeued" }
    | { readonly kind: "not_found" | "state_conflict" }
  > {
    if (!input.actorKey.trim() || !/^[0-9a-f]{64}$/.test(input.archiveSha256)) {
      throw new RangeError("Archive recovery metadata is invalid.");
    }
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{
        id: string;
        state: string;
      }>>`
        select id, state::text as state
        from public.import_runs
        where id = cast(${input.runId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
          and trigger = 'archive'::public.import_trigger
          and archive_sha256 = ${input.archiveSha256}
        for update
      `;
      const run = rows[0];
      if (!run) return { kind: "not_found" };
      const recordedRecovery = await transaction.audit_events.findFirst({
        where: {
          organization_id: input.organizationId,
          subject_type: "import_run",
          subject_id: input.runId,
          action: "provider.archive_import.requeue",
          outcome: "success",
        },
        select: { id: true },
      });
      if (run.state !== "failed") {
        return recordedRecovery ? { kind: "requeued" } : { kind: "state_conflict" };
      }

      await transaction.import_runs.updateMany({
        where: {
          id: input.runId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          state: "failed",
        },
        data: {
          state: "queued",
          finished_at: null,
          heartbeat_at: null,
          lease_owner: null,
          lease_expires_at: null,
          reached_provider_head: false,
          failure_code: null,
          failure_summary: null,
        },
      });
      if (!recordedRecovery) {
        await transaction.audit_events.create({
          data: {
            organization_id: input.organizationId,
            actor_key: input.actorKey,
            action: "provider.archive_import.requeue",
            subject_type: "import_run",
            subject_id: input.runId,
            outcome: "success",
            metadata_json: {
              providerId: input.providerId,
              archiveSha256: input.archiveSha256,
            },
            occurred_at: input.requeuedAt,
          },
        });
      }
      return { kind: "requeued" };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
