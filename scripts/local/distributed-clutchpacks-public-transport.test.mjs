import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { tsImport } from "tsx/esm/api";
const { readLocalClutchpacksPublicSurfaces, readLocalClutchpacksV3List } = await tsImport(
  "./distributed-clutchpacks-public-transport.mts", import.meta.url);
const { buildPublicRepackListPageV3, buildPublicDashboardBundleV3, buildPublicShellStatusV3 } = await tsImport(
  "../../packages/contracts/src/__fixtures__/data-release-v3.fixture.ts", import.meta.url);

function fixture(mutate = () => {}) {
  const calls = [];
  return { calls, client: {
    async query(ref, args) { calls.push({ kind: "query", path: getFunctionName(ref), args }); return { ok: true }; },
    async action(ref, args) {
      const path = getFunctionName(ref); calls.push({ kind: "action", path, args });
      const data = path.endsWith("listPublicRepacksV3")
        ? { ...buildPublicRepackListPageV3(), range: { start: 1, end: 2, total: 2 } }
        : path.endsWith("getDashboardBundleV3") ? buildPublicDashboardBundleV3() : buildPublicShellStatusV3();
      mutate(data, path);
      return { ok: true, data };
    },
  } };
}

test("distributed publication uses trusted V3 actions without caller clocks, preserving manifest queries", async () => {
  const h = fixture();
  const result = await readLocalClutchpacksPublicSurfaces(h.client, "fixture-catalog-read-token");
  assert.deepEqual(h.calls.map(({ kind, path }) => [kind, path]), [
    ["query", "publicRepacks:getPublicShellStatus"], ["query", "publicRepacks:listPublicRepacks"],
    ["action", "publicRepacksV3:getPublicShellStatusV3"], ["action", "publicRepacksV3:listPublicRepacksV3"],
    ["action", "publicRepacksV3:getDashboardBundleV3"],
  ]);
  for (const call of h.calls) {
    assert.equal(call.args.catalogReadToken, "fixture-catalog-read-token");
    if (call.kind === "action") assert.equal(Object.hasOwn(call.args, "currentTime"), false);
  }
  assert.equal(result.v3List.data.confidenceEvaluatedAt, buildPublicRepackListPageV3().confidenceEvaluatedAt);
  assert.equal(result.dashboard.data.confidenceEvaluatedAt, buildPublicDashboardBundleV3().confidenceEvaluatedAt);
});

test("predecessor reads also use the action and reject absent or forged trusted projection clocks", async () => {
  for (const mutate of [
    (data) => { delete data.confidenceEvaluatedAt; },
    (data) => { data.publicFreshnessPolicyVersion = "other-policy"; },
    (data) => { data.confidenceEvaluatedAt = "2099-01-01T00:00:00.000Z"; },
    (data) => { data.providerHealthEvaluatedAt = "2000-01-01T00:00:00.000Z"; },
    (data) => { data.details[0].evEstimates.packScout.confidenceEvaluatedAt = "2099-01-01T00:00:00.000Z"; },
    (data) => { data.rows[0].packScoutPresentation = data.rows[0].evEstimates.packScout; },
  ]) {
    const h = fixture(mutate);
    await assert.rejects(readLocalClutchpacksV3List(h.client));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].kind, "action");
    assert.equal(Object.hasOwn(h.calls[0].args, "currentTime"), false);
  }
});
