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

const EXPECTED_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: "20260816040000_catalog_promotion_retention",
    checksum: "98e762ab1ec5d877b418a5bebd8f9d605f557e5a8cf6d386a56a0d269ad3a865",
  }),
  Object.freeze({
    name: "20260819000000_worker_presence",
    checksum: "25dd46c5d182320654c3e5382b39f81fb82ce194717a3237e6dcfa7dc33d3608",
  }),
  Object.freeze({
    name: "20260820000000_machinery_alerts",
    checksum: "ef91ca0c3cc94a6d9e87215748e2efb35b687441a8d912f635ed4f1d88cdaddc",
  }),
  Object.freeze({
    name: "20260822000000_email_message_outbox",
    checksum: "833e44b7725dd169cd7d5552a8f85c3c8b9126ff06608e467c33428fa3426d41",
  }),
]);
const EXPECTED_TABLE_COUNT = 59;

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
    where migration.migration_name in (${Prisma.join(
      EXPECTED_MIGRATIONS.map(({ name }) => name),
    )})
    order by migration.started_at desc
  `);
  for (const expected of EXPECTED_MIGRATIONS) {
    const migration = rows.find(
      (row) => row.migrationName === expected.name,
    );
    if (
      !migration
      || migration.checksum !== expected.checksum
      || migration.finishedAt === null
      || migration.rolledBackAt !== null
      || migration.tableCount !== EXPECTED_TABLE_COUNT
    ) {
      throw new Error("schema not ready");
    }
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
