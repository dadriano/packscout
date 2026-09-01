import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const drainPolicy = await tsImport("./dataforrest-catalog-bridge-drain-policy.mts", import.meta.url);
const livePolicy = await tsImport("./dataforrest-catalog-bridge-drain-live-policy.mts", import.meta.url);
const liveDatabase = await tsImport("./dataforrest-catalog-bridge-drain-live-database.mts", import.meta.url);
const macos = await tsImport("./dataforrest-catalog-bridge-drain-macos.mts", import.meta.url);

const providerKey = "collector_crypt";
const definition = plan.catalogBridgeProvider(providerKey);
const hash = letter => letter.repeat(64);
const operationId = "40000000-0000-4000-8000-000000000001";
const operatorId = "40000000-0000-4000-8000-000000000002";
const runId = "40000000-0000-4000-8000-000000000003";
const pageId = "40000000-0000-4000-8000-000000000004";

function policy(overrides = {}) {
  return livePolicy.catalogBridgeLiveDrainPolicySchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_live_drain_v1",
    environment: "live",
    authorization: "operator_requested_catalog_bridge_drain",
    operationId,
    providerKey,
    providerId: definition.providerId,
    operatorId,
    entryKind: "running",
    currentConfigId: definition.currentConfigId,
    currentConfigNumber: definition.currentConfigNumber,
    providerRowVersion: "4",
    centralAuthorityDigest: hash("b"),
    databaseRouteDigest: hash("c"),
    runtimeGeneration: "26",
    runtimeRowVersion: "50",
    runId,
    runFence: "14",
    sourceCursorHash: hash("d"),
    importLeaseOwner: "provider-import:collector",
    importLeaseFence: "14",
    processPid: 99123,
    processIdentitySha256: hash("a"),
    receiptPath: "/tmp/catalog-bridge-receipt.json",
    ...overrides,
  });
}

