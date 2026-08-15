import { Prisma, PrismaClient } from "@prisma/client";

export type PackscoutPrismaClient = PrismaClient;
export type PackscoutTransactionClient = Prisma.TransactionClient;
export type PackscoutQueryClient = PackscoutPrismaClient | PackscoutTransactionClient;

export interface PrismaClientLifecycle {
  readonly client: PackscoutPrismaClient;
  start(): Promise<void>;
  transaction<T>(
    callback: (transaction: PackscoutTransactionClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface PrismaClientLifecycleOptions {
  databaseUrl?: string;
  client?: PackscoutPrismaClient;
  transaction?: {
    maxWaitMs?: number;
    timeoutMs?: number;
  };
}

export const PACKSCOUT_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
});

const EXPECTED_MIGRATION = Object.freeze({
  name: "20260815030000_normalized_heat_observations",
  checksum: "7eda052649c99ea5a94529fe0dd2a4f57a3d30653e1679ad78e6524f9defaafd",
  tableCount: 36,
});

interface MigrationReadinessRow {
  migrationName: string;
  checksum: string;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
  tableCount: number;
}

async function assertMigrationReadiness(
  client: PackscoutPrismaClient,
): Promise<void> {
  const rows = await client.$queryRaw<MigrationReadinessRow[]>(Prisma.sql`
    select migration.migration_name as "migrationName",
           migration.checksum,
           migration.finished_at as "finishedAt",
           migration.rolled_back_at as "rolledBackAt",
           (
             select count(*)::integer
             from pg_class table_class
             join pg_namespace table_schema
               on table_schema.oid = table_class.relnamespace
             where table_schema.nspname = 'public'
               and table_class.relkind = 'r'
               and table_class.relname <> '_prisma_migrations'
           ) as "tableCount"
    from public."_prisma_migrations" as migration
    where migration.migration_name = ${EXPECTED_MIGRATION.name}
    order by migration.started_at desc
    limit 1
  `);
  const migration = rows[0];
  if (
    !migration
    || migration.checksum !== EXPECTED_MIGRATION.checksum
    || migration.finishedAt === null
    || migration.rolledBackAt !== null
    || migration.tableCount !== EXPECTED_MIGRATION.tableCount
  ) {
    throw new Error("schema not ready");
  }
}

/**
 * Owns exactly one server-side Prisma client. Construction is side-effect free;
 * callers explicitly start the connection and always close it during shutdown.
 */
export function createPrismaClientLifecycle(
  options: PrismaClientLifecycleOptions = {},
): PrismaClientLifecycle {
  const databaseUrl = options.databaseUrl ?? process.env.PACKSCOUT_DATABASE_URL;
  const client = options.client ?? new PrismaClient({
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const start = async (): Promise<void> => {
    if (closed) throw new Error("PackScout database lifecycle is closed.");
    startPromise ??= (async () => {
      try {
        await client.$connect();
      } catch {
        throw new Error("PackScout database connection failed.");
      }
      try {
        await assertMigrationReadiness(client);
      } catch {
        throw new Error("PackScout database schema is not ready.");
      }
    })().catch((error: unknown) => {
      startPromise = undefined;
      throw error;
    });
    await startPromise;
  };

  return {
    client,
    start,
    async transaction<T>(
      callback: (transaction: PackscoutTransactionClient) => Promise<T>,
    ): Promise<T> {
      await start();
      return client.$transaction(callback, {
        maxWait: options.transaction?.maxWaitMs ?? PACKSCOUT_TRANSACTION_OPTIONS.maxWait,
        timeout: options.transaction?.timeoutMs ?? PACKSCOUT_TRANSACTION_OPTIONS.timeout,
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          await startPromise;
        } catch {
          // A failed startup still owns a Prisma engine that must be disconnected.
        }
        await client.$disconnect();
      })();
      return closePromise;
    },
  };
}
