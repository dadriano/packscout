import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import assert from "node:assert/strict";
import { createProviderDatabaseLifecycle, initializeProviderDatabaseIdentity, PrismaAdminProviderRuntimeRepository,
  PrismaProviderRuntimeRepository, type ProviderPrismaClient } from "@packscout/database";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const databasePackage = path.join(repositoryRoot, "packages/database");
const providerSchema = path.join(
  databasePackage,
  "prisma/provider/schema.prisma",
);
const prismaExecutable = path.join(
  repositoryRoot,
  "node_modules/prisma/build/index.js",
);
const disposableDatabasePattern =
  /^packscout_(?:clutch|courtyard)_test_[0-9]+_[a-f0-9]{10}$/u;

export interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  readonly providerId: string;
  readonly providerKey: string;
  close(): Promise<void>;
}

function adminUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  const parsed = new URL(configured);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  return parsed;
}

function databaseUrl(source: URL, databaseName: string): string {
  const result = new URL(source);
  result.pathname = `/${databaseName}`;
  // Preserve the explicitly selected Unix socket for isolated PostgreSQL tests.
  result.hash = "";
  return result.toString();
}

export async function createHarness(
  providerLabel: "clutch" | "courtyard" = "clutch",
  exactProviderKey?: "clutchpacks" | "courtyard",
): Promise<ProviderHarness> {
  const rootUrl = adminUrl();
  const databaseKey =
    `${providerLabel}_test_${process.pid}_${randomBytes(5).toString("hex")}`;
  const providerKey = exactProviderKey ?? databaseKey;
  const databaseName = `packscout_${providerKey}`;
  if (
    exactProviderKey === undefined
      ? !disposableDatabasePattern.test(databaseName)
      : process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL === undefined
  ) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }
  const administrator = new Pool({ connectionString: rootUrl.toString(), max: 1 });
  const providerDatabaseUrl = databaseUrl(rootUrl, databaseName);
  let created = false;
  let client: ProviderPrismaClient | undefined;
  try {
    const version = await administrator.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL 16 test infrastructure is required.");
    }
    const existing = await administrator.query<{ exists: boolean }>(
      "select exists(select 1 from pg_database where datname = $1) as exists",
      [databaseName],
    );
    if (existing.rows[0]?.exists) {
      throw new Error("Refusing to replace an existing provider test database.");
    }
    await administrator.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchema],
      {
        cwd: databasePackage,
        env: {
          ...process.env,
          PACKSCOUT_PROVIDER_DATABASE_URL: providerDatabaseUrl,
        },
      },
    );
    const providerId = randomUUID();
    client = createProviderDatabaseLifecycle({
      databaseUrl: providerDatabaseUrl,
      providerId,
      providerKey,
      connectionLimit: 2,
    }).client;
    await client.$connect();
    await initializeProviderDatabaseIdentity({
      client,
      providerId,
      providerKey,
    });
    return {
      client,
      providerId,
      providerKey,
      async close() {
        await client?.$disconnect();
        if (created) {
          await administrator.query(
            `drop database "${databaseName}" with (force)`,
          );
          created = false;
        }
        await administrator.end();
      },
    };
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    if (created) {
      await administrator.query(
        `drop database "${databaseName}" with (force)`,
      ).catch(() => undefined);
    }
    await administrator.end().catch(() => undefined);
    throw error;
  }
}

export async function enqueue(
  harness: ProviderHarness,
  configVersionId: string,
  sequence: number,
): Promise<string> {
  const runtime = await new PrismaProviderRuntimeRepository(
    harness.client,
  ).snapshot();
  const result = await new PrismaAdminProviderRuntimeRepository(
    harness.client,
  ).requestRunNow({
    providerId: harness.providerId,
    operatorId: "10000000-0000-4000-8000-000000000001",
    expectedConfigVersionId: configVersionId,
    expectedConfigVersionNumber: 1n,
    expectedGeneration: runtime.generation,
    idempotencyKey: `clutch-integration-${sequence}-${randomUUID()}`,
    commandId: randomUUID(),
    runId: randomUUID(),
    correlationId: randomUUID(),
  });
  assert.equal(result.kind, "created");
  if (result.kind !== "created") throw new Error("Run was not queued.");
  return result.run.id;
}
