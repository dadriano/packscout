import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import type {
  AdminProviderOperationCursor,
  AdminProviderOperationRecord,
} from "./admin-operation-read-model.ts";
import {
  providerConfigRevisions,
  providerSources,
} from "./schema/index.ts";

export interface AdminProviderOperationPage {
  readonly items: readonly AdminProviderOperationRecord[];
  readonly hasMore: boolean;
}

export class DrizzleAdminProviderOperationRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async listPage(input: {
    readonly organizationId: string;
    readonly after?: AdminProviderOperationCursor;
    readonly limit: number;
  }): Promise<AdminProviderOperationPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new RangeError("Provider operation page limit is invalid.");
    }
    const filters = [eq(providerSources.organizationId, input.organizationId)];
    if (input.after) {
      filters.push(
        or(
          gt(providerSources.platformKey, input.after.platformKey),
          and(
            eq(providerSources.platformKey, input.after.platformKey),
            gt(providerSources.id, input.after.providerId),
          ),
        )!,
      );
    }
    const providers = await this.database
      .select({
        providerId: providerSources.id,
        platformKey: providerSources.platformKey,
        activeRevisionId: providerSources.activeRevisionId,
      })
      .from(providerSources)
      .where(and(...filters))
      .orderBy(asc(providerSources.platformKey), asc(providerSources.id))
      .limit(input.limit + 1);

    const items = await Promise.all(
      providers.slice(0, input.limit).map(async (provider) => {
        const revisionFilters = [
          eq(providerConfigRevisions.organizationId, input.organizationId),
          eq(providerConfigRevisions.providerId, provider.providerId),
        ];
        if (provider.activeRevisionId) {
          revisionFilters.push(
            eq(providerConfigRevisions.id, provider.activeRevisionId),
          );
        }
        const [revision] = await this.database
          .select({
            id: providerConfigRevisions.id,
            version: providerConfigRevisions.version,
          })
          .from(providerConfigRevisions)
          .where(and(...revisionFilters))
          .orderBy(desc(providerConfigRevisions.version))
          .limit(1);
        if (!revision) {
          throw new Error("Provider configuration revision could not be loaded.");
        }
        return {
          providerId: provider.providerId,
          platformKey: provider.platformKey,
          configurationRevisionId: revision.id,
          configurationVersion: revision.version,
        };
      }),
    );
    return { items, hasMore: providers.length > input.limit };
  }
}
