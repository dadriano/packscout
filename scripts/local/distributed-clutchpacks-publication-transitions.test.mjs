import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  assertLocalClutchpacksV3Predecessor,
  bindLocalClutchpacksV3Predecessor,
  localClutchpacksManifestTransition,
  localClutchpacksProviderTransition,
} = await tsImport("./distributed-clutchpacks-publication-transitions.mts", import.meta.url);
const { DataReleaseV3ReleasePublisher } = await tsImport("@packscout/services", import.meta.url);

const epoch = (revision = 1) => ({
  configurationKey: "local-clutchpacks-distributed-v1",
  revision,
  publicChangeSequence: String(revision),
  configurationHash: String(revision).repeat(64),
});
const checkpoint = (sequence) => ({
  settledSequence: String(sequence),
  settledAt: "2026-08-29T22:00:00.000Z",
});
const proof = (revision = 1) => ({
  platformKey: "clutchpacks",
  publicProviderReleaseId: `provider-release-${revision}`,
  sharedConfigurationEpoch: epoch(revision),
});
function providerInput() {
  return {
    before: {
      platformKey: "clutchpacks",
      release: proof(),
      providerCheckpoint: checkpoint(78_502),
      observation: { sourceHeadSequence: "78502" },
    },
    expectedProof: proof(2),
    providerCheckpoint: checkpoint(78_519),
    observation: { sourceHeadSequence: "78519" },
  };
}
const refuses = (code) => (error) => error.code === code;

test("same local provider plan replays without writing another revision", () => {
  const input = providerInput();
  assert.equal(localClutchpacksProviderTransition({
    ...input,
    expectedProof: input.before.release,
    providerCheckpoint: input.before.providerCheckpoint,
    observation: input.before.observation,
  }), "replay");
});

test("new local provider output advances only after an actual ledger change", () => {
  const input = providerInput();
  const original = structuredClone(input.before);
  assert.equal(localClutchpacksProviderTransition(input), "publish");
  assert.deepEqual(input.before, original, "the prior immutable release remains unchanged");
  for (const sequence of [78_501, 78_502]) {
    assert.throws(() => localClutchpacksProviderTransition({
      ...input, providerCheckpoint: checkpoint(sequence),
    }), refuses("LOCAL_CONVEX_PROVIDER_CHECKPOINT_CONFLICT"));
  }
});

test("exact immutable content advances through reuse at a newer real checkpoint", () => {
  const input = providerInput();
  const original = structuredClone(input.before);
  assert.equal(localClutchpacksProviderTransition({
    ...input, expectedProof: input.before.release,
  }), "confirmReuse");
  assert.deepEqual(input.before, original);
  for (const sequence of [78_501, 78_502]) {
    assert.throws(() => localClutchpacksProviderTransition({
      ...input,
      expectedProof: input.before.release,
      providerCheckpoint: checkpoint(sequence),
    }), refuses("LOCAL_CONVEX_PROVIDER_CHECKPOINT_CONFLICT"));
  }
});

test("provider advancement refuses changed proof under the same identity and non-increasing epochs", () => {
  const input = providerInput();
  assert.throws(() => localClutchpacksProviderTransition({
    ...input,
    expectedProof: { ...input.expectedProof, publicProviderReleaseId: input.before.release.publicProviderReleaseId },
  }), refuses("LOCAL_CONVEX_PROVIDER_IDENTITY_CONFLICT"));
  assert.throws(() => localClutchpacksProviderTransition({
    ...input,
    expectedProof: { ...input.before.release, contentHash: "changed-public-content" },
  }), refuses("LOCAL_CONVEX_PROVIDER_IDENTITY_CONFLICT"));
  for (const changed of [{ revision: 1 }, { publicChangeSequence: "1" }]) {
    assert.throws(() => localClutchpacksProviderTransition({
      ...input,
      expectedProof: { ...input.expectedProof, sharedConfigurationEpoch: { ...epoch(2), ...changed } },
    }), refuses("LOCAL_CONVEX_PROVIDER_EPOCH_CONFLICT"));
  }
});

test("no-change source-head observations cannot invent provider or manifest sequence advancement", () => {
  const input = providerInput();
  assert.throws(() => localClutchpacksProviderTransition({
    ...input,
    expectedProof: input.before.release,
    providerCheckpoint: { ...input.before.providerCheckpoint, settledAt: "2026-08-29T22:10:00.000Z" },
    observation: { ...input.before.observation, lastSuccessfulObservationAt: "2026-08-29T22:10:00.000Z" },
  }), refuses("LOCAL_CONVEX_PROVIDER_CHECKPOINT_CONFLICT"));
  const manifest = manifestInput();
  assert.throws(() => localClutchpacksManifestTransition({
    ...manifest,
    manifest: manifest.before.activeManifest,
    observation: { ...manifest.before.observation,
      providerSelections: [{ platformKey: "clutchpacks", settledSourceFreshness: "fresh" }] },
  }), refuses("LOCAL_CONVEX_MANIFEST_OBSERVATION_CONFLICT"));
});

test("provider advancement refuses a foreign provider or nonlocal configuration", () => {
  for (const foreign of [
    { platformKey: "courtyard" },
    { release: { ...proof(), platformKey: "courtyard" } },
    { release: { ...proof(), sharedConfigurationEpoch: { ...epoch(), configurationKey: "production" } } },
  ]) {
    const input = providerInput();
    assert.throws(() => localClutchpacksProviderTransition({
      ...input, before: { ...input.before, ...foreign },
    }), refuses("LOCAL_CONVEX_PROVIDER_SCOPE_CONFLICT"));
  }
});

