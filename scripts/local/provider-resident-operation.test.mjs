import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins, residentFixture } from "./provider-resident-test-fixture.mjs";
const { withResidentOperation } = await tsImport("./provider-resident-operation.mts", import.meta.url);
const { readBackfillView } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { persistResidentHandoff } = await tsImport("./provider-resident-handoff.mts", import.meta.url);
const { createContinuousProviderReader } = await tsImport("./provider-continuous-read.mts", import.meta.url);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test("gateway timeout drains its pending callback and blocks later write phases before returning", async () => {
  const started = deferred(), release = deferred(); let writes = 0, finished = false;
  const operation = withResidentOperation(async (_db, active) => {
    active(); started.resolve(); await release.promise; active(); writes++; return "written";
  }, async callback => { void callback({}).catch(() => {}); await started.promise; return "gateway_expired"; }, new AbortController().signal)
    .then(value => { finished = true; return value; });
  await started.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(writes, 0);
  release.resolve(); assert.equal(await operation, "gateway_expired"); assert.equal(writes, 0); assert.equal(finished, true);
});
test("gateway rejection also drains an already-issued statement before client-close or next operation", async () => {
  const started = deferred(), release = deferred(); const order = [];
  const operation = withResidentOperation(async (_db, active) => {
    active(); started.resolve(); await release.promise; order.push("statement_settled"); return "done";
  }, async callback => { void callback({}).catch(() => {}); await started.promise; throw new Error("gateway rejected"); }, new AbortController().signal)
    .finally(() => order.push("safe_to_close"));
  void operation.catch(() => {});
  await started.promise; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, []);
  release.resolve(); await assert.rejects(operation, /gateway rejected/);
  assert.deepEqual(order, ["statement_settled", "safe_to_close"]);
});
test("handoff rechecks its active deadline after reads and before writing an audit receipt", async () => {
  const f = residentFixture(); const view = await readBackfillView(f.database, pins, f.authority); let expired = false;
  const original = f.database.provider_runs.findFirst;
  f.database.provider_runs.findFirst = async input => { const result = await original(input); expired = true; return result; };
  await assert.rejects(persistResidentHandoff(f.database, pins, f.authority, view,
    () => { if (expired) throw new Error("expired before write"); }), /expired before write/);
  assert.deepEqual(f.writes, []);
});
test("aborted or exhausted operation never begins the database callback body", async () => {
  const stop = new AbortController(); stop.abort(); let started = false;
  for (const [signal, milliseconds] of [[stop.signal, 55000], [new AbortController().signal, 0]]) {
    await assert.rejects(withResidentOperation(async () => { started = true; }, callback => callback({}), signal, milliseconds), /OPERATION_DEADLINE/);
  }
  assert.equal(started, false);
});
test("resident shutdown drains a timed-out read before closing its gateway", async () => {
  const started = deferred(), release = deferred(); let closed = false;
  const reader = createContinuousProviderReader({ authority: async () => ({}),
    run: async (_authority, callback) => { void callback({}).catch(() => {}); await started.promise;
      return { state: "unreachable", failureCode: "database_unreachable" }; },
    read: async () => { started.resolve(); await release.promise; return "late snapshot"; },
  });
  await assert.rejects(reader(), /CONTINUOUS_READ_UNAVAILABLE/);
  const drain = reader.drain().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release.resolve(); await drain; assert.equal(closed, true);
});
