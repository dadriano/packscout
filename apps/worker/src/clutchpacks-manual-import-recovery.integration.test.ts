import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
  providerMixedPageDigest,
  PrismaAdminProviderRuntimeRepository,
  PrismaProviderRunRepository,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  ProviderManualImportExecutor,
  type ProviderManualImportPageSource,
} from "./provider-manual-import-executor.ts";

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
  /^packscout_recovery_test_[0-9]+_[a-f0-9]{10}$/u;
const supportedAdapterKey = "recovery-test-adapter-v1";

interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  readonly providerId: string;
  readonly providerKey: string;
  close(): Promise<void>;
}

interface SynchronizedConfiguration {
  readonly id: string;
  readonly version: bigint;
  readonly adapterKey: string;
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
  const socketHost = result.searchParams.get("host");
  result.search = "";
  if (socketHost?.startsWith("/")) result.searchParams.set("host", socketHost);
  result.hash = "";
  return result.toString();
}

async function createHarness(): Promise<ProviderHarness> {
  const rootUrl = adminUrl();
  const providerKey =
    `recovery_test_${process.pid}_${randomBytes(5).toString("hex")}`;
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

function integrationEnabled(): boolean {
  return process.env.PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION === "1";
}

async function synchronizeConfiguration(
  harness: ProviderHarness,
  input: Readonly<{
    adapterKey?: string;
    expiresAt?: Date | null;
    id?: string;
    version?: bigint;
  }> = {},
): Promise<SynchronizedConfiguration> {
  const configuration = {
    id: input.id ?? randomUUID(),
    version: input.version ?? 1n,
    adapterKey: input.adapterKey ?? supportedAdapterKey,
  };
  const synchronized = await new PrismaProviderRuntimeRepository(
    harness.client,
  ).synchronizeConfiguration({
    centralProviderId: harness.providerId,
    providerKey: harness.providerKey,
    configVersionId: configuration.id,
    configVersionNumber: configuration.version,
    configuration: {
      adapterKey: configuration.adapterKey,
      settings: { platform: "clutchpacks" },
    },
    expiresAt: input.expiresAt ?? null,
    scheduleSeconds: 300,
    nextDueAt: null,
    synchronizedAt: new Date(),
  });
  assert.equal(synchronized.kind, "updated");
  return configuration;
}

async function startAttempt(
  harness: ProviderHarness,
  configuration: SynchronizedConfiguration,
  workerId: string,
): Promise<Readonly<{ runId: string; fence: bigint }>> {
  const leases = new PrismaProviderWorkerLeaseRepository(harness.client);
  const acquired = await leases.acquire({
    role: "import",
    owner: workerId,
    leaseMilliseconds: 30_000,
  });
  if (acquired.kind === "held") {
    throw new Error("The isolated provider import lease is unexpectedly held.");
  }
  const runId = randomUUID();
  const started = await new PrismaProviderRunRepository(harness.client).start({
    runId,
    idempotencyKey: `recovery-test/${runId}`,
    trigger: "scheduled",
    requestedByOperatorId: null,
    configVersionId: configuration.id,
    configVersionNumber: configuration.version,
    workerId,
    workerFence: acquired.lease.fence,
    correlationId: randomUUID(),
    requestedAt: new Date(),
  });
  assert.equal(started.kind, "started");
  return { runId, fence: acquired.lease.fence };
}

async function takeOverLease(
  harness: ProviderHarness,
  prior: Readonly<{ workerId: string; fence: bigint }>,
  nextWorkerId: string,
): Promise<bigint> {
  const leases = new PrismaProviderWorkerLeaseRepository(harness.client);
  assert.equal(await leases.release({
    role: "import",
    owner: prior.workerId,
    fence: prior.fence,
  }), true);
  const acquired = await leases.acquire({
    role: "import",
    owner: nextWorkerId,
    leaseMilliseconds: 30_000,
  });
  if (acquired.kind === "held") {
    throw new Error("The released provider import lease was not claimable.");
  }
  assert.ok(acquired.lease.fence > prior.fence);
  return acquired.lease.fence;
}

function emptyHeadSource(input: Readonly<{
  onNextPage?: () => void;
}> = {}): ProviderManualImportPageSource {
  return {
    supports(adapterKey) {
      return adapterKey === supportedAdapterKey;
    },
    nextPage(request) {
      input.onNextPage?.();
      const body = {
        contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        providerId: request.authority.providerId,
        runId: request.runId,
        configVersionId: request.authority.configVersionId,
        configVersionNumber: request.authority.configVersionNumber.toString(),
        leaseFence: request.workerFence.toString(),
        pageId: randomUUID(),
        pageNumber: request.pageNumber,
        inputCursor: request.sourceCheckpoint,
        inputCursorFingerprint: request.sourceCheckpointFingerprint,
        nextCursor: null,
        nextCursorFingerprint: null,
        continuation: "head",
        records: [],
      };
      return Promise.resolve({
        ...body,
        responseDigest: providerMixedPageDigest(body),
      });
    },
  };
}

async function commitCleanupContinuation(
  harness: ProviderHarness,
  input: Readonly<{ runId: string; workerId: string; fence: bigint }>,
): Promise<Readonly<{ checkpoint: { cursor: string }; checkpointHash: string }>> {
  const checkpoint = { cursor: "cleanup-checkpoint" };
  const checkpointHash = "c".repeat(64);
  const committed = await new PrismaProviderRunRepository(
    harness.client,
  ).commitPage({
    pageId: randomUUID(),
    runId: input.runId,
    workerId: input.workerId,
    workerFence: input.fence,
    contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
    requestedCursor: null,
    requestedCursorHash: null,
    nextCursor: checkpoint,
    nextCursorHash: checkpointHash,
    continuation: "more",
    responseDigest: "d".repeat(64),
    counts: {
      records: 0,
      catalog: 0,
      pulls: 0,
      marketEvents: 0,
      accepted: 0,
      duplicate: 0,
      quarantined: 0,
      materialChanges: 0,
    },
    committedAt: new Date(),
  });
  assert.equal(committed.kind, "committed");
  return { checkpoint, checkpointHash };
}

for (const failureCode of [
  "PROVIDER_IMPORT_AUTHORITY_EXPIRED",
  "PROVIDER_CAPTURE_ABORTED",
  "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED",
] as const) {
  test(`owned progress cleanup preserves the checkpoint for ${failureCode}`, async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    const harness = await createHarness();
    try {
      const configuration = await synchronizeConfiguration(harness);
      const workerId = "integration:owned-progress-cleanup";
      const active = await startAttempt(harness, configuration, workerId);
      const { checkpoint, checkpointHash } = await commitCleanupContinuation(
        harness,
        { ...active, workerId },
      );
      let sourceRequests = 0;
      const executor = new ProviderManualImportExecutor({
        database: harness.client,
        source: emptyHeadSource({
          onNextPage: () => { sourceRequests += 1; },
        }),
        workerId,
        leaseMilliseconds: 30_000,
      });
      assert.deepEqual(await executor.terminalizeProgress({
        progress: { kind: "progress", runId: active.runId, pageCount: 1 },
        failureCode,
      }), { kind: "failed", runId: active.runId, failureCode });
      assert.equal(sourceRequests, 0);
      assert.equal(await harness.client.provider_runs.count(), 1);
      assert.equal(await harness.client.provider_run_pages.count(), 1);
      assert.deepEqual(await harness.client.provider_runs.findUniqueOrThrow({
        where: { id: active.runId },
        select: {
          state: true,
          worker_fence: true,
          page_count: true,
          final_cursor: true,
          final_cursor_hash: true,
          failure_code: true,
        },
      }), {
        state: "failed",
        worker_fence: active.fence,
        page_count: 1,
        final_cursor: checkpoint,
        final_cursor_hash: checkpointHash,
        failure_code: failureCode,
      });
      assert.deepEqual(await harness.client.provider_runtime.findUniqueOrThrow({
        where: { singleton_key: true },
        select: {
          operating_state: true,
          source_cursor: true,
          source_cursor_hash: true,
        },
      }), {
        operating_state: "error",
        source_cursor: checkpoint,
        source_cursor_hash: checkpointHash,
      });
      assert.deepEqual(await harness.client.provider_worker_states
        .findUniqueOrThrow({
          where: { worker_role: "import" },
          select: { lease_owner: true, lease_fence: true },
        }), { lease_owner: null, lease_fence: active.fence });
    } finally {
      await harness.close();
    }
  });
}

