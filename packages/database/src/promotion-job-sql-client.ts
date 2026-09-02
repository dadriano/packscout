import type { Prisma as LegacyPrisma } from "@prisma/client";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type { CentralQueryClient } from "./central-database.ts";
import type { ProviderQueryClient } from "./provider-database.ts";
import type { PromotionJobSqlClient } from
  "./split-promotion-job-store.ts";

function centralStatement(statement: LegacyPrisma.Sql): CentralPrisma.Sql {
  return CentralPrisma.sql(statement.strings, ...statement.values);
}

function providerStatement(statement: LegacyPrisma.Sql): ProviderPrisma.Sql {
  return ProviderPrisma.sql(statement.strings, ...statement.values);
}

/**
 * Shared job SQL originates from the legacy Prisma runtime. Rebuild it with
 * the physical client's generated runtime so extended clients retain the
 * query text while intercepting raw operations.
 */
export function centralPromotionJobSqlClient(
  client: CentralQueryClient,
): PromotionJobSqlClient {
  return {
    query: async <T>(statement: LegacyPrisma.Sql) =>
      client.$queryRaw<T[]>(centralStatement(statement)),
    execute: async (statement: LegacyPrisma.Sql) =>
      client.$executeRaw(centralStatement(statement)),
  };
}

export function providerPromotionJobSqlClient(
  client: ProviderQueryClient,
): PromotionJobSqlClient {
  return {
    query: async <T>(statement: LegacyPrisma.Sql) =>
      client.$queryRaw<T[]>(providerStatement(statement)),
    execute: async (statement: LegacyPrisma.Sql) =>
      client.$executeRaw(providerStatement(statement)),
  };
}
