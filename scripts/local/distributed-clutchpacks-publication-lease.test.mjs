import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { withPublicationImportLease } = await tsImport("./distributed-clutchpacks-publication-lease.mts", import.meta.url);
function fixture() {
  const calls = []; let owned;
  return { calls, port: {
    async acquire(request) { calls.push("acquire"); owned = { role: request.role, owner: request.owner, fence: 7n,
      rowVersion: 1n, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + request.leaseMilliseconds) };
      return { kind: "acquired", lease: owned }; },
    async renew(request) { calls.push("renew"); assert.equal(request.owner, owned.owner); assert.equal(request.fence, 7n); return owned; },
    async release(request) { calls.push("release"); assert.equal(request.owner, owned.owner); assert.equal(request.fence, 7n); return true; },
  } };
}
test("publication retains its exact import fence through activation and releases only its lease", async () => {
  const { calls, port } = fixture();
  const result = await withPublicationImportLease({ port, operation: async (lease, assertLive) => {
    assert.equal(lease.role, "import"); assert.equal(lease.fence, 7n); calls.push("stage");
    await assertLive(); calls.push("activate"); return "complete";
  } });
  assert.equal(result, "complete");
  assert.deepEqual(calls, ["acquire", "renew", "stage", "renew", "activate", "renew", "release"]);
});
test("an existing importer blocks publication before staging and is never released", async () => {
  const { calls, port } = fixture();
  port.acquire = async () => ({ kind: "held", fence: 6n, expiresAt: new Date() });
  await assert.rejects(withPublicationImportLease({ port, operation: async () => { calls.push("stage"); } }),
    (error) => error.code === "LOCAL_PUBLICATION_IMPORT_LEASE_UNAVAILABLE");
  assert.deepEqual(calls, []);
});
test("lost renewal refuses activation, does not reacquire, and releases only the original fence", async () => {
  const { calls, port } = fixture(); const renew = port.renew; let count = 0;
  port.renew = async (request) => ++count === 1 ? renew(request) : null;
  await assert.rejects(withPublicationImportLease({ port, operation: async (_, assertLive) => {
    calls.push("stage"); await assertLive(); calls.push("activate");
  } }), (error) => error.code === "LOCAL_PUBLICATION_IMPORT_LEASE_UNAVAILABLE");
  assert.deepEqual(calls, ["acquire", "renew", "stage", "release"]);
});
test("failed publication still releases the exact owned lease", async () => {
  const { calls, port } = fixture();
  await assert.rejects(withPublicationImportLease({ port, operation: async () => { throw new Error("stage failed"); } }), /stage failed/);
  assert.equal(calls.at(-1), "release");
});
