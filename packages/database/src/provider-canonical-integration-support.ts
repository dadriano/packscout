import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PrismaClient as ProviderPrismaClient } from "../prisma/generated/provider/index.js";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const providerSchemaPath = fileURLToPath(
  new URL("../prisma/provider/schema.prisma", import.meta.url),
);
const prismaExecutable = fileURLToPath(
  new URL("../../../node_modules/prisma/build/index.js", import.meta.url),
);
const PROVIDER_DATABASE_PATTERN = /^packscout_canonical_[0-9]+_[a-f0-9]{10}$/;

export interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  readonly providerKey: string;
  close(): Promise<void>;
}

function resolveAdminUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  const value = configured
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  const result = new URL(value);
  if (result.protocol !== "postgresql:" && result.protocol !== "postgres:") {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  return result;
}

function providerUrl(adminUrl: URL, databaseName: string): string {
  const result = new URL(adminUrl);
  result.pathname = `/${databaseName}`;
  // Preserve an explicit Unix-socket host in disposable test infrastructure.
  result.hash = "";
  return result.toString();
}

export async function createProviderHarness(): Promise<ProviderHarness> {
  const adminUrl = resolveAdminUrl();
  const providerKey = `canonical_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!PROVIDER_DATABASE_PATTERN.test(databaseName)) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const databaseUrl = providerUrl(adminUrl, databaseName);
  let created = false;
  let client: ProviderPrismaClient | undefined;
  try {
    const version = await admin.query<{ server_version_num: string }>("show server_version_num");
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL 16 test infrastructure is required.");
    }
    const existing = await admin.query<{ exists: boolean }>(
      "select exists(select 1 from pg_database where datname = $1) as exists",
      [databaseName],
    );
    if (existing.rows[0]?.exists) {
      throw new Error("Refusing to replace an existing provider test database.");
    }
    await admin.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: databaseUrl },
      },
    );
    client = new ProviderPrismaClient({ datasources: { db: { url: databaseUrl } } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({
      client,
      providerId: randomUUID(),
      providerKey,
    });
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    if (created) {
      await admin.query(`drop database "${databaseName}" with (force)`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    client,
    providerKey,
    close() {
      closePromise ??= (async () => {
        await client.$disconnect();
        if (created) {
          await admin.query(`drop database "${databaseName}" with (force)`);
          created = false;
        }
        await admin.end();
      })();
      return closePromise;
    },
  };
}
