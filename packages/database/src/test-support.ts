import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaClient as CentralPrismaClientConstructor } from
  "../prisma/generated/central/index.js";
import {
  type CentralDatabaseLifecycle,
  type CentralPrismaClient,
  type CentralTransactionClient,
} from "./central-database.ts";
import {
  createPrismaClientLifecycle,
  type PackscoutPrismaClient,
  type PrismaClientLifecycle,
} from "./database.ts";
import {
  CENTRAL_SCHEMA_VERSION,
  centralDatabaseTarget,
} from "./database-topology.ts";
import { DISTRIBUTED_TRANSACTION_OPTIONS } from "./role-aware-database.ts";

/** Lets tests outside this package build real provider Prisma errors for classification. */
export { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const centralSchemaPath = fileURLToPath(
  new URL("../prisma/central/schema.prisma", import.meta.url),
);
const prismaExecutable = fileURLToPath(
  new URL("../../../node_modules/prisma/build/index.js", import.meta.url),
);
const DATABASE_NAME_PATTERN = /^packscout_test_[0-9]+_[a-f0-9]{16}$/;
const CENTRAL_DATABASE_NAME_PATTERN =
  /^packscout_central_test_[0-9]+_[a-f0-9]{16}$/;
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
  const lockKey = advisoryLockKey(templateName).toString();

  // The lock must be held on one checked-out session for its whole scope.
  // `pg_advisory_lock` is session-scoped, and a pool releases an idle client
  // after `idleTimeoutMillis` (10s by default) — which the migration below can
  // easily exceed. A reaped client ends the session, silently dropping the lock
  // and letting a second process build the template concurrently.
  //
  // Every query inside this scope uses `lockClient` rather than the pool. The
  // pool is capped at one connection, so reaching for `admin` here would wait
  // for a client that this function is itself holding, and deadlock.
  const lockClient = await admin.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1::bigint)", [lockKey]);
    try {
      const existing = await lockClient.query(
        "select 1 from pg_database where datname = $1",
        [templateName],
      );
      if (existing.rowCount && existing.rowCount > 0) return;

      const scratchName = `${templateName}_building_${process.pid}`;
      await lockClient.query(
        `drop database if exists "${scratchName}" with (force)`,
      );
      await lockClient.query(`create database "${scratchName}"`);
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
        await lockClient.query(
          `alter database "${scratchName}" rename to "${templateName}"`,
        );
      } catch (error) {
        await lockClient
          .query(`drop database if exists "${scratchName}" with (force)`)
          .catch(() => undefined);
        throw error;
      }
    } finally {
      await lockClient
        .query("select pg_advisory_unlock($1::bigint)", [lockKey])
        .catch(() => undefined);
    }
  } finally {
    lockClient.release();
  }
}

export interface StatementCounter {
  readonly count: number;
  reset(): void;
}

export type QueryObserver = (query: string) => void;

export interface MigratedTestDatabase {
  client: PackscoutPrismaClient;
  database: PackscoutPrismaClient;
  statementCounter: StatementCounter;
  observeQueries(observer: QueryObserver): () => void;
  createIndependentClient(): Promise<PackscoutPrismaClient>;
  createClientLifecycle(): PrismaClientLifecycle;
  close(): Promise<void>;
}

export interface MigratedCentralTestDatabase {
  client: CentralPrismaClient;
  database: CentralPrismaClient;
  databaseUrl: string;
  lifecycle: CentralDatabaseLifecycle;
  createIndependentLifecycle(): Promise<CentralDatabaseLifecycle>;
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
  const socketHost = databaseUrl.searchParams.get("host");
  databaseUrl.search = "";
  if (socketHost?.startsWith("/")) databaseUrl.searchParams.set("host", socketHost);
  databaseUrl.hash = "";
  return databaseUrl.toString();
}

function createInstrumentedClient(
  databaseUrl: string,
  onQuery: QueryObserver,
): PackscoutPrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  const eventClient = client as unknown as {
    $on(event: "query", callback: (event: { query: string }) => void): void;
  };
  eventClient.$on("query", ({ query }) => onQuery(query));
  return client;
}

/**
 * Test-only lifecycle for a random disposable database. Production still
 * enforces the exact `packscout` name; this helper validates only the central
 * role identity because every test database has a randomized safe name.
 */
