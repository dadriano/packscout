import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { tsImport } from "tsx/esm/api";

export const databaseModule = await tsImport("@packscout/database", import.meta.url);
export const plan = await tsImport("./collector-reconciliation-retry-plan.mts", import.meta.url);
export const control = await tsImport("./collector-reconciliation-retry-control.mts", import.meta.url);
export const policy = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
const execFileAsync = promisify(execFile);
const p = plan.collectorRepair;
export const operatorId = "22222222-2222-4222-8222-222222222222";
const finalCursor = {
  sourceInstanceId: p.providerId, sourceRevisionId: p.configId, sourceTypeKey: "dataforrest-events-v1",
  adapterVersion: "dataforrest-collector-crypt-distributed-adapter-v1", cursorCodecKey: "dataforrest-cursor-v1",
  cursorGeneration: 1, value: "synthetic-only-collector-repair-final-cursor",
};
const cursorAt = (page) => page === 387 ? finalCursor : { ...finalCursor, value: `synthetic-only-page-${page}` };
export const authority = {
  digest: "a".repeat(64), operatorId, configNumber: 3n,
  route: { organizationId: p.organizationId, configVersionId: p.configId,
    target: { providerId: p.providerId, providerKey: p.providerKey, databaseName: "packscout_collector_crypt" } },
  cachedConfiguration: { adapterKey: finalCursor.adapterVersion, settings: { platform: p.providerKey } },
  expiresAt: null, scheduleSeconds: 300,
};

/** The production pin is intentionally fixed. Only this synthetic cursor's JS
 * fingerprint is mapped to that pin; no real cursor is read or copied. All SQL,
 * constraints, transactions, repositories, receipt and command writes are real. */