test("live policy requires an exact private 0600 input and refuses mismatched pins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-live-drain-policy-"));
  const file = path.join(root, "policy.json");
  try {
    await writeFile(file, `${JSON.stringify(policy())}\n`, { mode: 0o600 });
    assert.equal((await livePolicy.readCatalogBridgeLiveDrainPolicy(file)).providerId, definition.providerId);
    await chmod(file, 0o640);
    await assert.rejects(livePolicy.readCatalogBridgeLiveDrainPolicy(file),
      { code: "CATALOG_BRIDGE_LIVE_DRAIN_POLICY_FILE_UNSAFE" });
    assert.throws(() => livePolicy.catalogBridgeLiveDrainPolicySchema.parse({ ...policy(),
      providerId: "40000000-0000-4000-8000-000000000099" }));
    assert.throws(() => livePolicy.assertCatalogBridgeLiveDrainInitialBoundary(policy(), {
      central: { providerId: definition.providerId, providerKey, providerRowVersion: "4",
        activeConfigId: definition.currentConfigId, activeConfigNumber: definition.currentConfigNumber,
        authorityDigest: hash("b") },
      runtime: { generation: "26", rowVersion: "51", sourceCursorHash: hash("d") },
      run: { id: runId, workerFence: "14" }, importLease: { owner: "provider-import:collector", fence: "14" },
      process: { launchdLabel: definition.launchdLabel, residencyPort: definition.residencyPort,
        pids: [99123], processIdentitySha256: hash("a") },
    }), { code: "CATALOG_BRIDGE_LIVE_DRAIN_POLICY_MISMATCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

function macRunner(options = {}) {
  let loaded = true;
  const commands = [];
  return {
    commands,
    runner: {
      async run(executable, args) {
        commands.push([executable, ...args]);
        if (executable === "/bin/launchctl" && args[0] === "bootout") {
          if (options.bootoutExitCode) return { exitCode: options.bootoutExitCode, stdout: "", stderr: "refused" };
          if (!options.staysLoaded) loaded = false;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (executable === "/bin/launchctl") return loaded
          ? { exitCode: 0, stdout: "\tpid = 99123\n", stderr: "" }
          : { exitCode: 113, stdout: "", stderr: "Could not find service" };
        if (executable === "/usr/sbin/lsof") return loaded
          ? { exitCode: 0, stdout: "p99123\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
        if (executable === "/bin/ps") return { exitCode: 0,
          stdout: "99123 1 Mon Aug 31 20:00:00 2026 /usr/local/bin/node provider-poller\n", stderr: "" };
        throw new Error("Unexpected command");
      },
    },
  };
}

async function onlineObservation(runner) {
  return macos.createCatalogBridgeMacosProcessAdapter({ providerKey, runner,
    platform: "darwin", uid: 501, authorizeBootout: async () => { throw new Error("not used"); } }).observe();
}

test("macOS adapter never executes bootout before the database safety proof", async () => {
  const fake = macRunner();
  const adapter = macos.createCatalogBridgeMacosProcessAdapter({ providerKey, runner: fake.runner,
    platform: "darwin", uid: 501, authorizeBootout: async () => { throw Object.assign(new Error("paused proof missing"),
      { code: "CATALOG_BRIDGE_LIVE_DRAIN_BOOTOUT_NOT_AUTHORIZED" }); } });
  await assert.rejects(adapter.bootout({ launchdLabel: definition.launchdLabel, expectedPid: 99123,
    expectedProcessIdentitySha256: hash("a") }), { code: "CATALOG_BRIDGE_LIVE_DRAIN_BOOTOUT_NOT_AUTHORIZED" });
  assert.equal(fake.commands.some(command => command[1] === "bootout"), false);
});

test("macOS adapter refuses process mismatch and launchctl bootout failure", async () => {
  const mismatch = macRunner();
  const observation = await onlineObservation(mismatch.runner);
  const mismatched = macos.createCatalogBridgeMacosProcessAdapter({ providerKey, runner: mismatch.runner,
    platform: "darwin", uid: 501, authorizeBootout: async () => observation });
  await assert.rejects(mismatched.bootout({ launchdLabel: definition.launchdLabel, expectedPid: 99124,
    expectedProcessIdentitySha256: observation.processIdentitySha256 }),
  { code: "CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT" });
  assert.equal(mismatch.commands.some(command => command[1] === "bootout"), false);

  const refused = macRunner({ bootoutExitCode: 77 });
  const exact = await onlineObservation(refused.runner);
  const adapter = macos.createCatalogBridgeMacosProcessAdapter({ providerKey, runner: refused.runner,
    platform: "darwin", uid: 501, authorizeBootout: async () => exact });
  await assert.rejects(adapter.bootout({ launchdLabel: definition.launchdLabel, expectedPid: 99123,
    expectedProcessIdentitySha256: exact.processIdentitySha256 }),
  { code: "CATALOG_BRIDGE_DRAIN_BOOTOUT_REFUSED" });
  assert.equal(refused.commands.filter(command => command[1] === "bootout").length, 1);
});

test("macOS adapter proves absence after bootout and fails closed on timeout without kill", async () => {
  const success = macRunner();
  const online = await onlineObservation(success.runner);
  let clock = Date.parse("2026-09-01T04:00:00.000Z");
  const adapter = macos.createCatalogBridgeMacosProcessAdapter({ providerKey, runner: success.runner,
    platform: "darwin", uid: 501, now: () => new Date(clock), wait: async () => { clock += 100; },
    authorizeBootout: async () => online });
  const receipt = await adapter.bootout({ launchdLabel: definition.launchdLabel, expectedPid: 99123,
    expectedProcessIdentitySha256: online.processIdentitySha256 });
  assert.equal(receipt.outcome, "unloaded");
  assert.equal((await adapter.observe()).processCount, 0);

  const stuck = macRunner({ staysLoaded: true });
  const stuckOnline = await onlineObservation(stuck.runner);
  let stuckClock = clock;
  const timingOut = macos.createCatalogBridgeMacosProcessAdapter({ providerKey, runner: stuck.runner,
    platform: "darwin", uid: 501, bootoutTimeoutMilliseconds: 100, bootoutPollMilliseconds: 25,
    now: () => new Date(stuckClock), wait: async milliseconds => { stuckClock += milliseconds; },
    authorizeBootout: async () => stuckOnline });
  await assert.rejects(timingOut.bootout({ launchdLabel: definition.launchdLabel, expectedPid: 99123,
    expectedProcessIdentitySha256: stuckOnline.processIdentitySha256 }),
  { code: "CATALOG_BRIDGE_DRAIN_BOOTOUT_TIMEOUT" });
  assert.equal(stuck.commands.filter(command => command[1] === "bootout").length, 1);
  assert.equal(stuck.commands.some(command => command.includes("kill")), false);
});

function fakeDatabase(options = {}) {
  const log = [];
  const audits = [];
  const databaseNow = new Date("2026-09-01T03:00:00.000Z");
  const run = { id: runId, state: "running", requested_at: new Date("2026-09-01T02:00:00.000Z"),
    config_version_id: definition.currentConfigId, config_version_number: BigInt(definition.currentConfigNumber),
    worker_fence: 14n, page_count: 1, reached_source_head: false, finished_at: null, failure_code: null,
    final_cursor: { cursor: "opaque" }, final_cursor_hash: hash("d") };
  const runtime = { central_provider_id: definition.providerId, provider_key: providerKey,
    operating_state: "running", state_generation: 26n, row_version: 50n,
    cached_config_version_id: definition.currentConfigId,
    cached_config_version_number: BigInt(definition.currentConfigNumber),
    cached_configuration: { adapterKey: definition.eventManifest.adapterVersion, settings: { platform: providerKey } },
    source_cursor: { cursor: "opaque" }, source_cursor_hash: hash("d") };
  const transaction = {
    async $queryRaw() { log.push("lease"); return [{ worker_role: "import", lease_owner: "provider-import:collector",
      lease_fence: 14n, heartbeat_at: databaseNow, lease_expires_at: new Date("2026-09-01T03:02:00.000Z"),
      row_version: 9n, database_now: databaseNow }]; },
    async $queryRawUnsafe(sql, parameter) {
      if (sql.includes("from provider_runs where id")) { log.push("run"); return [{ id: parameter }]; }
      if (sql.includes("from provider_runtime where singleton_key")) { log.push("runtime"); return [{ singleton_key: true }]; }
      if (sql.includes("pg_stat_activity")) return [{ count: 0n }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    database_identity: { findUnique: async () => ({ database_role: "provider",
      schema_version: "distributed-provider-v1" }) },
    provider_runtime: { findUnique: async () => runtime },
    provider_runs: { findUnique: async () => run,
      findFirst: async () => options.queuedRace ? { ...run, id: "40000000-0000-4000-8000-000000000099" } : run,
      count: async () => 1 },
    provider_run_pages: { findFirst: async () => ({ id: pageId, page_number: 1, next_cursor: { cursor: "opaque" },
      next_cursor_hash: hash("d"), continuation: "more" }) },
    control_commands: { count: async () => 0 },
    provider_worker_states: { findMany: async () => [] },
    local_audit_events: {
      findMany: async ({ where }) => audits.filter(row => row.correlation_id === where.correlation_id && row.action === where.action),
      async create({ data }) { audits.push({ sequence: BigInt(audits.length + 1), ...data }); return data; },
    },
  };
  return { log, audits, database: { $transaction: async callback => callback(transaction) } };
}

function adapterHarness(options = {}) {
  const fake = fakeDatabase(options);
  const live = policy();
  const process = { launchdLabel: definition.launchdLabel, launchdLoaded: true, processCount: 1, pids: [99123],
    processIdentitySha256: hash("a"), residencyPort: definition.residencyPort, residencyPortListening: true };
  const route = { target: { providerId: definition.providerId, providerKey, databaseName: definition.databaseName,
    databaseRole: "provider", schemaVersion: "distributed-provider-v1" } };
  const authority = { boundary: { organizationId: definition.organizationId, providerId: definition.providerId,
    providerKey, providerRowVersion: "4", activeConfigId: definition.currentConfigId,
    activeConfigNumber: definition.currentConfigNumber, maximumConfigNumber: definition.currentConfigNumber,
    activeAdapterVersion: definition.eventManifest.adapterVersion, configuration: { platform: providerKey },
    configurationDigest: plan.catalogBridgeDigest({ platform: providerKey }), authorityDigest: hash("b") },
  route, routeDigest: hash("c") };
  const adapter = liveDatabase.createCatalogBridgeLiveDatabaseAdapter({ policy: live, dependencies: {
    readAuthority: async () => authority,
    runProvider: async (_route, operation) => ({ state: "reachable", providerId: definition.providerId,
      observedAt: new Date().toISOString(), value: await operation(fake.database) }),
    observeProcess: async () => process,
    now: () => new Date("2026-09-01T03:00:00.000Z"),
  } });
  return { adapter, fake };
}

test("provider adapter locks lease then exact run then runtime and refuses a queued-head race", async () => {
  const raced = adapterHarness({ queuedRace: true });
  await assert.rejects(raced.adapter.readBoundary(), { code: "CATALOG_BRIDGE_LIVE_DRAIN_QUEUED_RUN_RACE" });
  assert.deepEqual(raced.fake.log.slice(0, 3), ["lease", "run", "runtime"]);
});

test("provider pause intent is immutable and an exact retry writes no duplicate", async () => {
  const harness = adapterHarness();
  const boundary = await harness.adapter.readBoundary();
  const intent = drainPolicy.createCatalogBridgePauseIntent({ pins: { operationId, providerKey, operatorId },
    boundary, kind: "running" });
  assert.equal((await harness.adapter.recordPauseIntent(intent)).exactRetry, false);
  assert.equal((await harness.adapter.recordPauseIntent(intent)).exactRetry, true);
  assert.equal(harness.fake.audits.length, 1);
  assert.deepEqual(harness.fake.log.slice(0, 3), ["lease", "run", "runtime"]);
});