function createCentralTestLifecycle(
  databaseUrl: string,
): CentralDatabaseLifecycle {
  const client = new CentralPrismaClientConstructor({
    datasources: { db: { url: databaseUrl } },
  });
  const target = centralDatabaseTarget();
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const readiness: CentralDatabaseLifecycle["readiness"] = async () => {
    const observedAt = new Date();
    try {
      await client.$connect();
      const identity = await client.database_identity.findUnique({
        where: { singleton_key: true },
        select: {
          database_role: true,
          schema_version: true,
          provider_id: true,
          provider_key: true,
        },
      });
      if (identity === null) {
        return {
          state: "unavailable",
          target,
          failureCode: "DATABASE_IDENTITY_MISSING",
          observedAt,
        };
      }
      if (identity.database_role !== "central") {
        return {
          state: "unavailable",
          target,
          failureCode: "DATABASE_ROLE_MISMATCH",
          observedAt,
        };
      }
      if (identity.schema_version !== CENTRAL_SCHEMA_VERSION) {
        return {
          state: "unavailable",
          target,
          failureCode: "DATABASE_SCHEMA_MISMATCH",
          observedAt,
        };
      }
      if (identity.provider_id !== null || identity.provider_key !== null) {
        return {
          state: "unavailable",
          target,
          failureCode: "PROVIDER_IDENTITY_MISMATCH",
          observedAt,
        };
      }
      return {
        state: "ready",
        target,
        observedSchemaVersion: identity.schema_version,
        observedAt,
      };
    } catch {
      return {
        state: "unavailable",
        target,
        failureCode: "DATABASE_UNREACHABLE",
        observedAt,
      };
    }
  };

  const start = async (): Promise<void> => {
    if (closed) throw new Error("Central test database lifecycle is closed.");
    startPromise ??= (async () => {
      const result = await readiness();
      if (result.state === "unavailable") {
        throw new Error(
          `Central test database is unavailable (${result.failureCode}).`,
        );
      }
    })().catch((error: unknown) => {
      startPromise = undefined;
      throw error;
    });
    await startPromise;
  };

  return {
    client,
    target,
    readiness,
    start,
    async transaction<T>(
      callback: (transaction: CentralTransactionClient) => Promise<T>,
    ): Promise<T> {
      await start();
      return client.$transaction(callback, DISTRIBUTED_TRANSACTION_OPTIONS);
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = client.$disconnect();
      return closePromise;
    },
  };
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
  const queryObservers = new Set<QueryObserver>();
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
    const client = createInstrumentedClient(databaseUrl, (query) => {
      statementCount += 1;
      for (const observer of queryObservers) observer(query);
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
    observeQueries(observer) {
      queryObservers.add(observer);
      return () => queryObservers.delete(observer);
    },
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

/** Creates one isolated, migrated central-role database owned by this call. */
export async function createMigratedCentralTestDatabase(): Promise<
  MigratedCentralTestDatabase
> {
  const adminUrl = resolveAdminDatabaseUrl();
  const databaseName =
    `packscout_central_test_${process.pid}_${randomBytes(8).toString("hex")}`;
  if (!CENTRAL_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error("Refusing to create an unscoped central test database.");
  }
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const databaseUrl = databaseUrlFor(adminUrl, databaseName);
  const lifecycles = new Set<CentralDatabaseLifecycle>();
  let databaseCreated = false;
  let closePromise: Promise<void> | undefined;

  try {
    const version = await admin.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL version is below 16");
    }
    await admin.query(`create database "${databaseName}"`);
    databaseCreated = true;
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", centralSchemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_CENTRAL_DATABASE_URL: databaseUrl },
      },
    );
  } catch {
    if (databaseCreated) {
      await admin
        .query(`drop database "${databaseName}" with (force)`)
        .catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw new Error(INFRASTRUCTURE_ERROR);
  }

  const createLifecycle = async (): Promise<CentralDatabaseLifecycle> => {
    const lifecycle = createCentralTestLifecycle(databaseUrl);
    lifecycles.add(lifecycle);
    try {
      await lifecycle.start();
      return lifecycle;
    } catch {
      lifecycles.delete(lifecycle);
      await lifecycle.close().catch(() => undefined);
      throw new Error(INFRASTRUCTURE_ERROR);
    }
  };

  let lifecycle: CentralDatabaseLifecycle;
  try {
    lifecycle = await createLifecycle();
  } catch {
    if (databaseCreated) {
      await admin
        .query(`drop database "${databaseName}" with (force)`)
        .catch(() => undefined);
      databaseCreated = false;
    }
    await admin.end().catch(() => undefined);
    throw new Error(INFRASTRUCTURE_ERROR);
  }

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await Promise.allSettled(
        [...lifecycles].map((tracked) => tracked.close()),
      );
      try {
        if (databaseCreated) {
          await admin.query(`drop database "${databaseName}" with (force)`);
          databaseCreated = false;
        }
      } finally {
        await admin.end();
      }
    })();
    return closePromise;
  };

  return {
    client: lifecycle.client,
    database: lifecycle.client,
    databaseUrl,
    lifecycle,
    createIndependentLifecycle: createLifecycle,
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
