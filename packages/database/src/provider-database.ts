import {
  Prisma as ProviderPrisma,
  PrismaClient as ProviderPrismaClient,
} from "../prisma/generated/provider/index.js";
import { providerDatabaseTarget } from "./database-topology.ts";
import { normalizeNativePrismaTlsUrl } from "./native-prisma-tls.ts";
import {
  createRoleAwareDatabaseLifecycle,
  type RoleAwareDatabaseLifecycle,
} from "./role-aware-database.ts";

export type { ProviderPrismaClient };
export type ProviderTransactionClient = ProviderPrisma.TransactionClient;
export type ProviderQueryClient = ProviderPrismaClient | ProviderTransactionClient;

export interface ProviderDatabaseLifecycleOptions {
  readonly databaseUrl: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly connectionLimit?: number;
  readonly client?: ProviderPrismaClient;
  readonly transaction?: {
    readonly maxWaitMs?: number;
    readonly timeoutMs?: number;
  };
}

export type ProviderDatabaseLifecycle = RoleAwareDatabaseLifecycle<
  ProviderPrismaClient,
  ProviderTransactionClient
>;

function boundedConnectionUrl(databaseUrl: string, connectionLimit: number): string {
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 32) {
    throw new TypeError("Provider database connection limit is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TypeError("Provider database URL is invalid.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TypeError("Provider database URL is invalid.");
  }
  parsed.searchParams.set("connection_limit", String(connectionLimit));
  return normalizeNativePrismaTlsUrl(parsed).toString();
}

export function createProviderDatabaseLifecycle(
  options: ProviderDatabaseLifecycleOptions,
): ProviderDatabaseLifecycle {
  const target = providerDatabaseTarget({
    providerId: options.providerId,
    providerKey: options.providerKey,
  });
  const client = options.client ?? new ProviderPrismaClient({
    datasources: {
      db: {
        url: boundedConnectionUrl(
          options.databaseUrl,
          options.connectionLimit ?? 4,
        ),
      },
    },
  });
  return createRoleAwareDatabaseLifecycle<
    ProviderPrismaClient,
    ProviderTransactionClient
  >({
    client,
    target,
    transaction: options.transaction,
  });
}

/**
 * Explicit provisioning step for a newly migrated provider database. The SQL
 * function is one-shot and validates current_database() against providerKey.
 * Normal application startup never invokes it.
 */
export async function initializeProviderDatabaseIdentity(input: {
  readonly client: ProviderPrismaClient;
  readonly providerId: string;
  readonly providerKey: string;
}): Promise<void> {
  providerDatabaseTarget({
    providerId: input.providerId,
    providerKey: input.providerKey,
  });
  await input.client.$executeRawUnsafe(
    "select public.initialize_provider_database_identity($1::uuid, $2::text)",
    input.providerId,
    input.providerKey,
  );
}
