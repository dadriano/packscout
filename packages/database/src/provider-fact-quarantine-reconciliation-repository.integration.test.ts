import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PrismaClient as ProviderPrismaClient } from
  "../prisma/generated/provider/index.js";
import type { CanonicalJsonObject } from "./provider-canonical-contract.ts";
import { ProviderCanonicalRepository } from
  "./provider-canonical-repository.ts";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";
import { PrismaProviderFactQuarantineReconciliationRepository } from
  "./provider-fact-quarantine-reconciliation-repository.ts";
import { PROVIDER_MIXED_PAGE_CONTRACT_VERSION } from
  "./provider-mixed-page-contract.ts";
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
const DATABASE_PATTERN =
  /^packscout_fact_quarantine_[0-9]+_[a-f0-9]{10}$/u;
const occurredAt = "2026-08-29T12:34:56.123Z";

interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  readonly providerId: string;
  close(): Promise<void>;
}

function adminUrl(): URL {
  const value = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  const parsed = new URL(value);
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
    `fact_quarantine_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!DATABASE_PATTERN.test(databaseName)) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }
  const administrator = new Pool({ connectionString: rootUrl.toString(), max: 1 });
  const url = databaseUrl(rootUrl, databaseName);
  let created = false;
  let client: ProviderPrismaClient | undefined;
  try {
    const version = await administrator.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL 16 test infrastructure is required.");
    }
    await administrator.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: url },
      },
    );
    const providerId = randomUUID();
    client = new ProviderPrismaClient({ datasources: { db: { url } } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({ client, providerId, providerKey });
    return {
      client,
      providerId,
      async close() {
        await client?.$disconnect();
        if (created) {
          await administrator.query(`drop database "${databaseName}" with (force)`);
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

function factDigest(domain: string, body: CanonicalJsonObject): string {
  return createHash("sha256")
    .update(`packscout.${domain}.v1\u0000`, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
}

function pullBody(pullKey: string, packKey = "pack:unresolved"): CanonicalJsonObject {
  return {
    pullKey,
    packKey,
    providerAccountKey: null,
    occurredAt,
    paidAmount: null,
    paidCurrency: null,
    items: [{
      collectibleKey: "collectible:unresolved",
      collectibleInstanceKey: null,
      quantity: "1",
      statedValueAmount: "25",
      statedValueCurrency: "USD",
    }],
  };
}

function marketEventBody(eventKey: string): CanonicalJsonObject {
  return {
    eventKey,
    eventGroupId: null,
    eventType: "sale",
    packKey: null,
    collectibleKey: "collectible:unresolved",
    collectibleInstanceKey: null,
    fromProviderAccountKey: null,
    toProviderAccountKey: null,
    quantity: null,
    occurredAt,
    amount: "25",
    currency: "USD",
    details: {},
  };
}

function withDigest(
  domain: "provider-pull-fact" | "provider-market-event-fact",
  body: CanonicalJsonObject,
): CanonicalJsonObject {
  return { ...body, factDigest: factDigest(domain, body) };
}

test("source-head fact reconciliation resolves exact retained facts and leaves false matches untouched", async () => {
  const harness = await createHarness();
  try {
    const workerId = `worker:fact-quarantine:${process.pid}`;
    const leaseResult = await new PrismaProviderWorkerLeaseRepository(
      harness.client,
    ).acquire({
      role: "import",
      owner: workerId,
      leaseMilliseconds: 120_000,
    });
    assert.notEqual(leaseResult.kind, "held");
    if (leaseResult.kind === "held") return;
    const fence = leaseResult.lease.fence;
    const now = new Date();
    const originRunId = randomUUID();
    const originPageId = randomUUID();
    const sourceHeadRunId = randomUUID();
    const sourceHeadPageId = randomUUID();
    const configVersionId = randomUUID();

    await harness.client.$transaction(async (transaction) => {
      await transaction.provider_state_events.create({
        data: {
          from_state: "idle",
          to_state: "running",
          state_generation: 1n,
          reason: null,
          actor_type: "runner",
          actor_id: workerId,
          correlation_id: randomUUID(),
          occurred_at: now,
        },
      });
      await transaction.provider_runtime.update({
        where: { singleton_key: true },
        data: {
          operating_state: "running",
          state_generation: 1n,
          cached_config_version_id: configVersionId,
          cached_config_version_number: 2n,
          cached_configuration: { adapterKey: "synthetic-quarantine" },
          last_control_sync_at: now,
          schedule_seconds: 300,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_runs.create({
        data: {
          id: originRunId,
          idempotency_key: `origin-${originRunId}`,
          trigger: "manual",
          state: "running",
          config_version_id: configVersionId,
          config_version_number: 1n,
          worker_fence: fence,
          requested_at: now,
          started_at: now,
          heartbeat_at: now,
          last_progress_at: now,
          reached_source_head: true,
          page_count: 1,
          pull_record_count: 4,
          market_event_record_count: 3,
          quarantined_count: 7,
        },
      });
      await transaction.provider_run_pages.create({
        data: {
          id: originPageId,
          provider_run_id: originRunId,
          page_number: 1,
          contract_version: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
          continuation: "head",
          response_digest: "a".repeat(64),
          record_count: 7,
          catalog_record_count: 0,
          pull_record_count: 4,
          market_event_record_count: 3,
          accepted_count: 0,
          duplicate_count: 0,
          quarantined_count: 7,
          material_change_count: 0,
          committed_at: now,
        },
      });
      await transaction.provider_runs.update({
        where: { id: originRunId },
        data: {
          state: "failed",
          failure_code: "HISTORICAL_RELATIONSHIP_MISSING",
          failure_class: "canonical",
          failure_summary: "Historical relationship facts preceded their catalog rows.",
          finished_at: now,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_runs.create({
        data: {
          id: sourceHeadRunId,
          idempotency_key: `source-head-${sourceHeadRunId}`,
          trigger: "manual",
          state: "running",
          config_version_id: configVersionId,
          config_version_number: 2n,
          worker_fence: fence,
          requested_at: now,
          started_at: now,
          heartbeat_at: now,
          last_progress_at: now,
          reached_source_head: true,
          page_count: 1,
        },
      });
      await transaction.provider_run_pages.create({
        data: {
          id: sourceHeadPageId,
          provider_run_id: sourceHeadRunId,
          page_number: 1,
          contract_version: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
          continuation: "head",
          response_digest: "b".repeat(64),
          record_count: 0,
          catalog_record_count: 0,
          pull_record_count: 0,
          market_event_record_count: 0,
          accepted_count: 0,
          duplicate_count: 0,
          quarantined_count: 0,
          material_change_count: 0,
          committed_at: now,
        },
      });
    });

    const exactPullBody = pullBody("pull:exact");
    const exactPull = withDigest("provider-pull-fact", exactPullBody);
    const exactEventBody = marketEventBody("event:exact");
    const exactEvent = withDigest("provider-market-event-fact", exactEventBody);
    const canonical = new ProviderCanonicalRepository(harness.client);
    await canonical.insertPull({
      pullKey: "pull:exact",
      factDigest: exactPull.factDigest as string,
      packKey: "pack:unresolved",
      packId: null,
      providerAccountId: null,
      occurredAt: new Date(occurredAt),
      paidAmount: null,
      paidCurrency: null,
      items: [{
        collectibleKey: "collectible:unresolved",
        collectibleId: null,
        collectibleInstanceId: null,
        quantity: 1n,
        statedValueAmount: "25",
        statedValueCurrency: "USD",
      }],
    });
    await canonical.insertMarketEvent({
      eventKey: "event:exact",
      factDigest: exactEvent.factDigest as string,
      eventGroupId: null,
      eventType: "sale",
      packKey: null,
      packId: null,
      collectibleKey: "collectible:unresolved",
      collectibleId: null,
      collectibleInstanceId: null,
      fromProviderAccountId: null,
      toProviderAccountId: null,
      quantity: null,
      occurredAt: new Date(occurredAt),
      amount: "25",
      currency: "USD",
      details: {},
    });

    const ids = {
      exactPull: randomUUID(),
      bodyMismatch: randomUUID(),
      exactEvent: randomUUID(),
      keyMismatch: randomUUID(),
      expired: randomUUID(),
      sourceRejected: randomUUID(),
      runningAttempt: randomUUID(),
    };
    const oldCreatedAt = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 86_400_000);
    const past = new Date(now.getTime() - 1_000);
    const bodyMismatch = {
      ...pullBody("pull:exact", "pack:different"),
      factDigest: exactPull.factDigest,
    };
    const quarantines = [
      { id: ids.exactPull, kind: "pull", key: "pull:exact", candidate: exactPull, expires: future, source: null },
      { id: ids.bodyMismatch, kind: "pull", key: "pull:exact", candidate: bodyMismatch, expires: future, source: null },
      { id: ids.exactEvent, kind: "market_event", key: "event:exact", candidate: exactEvent, expires: future, source: null },
      { id: ids.keyMismatch, kind: "market_event", key: "event:different", candidate: exactEvent, expires: future, source: null },
      { id: ids.expired, kind: "pull", key: "pull:exact", candidate: exactPull, expires: past, source: null },
      { id: ids.sourceRejected, kind: "market_event", key: "event:exact", candidate: exactEvent, expires: future, source: `source:${"c".repeat(64)}` },
      { id: ids.runningAttempt, kind: "pull", key: "pull:exact", candidate: exactPull, expires: future, source: null },
    ] as const;
    await harness.client.quarantine_records.createMany({
      data: quarantines.map((quarantine, recordIndex) => ({
        id: quarantine.id,
        provider_run_id: originRunId,
        provider_run_page_id: originPageId,
        record_index: recordIndex,
        record_kind: quarantine.kind,
        entity_key: quarantine.key,
        source_record_key: quarantine.source,
        reason_code: "RELATIONSHIP_NOT_FOUND",
        sanitized_summary: "A historical relationship was unavailable.",
        candidate_schema_version: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        normalized_candidate: quarantine.candidate,
        evidence_expires_at: quarantine.expires,
        created_at: oldCreatedAt,
        updated_at: oldCreatedAt,
      })),
    });
    await harness.client.quarantine_attempts.create({
      data: {
        quarantine_record_id: ids.runningAttempt,
        requested_by_operator_id: randomUUID(),
        correlation_id: randomUUID(),
        state: "running",
        started_at: now,
      },
    });

    const runBefore = await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: originRunId },
    });
    const pageBefore = await harness.client.provider_run_pages.findUniqueOrThrow({
      where: { id: originPageId },
    });
    const runtimeBefore = await harness.client.provider_runtime.findUniqueOrThrow({
      where: { singleton_key: true },
    });
    const repository = new PrismaProviderFactQuarantineReconciliationRepository(
      harness.client,
    );
    assert.deepEqual(await repository.reconcileBatch({
      runId: originRunId,
      workerId,
      workerFence: fence,
      limit: 2,
    }), { kind: "run_not_ready" });
    assert.deepEqual(await repository.reconcileBatch({
      runId: sourceHeadRunId,
      workerId,
      workerFence: fence + 1n,
      limit: 2,
    }), { kind: "lease_lost" });

    let cursor;
    let resolvedCount = 0;
    do {
      const result = await repository.reconcileBatch({
        runId: sourceHeadRunId,
        workerId,
        workerFence: fence,
        limit: 2,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      assert.equal(result.kind, "reconciled");
      if (result.kind !== "reconciled") return;
      assert.ok(result.scannedCount <= 2);
      resolvedCount += result.resolvedCount;
      cursor = result.nextScanCursor ?? undefined;
    } while (cursor !== undefined);
    assert.equal(resolvedCount, 2);

    const states = new Map((await harness.client.quarantine_records.findMany({
      select: {
        id: true,
        state: true,
        resolved_at: true,
        row_version: true,
        updated_at: true,
      },
    })).map((row) => [row.id, row]));
    for (const id of [ids.exactPull, ids.exactEvent]) {
      assert.equal(states.get(id)?.state, "resolved");
      assert.ok(states.get(id)?.resolved_at);
      assert.equal(states.get(id)?.row_version, 2n);
      assert.ok((states.get(id)?.updated_at.getTime() ?? 0) > oldCreatedAt.getTime());
    }
    for (const id of [
      ids.bodyMismatch,
      ids.keyMismatch,
      ids.expired,
      ids.sourceRejected,
      ids.runningAttempt,
    ]) {
      assert.equal(states.get(id)?.state, "open");
      assert.equal(states.get(id)?.resolved_at, null);
      assert.equal(states.get(id)?.row_version, 1n);
    }
    assert.equal(await harness.client.local_audit_events.count({
      where: { action: "provider.quarantine.fact_reconciled" },
    }), 2);
    assert.equal(await harness.client.provider_activity_outbox.count({
      where: { event_type: "provider.quarantine.resolved" },
    }), 2);
    assert.deepEqual(
      await harness.client.provider_runs.findUniqueOrThrow({
        where: { id: originRunId },
      }),
      runBefore,
    );
    assert.deepEqual(
      await harness.client.provider_run_pages.findUniqueOrThrow({
        where: { id: originPageId },
      }),
      pageBefore,
    );
    assert.deepEqual(
      await harness.client.provider_runtime.findUniqueOrThrow({
        where: { singleton_key: true },
      }),
      runtimeBefore,
    );

    cursor = undefined;
    let replayResolved = 0;
    do {
      const replay = await repository.reconcileBatch({
        runId: sourceHeadRunId,
        workerId,
        workerFence: fence,
        limit: 2,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      assert.equal(replay.kind, "reconciled");
      if (replay.kind !== "reconciled") return;
      replayResolved += replay.resolvedCount;
      cursor = replay.nextScanCursor ?? undefined;
    } while (cursor !== undefined);
    assert.equal(replayResolved, 0);
    assert.equal(await harness.client.local_audit_events.count({
      where: { action: "provider.quarantine.fact_reconciled" },
    }), 2);
    assert.equal(await harness.client.provider_activity_outbox.count({
      where: { event_type: "provider.quarantine.resolved" },
    }), 2);
  } finally {
    await harness.close();
  }
});