export function installSyntheticCheckpointHash(t) {
  const original = crypto.createHash;
  const exact = databaseModule.providerMixedPageCanonicalBytes(finalCursor);
  t.mock.method(crypto, "createHash", (...args) => {
    const hash = original(...args), chunks = [], update = hash.update.bind(hash), digest = hash.digest.bind(hash);
    hash.update = (value, ...rest) => { chunks.push(Buffer.from(value)); update(value, ...rest); return hash; };
    hash.digest = (...args) => args[0] === "hex" && Buffer.concat(chunks).equals(exact) ? p.cursorHash : digest(...args);
    return hash;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

async function seedTerminalAttempt(client) {
  const { PrismaProviderRuntimeRepository, PrismaProviderWorkerLeaseRepository,
    lockProviderWorkerLease, setProviderImportLeaseContext, providerMixedCursorFingerprint } = databaseModule;
  const runtime = new PrismaProviderRuntimeRepository(client);
  await runtime.synchronizeConfiguration({
    centralProviderId: p.providerId, providerKey: p.providerKey, configVersionId: p.configId,
    configVersionNumber: 3n, configuration: authority.cachedConfiguration, expiresAt: null,
    scheduleSeconds: 300, nextDueAt: null, synchronizedAt: new Date(),
  });
  // Reach the reviewed generation through legal transitions, never disabling a
  // trigger or overwriting a generation. The seed has no source/API activity.
  for (let generation = 0; generation < 22; generation++) {
    const paused = generation % 2 === 0;
    assert.equal((await runtime.transition({
      expectedGeneration: BigInt(generation), to: paused ? "paused" : "idle",
      reason: paused ? "synthetic fixture preparation" : null,
      actorType: "operator", actorId: operatorId, actorOperatorId: operatorId,
      correlationId: crypto.randomUUID(), occurredAt: new Date(),
    })).kind, "transitioned");
  }
  const worker = "test:collector-repair-parent";
  const leases = new PrismaProviderWorkerLeaseRepository(client);
  for (let fence = 1; fence <= 9; fence++) {
    const acquired = await leases.acquire({ role: "import", owner: worker, leaseMilliseconds: 300_000 });
    assert.notEqual(acquired.kind, "held");
    assert.equal(acquired.lease.fence, BigInt(fence));
    if (fence < 9) await leases.release({ role: "import", owner: worker, fence: acquired.lease.fence });
  }
  const withFence = (work) => client.$transaction(async (tx) => {
    const lease = await lockProviderWorkerLease(tx, "import");
    assert.equal(lease.lease_owner, worker);
    assert.equal(lease.lease_fence, 9n);
    await setProviderImportLeaseContext(tx, { owner: worker, fence: 9n });
    return work(tx);
  }, { maxWait: 5000, timeout: 15000 });
  const startedAt = new Date("2026-08-30T10:10:17.587Z");
  const requested = cursorAt(0), requestedHash = providerMixedCursorFingerprint(requested);
  await withFence(async (tx) => {
    await tx.provider_state_events.create({ data: {
      from_state: "idle", to_state: "running", state_generation: 23n, reason: null,
      actor_type: "runner", actor_id: worker, correlation_id: crypto.randomUUID(), occurred_at: startedAt,
    } });
    await tx.provider_runtime.update({ where: { singleton_key: true }, data: {
      operating_state: "running", state_generation: 23n, state_reason: null,
      source_cursor: requested, source_cursor_hash: requestedHash, row_version: { increment: 1 },
    } });
    await tx.provider_runs.create({ data: {
      id: p.parentRunId, idempotency_key: "synthetic-reviewed-parent", trigger: "manual", state: "running",
      requested_by_operator_id: operatorId, config_version_id: p.configId, config_version_number: 3n,
      worker_fence: 9n, requested_cursor: requested, requested_cursor_hash: requestedHash,
      requested_at: startedAt, started_at: startedAt,
    } });
  });
  for (let page = 1; page <= 387; page++) {
    const requestedCursor = cursorAt(page - 1), nextCursor = cursorAt(page);
    const committedAt = new Date(Date.parse("2026-08-30T12:22:31.817Z") - (387 - page) * 1000);
    await withFence(async (tx) => {
      await tx.provider_runtime.update({ where: { singleton_key: true }, data: {
        source_cursor: nextCursor, source_cursor_hash: providerMixedCursorFingerprint(nextCursor), row_version: { increment: 1 },
      } });
      await tx.provider_runs.update({ where: { id: p.parentRunId }, data: {
        page_count: { increment: 1 }, pull_record_count: { increment: 1000 }, accepted_count: { increment: 1000 },
        heartbeat_at: committedAt, last_progress_at: committedAt, row_version: { increment: 1 },
      } });
      await tx.provider_run_pages.create({ data: {
        id: plan.collectorRepairId(`fixture-page/${page}`), provider_run_id: p.parentRunId, page_number: page,
        contract_version: databaseModule.PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        requested_cursor: requestedCursor, requested_cursor_hash: providerMixedCursorFingerprint(requestedCursor),
        next_cursor: nextCursor, next_cursor_hash: providerMixedCursorFingerprint(nextCursor), continuation: "more",
        response_digest: policy.backfillDigest(["synthetic-page", page]), record_count: 1000,
        catalog_record_count: 0, pull_record_count: 1000, market_event_record_count: 0,
        accepted_count: 1000, duplicate_count: 0, quarantined_count: 0, material_change_count: 0,
        committed_at: committedAt,
      } });
    });
  }
  await withFence(async (tx) => {
    await tx.provider_state_events.create({ data: {
      from_state: "running", to_state: "error", state_generation: 24n, reason: p.failureCode,
      actor_type: "runner", actor_id: worker, correlation_id: crypto.randomUUID(), occurred_at: new Date(p.finishedAt),
    } });
    await tx.provider_runtime.update({ where: { singleton_key: true }, data: {
      operating_state: "error", state_generation: 24n, state_reason: p.failureCode, latest_failure_code: p.failureCode,
      row_version: { increment: 1 },
    } });
    await tx.provider_runs.update({ where: { id: p.parentRunId }, data: {
      state: "failed", final_cursor: finalCursor, final_cursor_hash: p.cursorHash, failure_code: p.failureCode,
      failure_class: "worker", failure_summary: "Synthetic unknown original exception.", finished_at: new Date(p.finishedAt),
      row_version: { increment: 1 },
    } });
  });
  await leases.release({ role: "import", owner: worker, fence: 9n });
}

export async function createCollectorRepairHarness() {
  const bin = process.env.PACKSCOUT_TEST_POSTGRES_BIN_DIRECTORY;
  if (!bin) throw new Error("An explicit PostgreSQL binary directory is required for this isolated test.");
  await Promise.all([access(join(bin, "initdb")), access(join(bin, "pg_ctl"))]);
  const directory = await mkdtemp("/tmp/packscout-collector-repair-test-");
  const data = join(directory, "data"), pgCtl = join(bin, "pg_ctl");
  let started = false, client, admin;
  async function close() {
    await client?.$disconnect(); await admin?.end();
    if (started) { await execFileAsync(pgCtl, ["stop", "-D", data, "-m", "fast", "-w", "-t", "15"]); started = false; }
    if (!directory.startsWith("/tmp/packscout-collector-repair-test-")) throw new Error("Unsafe test cleanup target.");
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await execFileAsync(join(bin, "initdb"), ["-D", data, "-A", "trust", "-U", "packscout_repair_test", "--no-locale", "-E", "UTF8"]);
    await execFileAsync(pgCtl, ["start", "-D", data, "-l", join(directory, "postgres.log"), "-w", "-t", "15",
      "-o", `-F -k ${directory} -c listen_addresses='' -c unix_socket_permissions=0700`]);
    started = true;
    admin = new Pool({ host: directory, user: "packscout_repair_test", database: "postgres", port: 5432, max: 1 });
    await admin.query('create database "packscout_collector_crypt"');
    const url = new URL("postgresql://packscout_repair_test@localhost:5432/packscout_collector_crypt");
    url.searchParams.set("host", directory);
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)),
      "migrate", "deploy", "--schema", fileURLToPath(new URL("../../packages/database/prisma/provider/schema.prisma", import.meta.url)),
    ], { env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: url.toString() } });
    client = databaseModule.createProviderDatabaseLifecycle({
      databaseUrl: url.toString(), providerId: p.providerId, providerKey: p.providerKey, connectionLimit: 1,
    }).client;
    await databaseModule.initializeProviderDatabaseIdentity({ client, providerId: p.providerId, providerKey: p.providerKey });
    await seedTerminalAttempt(client);
    return { client, close, createClient: () => databaseModule.createProviderDatabaseLifecycle({
      databaseUrl: url.toString(), providerId: p.providerId, providerKey: p.providerKey, connectionLimit: 1,
    }).client };
  } catch (error) { await close(); throw error; }
}
