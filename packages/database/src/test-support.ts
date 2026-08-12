import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  createPrismaClientLifecycle,
  type PackscoutPrismaClient,
  type PrismaClientLifecycle,
} from "./database.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const prismaExecutable = fileURLToPath(
  new URL("../../../node_modules/prisma/build/index.js", import.meta.url),
);
const DATABASE_NAME_PATTERN = /^packscout_test_[0-9]+_[a-f0-9]{16}$/;
const INFRASTRUCTURE_ERROR =
  "PostgreSQL 16 test infrastructure is required; set PACKSCOUT_TEST_ADMIN_DATABASE_URL.";

export interface StatementCounter {
  readonly count: number;
  reset(): void;
}

export interface MigratedTestDatabase {
  client: PackscoutPrismaClient;
  database: PackscoutPrismaClient;
  statementCounter: StatementCounter;
  createIndependentClient(): Promise<PackscoutPrismaClient>;
  createClientLifecycle(): PrismaClientLifecycle;
  close(): Promise<void>;
}

function resolveAdminDatabaseUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  const fallback = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  try {
    const parsed = new URL(configured ?? fallback);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new Error("unsupported protocol");
    }
    return parsed;
  } catch {
    throw new Error(INFRASTRUCTURE_ERROR);
  }
}

function databaseUrlFor(adminUrl: URL, databaseName: string): string {
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  databaseUrl.search = "";
  databaseUrl.hash = "";
  return databaseUrl.toString();
}

function createInstrumentedClient(
  databaseUrl: string,
  onQuery: () => void,
): PackscoutPrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  const eventClient = client as unknown as {
    $on(event: "query", callback: () => void): void;
  };
  eventClient.$on("query", onQuery);
  return client;
}

export async function createMigratedTestDatabase(): Promise<MigratedTestDatabase> {
  const adminUrl = resolveAdminDatabaseUrl();
  const databaseName = `packscout_test_${process.pid}_${randomBytes(8).toString("hex")}`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error("Refusing to create an unscoped test database.");
  }

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const databaseUrl = databaseUrlFor(adminUrl, databaseName);
  const clients = new Set<PackscoutPrismaClient>();
  let statementCount = 0;
  let closePromise: Promise<void> | undefined;

  try {
    const version = await admin.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL version is below 16");
    }
    await admin.query(`create database "${databaseName}"`);
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", schemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_DATABASE_URL: databaseUrl },
      },
    );
  } catch {
    try {
      await admin.query(`drop database if exists "${databaseName}" with (force)`);
    } catch {
      // Preserve the stable infrastructure failure below.
    }
    await admin.end().catch(() => undefined);
    throw new Error(INFRASTRUCTURE_ERROR);
  }

  const createClient = (): PackscoutPrismaClient => {
    const client = createInstrumentedClient(databaseUrl, () => {
      statementCount += 1;
    });
    clients.add(client);
    return client;
  };
  const client = createClient();
  try {
    await client.$connect();
  } catch {
    await client.$disconnect().catch(() => undefined);
    await admin.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw new Error(INFRASTRUCTURE_ERROR);
  }

  const statementCounter: StatementCounter = {
    get count() {
      return statementCount;
    },
    reset() {
      statementCount = 0;
    },
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await Promise.allSettled([...clients].map((tracked) => tracked.$disconnect()));
      try {
        await admin.query(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await admin.end();
      }
    })();
    return closePromise;
  };

  return {
    client,
    database: client,
    statementCounter,
    async createIndependentClient() {
      const independent = createClient();
      try {
        await independent.$connect();
        return independent;
      } catch {
        clients.delete(independent);
        await independent.$disconnect().catch(() => undefined);
        throw new Error(INFRASTRUCTURE_ERROR);
      }
    },
    createClientLifecycle() {
      const lifecycleClient = createClient();
      return createPrismaClientLifecycle({
        client: lifecycleClient,
        databaseUrl,
      });
    },
    close,
  };
}

export async function withMigratedTestDatabase<T>(
  callback: (harness: MigratedTestDatabase) => Promise<T>,
): Promise<T> {
  const harness = await createMigratedTestDatabase();
  try {
    return await callback(harness);
  } finally {
    await harness.close();
  }
}
