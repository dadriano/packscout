import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { providerMixedCursorFingerprint, PrismaAdminProviderRuntimeRepository } = await tsImport("@packscout/database", import.meta.url);
const { DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION } = await tsImport("@packscout/contracts", import.meta.url);
const { providerDataforrestLiveIntegrationRegistry } = await tsImport("../../apps/worker/src/provider-dataforrest-live-integration.ts", import.meta.url);
const { readContinuousView, persistContinuousOperation, persistContinuousCycle, queueContinuousCycle, findContinuousQueuedRun } = await tsImport("./provider-continuous-persistence.mts", import.meta.url);
const { continuousQueueOwner, continuousDecision } = await tsImport("./provider-continuous-policy.mts", import.meta.url);
const pins = { organizationId: "8b333333-3333-4333-8333-333333333331", providerId: "8b333333-3333-4333-8333-333333333332",
  providerKey: "clutchpacks", configId: "8b333333-3333-4333-8333-333333333333", initialRunId: "8b333333-3333-4333-8333-333333333334",
  operationId: "8b333333-3333-4333-8333-333333333335", operatorId: "8b333333-3333-4333-8333-333333333336" };
function fixture(cadence = { kind: "central" }, scheduleSeconds = 300, postHeadPolicy = { kind: "none" }) {
  const now = new Date("2026-08-30T06:05:00Z");
  const integration = providerDataforrestLiveIntegrationRegistry.resolve(
    "clutchpacks",
    DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  );
  const authority = { configNumber: 4n, integration, cachedConfiguration: { adapterKey: integration.manifest.adapterVersion,
    settings: { platform: "clutchpacks" } }, expiresAt: null, scheduleSeconds, digest: "d".repeat(64) };
  const cursor = { sourceInstanceId: pins.providerId, sourceRevisionId: pins.configId, sourceTypeKey: integration.manifest.sourceTypeKey,
    adapterVersion: integration.manifest.adapterVersion, cursorCodecKey: integration.manifest.cursorCodecKey,
    cursorGeneration: 1, value: "synthetic-private-continuation" };
  const hash = providerMixedCursorFingerprint(cursor);
  const runtime = { central_provider_id: pins.providerId, provider_key: pins.providerKey, operating_state: "idle",
    state_generation: 11n, cached_config_version_id: pins.configId, cached_config_version_number: 4n,
    cached_configuration: authority.cachedConfiguration, config_expires_at: null, schedule_seconds: scheduleSeconds,
    source_cursor: cursor, source_cursor_hash: hash };
  const parent = { id: pins.initialRunId, trigger: "manual", state: "succeeded", config_version_id: pins.configId,
    config_version_number: 4n, worker_fence: 459n, requested_cursor: cursor, requested_cursor_hash: hash,
    final_cursor: cursor, final_cursor_hash: hash, reached_source_head: true, page_count: 1, accepted_count: 0,
    failure_code: null, finished_at: new Date("2026-08-30T06:00:00Z"), requested_at: new Date("2026-08-30T05:59:00Z"), recovery_of_run_id: null };
  const last = { page_number: 1, continuation: "head", next_cursor: cursor, next_cursor_hash: hash };
  const runs = new Map([[parent.id, parent]]); const commands = new Map(); const audits = []; const writes = [];
  const lease = { worker_role: "import", lease_owner: null, lease_fence: 459n, heartbeat_at: null,
    lease_expires_at: null, row_version: 1n, database_now: now };
  let beforeAcquire = null;
  const filterAudit = where => audits.filter(row => (!where.action || row.action === where.action) &&
    (!where.correlation_id || row.correlation_id === where.correlation_id)).reverse();
  const database = {
    $transaction: async (fn, options) => { assert.equal(options.isolationLevel, "Serializable"); return fn(database); },
    $queryRaw: async sql => {
      const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
      if (text.includes("from provider_worker_states")) { if (beforeAcquire) { const callback = beforeAcquire; beforeAcquire = null; callback(); } return [lease]; }
      if (text.includes("from provider_runtime")) return [runtime];
      if (text.includes("from provider_runs")) return [...runs.values()].filter(row => ["queued", "running"].includes(row.state));
      if (text.includes("clock_timestamp")) return [{ now }];
      throw new Error("Unexpected continuous test query");
    },
    database_identity: { findUniqueOrThrow: async () => ({ database_role: "provider", provider_id: pins.providerId, provider_key: pins.providerKey }) },
    provider_runtime: { findUniqueOrThrow: async () => runtime },
    provider_worker_states: { findUniqueOrThrow: async () => lease, updateMany: async ({ where, data }) => {
      assert.equal(where.row_version, lease.row_version); writes.push("lease");
      const next = { ...data }; delete next.row_version; Object.assign(lease, next); lease.row_version++; return { count: 1 };
    } },
    provider_runs: {
      findUnique: async ({ where }) => runs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }) => runs.get(where.id),
      findFirst: async () => [...runs.values()].sort((a, b) => b.requested_at - a.requested_at)[0],
      findMany: async ({ where }) => [...runs.values()].filter(row => where.recovery_of_run_id
        ? row.recovery_of_run_id === where.recovery_of_run_id : ["queued", "running"].includes(row.state)),
      create: async ({ data }) => { writes.push("run"); const row = { ...data, recovery_of_run_id: null, page_count: 0,
        accepted_count: 0, reached_source_head: false, final_cursor: null, final_cursor_hash: null,
        failure_code: null, finished_at: null }; runs.set(row.id, row); return row; },
    },
    provider_run_pages: { findFirst: async ({ where }) => where.provider_run_id === parent.id ? last : null },
    control_commands: {
      findMany: async () => [...commands.values()].filter(row => ["pending", "accepted"].includes(row.state)),
      findUnique: async ({ where }) => where.id ? commands.get(where.id) ?? null : [...commands.values()].find(row => row.idempotency_key === where.idempotency_key) ?? null,
      create: async ({ data }) => { writes.push("command"); const row = { ...data, reason: null }; commands.set(row.id, row); return row; },
      update: async ({ where, data }) => { const row = commands.get(where.id); Object.assign(row, data); return row; },
    },
    local_audit_events: {
      findMany: async ({ where, take }) => filterAudit(where).slice(0, take),
      findFirst: async ({ where }) => filterAudit(where)[0] ?? null,
      create: async ({ data }) => { writes.push("audit"); const row = { ...structuredClone(data), sequence: BigInt(audits.length + 1) }; audits.push(row); return row; },
    },
    provider_activity_outbox: { create: async () => { writes.push("activity"); } },
  };
  const view = () => readContinuousView(database, pins, authority, cadence, postHeadPolicy);
  const persist = async () => persistContinuousCycle(database, pins, authority, await view(), undefined, cadence, postHeadPolicy);
  return { now, cursor, hash, authority, database, runtime, parent, last, runs, commands, audits, writes, lease, view, persist,
    queue: cycle => queueContinuousCycle({ database, cycle, readAuthority: async () => authority, cadence, postHeadPolicy }),
    onNextLease(callback) { beforeAcquire = callback; } };
}
test("minute operation persists before first due time without altering hourly configuration or saved history", async () => {
  const cadence = { kind: "operator_interval", intervalSeconds: 60 }, f = fixture(cadence, 3600);
  f.now.setTime(Date.parse("2026-08-30T06:00:30Z"));
  const before = structuredClone({ runtime: f.runtime, parent: f.parent, last: f.last });
  await persistContinuousOperation(f.database, pins, f.authority, await f.view(), undefined, cadence);
  assert.deepEqual(f.writes, ["audit"]); assert.equal(f.audits[0].details.version, 2);
  assert.deepEqual(f.audits[0].details.cadence, cadence); assert.equal(f.audits[0].details.effectiveIntervalSeconds, 60);
  await persistContinuousOperation(f.database, pins, f.authority, await f.view(), undefined, cadence);
  assert.equal(f.audits.length, 1);
  await assert.rejects(f.persist(), /NOT_DUE/);
  assert.deepEqual({ runtime: f.runtime, parent: f.parent, last: f.last }, before);
  f.now.setTime(Date.parse("2026-08-30T06:01:00Z"));
  const cycle = await f.persist(); assert.equal(cycle.effectiveIntervalSeconds, 60); await f.queue(cycle);
  assert.equal(f.runs.size, 2); assert.deepEqual(f.runs.get(cycle.runId).requested_cursor, f.cursor);
  assert.equal(f.runtime.schedule_seconds, 3600); assert.equal(f.authority.scheduleSeconds, 3600);
  assert.equal(f.runtime.state_generation, 11n);
  const writes = f.writes.length;
  await persistContinuousOperation(f.database, pins, f.authority, await f.view(), undefined, cadence);
  assert.equal(f.writes.length, writes, "Matching operation replay admits its own queued cycle without re-adopting an old head.");
});
test("restarting a bound operation with another cadence or old receipt fails before queue or lease writes", async () => {
  const cadence = { kind: "operator_interval", intervalSeconds: 60 }, f = fixture(cadence, 3600);
  await persistContinuousOperation(f.database, pins, f.authority, await f.view(), undefined, cadence);
  const cycle = await f.persist(), writes = f.writes.length;
  for (const changed of [{ kind: "central" }, { kind: "operator_interval", intervalSeconds: 120 }]) {
    await assert.rejects(readContinuousView(f.database, pins, f.authority, changed), /OPERATION_DRIFT/);
    await assert.rejects(queueContinuousCycle({ database: f.database, cycle, cadence: changed,
      readAuthority: async () => f.authority }), /CYCLE_DRIFT/);
  }
  assert.equal(f.writes.length, writes); assert.equal(f.runs.size, 1);
  const operation = f.audits.find(row => row.action === "local.provider_continuous.operation");
  operation.details = { pins, authorityDigest: f.authority.digest };
  await assert.rejects(f.view(), /OPERATION_DRIFT/);
  await assert.rejects(f.queue(cycle), /OPERATION_DRIFT/);
  assert.equal(f.writes.length, writes);
});
test("stored cycle cadence, effective interval and due-time drift cannot admit a run", async () => {
  for (const change of [{ cadence: { kind: "central" } }, { effectiveIntervalSeconds: 120 },
    { notBefore: "2026-08-30T06:00:00.000Z" }, { version: 1 }]) {
    const cadence = { kind: "operator_interval", intervalSeconds: 60 }, f = fixture(cadence, 3600);
    const cycle = await f.persist(), writes = f.writes.length;
    Object.assign(f.audits.find(row => row.action === "local.provider_continuous.cycle").details, change);
    await assert.rejects(f.view(), /CYCLE_DRIFT/); await assert.rejects(f.queue(cycle), /CYCLE_DRIFT/);
    assert.equal(f.writes.length, writes); assert.equal(f.runs.size, 1); assert.equal(f.commands.size, 0);
  }
});
test("required post-head policy binds before waiting and cannot be removed on queued-cycle replay", async () => {
  const cadence = { kind: "operator_interval", intervalSeconds: 60 };
  const postHeadPolicy = { kind: "callback", fingerprint: "e".repeat(64), timeoutMilliseconds: 1000 };
  const f = fixture(cadence, 3600, postHeadPolicy);
  f.now.setTime(Date.parse("2026-08-30T06:00:30Z"));
  const before = structuredClone({ runtime: f.runtime, parent: f.parent, last: f.last });
  await persistContinuousOperation(f.database, pins, f.authority, await f.view(), undefined, cadence, postHeadPolicy);
  assert.deepEqual(f.writes, ["audit"]); assert.deepEqual(f.audits[0].details.postHeadPolicy, postHeadPolicy);
  f.now.setTime(Date.parse("2026-08-30T06:01:00Z"));
  const cycle = await f.persist(); assert.deepEqual(cycle.postHeadPolicy, postHeadPolicy);
  for (const queued of [false, true]) {
    if (queued) await f.queue(cycle);
    const writes = f.writes.length, view = await f.view();
    for (const changed of [undefined, { kind: "none" }, { ...postHeadPolicy, timeoutMilliseconds: 1001 },
      { ...postHeadPolicy, fingerprint: "f".repeat(64) }]) {
      await assert.rejects(readContinuousView(f.database, pins, f.authority, cadence, changed), /OPERATION_DRIFT/);
      await assert.rejects(persistContinuousOperation(f.database, pins, f.authority, view, undefined, cadence, changed), /OPERATION_DRIFT/);
      await assert.rejects(persistContinuousCycle(f.database, pins, f.authority, view, undefined, cadence, changed), /OPERATION_DRIFT/);
      await assert.rejects(queueContinuousCycle({ database: f.database, cycle, cadence, postHeadPolicy: changed,
        readAuthority: async () => f.authority }), /CYCLE_DRIFT/);
    }
    assert.equal(f.writes.length, writes, "Policy drift must refuse before lease or run mutation, even for already-queued cycles.");
    await persistContinuousOperation(f.database, pins, f.authority, view, undefined, cadence, postHeadPolicy);
    assert.equal(f.writes.length, writes, "Matching callback policy must replay without re-adopting the initial head.");
  }
  await f.queue(cycle); assert.equal(f.runs.size, 2);
  assert.deepEqual({ runtime: f.runtime, parent: f.parent, last: f.last }, before);
});
test("missing, changed or malformed post-head receipt policy never admits new work", async () => {
  const postHeadPolicy = { kind: "callback", fingerprint: "e".repeat(64), timeoutMilliseconds: 1000 };
  for (const action of ["operation", "cycle"]) {
    for (const changed of [undefined, { kind: "none" }, { ...postHeadPolicy, timeoutMilliseconds: 1001 },
      { ...postHeadPolicy, fingerprint: "f".repeat(64) }, { ...postHeadPolicy, unknown: true }]) {
      const f = fixture(undefined, 300, postHeadPolicy), cycle = await f.persist(), writes = f.writes.length;
      const receipt = f.audits.find(row => row.action === `local.provider_continuous.${action}`);
      if (changed === undefined) delete receipt.details.postHeadPolicy;
      else receipt.details.postHeadPolicy = changed;
      const error = action === "operation" ? /OPERATION_DRIFT/ : /CYCLE_DRIFT/;
      await assert.rejects(f.view(), error); await assert.rejects(f.queue(cycle), error);
      assert.equal(f.writes.length, writes); assert.equal(f.runs.size, 1); assert.equal(f.commands.size, 0);
    }
  }
  const f = fixture(), cycle = await f.persist(), writes = f.writes.length;
  assert.deepEqual(cycle.postHeadPolicy, { kind: "none" });
  await assert.rejects(queueContinuousCycle({ database: f.database, cycle, postHeadPolicy: null,
    readAuthority: async () => assert.fail("Null policy must fail before any authority read.") }), /POST_HEAD_POLICY_INVALID/);
  assert.equal(f.writes.length, writes);
});
test("durable head receipt and queue copy exact full checkpoint once, retain history, and never resume", async () => {
  const f = fixture(); const before = structuredClone(f.parent); const original = structuredClone(f.runtime.source_cursor);
  const view = await f.view(); const cycle = await f.persist();
  assert.deepEqual(await persistContinuousCycle(f.database, pins, f.authority, view), cycle);
  assert.equal(f.audits.length, 2); assert.equal(f.writes.includes("run"), false);
  assert.equal(JSON.stringify(cycle).includes(f.cursor.value), false);
  await f.queue(cycle); await f.queue(cycle);
  assert.equal(f.runs.size, 2); assert.deepEqual(f.parent, before);
  assert.deepEqual(f.runs.get(cycle.runId).requested_cursor, original); assert.deepEqual(f.runtime.source_cursor, original);
  assert.equal(f.runtime.state_generation, 11n); assert.equal(f.commands.size, 1);
  assert.equal([...f.commands.values()][0].command_type, "run");
  assert.equal(f.lease.lease_owner, null); assert.equal(f.lease.lease_fence, 460n);
  assert.equal((await f.view()).cycleQueued, true);
});
test("request acknowledgement loss is replay-safe and an advanced completed child remains recognized", async () => {
  const f = fixture(); const cycle = await f.persist(); const commands = new PrismaAdminProviderRuntimeRepository(f.database);
  await assert.rejects(queueContinuousCycle({ database: f.database, cycle, readAuthority: async () => f.authority,
    commands: { requestRunNow: async input => { await commands.requestRunNow(input); throw new Error("synthetic acknowledgement loss"); } } }));
  await f.queue(cycle); assert.equal(f.runs.size, 2);
  const child = f.runs.get(cycle.runId); child.state = "succeeded"; f.runtime.state_generation = 13n;
  f.runtime.source_cursor = { ...f.cursor, value: "synthetic-later" }; f.runtime.source_cursor_hash = providerMixedCursorFingerprint(f.runtime.source_cursor);
  await f.queue(cycle); assert.equal(f.runs.size, 2); assert.equal(await findContinuousQueuedRun(f.database, cycle), true);
});
test("receipt-before-queue restart continues once; pause, authority, history and checkpoint drift refuse writes", async () => {
  for (const mutation of [f => { f.runtime.operating_state = "paused"; }, f => { f.runtime.state_generation++; },
    f => { f.runtime.source_cursor = { ...f.cursor, value: "changed" }; }, f => { f.authority.digest = "f".repeat(64); },
    f => { f.parent.finished_at = new Date("2026-08-30T06:00:01Z"); }, f => { f.last.next_cursor_hash = "f".repeat(64); },
    f => { f.lease.lease_owner = "foreign"; f.lease.lease_expires_at = new Date("2026-08-30T06:04:00Z"); }]) {
    const f = fixture(); const cycle = await f.persist(); mutation(f);
    await assert.rejects(f.queue(cycle)); assert.equal(f.runs.size, 1); assert.equal(f.commands.size, 0);
  }
  const f = fixture(); const cycle = await f.persist(); assert.equal((await f.view()).cycleQueued, false);
  await f.queue(cycle); assert.equal((await f.view()).cycleQueued, true);
});
test("queued crash-gap utility lease waits live then fences only its expired receipt-owned lease", async () => {
  const f = fixture(); const cycle = await f.persist(); await f.queue(cycle);
  f.lease.lease_owner = continuousQueueOwner(cycle); f.lease.lease_expires_at = new Date(f.now.getTime() + 1000);
  assert.equal(continuousDecision(await f.view(), pins).state, "waiting");
  await assert.rejects(f.queue(cycle)); assert.equal(f.lease.lease_owner, continuousQueueOwner(cycle));
  f.lease.lease_expires_at = new Date(f.now.getTime() - 1);
  await f.queue(cycle); assert.equal(f.lease.lease_owner, null); assert.equal(f.lease.lease_fence, 461n); assert.equal(f.runs.size, 2);
});
test("changed command/run receipt and foreign later run never become owned cycles", async () => {
  const f = fixture(); const cycle = await f.persist(); await f.queue(cycle);
  f.commands.get(cycle.commandId).requested_by_operator_id = pins.providerId;
  await assert.rejects(f.view(), /QUEUED_RUN_DRIFT/);
  const g = fixture(); g.runs.set(pins.operatorId, { ...g.parent, id: pins.operatorId, requested_at: g.now });
  await assert.rejects(g.view(), /FOREIGN_RUN/);
});
test("operator pause racing after last utility guard still blocks atomic run queue", async () => {
  const f = fixture(); const cycle = await f.persist(); const repository = new PrismaAdminProviderRuntimeRepository(f.database);
  await assert.rejects(queueContinuousCycle({ database: f.database, cycle, readAuthority: async () => f.authority,
    commands: { requestRunNow: async input => { f.runtime.operating_state = "paused"; f.runtime.state_generation++;
      return repository.requestRunNow(input); } } }), /QUEUE_REFUSED/);
  assert.equal(f.runs.size, 1); assert.equal(f.commands.size, 0); assert.equal(f.lease.lease_owner, null);
});
test("atomic queue receives the acquired fence and rejects expiry or foreign ownership after preflight", async () => {
  for (const race of ["expired", "foreign"]) {
    const f = fixture(); const cycle = await f.persist();
    const repository = new PrismaAdminProviderRuntimeRepository(f.database);
    await assert.rejects(queueContinuousCycle({ database: f.database, cycle, readAuthority: async () => f.authority,
      commands: { requestRunNow: async input => {
        assert.deepEqual({ owner: input.expectedImportLease.owner, fence: input.expectedImportLease.fence },
          { owner: continuousQueueOwner(cycle), fence: 460n });
        if (race === "expired") f.lease.lease_expires_at = new Date(f.now.getTime() - 1);
        else { f.lease.lease_owner = "foreign-owner"; f.lease.lease_fence++; }
        return repository.requestRunNow(input);
      } } }), /QUEUE_REFUSED/);
    assert.equal(f.runs.size, 1); assert.equal(f.commands.size, 0);
    assert.equal(f.lease.lease_owner, race === "foreign" ? "foreign-owner" : null);
  }
});
