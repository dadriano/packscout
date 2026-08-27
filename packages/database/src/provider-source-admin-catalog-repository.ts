import type { PackscoutPrismaClient } from "./database.ts";

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export class ProviderSourceAdminCatalogRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async listProviders(organizationId: string) {
    const providers = await this.database.provider_sources.findMany({
      where: { organization_id: organizationId },
      orderBy: [{ platform_key: "asc" }, { id: "asc" }],
      select: { id: true, platform_key: true },
    });
    return providers.map((provider) => ({
      id: provider.id,
      provider: provider.platform_key,
    }));
  }

  async listConnections(organizationId: string) {
    const profiles = await this.database.source_connection_profiles.findMany({
      where: { organization_id: organizationId },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
    return Promise.all(profiles.map(async (profile) => {
      const revision = await this.database.source_connection_revisions.findFirst({
        where: {
          organization_id: organizationId,
          connection_profile_id: profile.id,
        },
        orderBy: [{ revision_number: "desc" }, { id: "desc" }],
      });
      if (!revision) return null;
      const [openEpisode, revokedRevision, activeRevision] = await Promise.all([
        this.database.source_connection_health_episodes.findFirst({
          where: {
            organization_id: organizationId,
            connection_profile_id: profile.id,
            closed_at: null,
          },
          orderBy: [{ opened_at: "desc" }, { id: "desc" }],
          select: { id: true, connection_revision_id: true },
        }),
        profile.state === "disabled" && profile.active_revision_id === null
          ? this.database.source_connection_revisions.findFirst({
              where: {
                organization_id: organizationId,
                connection_profile_id: profile.id,
                state: "revoked",
              },
              orderBy: [{ revision_number: "desc" }, { id: "desc" }],
              select: { id: true },
            })
          : null,
        profile.active_revision_id === revision.id
          ? revision
          : profile.active_revision_id
            ? this.database.source_connection_revisions.findFirst({
                where: {
                  id: profile.active_revision_id,
                  organization_id: organizationId,
                  connection_profile_id: profile.id,
                },
              })
            : null,
      ]);
      const job = await this.database.source_connection_test_jobs.findFirst({
        where: {
          organization_id: organizationId,
          connection_profile_id: profile.id,
          connection_revision_id: revision.id,
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      });
      const activeJob = activeRevision === null
        ? null
        : activeRevision.id === revision.id
          ? job
          : await this.database.source_connection_test_jobs.findFirst({
              where: {
                organization_id: organizationId,
                connection_profile_id: profile.id,
                connection_revision_id: activeRevision.id,
              },
              orderBy: [{ created_at: "desc" }, { id: "desc" }],
            });
      const result = job
        ? await this.database.source_connection_test_results.findUnique({
            where: { job_id: job.id },
          })
        : null;
      const activeResult = activeJob === null
        ? null
        : activeJob.id === job?.id
          ? result
          : await this.database.source_connection_test_results.findUnique({
              where: { job_id: activeJob.id },
            });
      return {
        id: profile.id,
        displayName: profile.display_name,
        sourceTypeKey: profile.source_type_key,
        connectionTypeKey: profile.connection_type_key,
        state: profile.state,
        requestLimit: profile.request_limit,
        activeRevisionId: profile.active_revision_id,
        activeRevision: activeRevision
          ? {
              revision: {
                id: activeRevision.id,
                revisionNumber: activeRevision.revision_number,
                sourceAdapterVersion: activeRevision.source_adapter_version,
                state: activeRevision.state,
                configurationFingerprint:
                  activeRevision.configuration_fingerprint,
                encryptionKeyVersion: activeRevision.encryption_key_version,
                healthGeneration: activeRevision.health_generation,
                revokedAt: activeRevision.revoked_at,
                createdAt: activeRevision.created_at,
              },
              test: {
                jobId: activeJob?.id ?? null,
                connectionRevisionId:
                  activeJob?.connection_revision_id ?? null,
                expectedHealthGeneration:
                  activeJob?.expected_health_generation ?? null,
                resultingHealthGeneration:
                  activeResult?.resulting_health_generation ?? null,
                state: activeJob?.state ?? null,
                outcome: activeResult?.outcome ?? null,
                safeCode: activeResult?.safe_code ?? null,
                requestedAt: activeJob?.created_at ?? null,
                testedAt: activeResult?.tested_at ?? null,
              },
            }
          : null,
        recoveryFence: openEpisode
          ? {
              blockedRevisionId: openEpisode.connection_revision_id,
              blockingEpisodeId: openEpisode.id,
            }
          : revokedRevision
            ? {
                blockedRevisionId: revokedRevision.id,
                blockingEpisodeId: null,
              }
            : null,
        revision: {
          id: revision.id,
          revisionNumber: revision.revision_number,
          sourceAdapterVersion: revision.source_adapter_version,
          state: revision.state,
          configurationFingerprint: revision.configuration_fingerprint,
          encryptionKeyVersion: revision.encryption_key_version,
          healthGeneration: revision.health_generation,
          revokedAt: revision.revoked_at,
          createdAt: revision.created_at,
        },
        test: {
          jobId: job?.id ?? null,
          connectionRevisionId: job?.connection_revision_id ?? null,
          expectedHealthGeneration: job?.expected_health_generation ?? null,
          resultingHealthGeneration: result?.resulting_health_generation ?? null,
          state: job?.state ?? null,
          outcome: result?.outcome ?? null,
          safeCode: result?.safe_code ?? null,
          requestedAt: job?.created_at ?? null,
          testedAt: result?.tested_at ?? null,
        },
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      };
    })).then((rows) => rows.filter((row) => row !== null));
  }

  async listSources(organizationId: string) {
    const sources = await this.database.provider_source_instances.findMany({
      where: { organization_id: organizationId, active_revision_id: { not: null } },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
    return Promise.all(sources.map(async (source) => {
      const [provider, revision, profile, schedule, cursor, job, activeRun] =
        await Promise.all([
          this.database.provider_sources.findFirst({
            where: { id: source.provider_id, organization_id: organizationId },
            select: { platform_key: true },
          }),
          this.database.provider_source_revisions.findFirst({
            where: {
              id: source.active_revision_id!,
              organization_id: organizationId,
              source_instance_id: source.id,
            },
          }),
          this.database.source_connection_profiles.findFirst({
            where: {
              id: source.connection_profile_id,
              organization_id: organizationId,
            },
            select: { active_revision_id: true },
          }),
          this.database.provider_source_schedules.findFirst({
            where: { source_instance_id: source.id, organization_id: organizationId },
          }),
          this.database.provider_source_cursors.findFirst({
            where: { source_instance_id: source.id, organization_id: organizationId },
          }),
          this.database.provider_source_test_jobs.findFirst({
            where: { source_instance_id: source.id, organization_id: organizationId },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
          }),
          this.database.import_runs.findFirst({
            where: {
              source_instance_id: source.id,
              organization_id: organizationId,
              state: { in: ["queued", "running"] },
            },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
            select: { records_per_request: true },
          }),
        ]);
      if (!provider || !revision || !schedule || !cursor) return null;
      const [scheduleRevision, result, connectionRevision] = await Promise.all([
        this.database.provider_source_schedule_revisions.findFirst({
          where: {
            id: schedule.active_schedule_revision_id,
            organization_id: organizationId,
            source_instance_id: source.id,
          },
        }),
        job
          ? this.database.provider_source_test_results.findUnique({
              where: { job_id: job.id },
            })
          : null,
        profile?.active_revision_id
          ? this.database.source_connection_revisions.findFirst({
              where: {
                id: profile.active_revision_id,
                organization_id: organizationId,
                connection_profile_id: source.connection_profile_id,
              },
              select: { health_generation: true },
            })
          : null,
      ]);
      if (!scheduleRevision) return null;
      return {
        providerId: source.provider_id,
        provider: provider.platform_key,
        sourceInstanceId: source.id,
        sourceRevisionId: revision.id,
        sourceTypeKey: revision.source_type_key,
        sourceAdapterVersion: revision.source_adapter_version,
        connectionProfileId: source.connection_profile_id,
        connectionRevisionId: profile?.active_revision_id ?? null,
        connectionHealthGeneration: connectionRevision?.health_generation ?? null,
        state: source.state,
        pauseRequested: source.pause_requested_at !== null,
        normalizedContractVersion: revision.normalized_contract_version,
        mapperKey: revision.mapper_key,
        mapperVersion: revision.mapper_version,
        identityNamespaceKey: revision.identity_namespace_key,
        recordIdScopes: strings(revision.record_id_scopes_json),
        intervalSeconds: scheduleRevision.interval_seconds,
        recordsPerRequest: scheduleRevision.records_per_request,
        activeRunRecordsPerRequest:
          activeRun?.records_per_request ?? null,
        freshnessGraceSeconds: scheduleRevision.freshness_grace_seconds,
        scheduleRevisionId: scheduleRevision.id,
        cursorGeneration: cursor.cursor_generation,
        cursorFingerprint: cursor.cursor_fingerprint,
        test: {
          jobId: job?.id ?? null,
          connectionRevisionId: job?.connection_revision_id ?? null,
          expectedHealthGeneration: job?.expected_health_generation ?? null,
          resultingHealthGeneration: result?.resulting_health_generation ?? null,
          state: job?.state ?? null,
          outcome: result?.outcome ?? null,
          safeCode: result?.safe_code ?? null,
          requestedAt: job?.created_at ?? null,
          testedAt: result?.tested_at ?? null,
        },
        createdAt: source.created_at,
        updatedAt: source.updated_at,
      };
    })).then((rows) => rows.filter((row) => row !== null));
  }
}
