import {
  Prisma as CentralPrisma,
  PrismaClient as CentralPrismaClient,
} from "../prisma/generated/central/index.js";
import { centralDatabaseTarget } from "./database-topology.ts";
import {
  createRoleAwareDatabaseLifecycle,
  type RoleAwareDatabaseLifecycle,
} from "./role-aware-database.ts";

export type { CentralPrismaClient };
export type CentralTransactionClient = CentralPrisma.TransactionClient;
export type CentralQueryClient = CentralPrismaClient | CentralTransactionClient;

export const CENTRAL_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
});

export interface CentralDatabaseLifecycleOptions {
  readonly databaseUrl: string;
  readonly connectionLimit?: number;
  readonly client?: CentralPrismaClient;
  readonly transaction?: {
    readonly maxWaitMs?: number;
    readonly timeoutMs?: number;
  };
}

export type CentralDatabaseLifecycle = RoleAwareDatabaseLifecycle<
  CentralPrismaClient,
  CentralTransactionClient
>;

function boundedConnectionUrl(databaseUrl: string, connectionLimit: number): string {
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 32) {
    throw new TypeError("Central database connection limit is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TypeError("Central database URL is invalid.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TypeError("Central database URL is invalid.");
  }
  parsed.searchParams.set("connection_limit", String(connectionLimit));
  return parsed.toString();
}

/**
 * Owns the control-plane database client. Startup verifies the immutable
 * central identity row and never performs schema or provisioning mutations.
 */
export function createCentralDatabaseLifecycle(
  options: CentralDatabaseLifecycleOptions,
): CentralDatabaseLifecycle {
  const client = options.client ?? new CentralPrismaClient({
    datasources: {
      db: {
        url: boundedConnectionUrl(
          options.databaseUrl,
          options.connectionLimit ?? 10,
        ),
      },
    },
  });
  return createRoleAwareDatabaseLifecycle<
    CentralPrismaClient,
    CentralTransactionClient
  >({
    client,
    target: centralDatabaseTarget(),
    transaction: options.transaction,
  });
}