test("progress cleanup cannot release a contended successor or terminalize an old run", async (context) => {
  if (!integrationEnabled()) {
    context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
    return;
  }
  const harness = await createHarness();
  try {
    const configuration = await synchronizeConfiguration(harness);
    const workerId = "integration:stale-progress-cleanup";
    const successorWorkerId = "integration:successor-progress-cleanup";
    const active = await startAttempt(harness, configuration, workerId);
    await commitCleanupContinuation(harness, { ...active, workerId });
    let sourceRequests = 0;
    const executor = new ProviderManualImportExecutor({
      database: harness.client,
      source: emptyHeadSource({
        onNextPage: () => { sourceRequests += 1; },
      }),
      workerId,
      leaseMilliseconds: 30_000,
    });
    const progress = { kind: "progress", runId: active.runId, pageCount: 1 } as const;
    const successorFence = await takeOverLease(
      harness,
      { workerId, fence: active.fence },
      successorWorkerId,
    );
    assert.deepEqual(await executor.terminalizeProgress({
      progress,
      failureCode: "PROVIDER_CAPTURE_ABORTED",
    }), {
      kind: "blocked",
      runId: active.runId,
      failureCode: "PROVIDER_IMPORT_LEASE_LOST",
    });
    assert.deepEqual(await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: active.runId },
      select: { state: true, failure_code: true },
    }), { state: "running", failure_code: null });
    const recoveryRunId = randomUUID();
    assert.equal((await new PrismaProviderRunRepository(harness.client)
      .recoverActive({
        recoveryRunId,
        workerId: successorWorkerId,
        workerFence: successorFence,
        correlationId: randomUUID(),
      })).kind, "recovered");
    const oldRunBefore = await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: active.runId },
    });
    const successorBefore = await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: recoveryRunId },
    });
    const leaseBefore = await harness.client.provider_worker_states.findUniqueOrThrow({
      where: { worker_role: "import" },
    });
    assert.deepEqual(await executor.terminalizeProgress({
      progress,
      failureCode: "PROVIDER_IMPORT_AUTHORITY_EXPIRED",
    }), {
      kind: "blocked",
      runId: active.runId,
      failureCode: "PROVIDER_IMPORT_LEASE_LOST",
    });
    assert.equal(sourceRequests, 0);
    assert.deepEqual(await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: active.runId },
    }), oldRunBefore);
    assert.deepEqual(await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: recoveryRunId },
    }), successorBefore);
    assert.deepEqual(await harness.client.provider_worker_states.findUniqueOrThrow({
      where: { worker_role: "import" },
    }), leaseBefore);
    assert.equal(leaseBefore.lease_owner, successorWorkerId);
    assert.equal(leaseBefore.lease_fence, successorFence);
  } finally {
    await harness.close();
  }
});

