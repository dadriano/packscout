import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tsImport } from "tsx/esm/api";
const { parseCourtyardHandoffArguments, courtyardGatewayBounds, courtyardResumeReviewAvailable, withCourtyardCheckpointLocks } =
  await tsImport("./handoff-courtyard-response-budget.mts", import.meta.url);
const diagnostics = await tsImport("./handoff-courtyard-response-budget.mts", import.meta.url);
const { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy } = await tsImport("@packscout/database", import.meta.url);
const operationId = "26c70381-925a-5228-87be-4e6b862fa508";
test("Courtyard CLI admits only explicit operation/review phases, never provider/token/PID overrides", () => {
  const args = ["--check-only", "--operation-id", operationId];
  assert.equal(parseCourtyardHandoffArguments(args).operationId, operationId);
  for (const mode of ["--pause", "--prepare", "--resume"]) {
    assert.throws(() => parseCourtyardHandoffArguments([mode, ...args.slice(1)]));
    assert.equal(parseCourtyardHandoffArguments([mode, ...args.slice(1), "--review-digest", "a".repeat(64)]).mode, mode);
  }
  for (const extra of [["--provider", "collector_crypt"], ["--token", "private-token"], ["--old-worker-pid", "1234"],
    ["--operation-id", operationId], ["--review-digest", "not-hash"]]) {
    assert.throws(() => parseCourtyardHandoffArguments([...args, ...extra]), (error) => !error.message.includes("private-token"));
  }
  assert.throws(() => parseCourtyardHandoffArguments(["--check-only", "--operation-id", "invalid"]));
});
test("Courtyard interrupted acquire/local commit/central activation require own-lease cleanup before resume review", () => {
  const owner = `local:courtyard:response-budget:${operationId}`;
  for (const active of [false, true]) assert.equal(courtyardResumeReviewAvailable(active, owner, owner), false);
  assert.equal(courtyardResumeReviewAvailable(true, null, owner), true);
  assert.equal(courtyardResumeReviewAvailable(false, null, owner), false);
  // Classifier only selects a phase. The plan's exact SQL-time lease guard separately rejects live/foreign leases.
});
test("Courtyard process-only bootstrap works without an isolated .env and preserves input keys/allowlisted forwarding", async (t) => {
  const readEnvironment = diagnostics.readCourtyardHandoffEnvironment;
  assert.equal(typeof readEnvironment, "function");
  let reads = 0;
  t.mock.method(fsPromises, "readFile", async (target) => {
    assert.equal(String(target), new URL("../../.env", import.meta.url).href);
    reads += 1; const error = new Error("absent fixture environment"); error.code = "ENOENT"; throw error;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const originalKey = Buffer.alloc(32, 7);
  const environment = { NODE_ENV: "development", PATH: "/test-bin",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://packscout_control_app:fixture-password@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: originalKey.toString("base64"), PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "4",
    PACKSCOUT_PROVIDER_DATABASE_URL: "postgresql://wrong:private@remote.invalid/provider",
    PACKSCOUT_DATA_API_TOKEN: "private-source-override-must-not-be-used" };
  const before = structuredClone(environment);
  const resolved = await readEnvironment(environment);
  assert.equal(reads, 1); assert.equal(resolved.version, 4); assert.deepEqual(resolved.key, originalKey);
  assert.equal(resolved.centralDatabaseUrl, environment.PACKSCOUT_CENTRAL_DATABASE_URL);
  assert.deepEqual(Object.keys(resolved.workerEnvironment).sort(), ["NODE_ENV", "PATH", "PACKSCOUT_CENTRAL_DATABASE_URL",
    "PACKSCOUT_DATABASE_MODE", "PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS", "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS",
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64", "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION"].sort());
  assert.equal(resolved.workerEnvironment.PACKSCOUT_DATABASE_MODE, "local");
  assert.equal(resolved.workerEnvironment.PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS, undefined);
  assert.equal(resolved.workerEnvironment.PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS, undefined);
  assert.equal(JSON.stringify(resolved.workerEnvironment).includes("private-source-override"), false);
  resolved.key.fill(0); assert.deepEqual(originalKey, Buffer.alloc(32, 7)); assert.deepEqual(environment, before);
  for (const change of [{ NODE_ENV: "production" }, { PACKSCOUT_PROVIDER_LANES_JSON: "[]" },
    { PACKSCOUT_DATABASE_MODE: "remote", PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "remote.test",
      PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.test",
      PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:fixture-password@remote.test:5432/packscout?sslmode=require&sslaccept=strict" },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:fixture-password@remote.test/packscout" },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:fixture-password@127.0.0.1:55434/packscout" }]) {
    await assert.rejects(readEnvironment({ ...environment, ...change }), error => !error.message.includes("fixture-password"));
  }
});
test("Courtyard bounded gateway remains centrally routed and Courtyard-port-only", async () => {
  const gateway = new BoundedProviderDatabaseGateway({ central: { client: {} }, credentialResolver: {},
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [55433], allowedSslModes: ["disable"] }),
    ...courtyardGatewayBounds });
  assert.equal(courtyardGatewayBounds.operationTimeoutMs, 60000); await gateway.close();
});

test("Courtyard gateway preserves only closed domain codes and redacts arbitrary errors, messages and causes", async () => {
  const { captureCourtyardHandoffResult, courtyardHandoffFailureCode, CourtyardHandoffError } = diagnostics;
  const gateway = async (action) => { try { return { state: "reachable", value: await action() }; } catch { return { state: "unreachable" }; } };
  const secret = "private-token-body-cursor";
  const error = new CourtyardHandoffError("COURTYARD_CANARY_ADMISSION_FAILED"); error.message = secret; error.cause = new Error(secret);
  const result = await gateway(() => captureCourtyardHandoffResult(async () => { throw error; }));
  assert.deepEqual(result, { state: "reachable", value: { ok: false, code: "COURTYARD_CANARY_ADMISSION_FAILED" } });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(await captureCourtyardHandoffResult(async () => ({ phase: "prepared_paused" })), { ok: true, value: { phase: "prepared_paused" } });
  for (const untrusted of [new Error(secret), { code: "COURTYARD_CANARY_ADMISSION_FAILED", message: secret },
    new CourtyardHandoffError(`COURTYARD_${secret}`), new CourtyardHandoffError("COURTYARD_UNREVIEWED_NEW_CODE")]) {
    assert.equal(courtyardHandoffFailureCode(untrusted), undefined);
    assert.deepEqual(await gateway(() => captureCourtyardHandoffResult(async () => { throw untrusted; })), { state: "unreachable" });
  }
});

test("Courtyard utility locks its live import lease then terminal run then runtime before stage or activation", async () => {
  const owner = `local:courtyard:response-budget:${operationId}`;
  const now = new Date("2026-08-30T20:00:00Z");
  const row = { lease_owner: owner, lease_fence: 83n, lease_expires_at: new Date(now.getTime() + 120000), database_now: now };
  const events = [];
  const tx = { $queryRaw: async (query) => {
    const sql = typeof query.sql === "string" ? query.sql : query.join("?");
    if (sql.includes("provider_worker_states")) { events.push("lease-lock"); return [row]; }
    if (sql.includes("set_config")) events.push("fenced-context");
    else if (sql.includes("provider_runs")) events.push("terminal-run-lock");
    else if (sql.includes("provider_runtime")) events.push("runtime-lock");
    else assert.fail("Unexpected SQL");
    return [];
  } };
  const database = { $transaction: async (operation, bounds) => {
    assert.deepEqual(bounds, { isolationLevel: "Serializable", maxWait: 5000, timeout: 45000 });
    events.push("begin"); try { const value = await operation(tx); events.push("commit"); return value; }
    catch (error) { events.push("rollback"); throw error; }
  } };
  assert.equal(await withCourtyardCheckpointLocks(database, { owner, fence: 83n }, async () => {
    events.push("exact-checkpoint-then-central-stage"); return "prepared";
  }), "prepared");
  assert.deepEqual(events, ["begin", "lease-lock", "fenced-context", "terminal-run-lock", "runtime-lock", "exact-checkpoint-then-central-stage", "commit"]);
  for (const change of [{ lease_owner: "foreign" }, { lease_fence: 84n }, { lease_expires_at: now }, { lease_expires_at: null }]) {
    const before = { ...row }; Object.assign(row, change); events.length = 0;
    await assert.rejects(withCourtyardCheckpointLocks(database, { owner, fence: 83n }, async () => assert.fail("Must not stage/activate")));
    assert.deepEqual(events, ["begin", "lease-lock", "rollback"]); Object.assign(row, before);
  }
  events.length = 0;
  await assert.rejects(withCourtyardCheckpointLocks(database, { owner: "foreign", fence: 83n }, async () => assert.fail()));
  await assert.rejects(withCourtyardCheckpointLocks(database, { owner, fence: 82n }, async () => assert.fail()));
  assert.deepEqual(events, []);
});
