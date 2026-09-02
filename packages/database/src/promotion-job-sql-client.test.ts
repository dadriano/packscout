import assert from "node:assert/strict";
import test from "node:test";
import { Prisma as LegacyPrisma } from "@prisma/client";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type { CentralQueryClient } from "./central-database.ts";
import type { ProviderQueryClient } from "./provider-database.ts";
import {
  centralPromotionJobSqlClient,
  providerPromotionJobSqlClient,
} from "./promotion-job-sql-client.ts";

test("promotion job clients rebuild shared SQL with each physical Prisma runtime", async () => {
  const sharedQuery = LegacyPrisma.sql`
    select ${1}::integer from ${LegacyPrisma.raw("public.synthetic_job")}
  `;
  const sharedExecute = LegacyPrisma.sql`select ${2}::integer`;
  const centralQueries: CentralPrisma.Sql[] = [];
  const centralExecutions: CentralPrisma.Sql[] = [];
  const central = centralPromotionJobSqlClient({
    $queryRaw: async (statement: CentralPrisma.Sql) => {
      centralQueries.push(statement);
      return [];
    },
    $executeRaw: async (statement: CentralPrisma.Sql) => {
      centralExecutions.push(statement);
      return 1;
    },
  } as unknown as CentralQueryClient);
  await central.query(sharedQuery);
  await central.execute(sharedExecute);

  const providerQueries: ProviderPrisma.Sql[] = [];
  const providerExecutions: ProviderPrisma.Sql[] = [];
  const provider = providerPromotionJobSqlClient({
    $queryRaw: async (statement: ProviderPrisma.Sql) => {
      providerQueries.push(statement);
      return [];
    },
    $executeRaw: async (statement: ProviderPrisma.Sql) => {
      providerExecutions.push(statement);
      return 1;
    },
  } as unknown as ProviderQueryClient);
  await provider.query(sharedQuery);
  await provider.execute(sharedExecute);

  assert.notEqual(sharedQuery.constructor, CentralPrisma.sql``.constructor);
  assert.notEqual(sharedQuery.constructor, ProviderPrisma.sql``.constructor);
  assert.equal(centralQueries[0]?.constructor, CentralPrisma.sql``.constructor);
  assert.equal(centralExecutions[0]?.constructor, CentralPrisma.sql``.constructor);
  assert.equal(providerQueries[0]?.constructor, ProviderPrisma.sql``.constructor);
  assert.equal(providerExecutions[0]?.constructor, ProviderPrisma.sql``.constructor);
  assert.equal(centralQueries[0]?.sql, sharedQuery.sql);
  assert.equal(centralExecutions[0]?.sql, sharedExecute.sql);
  assert.equal(providerQueries[0]?.sql, sharedQuery.sql);
  assert.equal(providerExecutions[0]?.sql, sharedExecute.sql);
});
