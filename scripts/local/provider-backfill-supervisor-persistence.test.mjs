import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const { providerDataforrestLiveIntegrationRegistry } = await tsImport("../../apps/worker/src/provider-dataforrest-live-integration.ts", import.meta.url);
const { readBackfillSnapshot, readBackfillIntent } = await tsImport("./provider-backfill-supervisor-state.mts", import.meta.url);
const { assertBackfillOperation, persistBackfillIntent, claimBackfillExecution, assertBackfillRetryPinned } =
  await tsImport("./provider-backfill-supervisor-persistence.mts", import.meta.url);
const { readBackfillView } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { recordBackfillLaunch, persistClosedBackfillRestart, readBackfillRestart } =
  await tsImport("./provider-backfill-supervisor-restart.mts", import.meta.url);
const pins = { organizationId: "6b18e44d-8dbd-4604-bbdf-4e4f84c67c11", providerId: "6b18e44d-8dbd-4604-bbdf-4e4f84c67c12",
  providerKey: "phygitals", configId: "6b18e44d-8dbd-4604-bbdf-4e4f84c67c13",
  initialRunId: "6b18e44d-8dbd-4604-bbdf-4e4f84c67c14", operationId: "6b18e44d-8dbd-4604-bbdf-4e4f84c67c15",
  operatorId: "6b18e44d-8dbd-4604-bbdf-4e4f84c67c16" };
const integration = providerDataforrestLiveIntegrationRegistry.resolveProvider("phygitals");
const authority = { configNumber: 4n, integration, cachedConfiguration: {
  adapterKey: integration.manifest.adapterVersion, settings: { platform: "phygitals" } },
  expiresAt: null, scheduleSeconds: 60, digest: "d".repeat(64) };

