import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PrismaClient as ProviderPrismaClient } from
  "../prisma/generated/provider/index.js";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";
import { PrismaProviderSourceRequestAuditRepository } from
  "./provider-source-request-audit-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from
  "./provider-worker-lease-repository.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const providerSchemaPath = fileURLToPath(
  new URL("../prisma/provider/schema.prisma", import.meta.url),
);
const prismaExecutable = fileURLToPath(
  new URL("../../../node_modules/prisma/build/index.js", import.meta.url),
);
const providerDatabasePattern =
  /^packscout_request_audit_[0-9]+_[a-f0-9]{10}$/u;

interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  close(): Promise<void>;
}

function resolveAdminUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  const fallback =
    `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  const parsed = new URL(configured ?? fallback);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  return parsed;
}

function databaseUrl(adminUrl: URL, databaseName: string): string {
  const result = new URL(adminUrl);
  result.pathname = `/${databaseName}`;
  const socketHost = result.searchParams.get("host");
  result.search = "";
  if (socketHost?.startsWith("/")) result.searchParams.set("host", socketHost);
  result.hash = "";
  return result.toString();
}

async function createProviderHarness(): Promise<ProviderHarness> {
  const adminUrl = resolveAdminUrl();
  const providerKey =
    `request_audit_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!providerDatabasePattern.test(databaseName)) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const url = databaseUrl(adminUrl, databaseName);
  let created = false;
  let client: ProviderPrismaClient | undefined;
  try {
    const version = await admin.query<{ server_version_num: string }>(
      "show server_version_num",
    );
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
        env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: url },
      },
    );
    client = new ProviderPrismaClient({ datasources: { db: { url } } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({
      client,
      providerId: randomUUID(),
      providerKey,
    });
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    if (created) {
      await admin.query(
        `drop database "${databaseName}" with (force)`,
      ).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    client,
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

test("request and page translation audits require the exact live import lease and running run", async () => {
  const harness = await createProviderHarness();
  try {
    const workerLeases = new PrismaProviderWorkerLeaseRepository(
      harness.client,
    );
    const requestAudits = new PrismaProviderSourceRequestAuditRepository(
      harness.client,
    );
    const firstWorkerId = "worker:request-audit:first";
    const firstLease = await workerLeases.acquire({
      role: "import",
      owner: firstWorkerId,
      leaseMilliseconds: 60_000,
    });
    assert.equal(firstLease.kind, "acquired");

    const runningRunId = randomUUID();
    const runningAt = new Date();
    await harness.client.provider_runs.create({
      data: {
        id: runningRunId,
        idempotency_key: `request-audit-running-${randomUUID()}`,
        trigger: "scheduled",
        state: "running",
        config_version_id: randomUUID(),
        config_version_number: 3n,
        worker_fence: firstLease.lease.fence,
        requested_at: runningAt,
        started_at: runningAt,
        heartbeat_at: runningAt,
        last_progress_at: runningAt,
      },
    });

    const requestAttemptId = randomUUID();
    const requestLeaseId = randomUUID();
    const recorded = await requestAudits.record({
      runId: runningRunId,
      workerId: firstWorkerId,
      workerFence: firstLease.lease.fence,
      requestAttemptId,
      requestLeaseId,
      pageNumber: 4,
      outcome: "success",
      resultCode: "DATAFORREST_HTTP_200",
      durationMilliseconds: 321,
      responseBytes: 4_096,
    });
    assert.equal(recorded.kind, "recorded");
    if (recorded.kind !== "recorded") {
      throw new Error("Source request audit was not recorded.");
    }

    const audit = await harness.client.local_audit_events.findUniqueOrThrow({
      where: { sequence: 1n },
      select: {
        command_id: true,
        actor_operator_id: true,
        correlation_id: true,
        action: true,
        target_type: true,
        target_id: true,
        outcome: true,
        details: true,
        occurred_at: true,
      },
    });
    assert.deepEqual(audit, {
      command_id: null,
      actor_operator_id: null,
      correlation_id: requestAttemptId,
      action: "provider.source.request.terminalized",
      target_type: "source_request_attempt",
      target_id: requestAttemptId,
      outcome: "success",
      details: {
        durationMilliseconds: 321,
        leaseFence: firstLease.lease.fence.toString(),
        pageNumber: 4,
        requestLeaseId,
        responseBytes: 4_096,
        resultCode: "DATAFORREST_HTTP_200",
        runId: runningRunId,
      },
      occurred_at: recorded.occurredAt,
    });
    assert.equal(
      /authorization|bearer|credential|cursor|payload|secret|token/iu.test(
        JSON.stringify(audit.details),
      ),
      false,
    );

    const pageAttemptId = randomUUID();
    const translated = await requestAudits.recordPageTranslation({
      runId: runningRunId,
      workerId: firstWorkerId,
      workerFence: firstLease.lease.fence,
      requestAttemptId,
      pageAttemptId,
      pageNumber: 4,
      sourceRecordCount: 2_000,
      normalizedRecordCount: 1_987,
      recordCounts: { catalogRecordCount: 1_500, collectibleRecordCount: 1_490, packContentSnapshotCount: 7,
        pullRecordCount: 400, marketEventRecordCount: 80, rejectedRecordCount: 7 },
      catalogIdentityCensus: null,
    });
    assert.equal(translated.kind, "recorded");
    if (translated.kind !== "recorded") {
      throw new Error("Source page translation audit was not recorded.");
    }
    const translationAudit = await harness.client.local_audit_events
      .findUniqueOrThrow({
        where: { sequence: 2n },
        select: {
          command_id: true,
          actor_operator_id: true,
          correlation_id: true,
          action: true,
          target_type: true,
          target_id: true,
          outcome: true,
          details: true,
          occurred_at: true,
        },
      });
    assert.deepEqual(translationAudit, {
      command_id: null,
      actor_operator_id: null,
      correlation_id: requestAttemptId,
      action: "provider.source.page.translated",
      target_type: "source_page_attempt",
      target_id: pageAttemptId,
      outcome: "success",
      details: {
        leaseFence: firstLease.lease.fence.toString(),
        normalizedRecordCount: 1_987,
        catalogRecordCount: 1_500, collectibleRecordCount: 1_490, packContentSnapshotCount: 7,
        pullRecordCount: 400, marketEventRecordCount: 80, rejectedRecordCount: 7,
        pageNumber: 4,
        runId: runningRunId,
        sourceRecordCount: 2_000,
      },
      occurred_at: translated.occurredAt,
    });
    await assert.rejects(requestAudits.recordPageTranslation({
      runId: runningRunId, workerId: firstWorkerId, workerFence: firstLease.lease.fence,
      requestAttemptId: randomUUID(), pageAttemptId: randomUUID(), pageNumber: 5,
      sourceRecordCount: 1, normalizedRecordCount: 1,
      recordCounts: { catalogRecordCount: 0, collectibleRecordCount: 0, packContentSnapshotCount: 0,
        pullRecordCount: 0, marketEventRecordCount: 0, rejectedRecordCount: 0 },
      catalogIdentityCensus: null,
    }), /counts do not match/);
    assert.equal(await harness.client.local_audit_events.count(), 2,
      "Invalid measurements must not append misleading audit evidence.");
    const census = { schemaVersion: "provider_catalog_identity_census_v1" as const,
      pageResponseDigest: "a".repeat(64), rawCardObservationCount: 1,
      rawPackObservationCount: 0, distinctCardIdentityCount: 1,
      distinctPackIdentityCount: 0, identityChainDigest: "b".repeat(64),
      pageIdentityMultisetDigest: "c".repeat(64),
      identityMultisetDigest: "c".repeat(64) };
    const catalogTranslation = { runId: runningRunId, workerId: firstWorkerId,
      workerFence: firstLease.lease.fence, requestAttemptId: randomUUID(),
      pageAttemptId: randomUUID(), pageNumber: 5, sourceRecordCount: 1,
      normalizedRecordCount: 1,
      recordCounts: { catalogRecordCount: 1, collectibleRecordCount: 1,
        packContentSnapshotCount: 0, pullRecordCount: 0,
        marketEventRecordCount: 0, rejectedRecordCount: 0 },
      catalogIdentityCensus: census };
    assert.equal((await requestAudits.recordPageTranslation(catalogTranslation)).kind, "recorded");
    assert.equal((await requestAudits.recordPageTranslation({ ...catalogTranslation,
      requestAttemptId: randomUUID(), pageAttemptId: randomUUID() })).kind, "recorded");
    assert.equal(await harness.client.local_audit_events.count(), 3,
      "An exact catalog page replay must reuse its durable translation evidence.");
    await assert.rejects(requestAudits.recordPageTranslation({ ...catalogTranslation,
      requestAttemptId: randomUUID(), pageAttemptId: randomUUID(),
      catalogIdentityCensus: { ...census, pageResponseDigest: "d".repeat(64) } }),
    /replay conflicts/);
    assert.equal(await harness.client.local_audit_events.count(), 3);
    assert.equal(
      /authorization|bearer|credential|cursor|payload|secret|token/iu.test(
        JSON.stringify(translationAudit.details),
      ),
      false,
    );

    assert.equal(await workerLeases.release({
      role: "import",
      owner: firstWorkerId,
      fence: firstLease.lease.fence,
    }), true);
    const secondWorkerId = "worker:request-audit:second";
    const secondLease = await workerLeases.acquire({
      role: "import",
      owner: secondWorkerId,
      leaseMilliseconds: 60_000,
    });
    assert.equal(secondLease.kind, "acquired");
    assert.equal(secondLease.lease.fence, firstLease.lease.fence + 1n);

    const staleFence = await requestAudits.record({
      runId: runningRunId,
      workerId: firstWorkerId,
      workerFence: firstLease.lease.fence,
      requestAttemptId: randomUUID(),
      requestLeaseId: randomUUID(),
      pageNumber: 5,
      outcome: "failure",
      resultCode: "REQUEST_FAILED",
      durationMilliseconds: 10,
      responseBytes: 0,
    });
    assert.deepEqual(staleFence, { kind: "lease_lost" });
    const staleTranslation = await requestAudits.recordPageTranslation({
      runId: runningRunId,
      workerId: firstWorkerId,
      workerFence: firstLease.lease.fence,
      requestAttemptId: randomUUID(),
      pageAttemptId: randomUUID(),
      pageNumber: 5,
      sourceRecordCount: 1,
      normalizedRecordCount: 1,
      recordCounts: { catalogRecordCount: 0, collectibleRecordCount: 0, packContentSnapshotCount: 0,
        pullRecordCount: 1, marketEventRecordCount: 0, rejectedRecordCount: 0 },
      catalogIdentityCensus: null,
    });
    assert.deepEqual(staleTranslation, { kind: "lease_lost" });

    const finishedRunId = randomUUID();
    const finishedAt = new Date();
    await harness.client.provider_runs.create({
      data: {
        id: finishedRunId,
        idempotency_key: `request-audit-finished-${randomUUID()}`,
        trigger: "scheduled",
        state: "succeeded",
        config_version_id: randomUUID(),
        config_version_number: 3n,
        worker_fence: secondLease.lease.fence,
        reached_source_head: true,
        requested_at: finishedAt,
        started_at: finishedAt,
        last_progress_at: finishedAt,
        heartbeat_at: finishedAt,
        finished_at: finishedAt,
      },
    });
    const notRunning = await requestAudits.record({
      runId: finishedRunId,
      workerId: secondWorkerId,
      workerFence: secondLease.lease.fence,
      requestAttemptId: randomUUID(),
      requestLeaseId: randomUUID(),
      pageNumber: 1,
      outcome: "success",
      resultCode: "DATAFORREST_HTTP_200",
      durationMilliseconds: 1,
      responseBytes: 1,
    });
    assert.deepEqual(notRunning, { kind: "run_not_running" });
    const terminalTranslation = await requestAudits.recordPageTranslation({
      runId: finishedRunId,
      workerId: secondWorkerId,
      workerFence: secondLease.lease.fence,
      requestAttemptId: randomUUID(),
      pageAttemptId: randomUUID(),
      pageNumber: 1,
      sourceRecordCount: 1,
      normalizedRecordCount: 1,
      recordCounts: { catalogRecordCount: 0, collectibleRecordCount: 0, packContentSnapshotCount: 0,
        pullRecordCount: 1, marketEventRecordCount: 0, rejectedRecordCount: 0 },
      catalogIdentityCensus: null,
    });
    assert.deepEqual(terminalTranslation, { kind: "run_not_running" });
    assert.equal(await harness.client.local_audit_events.count(), 3);
  } finally {
    await harness.close();
  }
});
