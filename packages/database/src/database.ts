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
  [
    "20260812000000_clean_baseline",
    "41576f412f2ff33b12db7d6dcffb19fa88a6c40a09a9ed7200b9904377428a10",
  ],
  [
    "20260813590000_add_archive_import_trigger",
    "5e6281d4dbb178f389202fbd6f88b53052976d567057ae20cddc716d6905fe7b",
  ],
  [
    "20260814000000_provider_stream_v2_cutover",
    "1b824eee851f595145480ca8709f0f2d56b00e7a7a01418d0627ce4546ae749c",
  ],
  [
    "20260815010000_public_change_settlement",
    "127d2fa5fa3941196076d938e1b518dd15813cfc47686be4e5dbf60ce80591b8",
  ],
  [
    "20260815020000_approved_public_catalog_configuration",
    "934bcbcf7a5d1562e79696cde92f7eabe357ae970fa482da732ae79dd8972356",
  ],
  [
    "20260815030000_normalized_heat_observations",
    "ed81e9f3f13d1b4708b44c1928eb79c1b79f351d637c549a71cf87714ab1bd2c",
  ],
  [
    "20260815040000_catalog_promotion_ledger",
    "09d6d5896f825a1e36a2ca39e41ed70b6ac005e25722a8b9189bffec5f1f75b4",
  ],
  [
    "20260815050000_promotion_operational_readiness",
    "9d0c7276085648b470ddb5d05ab16bda41b86605b8f7a346da2286c786232823",
  ],
  [
    "20260816010000_provider_catalog_settlement",
    "b6633942cd1536980a0ba28bb5b977f3d5af9ed209b2800a69f8eb23aafd0a89",
  ],
  [
    "20260816020000_provider_manifest_promotion",
    "3c4061cbbe30adad937b66d68efed4afc03994cf8a8915f88c8bb1faa1fb8f10",
  ],
  [
    "20260816030000_heat_manifest_alignment",
    "91ba14b7a242c57f1eb8788570672863cfd4252620b3494520e904911f809f3f",
  ],
  [
    "20260816040000_catalog_promotion_retention",
    "98e762ab1ec5d877b418a5bebd8f9d605f557e5a8cf6d386a56a0d269ad3a865",
  ],
  [
    "20260816050000_promotion_constraint_hardening",
    "333679983d4a3e01a67934b0c306f6a87d6759f08590a94f9adb57a8146da9aa",
  ],
] as const);
const EXPECTED_TABLE_COUNT = 56;

interface MigrationReadinessRow {
  migrationName: string;
  checksum: string;
  tableCount: number;
}

async function assertMigrationReadiness(
  client: PackscoutPrismaClient,
): Promise<void> {
  const rows = await client.$queryRaw<MigrationReadinessRow[]>(Prisma.sql`
    select migration.migration_name as "migrationName",
           migration.checksum,
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
    where migration.finished_at is not null
      and migration.rolled_back_at is null
    order by migration.migration_name asc
  `);
  const migrationsMatch = rows.length === EXPECTED_MIGRATIONS.length
    && rows.every((migration, index) => {
      const expected = EXPECTED_MIGRATIONS[index];
      return migration.migrationName === expected?.[0]
        && migration.checksum === expected[1];
    });
  if (
    !migrationsMatch
    || rows.some(({ tableCount }) => tableCount !== EXPECTED_TABLE_COUNT)
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