test(
  "the current import fence resumes the same run from the runtime checkpoint",
  { concurrency: false },
  async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    const harness = await createHarness();
    try {
      const configuration = await synchronizeConfiguration(harness);
      const workerId = "integration:same-fence-resume";
      const active = await startAttempt(harness, configuration, workerId);
      const checkpoint = { cursor: "same-fence-checkpoint" };
      const checkpointHash = "a".repeat(64);
      const runs = new PrismaProviderRunRepository(harness.client);
      assert.equal((await runs.commitPage({
        pageId: randomUUID(),
        runId: active.runId,
        workerId,
        workerFence: active.fence,
        contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        requestedCursor: null,
        requestedCursorHash: null,
        nextCursor: checkpoint,
        nextCursorHash: checkpointHash,
        continuation: "more",
        responseDigest: "b".repeat(64),
        counts: {
          records: 0,
          catalog: 0,
          pulls: 0,
          marketEvents: 0,
          accepted: 0,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 0,
        },
        committedAt: new Date(),
      })).kind, "committed");
      const resumed = await runs.recoverActive({
        recoveryRunId: randomUUID(),
        workerId,
        workerFence: active.fence,
        correlationId: randomUUID(),
      });
      assert.equal(resumed.kind, "resumed");
      if (resumed.kind !== "resumed") {
        throw new Error("The current-fence provider run was not resumed.");
      }
      assert.equal(resumed.run.id, active.runId);
      assert.deepEqual(resumed.checkpoint, checkpoint);
      assert.equal(resumed.checkpointFingerprint, checkpointHash);
      assert.equal(await harness.client.provider_runs.count(), 1);
      assert.equal(await harness.client.provider_runs.count({
        where: { recovery_of_run_id: active.runId },
      }), 0);
    } finally {
      await harness.close();
    }
  },
);

