import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { migrateLocalConvexEv, withLocalConvexEvReady } =
  await tsImport("./local-convex-ev-migration.mts", import.meta.url);

const releaseId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const pointer = (index, repacks) => ({ publicReleaseId: releaseId(index), counts: { repacks },
  releaseFingerprint: String(index).repeat(64), completedAt: "2026-08-30T00:00:00.000Z" });
function harness(options = {}) {
  const state = { expectedGeneration: 2, expectedActivePublicReleaseId: releaseId(2),
    expectedPreviousPublicReleaseId: releaseId(1), activeRelease: pointer(2, 2),
    previousRelease: pointer(1, 65), initialized: false, ...options.state };
  const scope = () => ({ expectedGeneration: state.expectedGeneration,
    expectedActivePublicReleaseId: state.expectedActivePublicReleaseId,
    expectedPreviousPublicReleaseId: state.expectedPreviousPublicReleaseId });
  const statuses = new Map([state.previousRelease, state.activeRelease].filter(Boolean).map((target) =>
    [target.publicReleaseId, { publicReleaseId: target.publicReleaseId, count: 0, nextCursor: null, complete: false }]));
  const calls = [];
  let failAfterPage = options.failAfterPage;
  const client = {
    async call(operation, args) {
      calls.push({ operation, args: structuredClone(args) });
      await options.beforeCall?.({ operation, args, state, statuses });
      if (operation === "state") return structuredClone(state);
      const target = [state.previousRelease, state.activeRelease].find((row) => row?.publicReleaseId === args.publicReleaseId);
      assert.ok(target);
      const status = statuses.get(target.publicReleaseId);
      if (operation === "progress") return { ...status, ...scope() };
      assert.deepEqual({ expectedGeneration: args.expectedGeneration,
        expectedActivePublicReleaseId: args.expectedActivePublicReleaseId,
        expectedPreviousPublicReleaseId: args.expectedPreviousPublicReleaseId }, scope());
      if (operation === "page") {
        assert.equal(args.afterPublicRepackId, status.nextCursor);
        status.count = Math.min(target.counts.repacks, status.count + 32);
        status.nextCursor = status.count === 0 ? null : releaseId(status.count);
        status.complete = status.count === target.counts.repacks;
        if (failAfterPage) { failAfterPage = false; throw new Error("connection lost after commit"); }
        return structuredClone(status);
      }
      assert.equal(operation, "initialize");
      assert.ok([...statuses.values()].every(({ complete }) => complete));
      state.initialized = true;
      return { initialized: true };
    },
    async verifyPublicRead(id) {
      calls.push({ operation: "public", id });
      assert.equal(id, state.expectedActivePublicReleaseId);
      assert.equal(state.initialized, true);
      await options.publicRead?.(state);
    },
  };
  return { client, calls, state, statuses };
}

test("migrates previous then active with fixed CAS pins and verifies public reads only after initialization", async () => {
  const h = harness();
  const before = structuredClone(h.state);
  assert.equal((await migrateLocalConvexEv(h.client)).status, "ready");
  assert.deepEqual(h.calls.map(({ operation }) => operation),
    ["state", "progress", "page", "page", "page", "progress", "page", "initialize", "state", "public", "state"]);
  assert.deepEqual(h.calls.filter(({ operation }) => operation === "page").map(({ args }) => args.publicReleaseId),
    [releaseId(1), releaseId(1), releaseId(1), releaseId(2)]);
  assert.deepEqual({ ...h.state, initialized: false }, before);
});

test("resumes after a committed page loses its acknowledgement without rewriting completed rows", async () => {
  const h = harness({ failAfterPage: true });
  await assert.rejects(migrateLocalConvexEv(h.client), /connection lost/u);
  assert.equal(h.statuses.get(releaseId(1)).count, 32);
  assert.equal(h.calls.some(({ operation }) => operation === "public"), false);
  assert.equal((await migrateLocalConvexEv(h.client)).status, "ready");
  const pages = h.calls.filter(({ operation }) => operation === "page");
  assert.equal(pages[1].args.afterPublicRepackId, releaseId(32));
});

test("check-only on a populated legacy target is read-only and blocks all publication side effects", async () => {
  const h = harness();
  assert.equal((await migrateLocalConvexEv(h.client, { checkOnly: true })).status, "migration_required");
  let published = false;
  await assert.rejects(withLocalConvexEvReady(h.client, async () => { published = true; }), /MIGRATION_REQUIRED/u);
  assert.equal(published, false);
  assert.deepEqual(h.calls.map(({ operation }) => operation), ["state", "state"]);
});

test("already initialized targets verify readiness without backfill or initialization writes", async () => {
  const h = harness({ state: { initialized: true } });
  assert.equal(await withLocalConvexEvReady(h.client, async () => "published"), "published");
  assert.deepEqual(h.calls.map(({ operation }) => operation), ["state", "state", "public", "state"]);
});

test("an empty deployment is ready without a public predecessor or any writes", async () => {
  const h = harness({ state: { initialized: true, expectedGeneration: 0,
    expectedActivePublicReleaseId: null, expectedPreviousPublicReleaseId: null,
    activeRelease: null, previousRelease: null } });
  assert.equal((await migrateLocalConvexEv(h.client)).status, "ready");
  assert.ok(h.calls.every(({ operation }) => operation === "state"));
});

test("progress pointer drift cannot replace the original scope or reach a mutation", async () => {
  const h = harness({ beforeCall({ operation, state }) { if (operation === "progress") state.expectedGeneration += 1; } });
  await assert.rejects(migrateLocalConvexEv(h.client), /POINTER_CHANGED/u);
  assert.deepEqual(h.calls.map(({ operation }) => operation), ["state", "progress"]);
});

test("release proof changes after initialization or public read refuse successful completion", async () => {
  for (const atRead of [false, true]) {
    const mutate = (state) => { state.activeRelease.completedAt = "2026-08-30T00:01:00.000Z"; };
    const h = harness({
      beforeCall({ operation, state }) { if (!atRead && operation === "state" && state.initialized) mutate(state); },
      publicRead: atRead ? mutate : undefined,
    });
    await assert.rejects(migrateLocalConvexEv(h.client), /POINTER_CHANGED/u);
  }
});

test("sealed facts alone are not ready if initialization does not complete", async () => {
  const h = harness();
  const call = h.client.call;
  h.client.call = async (operation, args) => operation === "initialize" ? { initialized: true } : call(operation, args);
  await assert.rejects(migrateLocalConvexEv(h.client), /MIGRATION_REQUIRED/u);
  assert.equal(h.calls.some(({ operation }) => operation === "public"), false);
});

test("readiness lost after public verification cannot report ready", async () => {
  const h = harness({ state: { initialized: true }, publicRead(state) { state.initialized = false; } });
  await assert.rejects(migrateLocalConvexEv(h.client), /MIGRATION_REQUIRED/u);
});

test("malformed or nonadvancing progress fails instead of looping or initializing partial facts", async () => {
  for (const response of [{ count: 0, nextCursor: null, complete: false },
    { count: 1, nextCursor: releaseId(1), complete: true }]) {
    const h = harness();
    const call = h.client.call;
    h.client.call = async (operation, args) => operation === "page"
      ? { ...response, publicReleaseId: args.publicReleaseId } : call(operation, args);
    await assert.rejects(migrateLocalConvexEv(h.client), /MIGRATION_INVALID/u);
    assert.equal(h.calls.some(({ operation }) => operation === "initialize"), false);
  }
});
