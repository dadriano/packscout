import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { tsImport } from "tsx/esm/api";
import { optionsFixture } from "./clutchpacks-production-source.test-support.mjs";
const { createProductionSourceController, ClutchpacksProductionSourceError } = await tsImport("./clutchpacks-production-source-controller.mts", import.meta.url);
function deferred() { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; }
function fixture() {
  const options = optionsFixture(), calls = { authority: 0, state: 0, catalog: 0, acquire: 0, renew: 0, release: 0, cleanup: 0, close: 0 };
  const authority = { digest: "a".repeat(64), route: {} }, checkpoint = { promotionSequence: 1n };
  const current = { digest: "b".repeat(64), checkpoint, observation: { qualityState: "degraded", quarantineCount: 465 }, leaseValidThrough: null };
  const catalog = { catalogDigest: "c".repeat(64), facts: { activeCollectibleCount: 6718 }, canonicalCatalog: { collectibles: [{ id: "nonmember" }] } };
  const lease = { role: "import", owner: "publication:fixture", fence: 8n, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 90_000), rowVersion: 1n };
  const hooks = { authority: async () => {}, state: async () => {}, snapshot: async () => {}, cleanup: async () => true };
  const ports = {
    authority: async pinned => { calls.authority++; await hooks.authority(pinned, calls.authority); return authority; },
    state: async () => { calls.state++; await hooks.state(calls.state); return { ...current }; },
    snapshot: async () => { calls.catalog++; await hooks.snapshot(); return { current: { ...current }, catalog }; },
    leases: () => ({ acquire: async request => { calls.acquire++; assert.equal(request.role, "import"); assert.equal(request.owner, lease.owner); return { kind: "acquired", lease }; },
      renew: async request => { calls.renew++; assert.equal(request.role, "import"); assert.equal(request.fence, lease.fence); return lease; },
      release: async request => { calls.release++; assert.equal(request.role, "import"); assert.equal(request.fence, lease.fence); return true; } }),
    cleanup: async (_input, _authority, token) => { calls.cleanup++; assert.deepEqual(token, { role: "import", owner: lease.owner, fence: lease.fence }); return hooks.cleanup(); },
    close: async () => { calls.close++; },
  };
  const reader = createProductionSourceController(options, ports);
  return { reader, options, calls, hooks, current, catalog, lease, authority };
}
test("full read freezes caller pins; metadata-only checks never reload the complete catalog or acquire leases", async () => {
  const f = fixture(), original = { ...f.options.scope }, gate = deferred();
  f.hooks.authority = async pinned => { await gate.promise; assert.deepEqual(pinned.scope, original); assert.equal(pinned.approvedPublicAssetOrigins.length, 1); };
  const first = f.reader.read(); f.options.scope.providerId = "mutated"; f.options.expected.checkpointHash = "mutated"; f.options.approvedPublicAssetOrigins.push("https://foreign.test");
  gate.release(); assert.equal((await first).facts.activeCollectibleCount, 6718);
  await f.reader.assertQuiet(); await f.reader.assertQuiet();
  assert.equal(f.calls.catalog, 1); assert.equal(f.calls.acquire, 0); assert.equal(f.calls.release, 0);
  await f.reader.close(); assert.equal(f.calls.close, 1);
});
test("full read refuses drift visible only in the fresh post-catalog transaction", async () => {
  const f = fixture(); f.hooks.state = async () => { f.current.digest = "d".repeat(64); };
  await assert.rejects(f.reader.read(), /PRODUCTION_SOURCE_CHANGED_DURING_READ/);
  await assert.rejects(f.reader.assertQuiet(), /PRODUCTION_SOURCE_FULL_READ_REQUIRED/);
  assert.equal(f.calls.acquire, 0); await f.reader.close();
});
test("subsequent full read binds nonmembership catalog changes even with unchanged highwater", async () => {
  const f = fixture(); await f.reader.read(); f.catalog.catalogDigest = "e".repeat(64);
  await assert.rejects(f.reader.read(), /PRODUCTION_SOURCE_CATALOG_CHANGED/); await f.reader.close();
});
test("same source highwater may be checked cheaply while holding only this reader's acquired normal lease", async () => {
  const f = fixture(); await f.reader.read();
  await assert.rejects(f.reader.assertQuiet({ expectedImportLease: f.lease }), /PRODUCTION_SOURCE_IMPORT_LEASE_NOT_ACQUIRED_HERE/);
  await f.reader.leasePort.acquire({ role: "import", owner: f.lease.owner, leaseMilliseconds: 90_000 });
  await f.reader.assertQuiet({ expectedImportLease: f.lease }); await f.reader.leasePort.renew({ ...f.lease, leaseMilliseconds: 90_000 });
  assert.equal(f.calls.catalog, 1); await f.reader.leasePort.release(f.lease); await f.reader.close();
  assert.equal(f.calls.acquire, 1); assert.equal(f.calls.renew, 1); assert.equal(f.calls.release, 1);
});
test("a delayed final central authority check cannot return a stale lease proof", async () => {
  const f = fixture(); await f.reader.read(); await f.reader.leasePort.acquire({ role: "import", owner: f.lease.owner, leaseMilliseconds: 90_000 });
  const start = f.calls.authority;
  f.hooks.state = async () => { f.current.leaseValidThrough = performance.now() + 5; };
  f.hooks.authority = async (_pinned, count) => { if (count === start + 3) await new Promise(resolve => setTimeout(resolve, 12)); };
  await assert.rejects(f.reader.assertQuiet({ expectedImportLease: f.lease }), /PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE/);
  assert.equal(f.calls.catalog, 1); await f.reader.close(); assert.equal(f.calls.release, 0);
});
test("single-flight refuses overlap and close drains an active read before closing owned clients", async () => {
  const f = fixture(), gate = deferred(); f.hooks.snapshot = async () => gate.promise;
  const read = f.reader.read(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.reader.read(), /PRODUCTION_SOURCE_CLOSED_OR_BUSY/);
  const close = f.reader.close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.close, 0);
  gate.release(); await read; await close; await f.reader.close(); assert.equal(f.calls.close, 1);
  await assert.rejects(f.reader.read(), /PRODUCTION_SOURCE_CLOSED_OR_BUSY/);
});
test("dependency messages containing credentials are not exposed", async () => {
  const f = fixture(); f.hooks.snapshot = async () => { throw new Error("postgresql://fake-secret@fake-host/raw-cursor"); };
  await assert.rejects(f.reader.read(), error => error.code === "PRODUCTION_SOURCE_READ_UNAVAILABLE" && error.message === error.code);
  await f.reader.close();
});
test("actual orchestration compensates known lease after metadata failure, but refuses unprovable cleanup", async () => {
  for (const provable of [true, false]) {
    const f = fixture(); await f.reader.read();
    f.hooks.state = async () => { if (f.calls.acquire) throw new ClutchpacksProductionSourceError("PRODUCTION_SOURCE_HEAD_OR_RUNTIME_CHANGED"); };
    f.hooks.cleanup = async () => provable;
    await assert.rejects(f.reader.leasePort.acquire({ role: "import", owner: f.lease.owner, leaseMilliseconds: 90_000 }),
      provable ? /PRODUCTION_SOURCE_HEAD_OR_RUNTIME_CHANGED/ : /PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED/);
    assert.equal(f.calls.acquire, 1); assert.equal(f.calls.cleanup, 1); await f.reader.close(); assert.equal(f.calls.release, 0);
  }
});
test("actual lease-port request role/owner cannot mutate during authority admission", async () => {
  const f = fixture(); await f.reader.read(); const gate = deferred(); f.hooks.authority = async () => gate.promise;
  const request = { role: "import", owner: f.lease.owner, leaseMilliseconds: 90_000 };
  const work = f.reader.leasePort.acquire(request); request.role = "promotion"; request.owner = "foreign"; gate.release();
  await work; assert.equal(f.calls.acquire, 1); await f.reader.close();
});
