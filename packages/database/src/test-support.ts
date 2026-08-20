import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
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
const TEMPLATE_NAME_PATTERN = /^packscout_test_template_[a-f0-9]{16}$/;
const INFRASTRUCTURE_ERROR =
  "PostgreSQL 16 test infrastructure is required; set PACKSCOUT_TEST_ADMIN_DATABASE_URL.";
const migrationsDirectory = fileURLToPath(
  new URL("../prisma/migrations", import.meta.url),
);

/**
 * Identifies the schema a template database was built from.
 *
 * Every migration's name and contents feed the hash, so any change to the
 * migration history produces a different template name. A stale template can
 * therefore never be reused: it simply stops being the one that gets looked up.
 */
function migrationsFingerprint(): string {
  const hash = createHash("sha256");
  let entries: string[];
  try {
    entries = readdirSync(migrationsDirectory).sort();
  } catch {
    throw new Error(INFRASTRUCTURE_ERROR);
  }

  for (const entry of entries) {
    hash.update(entry);
    try {
      hash.update(
        readFileSync(path.join(migrationsDirectory, entry, "migration.sql")),
      );
    } catch {
      // Directory entries without a migration file (such as the lock file)
      // still contribute their name, which is enough to detect a change.
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * A stable 64-bit key for the PostgreSQL advisory lock that guards template
 * creation. Test files run in separate processes, so the lock has to live in
 * the database rather than in this module.
 */
function advisoryLockKey(templateName: string): bigint {
  const digest = createHash("sha256").update(templateName).digest();
  return digest.readBigInt64BE(0);
}

/**
 * Builds the migrated template if it does not already exist.
 *
 * The template is migrated under a temporary name and only renamed into place
 * once the migration succeeds, so a process that dies mid-migration leaves
 * behind an unused scratch database rather than a half-migrated template that
 * later runs would clone and trust.
 */
async function ensureTemplateDatabase(
  admin: Pool,
  adminUrl: URL,
  templateName: string,
): Promise<void> {
  const lockKey = advisoryLockKey(templateName);
  await admin.query("select pg_advisory_lock($1::bigint)", [
    lockKey.toString(),
  ]);
  try {
    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [templateName],
    );
    if (existing.rowCount && existing.rowCount > 0) return;

    const scratchName = `${templateName}_building_${process.pid}`;
    await admin.query(`drop database if exists "${scratchName}" with (force)`);
    await admin.query(`create database "${scratchName}"`);
    try {
      await execFileAsync(
        process.execPath,
        [prismaExecutable, "migrate", "deploy", "--schema", schemaPath],
        {
          cwd: packageDirectory,
          env: {
            ...process.env,
            PACKSCOUT_DATABASE_URL: databaseUrlFor(adminUrl, scratchName),
          },
        },
      );
      await admin.query(
        `alter database "${scratchName}" rename to "${templateName}"`,
      );
    } catch (error) {
      await admin
        .query(`drop database if exists "${scratchName}" with (force)`)
        .catch(() => undefined);
      throw error;
    }
  } finally {
    await admin
      .query("select pg_advisory_unlock($1::bigint)", [lockKey.toString()])
      .catch(() => undefined);
  }
}

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

    // Migrating once into a template and cloning it per test keeps the
    // isolation guarantee — every test still gets its own database no other
    // test can observe — while replacing a full migration run per test with a
    // file-level copy. Cloning is the only path: a failure here propagates
    // rather than falling back to an unmigrated database.
    const templateName = `packscout_test_template_${migrationsFingerprint()}`;
    if (!TEMPLATE_NAME_PATTERN.test(templateName)) {
      throw new Error("Refusing to create an unscoped template database.");
    }
    await ensureTemplateDatabase(admin, adminUrl, templateName);
    await admin.query(
      `create database "${databaseName}" template "${templateName}"`,
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
