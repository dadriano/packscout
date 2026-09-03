import type { PackscoutPrismaClient } from "./database.ts";

/** Tenant-scoped lifecycle referents shared by configuration command services. */
export class ProviderSourceAdminReadRepository {
  constructor(protected readonly database: PackscoutPrismaClient) {}

  async loadProvider(input: Readonly<{
    organizationId: string;
    providerId: string;
  }>) {
    const provider = await this.database.provider_sources.findFirst({
      where: { id: input.providerId, organization_id: input.organizationId },
      select: { id: true, organization_id: true, platform_key: true },
    });
    return provider
      ? {
          organizationId: provider.organization_id,
          providerId: provider.id,
          provider: provider.platform_key,
        }
      : null;
  }

  async loadConnectionProfile(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
  }>) {
    const profile = await this.database.source_connection_profiles.findFirst({
      where: {
        id: input.connectionProfileId,
        organization_id: input.organizationId,
      },
      select: {
        id: true,
        organization_id: true,
        source_type_key: true,
        state: true,
        active_revision_id: true,
      },
    });
    const activeRevision = profile?.active_revision_id
      ? await this.database.source_connection_revisions.findFirst({
          where: {
            id: profile.active_revision_id,
            organization_id: input.organizationId,
            connection_profile_id: profile.id,
          },
          select: { source_adapter_version: true },
        })
      : null;
    return profile
      ? {
          organizationId: profile.organization_id,
          connectionProfileId: profile.id,
          sourceTypeKey: profile.source_type_key,
          state: profile.state,
          activeRevisionId: profile.active_revision_id,
          activeRevisionSourceAdapterVersion:
            activeRevision?.source_adapter_version ?? null,
        }
      : null;
  }
}
