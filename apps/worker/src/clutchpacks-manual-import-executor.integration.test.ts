import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  createProviderDatabaseLifecycle,
  initializeProviderDatabaseIdentity,
  PrismaAdminProviderRuntimeRepository,
  PrismaProviderActivityOutboxRepository,
  PrismaProviderCommandRepository,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  ClutchpacksManualImportExecutor,
  type ProviderManualImportPageSource,
} from "./clutchpacks-manual-import-executor.ts";
import { ProviderCaptureMixedPageSource } from
  "./provider-capture-mixed-page-source.ts";
import {
  CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  CLUTCHPACKS_CAPTURE_FILE_NAME,
} from "./provider-capture-source-contract.ts";

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
  /^packscout_clutch_test_[0-9]+_[a-f0-9]{10}$/u;

interface ProviderHarness {
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
  result.search = "";
  result.hash = "";
  return result.toString();
}

async function createHarness(): Promise<ProviderHarness> {
  const rootUrl = adminUrl();
  const providerKey =
    `clutch_test_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!disposableDatabasePattern.test(databaseName)) {
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

function isolatedClutchSource(captureRoot: string): ProviderManualImportPageSource {
  const source = new ProviderCaptureMixedPageSource({
    captureRoot,
    actorHmacKey: Buffer.alloc(32, 0x5a),
  });
  return {
    supports(adapterKey) {
      return source.supports(adapterKey, "clutchpacks");
    },
    nextPage(input) {
      return source.nextPage({
        ...input,
        authority: { ...input.authority, providerKey: "clutchpacks" },
      });
    },
  };
}

async function enqueue(
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

test("admin queue executes one isolated Clutch page and replay stays canonical-idempotent", async (context) => {
  if (process.env.PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION !== "1") {
    context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
    return;
  }
  const captureRoot = process.env.PACKSCOUT_PROVIDER_CAPTURE_ROOT;
  if (captureRoot === undefined || captureRoot.length === 0) {
    context.skip(
      "Set PACKSCOUT_PROVIDER_CAPTURE_ROOT to run the protected capture proof.",
    );
    return;
  }
  if (!path.isAbsolute(captureRoot)) {
    throw new Error("PACKSCOUT_PROVIDER_CAPTURE_ROOT must be absolute.");
  }
  try {
    await access(path.join(captureRoot, CLUTCHPACKS_CAPTURE_FILE_NAME));
  } catch {
    context.skip("The protected ClutchPacks capture is not available.");
    return;
  }

  const harness = await createHarness();
  try {
    const configVersionId = randomUUID();
    const configuration = {
      adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
      settings: {
        captureDirectory: "clutchpacks",
        lanes: [{ name: "catalog", enabled: true }],
      },
    };
    const runtime = new PrismaProviderRuntimeRepository(harness.client);
    const synchronized = await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId,
      configVersionNumber: 1n,
      configuration,
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    });
    assert.equal(synchronized.kind, "updated");
    const unchanged = await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId,
      configVersionNumber: 1n,
      configuration,
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    });
    assert.equal(unchanged.kind, "unchanged");

    const executor = new ClutchpacksManualImportExecutor({
      database: harness.client,
      source: isolatedClutchSource(captureRoot),
      workerId: "integration:clutchpacks",
      leaseMilliseconds: 30_000,
    });
    const firstRunId = await enqueue(harness, configVersionId, 1);
    assert.equal(
      (await new PrismaProviderCommandRepository(harness.client)
        .nextAccepted())?.resulting_run_id,
      firstRunId,
    );
    const leaseProbe = await new PrismaProviderWorkerLeaseRepository(
      harness.client,
    ).acquire({
      role: "import",
      owner: "integration:lease-probe",
      leaseMilliseconds: 30_000,
    });
    if (leaseProbe.kind === "held") throw new Error("Lease probe was held.");
    assert.equal(leaseProbe.kind, "acquired");
    assert.equal(await new PrismaProviderWorkerLeaseRepository(harness.client)
      .release({
        role: "import",
        owner: "integration:lease-probe",
        fence: leaseProbe.lease.fence,
      }), true);
    const first = await executor.executeNext();
    assert.deepEqual(first, {
      kind: "completed",
      runId: firstRunId,
      pageCount: 1,
      counters: {
        pages: 1,
        catalog: 946,
        pulls: 15,
        marketEvents: 15,
        accepted: 961,
        duplicate: 0,
        quarantined: 15,
        materialChanges: 961,
      },
    });

    const counts = await Promise.all([
      harness.client.categories.count(),
      harness.client.packs.count(),
      harness.client.collectibles.count(),
      harness.client.provider_accounts.count(),
      harness.client.pack_contents.count(),
      harness.client.pulls.count(),
      harness.client.pull_items.count(),
      harness.client.market_events.count(),
      harness.client.quarantine_records.count(),
      harness.client.provider_run_pages.count({ where: { provider_run_id: firstRunId } }),
    ]);
    assert.deepEqual(counts, [8, 14, 907, 17, 0, 0, 0, 15, 15, 1]);
    const quarantines = await harness.client.quarantine_records.findMany({
      where: { provider_run_id: firstRunId },
      select: { record_kind: true, reason_code: true, field_path: true },
    });
    assert.equal(quarantines.length, 15);
    assert.equal(quarantines.every((entry) =>
      entry.record_kind === "pull"
      && entry.reason_code === "NORMALIZED_CANDIDATE_INVALID"
      && entry.field_path === "packKey"
    ), true);
    const outbox = new PrismaProviderActivityOutboxRepository(harness.client);
    const pendingActivity = await outbox.readPendingBatch({
      providerId: harness.providerId,
      limit: 100,
    });
    assert.equal(pendingActivity.health.providerId, harness.providerId);
    const quarantineActivity = pendingActivity.events.filter(
      ({ eventType }) => eventType === "provider.quarantine.opened",
    );
    assert.equal(quarantineActivity.length, 15);
    assert.equal(quarantineActivity.every((event) =>
      event.localRunId === firstRunId
      && event.localQuarantineId !== null
    ), true);
    const terminalActivity = pendingActivity.events.find((event) =>
      event.eventType === "provider.run.terminal"
      && event.localRunId === firstRunId
    );
    assert.ok(terminalActivity);
    assert.equal(await outbox.markDeliveryFailed({
      eventId: terminalActivity.id,
      eventDigest: terminalActivity.eventDigest,
      attemptedAt: new Date(),
      failureCode: "CENTRAL_ACTIVITY_UNAVAILABLE",
    }), "recorded");
    assert.equal(await outbox.markDelivered({
      eventId: terminalActivity.id,
      eventDigest: terminalActivity.eventDigest,
      deliveredAt: new Date(),
    }), "delivered");
    assert.deepEqual(await harness.client.provider_activity_outbox.findUniqueOrThrow({
      where: { id: terminalActivity.id },
      select: { delivery_state: true, delivery_attempt_count: true },
    }), { delivery_state: "delivered", delivery_attempt_count: 2 });
    const firstSequence = (await harness.client.promotion_ledger.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { last_sequence: true },
    })).last_sequence;

    const secondRunId = await enqueue(harness, configVersionId, 2);
    const replay = await executor.executeNext();
    assert.equal(replay.kind, "completed");
    assert.equal(replay.runId, secondRunId);
    if (replay.kind !== "completed") throw new Error("Replay did not complete.");
    assert.equal(replay.pageCount, 1);
    assert.equal(replay.counters.duplicate, 961);
    assert.equal(replay.counters.quarantined, 15);
    assert.equal(replay.counters.materialChanges, 0);
    assert.deepEqual(await Promise.all([
      harness.client.packs.count(),
      harness.client.collectibles.count(),
      harness.client.pulls.count(),
      harness.client.market_events.count(),
      harness.client.quarantine_records.count(),
    ]), [14, 907, 0, 15, 30]);
    assert.equal((await harness.client.promotion_ledger.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { last_sequence: true },
    })).last_sequence, firstSequence);
    assert.deepEqual(await harness.client.database_identity.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { provider_id: true, provider_key: true },
    }), {
      provider_id: harness.providerId,
      provider_key: harness.providerKey,
    });

    const nextConfigurationId = randomUUID();
    const advanced = await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId: nextConfigurationId,
      configVersionNumber: 2n,
      configuration: {
        adapterKey: "dataforrest-events-adapter-v3",
        settings: { platform: "clutchpacks" },
      },
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    });
    assert.equal(advanced.kind, "updated");
    assert.equal(advanced.runtime.cursorFingerprint, null);
    assert.deepEqual(await harness.client.provider_runtime.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { source_cursor: true, source_cursor_hash: true },
    }), { source_cursor: null, source_cursor_hash: null });
  } finally {
    await harness.close();
  }
});
