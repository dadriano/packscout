import type { PackscoutPrismaClient } from "./database.ts";
import type {
  AdminProviderOperationCursor,
  AdminProviderOperationRecord,
} from "./admin-operation-read-model.ts";

export interface AdminProviderOperationPage {
  readonly items: readonly AdminProviderOperationRecord[];
  readonly hasMore: boolean;
}

export class DrizzleAdminProviderOperationRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async listPage(input: {
    readonly organizationId: string;
    readonly after?: AdminProviderOperationCursor;
    readonly limit: number;
  }): Promise<AdminProviderOperationPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new RangeError("Provider operation page limit is invalid.");
    }
    const providers = await this.database.provider_sources.findMany({
      where: {
        organization_id: input.organizationId,
        ...(input.after
          ? {
              OR: [
                { platform_key: { gt: input.after.platformKey } },
                {
                  platform_key: input.after.platformKey,
                  id: { gt: input.after.providerId },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        platform_key: true,
        active_revision_id: true,
      },
      orderBy: [{ platform_key: "asc" }, { id: "asc" }],
      take: input.limit + 1,
    });

    const items = await Promise.all(
      providers.slice(0, input.limit).map(async (provider) => {
        const revision = await this.database.provider_config_revisions.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: provider.id,
            ...(provider.active_revision_id
              ? { id: provider.active_revision_id }
              : {}),
          },
          select: { id: true, version: true },
          orderBy: { version: "desc" },
        });
        if (!revision) {
          throw new Error("Provider configuration revision could not be loaded.");
        }
        return {
          providerId: provider.id,
          platformKey: provider.platform_key,
          configurationRevisionId: revision.id,
          configurationVersion: revision.version,
        };
      }),
    );
    return { items, hasMore: providers.length > input.limit };
  }
}