test(
  "a new import fence recovers from the last committed runtime cursor",
  { concurrency: false },
  async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    const harness = await createHarness();
    try {
      const configuration = await synchronizeConfiguration(harness);
      const priorWorkerId = "integration:recovery-prior";
      const prior = await startAttempt(
        harness,
        configuration,
        priorWorkerId,
      );
      const committedCursor = { cursor: "committed-page-1" };
      const committedCursorHash = "b".repeat(64);
      const runs = new PrismaProviderRunRepository(harness.client);
      const page = await runs.commitPage({
        pageId: randomUUID(),
        runId: prior.runId,
        workerId: priorWorkerId,
        workerFence: prior.fence,
        contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        requestedCursor: null,
        requestedCursorHash: null,
        nextCursor: committedCursor,
        nextCursorHash: committedCursorHash,
        continuation: "more",
        responseDigest: "c".repeat(64),
        counts: {
          records: 0,
          catalog: 0,
          pulls: 0,
          marketEvents: 0,
          accepted: 0,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 0,
        },
        committedAt: new Date(),
      });
      assert.equal(page.kind, "committed");

      const recoveryWorkerId = "integration:recovery-next";
      const recoveryFence = await takeOverLease(
        harness,
        { workerId: priorWorkerId, fence: prior.fence },
        recoveryWorkerId,
      );
      const recovered = await runs.recoverActive({
        recoveryRunId: randomUUID(),
        workerId: recoveryWorkerId,
        workerFence: recoveryFence,
        correlationId: randomUUID(),
      });
      assert.equal(recovered.kind, "recovered");
      if (recovered.kind !== "recovered") {
        throw new Error("The stale provider run was not recovered.");
      }
      assert.deepEqual(recovered.checkpoint, committedCursor);
      assert.equal(recovered.checkpointFingerprint, committedCursorHash);
      assert.equal(recovered.run.recoveryOfRunId, prior.runId);
      assert.equal(recovered.run.attemptNumber, 2);
      assert.deepEqual(
        await harness.client.provider_runs.findUniqueOrThrow({
          where: { id: prior.runId },
          select: {
            state: true,
            final_cursor: true,
            final_cursor_hash: true,
            failure_code: true,
          },
        }),
        {
          state: "incomplete",
          final_cursor: committedCursor,
          final_cursor_hash: committedCursorHash,
          failure_code: "PROVIDER_IMPORT_LEASE_EXPIRED",
        },
      );
      assert.deepEqual(
        await harness.client.provider_runs.findUniqueOrThrow({
          where: { id: recovered.run.id },
          select: {
            state: true,
            requested_cursor: true,
            requested_cursor_hash: true,
          },
        }),
        {
          state: "running",
          requested_cursor: committedCursor,
          requested_cursor_hash: committedCursorHash,
        },
      );
    } finally {
      await harness.close();
    }
  },
);

