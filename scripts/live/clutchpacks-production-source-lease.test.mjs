import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { acquireCheckedProductionSourceLease } = await tsImport("./clutchpacks-production-source-lease.mts", import.meta.url);
const request = { role: "import", owner: "publication:fixture", leaseMilliseconds: 90_000 };
const result = { kind: "acquired", lease: { role: "import", owner: request.owner, fence: 44n, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 90_000), rowVersion: 1n } };

test("known acquire followed by failed post-check compensates only the captured exact lease and preserves original failure", async () => {
  const failure = new Error("post-read changed"), calls = [];
  await assert.rejects(acquireCheckedProductionSourceLease({ request, acquire: async captured => { assert.deepEqual(captured, request); return result; },
    postcheck: async () => { throw failure; }, cleanup: async lease => { calls.push(lease); return true; } }), error => error === failure);
  assert.deepEqual(calls, [{ role: "import", owner: request.owner, fence: 44n }]);
});
for (const kind of ["unprovable authority", "uncertain release", "lost fence"]) test(`known acquisition cleanup reports ${kind}`, async () => {
  let attempts = 0;
  await assert.rejects(acquireCheckedProductionSourceLease({ request, acquire: async () => result,
    postcheck: async () => { throw new Error("post-read changed"); }, cleanup: async () => { attempts++; if (kind === "lost fence") return false; throw new Error(kind); } }),
  /PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED/);
  assert.equal(attempts, 1);
});
test("uncertain acquire rejection never invents a fence, retries, or compensates", async () => {
  const failure = new Error("uncertain acquire timeout"); let acquisitions = 0;
  await assert.rejects(acquireCheckedProductionSourceLease({ request, acquire: async () => { acquisitions++; throw failure; },
    postcheck: async () => assert.fail("No returned lease"), cleanup: async () => assert.fail("No known fence") }), error => error === failure);
  assert.equal(acquisitions, 1);
});
test("lease request identity cannot change while admission is awaiting", async () => {
  const mutable = { ...request }; let continueAcquire;
  const gate = new Promise(resolve => { continueAcquire = resolve; });
  const work = acquireCheckedProductionSourceLease({ request: mutable, acquire: async captured => {
    await gate; assert.deepEqual(captured, request); return result;
  }, postcheck: async lease => { assert.equal(lease.role, "import"); assert.equal(lease.owner, request.owner); }, cleanup: async () => assert.fail("Unexpected cleanup") });
  mutable.role = "promotion"; mutable.owner = "changed"; continueAcquire();
  assert.equal((await work).lease.fence, 44n);
});
