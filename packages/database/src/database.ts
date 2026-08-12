import { Prisma, PrismaClient } from "@prisma/client";
import type { Pool, PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as schema from "./schema/index.ts";

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
    startPromise ??= client.$connect().catch(() => {
      startPromise = undefined;
      throw new Error("PackScout database connection failed.");
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

// Temporary cutover scaffolding. Task 008 removes the Drizzle surface after all
// repositories and application compositions use the Prisma lifecycle above.
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