function fixture() {
  const now = new Date("2026-08-30T06:00:00Z");
  const cursor = { sourceInstanceId: pins.providerId, sourceRevisionId: pins.configId,
    sourceTypeKey: integration.manifest.sourceTypeKey, adapterVersion: integration.manifest.adapterVersion,
    cursorCodecKey: integration.manifest.cursorCodecKey, cursorGeneration: 1, value: "secret-opaque-checkpoint" };
  const hash = providerMixedCursorFingerprint(cursor);
  const runtime = { central_provider_id: pins.providerId, provider_key: pins.providerKey, operating_state: "error",
    state_generation: 2n, cached_config_version_id: pins.configId, cached_config_version_number: 4n,
    cached_configuration: authority.cachedConfiguration, config_expires_at: null, schedule_seconds: 60,
    source_cursor: cursor, source_cursor_hash: hash };
  const run = { id: pins.initialRunId, state: "failed", config_version_id: pins.configId, config_version_number: 4n,
    worker_fence: 1n, requested_cursor: null, requested_cursor_hash: null, final_cursor: cursor, final_cursor_hash: hash,
    reached_source_head: false, page_count: 12, accepted_count: 1200,
    failure_code: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT", finished_at: now };
  const lease = { worker_role: "import", lease_owner: null, lease_fence: 1n, heartbeat_at: null,
    lease_expires_at: null, row_version: 1n, database_now: now };
  const last = { page_number: 12, continuation: "more", next_cursor: cursor, next_cursor_hash: hash };
  const audits = []; const queries = []; let active = []; let actionable = [];
  const filter = where => audits.filter(row => (!where.action || row.action === where.action) &&
    (!where.correlation_id || row.correlation_id === where.correlation_id) &&
    (!where.details || row.details[where.details.path[0]] === where.details.equals)).reverse();
  const database = {
    $transaction: async (fn, options) => { assert.equal(options.isolationLevel, "Serializable"); return fn(database); },
    $queryRaw: async sql => {
      const text = (Array.isArray(sql) ? sql : sql.strings).join(" "); queries.push(text);
      if (text.includes("from provider_worker_states")) return [lease];
      if (text.includes("from provider_runs")) return [{ id: run.id }];
      if (text.includes("from provider_runtime")) return [{ singleton_key: true }];
      if (text.includes("clock_timestamp")) return [{ now }];
      throw new Error("Unexpected supervisor query in test");
    },
    database_identity: { findUniqueOrThrow: async () => ({ database_role: "provider", provider_id: pins.providerId, provider_key: pins.providerKey }) },
    provider_runtime: { findUniqueOrThrow: async () => runtime },
    provider_worker_states: { findUniqueOrThrow: async () => lease, updateMany: async ({ where, data }) => {
      assert.equal(where.row_version, lease.row_version); const next = { ...data }; delete next.row_version;
      Object.assign(lease, next); lease.row_version++; return { count: 1 };
    } },
    provider_runs: { findUnique: async ({ where }) => where.id === run.id ? run : null,
      findMany: async ({ where }) => where.recovery_of_run_id ? [] : active },
    provider_run_pages: { findFirst: async () => last, count: async () => 50000 },
    control_commands: { findMany: async () => actionable, findUnique: async () => null },
    local_audit_events: {
      findMany: async ({ where, take }) => filter(where).slice(0, take),
      findFirst: async ({ where }) => filter(where)[0] ?? null,
      create: async ({ data }) => { const row = { ...structuredClone(data), sequence: BigInt(audits.length + 1) }; audits.push(row); return row; },
    },
  };
  return { database, runtime, run, lease, last, audits, queries, now,
    setActive(value) { active = value; }, setActionable(value) { actionable = value; },
    read: () => readBackfillSnapshot(database, pins, authority, run.id) };
}

test("durable intent is idempotent, safely hashed, and restart-readable under lease→run→runtime locks", async () => {
  const f = fixture(); const s = await f.read();
  await assertBackfillOperation(f.database, pins, authority, true);
  await assertBackfillOperation(f.database, pins, authority, true);
  const first = await persistBackfillIntent(f.database, pins, authority, s, null, 0);
  const retry = await persistBackfillIntent(f.database, pins, authority, s, null, .8);
  assert.deepEqual(retry, first); assert.deepEqual(await readBackfillIntent(f.database, pins), first);
  assert.equal(f.audits.length, 2);
  assert.equal(JSON.stringify(f.audits, (_key, value) => typeof value === "bigint" ? String(value) : value).includes("secret-opaque-checkpoint"), false);
  const locks = f.queries.filter(query => query.includes("for update"));
  assert.ok(locks.some((query, index) => query.includes("provider_worker_states") &&
    locks[index + 1].includes("provider_runs") && locks[index + 2].includes("provider_runtime")));
  const view = await readBackfillView(f.database, pins, authority);
  assert.equal(view.pendingRetry, true); assert.equal(view.intent.runId, first.runId);
});

test("operation receipt rejects config/authority/operator drift before another attempt", async () => {
  const f = fixture(); await assertBackfillOperation(f.database, pins, authority, true);
  await assert.rejects(assertBackfillOperation(f.database, pins, { ...authority, digest: "e".repeat(64) }, false), /OPERATION_DRIFT/);
  await assert.rejects(assertBackfillOperation(f.database, { ...pins, operatorId: pins.organizationId }, authority, false), /OPERATION_DRIFT/);
  assert.equal(f.audits.length, 1);
});

test("execution uses existing lease repository and writes ownership evidence before acquire, then exact pins gate resume", async () => {
  const f = fixture(); const s = await f.read();
  const intent = await persistBackfillIntent(f.database, pins, authority, s, null, 0);
  const owner = `local:backfill:${pins.operationId}:test`;
  const held = await claimBackfillExecution(f.database, pins, authority, s, owner);
  assert.equal(held.fence, 2n); assert.equal(f.lease.lease_owner, owner);
  assert.equal(f.audits.at(-1).details.fence, "2");
  await assertBackfillRetryPinned(f.database, authority, intent, held, false);
  f.runtime.operating_state = "idle"; f.runtime.state_generation = 3n;
  await assertBackfillRetryPinned(f.database, authority, intent, held, true);
  f.runtime.operating_state = "paused"; f.runtime.state_generation = 4n;
  await assert.rejects(assertBackfillRetryPinned(f.database, authority, intent, held, true), /RETRY_PIN_CHANGED/);
});

test("expired exact prior execution can be fenced; live and unproven foreign ownership cannot", async () => {
  const f = fixture(); let s = await f.read(); const owner = `local:backfill:${pins.operationId}:old`;
  await claimBackfillExecution(f.database, pins, authority, s, owner);
  s = await f.read();
  await assert.rejects(claimBackfillExecution(f.database, pins, authority, s, "new-worker"), /LEASE_UNAVAILABLE/);
  f.lease.lease_expires_at = new Date(f.now.getTime() - 1); s = await f.read();
  const held = await claimBackfillExecution(f.database, pins, authority, s, "new-worker");
  assert.equal(held.fence, 3n);
  const g = fixture(); g.lease.lease_owner = "foreign"; g.lease.lease_expires_at = new Date(g.now.getTime() - 1);
  await assert.rejects(claimBackfillExecution(g.database, pins, authority, await g.read(), "new-worker"), /LEASE_UNAVAILABLE/);
  assert.equal(g.audits.length, 0); assert.equal(g.lease.lease_fence, 1n);
});

test("unexpected queued work, tampered cursor provenance and operator stop block durable intent", async () => {
  for (const mutation of [f => f.setActive([{ id: pins.organizationId }]),
    f => f.setActionable([{ id: pins.organizationId, resulting_run_id: null }]),
    f => { f.runtime.source_cursor = { ...f.runtime.source_cursor, sourceRevisionId: pins.organizationId };
      f.runtime.source_cursor_hash = providerMixedCursorFingerprint(f.runtime.source_cursor); },
    f => f.runtime.operating_state = "paused"]) {
    const f = fixture(); const before = await f.read(); mutation(f);
    await assert.rejects(persistBackfillIntent(f.database, pins, authority, before, null, 0));
    assert.equal(f.audits.length, 0);
  }
});

async function launchedFixture() {
  const f = fixture(); f.runtime.operating_state = "idle"; f.run.state = "queued";
  f.run.requested_cursor = f.runtime.source_cursor; f.run.requested_cursor_hash = f.runtime.source_cursor_hash;
  f.run.page_count = 0; f.setActive([{ id: f.run.id }]);
  const lease = await claimBackfillExecution(f.database, pins, authority, await f.read(), "owned-child");
  const launch = await recordBackfillLaunch(f.database, pins, authority, lease, f.run.id, pins.initialRunId);
  return { ...f, lease, launch };
}

test("an exactly owned closed child gets durable delayed restart without resume/queue/checkpoint writes", async () => {
  const f = await launchedFixture(); const oldRuntime = structuredClone(f.runtime);
  await persistClosedBackfillRestart({ database: f.database, pins, authority, lease: f.lease, launch: f.launch,
    childClosed: true, aborted: false, jitter: 0 });
  const restart = await readBackfillRestart(f.database, pins, authority);
  assert.equal(restart.kind, "closed_child_restart"); assert.equal(restart.runId, f.run.id);
  assert.equal(Date.parse(restart.notBefore) - f.now.getTime(), 5000);
  assert.deepEqual(f.runtime, oldRuntime);
  assert.equal(f.audits.filter(row => row.action === "local.provider_backfill.retry_intent").length, 0);
  await persistClosedBackfillRestart({ database: f.database, pins, authority, lease: f.lease, launch: f.launch,
    childClosed: true, aborted: false, jitter: 0 });
  assert.equal((await readBackfillRestart(f.database, pins, authority)).consecutiveNoProgress, 2);
});

test("closed-child restart refuses aborted/not-closed processes, foreign fence, generation change and operator pause", async () => {
  for (const mutation of [input => input.aborted = true, input => input.childClosed = false,
    (input, f) => f.runtime.state_generation++, (input, f) => f.runtime.operating_state = "paused",
    (input, f) => { f.database.provider_worker_states.findUniqueOrThrow = async () => ({ lease_owner: "foreign", lease_fence: 9n }); }]) {
    const f = await launchedFixture(); const count = f.audits.length;
    const input = { database: f.database, pins, authority, lease: f.lease, launch: f.launch,
      childClosed: true, aborted: false, jitter: 0 };
    mutation(input, f);
    await assert.rejects(persistClosedBackfillRestart(input)); assert.equal(f.audits.length, count);
  }
});
