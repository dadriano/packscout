import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { createContinuousProviderReader, ContinuousReadUnavailableError } = await tsImport("./provider-continuous-read.mts", import.meta.url);
const { ProviderBackfillSupervisorError } = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
const unavailable = (failureCode = "database_unreachable") => ({ state: "unreachable", failureCode });
function harness() {
  let authorities = 0; let gateways = 0; let reads = 0;
  const input = { authority: async () => ({ version: ++authorities }),
    run: async (authority, callback) => {
      gateways++;
      try { return { state: "reachable", value: await callback({}) }; } catch { return unavailable(); }
    },
    read: async (_db, authority) => { reads++; return { version: authority.version }; } };
  return { input, reader: createContinuousProviderReader(input), counts: () => ({ authorities, gateways, reads }) };
}
test("settled provider connection unavailability retries only a fresh authority and snapshot", async () => {
  const f = harness(); const read = f.input.read; let failures = 2;
  f.input.read = async (...args) => { if (failures-- > 0) throw { code: "P1001", message: "private details" }; return read(...args); };
  await assert.rejects(f.reader(), ContinuousReadUnavailableError);
  await assert.rejects(f.reader(), ContinuousReadUnavailableError);
  assert.deepEqual(await f.reader(), { version: 3 });
  assert.deepEqual(f.counts(), { authorities: 3, gateways: 3, reads: 1 });
});
test("gateway readiness unavailability is retryable but identity, route and credential failures are not", async () => {
  for (const code of ["database_unreachable", "provider_identity_mismatch", "database_schema_mismatch", "route_changed", "credential_unavailable"]) {
    const f = harness(); f.input.run = async () => unavailable(code);
    await assert.rejects(f.reader(), error => code === "database_unreachable"
      ? error instanceof ContinuousReadUnavailableError : !(error instanceof ContinuousReadUnavailableError));
    assert.equal(f.counts().reads, 0);
  }
});
test("an unsettled timed-out read prevents new reads or authority work until completion; late views are discarded", async () => {
  const f = harness(); let release; let running; let starts = 0;
  f.input.read = () => new Promise(resolve => { release = resolve; });
  f.input.run = async (_authority, callback) => { starts++; running = callback({}); return unavailable(); };
  await assert.rejects(f.reader(), ContinuousReadUnavailableError);
  await assert.rejects(f.reader(), ContinuousReadUnavailableError);
  await assert.rejects(f.reader(), ContinuousReadUnavailableError);
  assert.equal(starts, 1); assert.equal(f.counts().authorities, 1);
  release({ version: "stale-view" }); await running;
  f.input.run = async (_authority, callback) => ({ state: "reachable", value: await callback({}) });
  f.input.read = async (_db, authority) => ({ version: authority.version });
  assert.deepEqual(await f.reader(), { version: 2 });
});
test("unknown errors and late authority drift are never converted into read retry capabilities", async () => {
  const f = harness(); const expected = new ProviderBackfillSupervisorError("BACKFILL_CONFIGURATION_OR_CHECKPOINT_DRIFT");
  let reject; let running;
  f.input.read = () => new Promise((_resolve, fail) => { reject = fail; });
  f.input.run = async (_authority, callback) => { running = callback({}).catch(() => undefined); return unavailable(); };
  await assert.rejects(f.reader(), ContinuousReadUnavailableError);
  reject(expected); await running;
  await assert.rejects(f.reader(), error => error === expected);
  for (const error of [new Error("private unknown"), { code: "P2034" }, { code: "P2028" },
    Object.defineProperty({}, "code", { get() { assert.fail("must not read accessor"); } })]) {
    const g = harness(); g.input.read = async () => { throw error; };
    await assert.rejects(g.reader(), actual => actual === error);
  }
  const g = harness(); g.input.authority = async () => { throw expected; };
  await assert.rejects(g.reader(), error => error === expected); assert.equal(g.counts().gateways, 0);
});