test(
  "expired or mismatched recovery authority terminalizes the old run and unblocks configuration sync",
  { concurrency: false },
  async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    for (const scenario of ["config_expired", "config_mismatch"] as const) {
      const harness = await createHarness();
      try {
        const configuration = await synchronizeConfiguration(harness);
        const priorWorkerId = `integration:${scenario}-prior`;
        const prior = await startAttempt(
          harness,
          configuration,
          priorWorkerId,
        );
        if (scenario === "config_expired") {
          await harness.client.provider_runtime.update({
            where: { singleton_key: true },
            data: {
              config_expires_at: new Date(Date.now() - 60_000),
              row_version: { increment: 1n },
            },
          });
        } else {
          await harness.client.provider_runtime.update({
            where: { singleton_key: true },
            data: {
              cached_config_version_id: randomUUID(),
              cached_config_version_number: 2n,
              cached_configuration: {
                adapterKey: supportedAdapterKey,
                settings: { platform: "clutchpacks" },
              },
              row_version: { increment: 1n },
            },
          });
        }
        const recoveryWorkerId = `integration:${scenario}-next`;
        const recoveryFence = await takeOverLease(
          harness,
          { workerId: priorWorkerId, fence: prior.fence },
          recoveryWorkerId,
        );
        const runs = new PrismaProviderRunRepository(harness.client);
        const recovered = await runs.recoverActive({
          recoveryRunId: randomUUID(),
          workerId: recoveryWorkerId,
          workerFence: recoveryFence,
          correlationId: randomUUID(),
        });
        assert.equal(recovered.kind, scenario);
        assert.equal(await runs.active(), null);
        assert.deepEqual(
          await harness.client.provider_runs.findUniqueOrThrow({
            where: { id: prior.runId },
            select: { state: true, failure_code: true },
          }),
          {
            state: "incomplete",
            failure_code: scenario === "config_expired"
              ? "PROVIDER_IMPORT_CONFIG_EXPIRED"
              : "PROVIDER_IMPORT_CONFIG_MISMATCH",
          },
        );

        const current = await new PrismaProviderRuntimeRepository(
          harness.client,
        ).snapshot();
        const next = await synchronizeConfiguration(harness, {
          id: randomUUID(),
          version: (current.cachedConfiguration?.version ?? 1n) + 1n,
        });
        const afterSync = await new PrismaProviderRuntimeRepository(
          harness.client,
        ).snapshot();
        assert.equal(afterSync.cachedConfiguration?.id, next.id);
      } finally {
        await harness.close();
      }
    }
  },
);

test(
  "an unsupported adapter cannot leave a stale active run wedged",
  { concurrency: false },
  async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    const harness = await createHarness();
    try {
      const configuration = await synchronizeConfiguration(harness, {
        adapterKey: "unsupported-recovery-adapter-v1",
      });
      const priorWorkerId = "integration:unsupported-prior";
      const prior = await startAttempt(
        harness,
        configuration,
        priorWorkerId,
      );
      assert.equal(await new PrismaProviderWorkerLeaseRepository(
        harness.client,
      ).release({
        role: "import",
        owner: priorWorkerId,
        fence: prior.fence,
      }), true);
      let pageCalls = 0;
      const result = await new ProviderManualImportExecutor({
        database: harness.client,
        source: {
          supports: () => false,
          nextPage: () => {
            pageCalls += 1;
            throw new Error("The unsupported source must not be called.");
          },
        },
        workerId: "integration:unsupported-recovery",
        leaseMilliseconds: 30_000,
      }).executeNext();
      assert.equal(result.kind, "failed");
      assert.equal(result.failureCode, "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE");
      assert.equal(pageCalls, 0);
      const runs = new PrismaProviderRunRepository(harness.client);
      assert.equal(await runs.active(), null);
      assert.deepEqual(
        await harness.client.provider_runs.findUniqueOrThrow({
          where: { id: prior.runId },
          select: { state: true, failure_code: true },
        }),
        {
          state: "incomplete",
          failure_code: "PROVIDER_IMPORT_LEASE_EXPIRED",
        },
      );
      const recovery = await harness.client.provider_runs.findFirstOrThrow({
        where: { recovery_of_run_id: prior.runId },
        select: { id: true, state: true, failure_code: true },
      });
      assert.equal(result.runId, recovery.id);
      assert.deepEqual(
        { state: recovery.state, failure_code: recovery.failure_code },
        {
          state: "failed",
          failure_code: "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
        },
      );
    } finally {
      await harness.close();
    }
  },
);

