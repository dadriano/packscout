import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { withLocalClutchpacksWitnessReady, localClutchpacksRetainedEvWitnessRequest,
  assertLocalClutchpacksWitnessUnchanged } = await tsImport("./distributed-clutchpacks-ev-witness.mts", import.meta.url);
const releaseId = "10000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);
const scope = { publicRepackId: "00000000-0000-5000-8000-000000000001",
  publicVendorId: "00000000-0000-5000-8000-000000000002", vendorKey: "clutchpacks" };
const retention = { operationId: "fixture-transition", direction: "forward", changesSha256: "b".repeat(64) };
const state = { generation: 3, activeRelease: { publicReleaseId: releaseId, releaseFingerprint: fingerprint }, previousRelease: null };
const refused = (error) => error.code === "LOCAL_CONVEX_PUBLIC_READBACK_FAILED";

test("genesis and existing releases require signed readiness before any publication callback", async () => {
  for (const active of [state, { generation: 0, activeRelease: null, previousRelease: null }]) {
    const events = [];
    await withLocalClutchpacksWitnessReady({
      async activeState() { events.push("active"); return active; },
      async retainedEvWitnessReadiness(request) {
        events.push("readiness");
        assert.deepEqual(request, { expectedGeneration: active.generation,
          expectedActivePublicReleaseId: active.activeRelease?.publicReleaseId ?? null,
          expectedActiveReleaseFingerprint: active.activeRelease?.releaseFingerprint ?? null });
        return { generation: active.generation, activePublicReleaseId: active.activeRelease?.publicReleaseId ?? null,
          activeReleaseFingerprint: active.activeRelease?.releaseFingerprint ?? null,
          retention: active.activeRelease === null ? null : retention };
      },
    }, async (observed) => { assert.deepEqual(observed, active); events.push("publish"); });
    assert.deepEqual(events, ["active", "readiness", "publish"]);
    let writes = 0;
    await assert.rejects(withLocalClutchpacksWitnessReady({ async activeState() { return active; },
      async retainedEvWitnessReadiness() { throw new Error("old-backend-404"); } }, async () => { writes++; }));
    assert.equal(writes, 0);
  }
});

test("incoherent readiness and mismatched generation/identity refuse before publication", async () => {
  const ready = { generation: 3, activePublicReleaseId: releaseId, activeReleaseFingerprint: fingerprint, retention };
  for (const patch of [{ generation: 4 }, { activePublicReleaseId: null }, { activeReleaseFingerprint: "c".repeat(64) },
    { retention: null }, { retention: { ...retention, changesSha256: "bad" } }]) {
    let writes = 0;
    await assert.rejects(withLocalClutchpacksWitnessReady({ async activeState() { return state; },
      async retainedEvWitnessReadiness() { return { ...ready, ...patch }; } }, async () => { writes++; }), refused);
    assert.equal(writes, 0);
  }
});

test("post-publication witness requests pin exact candidate generation and bounded unique scopes", () => {
  const input = { publicReleaseId: releaseId, releaseFingerprint: fingerprint, rows: [scope], state };
  assert.deepEqual(localClutchpacksRetainedEvWitnessRequest(input), {
    expectedActivePublicReleaseId: releaseId, expectedActiveReleaseFingerprint: fingerprint,
    expectedGeneration: 3, scopes: [scope],
  });
  for (const patch of [{ rows: [] }, { rows: [scope, scope] },
    { state: { ...state, generation: 0 } }, { releaseFingerprint: "b".repeat(64) },
    { publicReleaseId: "10000000-0000-4000-8000-000000000009" },
    { rows: Array.from({ length: 101 }, (_, i) => ({ ...scope,
      publicRepackId: `00000000-0000-5000-8000-${String(i).padStart(12, "0")}` })) }]) {
    assert.throws(() => localClutchpacksRetainedEvWitnessRequest({ ...input, ...patch }), refused);
  }
});

test("second signed witness rejects a changed generation, retained transition, or digest", () => {
  const first = { generation: 3, retention, witnessSha256: "a".repeat(64) };
  assertLocalClutchpacksWitnessUnchanged(first, structuredClone(first));
  for (const patch of [{ generation: 4 }, { retention: { ...retention, direction: "reverse" } },
    { witnessSha256: "b".repeat(64) }]) {
    assert.throws(() => assertLocalClutchpacksWitnessUnchanged(first, { ...first, ...patch }), refused);
  }
});
