import type { Pool, PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as schema from "./schema/index.ts";

export type PackscoutSchema = typeof schema;
export type PackscoutDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  PackscoutSchema
>;

export function createNodePostgresDatabase(
  client: Pool | PoolClient,
): NodePgDatabase<PackscoutSchema> {
  return drizzle(client, { schema });
}