test(
  "an unsupported adapter leaves a new accepted command and import fence untouched",
  { concurrency: false },
  async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    const harness = await createHarness();
    try {
      const configuration = await synchronizeConfiguration(harness, {
        adapterKey: "unsupported-new-run-adapter-v1",
      });
      const runtime = await new PrismaProviderRuntimeRepository(
        harness.client,
      ).snapshot();
      const commandId = randomUUID();
      const queuedRunId = randomUUID();
      const queued = await new PrismaAdminProviderRuntimeRepository(
        harness.client,
      ).requestRunNow({
        providerId: harness.providerId,
        operatorId: "10000000-0000-4000-8000-000000000001",
        expectedConfigVersionId: configuration.id,
        expectedConfigVersionNumber: configuration.version,
        expectedGeneration: runtime.generation,
        idempotencyKey: `unsupported-new-run/${randomUUID()}`,
        commandId,
        runId: queuedRunId,
        correlationId: randomUUID(),
      });
      assert.equal(queued.kind, "created");
      const leaseBefore = await harness.client.provider_worker_states
        .findUniqueOrThrow({
          where: { worker_role: "import" },
          select: {
            lease_owner: true,
            lease_fence: true,
            row_version: true,
          },
        });
      let pageCalls = 0;
      const result = await new ProviderManualImportExecutor({
        database: harness.client,
        source: {
          supports: () => false,
          nextPage: () => {
            pageCalls += 1;
            throw new Error("The unsupported source must not be called.");
          },
        },
        workerId: "integration:unsupported-new-run",
        leaseMilliseconds: 30_000,
      }).executeNext();
      assert.deepEqual(result, {
        kind: "blocked",
        runId: null,
        failureCode: "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
      });
      assert.equal(pageCalls, 0);
      assert.deepEqual(
        await harness.client.provider_runs.findUniqueOrThrow({
          where: { id: queuedRunId },
          select: { state: true, worker_fence: true },
        }),
        { state: "queued", worker_fence: 0n },
      );
      assert.deepEqual(
        await harness.client.control_commands.findUniqueOrThrow({
          where: { id: commandId },
          select: { state: true, resulting_run_id: true },
        }),
        { state: "accepted", resulting_run_id: queuedRunId },
      );
      assert.deepEqual(
        await harness.client.provider_worker_states.findUniqueOrThrow({
          where: { worker_role: "import" },
          select: {
            lease_owner: true,
            lease_fence: true,
            row_version: true,
          },
        }),
        leaseBefore,
      );
    } finally {
      await harness.close();
    }
  },
);

test(
  "a lease lost immediately before finish is returned instead of reported completed",
  { concurrency: false },
  async (context) => {
    if (!integrationEnabled()) {
      context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
      return;
    }
    const harness = await createHarness();
    try {
      const configuration = await synchronizeConfiguration(harness);
      const workerId = "integration:finish-loss";
      const active = await startAttempt(harness, configuration, workerId);
      const originalFinish = PrismaProviderRunRepository.prototype.finish;
      let finishCalls = 0;
      // Inject at the operation boundary, not at a reconciliation SQL count:
      // an empty catalog legitimately skips all unresolved-fact updates. The
      // lease takeover and the original finish transaction both use the real DB.
      context.mock.method(PrismaProviderRunRepository.prototype, "finish", async function (
        this: PrismaProviderRunRepository,
        input: Parameters<PrismaProviderRunRepository["finish"]>[0],
      ) {
        finishCalls += 1;
        assert.equal(input.runId, active.runId);
        assert.equal(input.state, "succeeded");
        assert.equal(await takeOverLease(
          harness,
          { workerId, fence: active.fence },
          "integration:finish-thief",
        ), active.fence + 1n);
        const finished = await originalFinish.call(this, input);
        assert.equal(finished.kind, "lease_lost");
        return finished;
      });
      let pageCalls = 0;
      const result = await new ProviderManualImportExecutor({
        database: harness.client,
        source: emptyHeadSource({ onNextPage: () => { pageCalls += 1; } }),
        workerId,
        leaseMilliseconds: 30_000,
      }).executeNext();
      assert.equal(finishCalls, 1);
      assert.equal(pageCalls, 1);
      assert.deepEqual(result, {
        kind: "blocked",
        runId: active.runId,
        failureCode: "PROVIDER_IMPORT_LEASE_LOST",
      });
      assert.deepEqual(
        await harness.client.provider_runs.findUniqueOrThrow({
          where: { id: active.runId },
          select: { state: true, page_count: true, reached_source_head: true },
        }),
        { state: "running", page_count: 1, reached_source_head: true },
      );
      assert.deepEqual(
        await harness.client.provider_worker_states.findUniqueOrThrow({
          where: { worker_role: "import" },
          select: { lease_owner: true, lease_fence: true },
        }),
        {
          lease_owner: "integration:finish-thief",
          lease_fence: active.fence + 1n,
        },
      );
    } finally {
      await harness.close();
    }
  },
);