const observation = (sequence) => ({
  observationSequence: sequence,
  providerSelections: [{ platformKey: "clutchpacks" }],
});
function manifestInput() {
  return {
    before: {
      activeManifest: { publicReleaseId: "manifest-old", manifestFingerprint: "a".repeat(64), sharedConfigurationEpoch: epoch() },
      observation: observation(78_502),
    },
    manifest: { publicReleaseId: "manifest-new", manifestFingerprint: "b".repeat(64), sharedConfigurationEpoch: epoch(2) },
    observation: observation(78_519),
  };
}

test("manifest transitions select replay, forward activation, and same-reference refresh", () => {
  const input = manifestInput();
  assert.equal(localClutchpacksManifestTransition(input), "activateManifest");
  assert.equal(localClutchpacksManifestTransition({ ...input, before: { activeManifest: null } }), "activateManifest");
  assert.equal(localClutchpacksManifestTransition({ ...input, manifest: input.before.activeManifest }), "refreshActiveState");
  assert.equal(localClutchpacksManifestTransition({
    ...input, manifest: input.before.activeManifest, observation: input.before.observation,
  }), "replay");
});

test("manifest advancement refuses foreign or mixed provider predecessors", () => {
  for (const selections of [[{ platformKey: "courtyard" }],
    [{ platformKey: "clutchpacks" }, { platformKey: "courtyard" }]]) {
    const input = manifestInput();
    assert.throws(() => localClutchpacksManifestTransition({
      ...input, before: { ...input.before, observation: { ...input.before.observation, providerSelections: selections } },
    }), refuses("LOCAL_CONVEX_MANIFEST_SCOPE_CONFLICT"));
  }
});

test("manifest advancement refuses observation regression and conflicting immutable identity", () => {
  const input = manifestInput();
  assert.throws(() => localClutchpacksManifestTransition({
    ...input, observation: observation(78_502),
  }), refuses("LOCAL_CONVEX_MANIFEST_OBSERVATION_CONFLICT"));
  assert.throws(() => localClutchpacksManifestTransition({
    ...input, manifest: { ...input.manifest, publicReleaseId: input.before.activeManifest.publicReleaseId },
  }), refuses("LOCAL_CONVEX_ACTIVE_MANIFEST_CONFLICT"));
});

const v3State = () => ({
  generation: 1,
  activeRelease: { publicReleaseId: "v3-old", releaseFingerprint: "a".repeat(64), counts: { repacks: 2 } },
  previousRelease: null,
});
function predecessor() {
  return {
    state: v3State(), publicReleaseId: "v3-old", total: 2,
    rows: ["pack-a", "pack-b"].map((publicRepackId) => ({ publicRepackId, publicVendorId: "vendor-local", vendorKey: "clutchpacks" })),
    expectedPublicRepackIds: ["pack-b", "pack-a"],
    expectedPublicVendorId: "vendor-local",
  };
}

test("V3 predecessor requires the exact provider identity and full unfiltered pack set", () => {
  assert.doesNotThrow(() => assertLocalClutchpacksV3Predecessor(predecessor()));
  for (const override of [
    { publicReleaseId: "v3-concurrent" },
    { total: 3 },
    { rows: predecessor().rows.slice(0, 1) },
    { expectedPublicVendorId: "other-vendor" },
    { expectedPublicRepackIds: ["pack-a", "unknown-pack"] },
    { rows: predecessor().rows.map((row) => ({ ...row, vendorKey: "courtyard" })) },
  ]) {
    assert.throws(() => assertLocalClutchpacksV3Predecessor({ ...predecessor(), ...override }),
      refuses("LOCAL_CONVEX_DATA_RELEASE_V3_SCOPE_CONFLICT"));
  }
});

test("concurrent V3 pointer change between scope read and staging causes zero publication writes", async () => {
  let writes = 0;
  const expected = v3State();
  const port = bindLocalClutchpacksV3Predecessor({
    async activeState() { return { ...expected, generation: 2 }; },
    async start() { writes += 1; },
  }, expected);
  await assert.rejects(new DataReleaseV3ReleasePublisher(port).publish({}),
    (error) => error.stage === "active_state");
  assert.equal(writes, 0);
});

test("V3 activation preserves the inspected predecessor CAS and then permits readback", async () => {
  const expected = v3State();
  let current = expected;
  const activations = [];
  const port = bindLocalClutchpacksV3Predecessor({
    async activeState() { return current; },
    async activate(request) {
      activations.push(request);
      current = { ...expected, generation: 2, previousRelease: expected.activeRelease,
        activeRelease: { ...expected.activeRelease, publicReleaseId: "v3-new" } };
      return { result: "activated" };
    },
  }, expected);
  assert.deepEqual(await port.activeState(), expected);
  assert.throws(() => port.activate({ expectedActivePublicReleaseId: "unreviewed-v3" }),
    refuses("LOCAL_CONVEX_DATA_RELEASE_V3_CONFLICT"));
  assert.equal(activations.length, 0);
  await port.activate({ expectedActivePublicReleaseId: "v3-old" });
  assert.equal(activations.length, 1);
  assert.equal((await port.activeState()).activeRelease.publicReleaseId, "v3-new");
});
