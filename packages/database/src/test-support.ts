import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema/index.ts";

export interface MigratedTestDatabase {
  client: PGlite;
  database: PgliteDatabase<typeof schema>;
  close(): Promise<void>;
}

export async function createMigratedTestDatabase(): Promise<MigratedTestDatabase> {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  return {
    client,
    database,
    close: () => client.close(),
  };
}
