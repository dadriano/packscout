import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PrismaClient } from "../prisma/generated/provider/index.js";
import { PrismaAdminProviderRuntimeRepository } from "./admin-provider-runtime-repository.ts";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";
import { PrismaProviderRuntimeRepository } from "./provider-runtime-repository.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const providerSchemaPath = fileURLToPath(new URL("../prisma/provider/schema.prisma", import.meta.url));
const prismaExecutable = fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url));

async function createHarness() {
  const administratorUrl = new URL(process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`);
  if (!["postgresql:", "postgres:"].includes(administratorUrl.protocol)) {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  const providerKey = `snapshot_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!/^packscout_snapshot_[0-9]+_[a-f0-9]{10}$/u.test(databaseName)) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }
  const databaseUrl = new URL(administratorUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const administrator = new Pool({ connectionString: administratorUrl.toString(), max: 1 });
  let created = false;
  let client: PrismaClient | undefined;
  let writer: Pool | undefined;
  try {
    const version = await administrator.query<{ server_version_num: string }>("show server_version_num");
    assert.ok(Number(version.rows[0]?.server_version_num) >= 160_000);
    await administrator.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchemaPath], {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: databaseUrl.toString() },
      });
    // A database-enforced deadline makes lock contention deterministic without
    // asserting millisecond timings on busy test hosts. This database is disposable.
    await administrator.query(`alter database "${databaseName}" set lock_timeout = '1s'`);
    client = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({ client, providerId: randomUUID(), providerKey });
    writer = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
    return {
      client,
      writer,
      async close() {
        await client?.$disconnect();
        await writer?.end();
        try {
          if (created) await administrator.query(`drop database "${databaseName}" with (force)`);
        } finally {
          created = false;
          await administrator.end();
        }
      },
    };
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    await writer?.end().catch(() => undefined);
    if (created) {
      await administrator.query(`drop database "${databaseName}" with (force)`).catch(() => undefined);
    }
    await administrator.end().catch(() => undefined);
    throw error;
  }
}

type RuntimeSnapshotHarness = Awaited<ReturnType<typeof createHarness>>;

async function assertSnapshotReadsCommittedState(
  harness: RuntimeSnapshotHarness,
  repository: PrismaProviderRuntimeRepository,
): Promise<void> {
  const committed = await repository.snapshot();
  assert.equal(committed.freshness, "unknown");
  const writer = await harness.writer.connect();
  try {
    await writer.query("begin");
    await writer.query("select singleton_key from provider_runtime where singleton_key = true for update");
    await writer.query(`update provider_runtime
      set freshness_state = 'stale', row_version = row_version + 1
      where singleton_key = true`);

    const snapshot = await repository.snapshot();
    assert.equal(snapshot.freshness, committed.freshness, "uncommitted worker changes are not exposed");
    assert.equal(snapshot.rowVersion, committed.rowVersion);
    assert.equal(snapshot.state, committed.state);
    assert.equal(snapshot.generation, committed.generation);

    const overview = await new PrismaAdminProviderRuntimeRepository(harness.client).overview();
    assert.equal(overview.freshnessState, committed.freshness);
    assert.equal(overview.runtimeState, committed.state);
    assert.equal(overview.runtimeGeneration, committed.generation);
    assert.equal(overview.activeRun, null);
    assert.equal(overview.latestRun, null);
    const uncommitted = await writer.query<{ freshness_state: string }>(
      "select freshness_state from provider_runtime where singleton_key = true",
    );
    assert.equal(uncommitted.rows[0]?.freshness_state, "stale", "the writer still owns its pending change");
  } finally {
    await writer.query("rollback");
    writer.release();
  }
}

async function assertTransitionRetainsRuntimeLocking(
  harness: RuntimeSnapshotHarness,
  repository: PrismaProviderRuntimeRepository,
): Promise<void> {
  const committed = await repository.snapshot();
  const transition = {
    expectedGeneration: committed.generation,
    to: "paused" as const,
    reason: "Snapshot contention regression test",
    actorType: "operator" as const,
    actorId: "snapshot-regression-test",
    correlationId: randomUUID(),
    occurredAt: new Date(),
  };
  const writer = await harness.writer.connect();
  try {
    await writer.query("begin");
    await writer.query("select singleton_key from provider_runtime where singleton_key = true for update");
    await assert.rejects(repository.transition(transition), /lock timeout/u);
    const unchanged = await writer.query<{ operating_state: string; state_generation: string }>(
      "select operating_state, state_generation from provider_runtime where singleton_key = true",
    );
    assert.equal(unchanged.rows[0]?.operating_state, committed.state);
    assert.equal(unchanged.rows[0]?.state_generation, committed.generation.toString());
  } finally {
    await writer.query("rollback");
    writer.release();
  }
  const applied = await repository.transition(transition);
  assert.equal(applied.kind, "transitioned");
  assert.equal(applied.runtime.state, "paused");
  assert.equal(applied.runtime.generation, committed.generation + 1n);
}

test("provider status remains readable during a worker transaction while runtime mutations retain locking", async () => {
  const harness = await createHarness();
  const repository = new PrismaProviderRuntimeRepository(harness.client);
  try {
    // Keep both phases in this test's async scope so their shared Prisma
    // resources remain owned until the harness is fully closed.
    await assertSnapshotReadsCommittedState(harness, repository);
    await assertTransitionRetainsRuntimeLocking(harness, repository);
  } finally {
    await harness.close();
  }
});
