import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  ClutchpacksReplayPreparationError,
  prepareClutchpacksDataforrestReplay,
  safeClutchpacksReplayPreparationError,
} = await tsImport(
  "./prepare-clutchpacks-dataforrest-replay-plan.mts",
  import.meta.url,
);

const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "10000000-0000-4000-8000-000000000002";
const operatorId = "10000000-0000-4000-8000-000000000003";
const v3Id = "10000000-0000-4000-8000-000000000004";
const v4Id = "10000000-0000-4000-8000-000000000005";

function central(phase = "v3_active") {
  const v4 = phase !== "v3_active";
  return {
    phase,
    organizationId,
    providerId,
    providerKey: "clutchpacks",
    operatorId,
    configVersionId: v4 ? v4Id : v3Id,
    configVersionNumber: v4 ? 4n : 3n,
    providerRowVersion: phase === "v4_active" ? 8n : 7n,
    topologyVersion: 2n,
  };
}

function provider(overrides = {}) {
  return {
    providerId,
    providerKey: "clutchpacks",
    runtimeState: "error",
    runtimeGeneration: 4n,
    cachedConfigVersionId: v3Id,
    cachedConfigVersionNumber: 3n,
    activeRunId: null,
    leaseDisposition: "unowned",
    cursorCleared: false,
    exactResumeEvidence: false,
    ...overrides,
  };
}

function proof() {
  return {
    configVersionId: v4Id,
    providerRowVersion: 7n,
    topologyVersion: 2n,
    databaseNodeId: "10000000-0000-4000-8000-000000000006",
    databaseNodeRowVersion: 1n,
    databaseCredentialVersionId:
      "10000000-0000-4000-8000-000000000007",
    sourceCredentialVersionId:
      "10000000-0000-4000-8000-000000000008",
    observedProviderSchemaVersion: "distributed-provider-v1",
    durationMilliseconds: 12,
    responseStatus: 200,
    responseBytes: 400,
    recordCount: 1,
  };
}

function harness(input = {}) {
  let centralState = input.centralState ?? central();
  let providerState = input.providerState ?? provider();
  const calls = [];
  const dependencies = {
    async inspectCentral() {
      calls.push("inspect_central");
      return centralState;
    },
    async inspectProvider() {
      calls.push("inspect_provider");
      return providerState;
    },
    async acquireLease() {
      calls.push("acquire_lease");
      providerState = { ...providerState, leaseDisposition: "owned" };
      return { fence: 9n };
    },
    async renewLease(_central, lease) {
      calls.push("renew_lease");
      assert.equal(providerState.leaseDisposition, "owned");
      return lease;
    },
    async releaseLease() {
      calls.push("release_lease");
      providerState = { ...providerState, leaseDisposition: "unowned" };
      return true;
    },
    async appendV4(expected) {
      calls.push("append_v4");
      assert.equal(expected.phase, "v3_active");
      centralState = central("v4_candidate");
      return centralState;
    },
    async testV4(candidate) {
      calls.push("test_v4");
      assert.equal(candidate.phase, "v4_candidate");
      if (input.failTest) throw new Error("protected upstream failure");
      return proof();
    },
    async activateV4(candidate, tested) {
      calls.push("activate_v4");
      assert.equal(candidate.phase, "v4_candidate");
      assert.equal(tested.configVersionId, v4Id);
      centralState = central("v4_active");
      return centralState;
    },
    async synchronizeProvider(active) {
      calls.push("synchronize_provider");
      assert.equal(active.phase, "v4_active");
      providerState = {
        ...providerState,
        cachedConfigVersionId: v4Id,
        cachedConfigVersionNumber: 4n,
        cursorCleared: true,
      };
      return providerState;
    },
    async resumeProvider(active, current) {
      calls.push("resume_provider");
      assert.equal(active.phase, "v4_active");
      assert.equal(current.runtimeState, "error");
      providerState = {
        ...providerState,
        runtimeState: "idle",
        runtimeGeneration: providerState.runtimeGeneration + 1n,
        exactResumeEvidence: true,
      };
      return providerState;
    },
  };
  return { calls, dependencies };
}

test("fresh v3 preparation copies, tests, activates, clears, and resumes in order", async () => {
  const fixture = harness();
  const result = await prepareClutchpacksDataforrestReplay(
    fixture.dependencies,
  );

  assert.deepEqual(result, {
    outcome: "prepared",
    providerId,
    providerKey: "clutchpacks",
    configVersionId: v4Id,
    configVersionNumber: 4,
    runtimeState: "idle",
    cursorState: "cleared",
  });
  assert.deepEqual(fixture.calls, [
    "inspect_central",
    "inspect_provider",
    "acquire_lease",
    "inspect_provider",
    "append_v4",
    "renew_lease",
    "test_v4",
    "renew_lease",
    "activate_v4",
    "renew_lease",
    "synchronize_provider",
    "renew_lease",
    "resume_provider",
    "release_lease",
    "inspect_central",
    "inspect_provider",
  ]);
});

test("a committed v4 candidate resumes at the bounded exact test", async () => {
  const fixture = harness({
    centralState: central("v4_candidate"),
  });
  await prepareClutchpacksDataforrestReplay(fixture.dependencies);
  assert.equal(fixture.calls.includes("append_v4"), false);
  assert.equal(fixture.calls.includes("test_v4"), true);
  assert.equal(fixture.calls.includes("activate_v4"), true);
});

test("central v4 with provider v3 resumes at provider synchronization", async () => {
  const fixture = harness({
    centralState: central("v4_active"),
    providerState: provider({ cursorCleared: false }),
  });
  await prepareClutchpacksDataforrestReplay(fixture.dependencies);
  assert.equal(fixture.calls.includes("append_v4"), false);
  assert.equal(fixture.calls.includes("test_v4"), false);
  assert.equal(fixture.calls.includes("activate_v4"), false);
  assert.equal(fixture.calls.includes("synchronize_provider"), true);
  assert.equal(fixture.calls.includes("resume_provider"), true);
});

test("a crash after audited resume reclaims only its own lease and releases it", async () => {
  const fixture = harness({
    centralState: central("v4_active"),
    providerState: provider({
      runtimeState: "idle",
      runtimeGeneration: 5n,
      cachedConfigVersionId: v4Id,
      cachedConfigVersionNumber: 4n,
      leaseDisposition: "owned",
      cursorCleared: true,
      exactResumeEvidence: true,
    }),
  });
  const result = await prepareClutchpacksDataforrestReplay(
    fixture.dependencies,
  );
  assert.equal(result.outcome, "prepared");
  assert.equal(fixture.calls.includes("synchronize_provider"), false);
  assert.equal(fixture.calls.includes("resume_provider"), false);
  assert.deepEqual(fixture.calls, [
    "inspect_central",
    "inspect_provider",
    "acquire_lease",
    "inspect_provider",
    "release_lease",
    "inspect_central",
    "inspect_provider",
  ]);
});

test("an exact completed rerun performs no writes", async () => {
  const fixture = harness({
    centralState: central("v4_active"),
    providerState: provider({
      runtimeState: "idle",
      runtimeGeneration: 5n,
      cachedConfigVersionId: v4Id,
      cachedConfigVersionNumber: 4n,
      cursorCleared: true,
      exactResumeEvidence: true,
    }),
  });
  const result = await prepareClutchpacksDataforrestReplay(
    fixture.dependencies,
  );
  assert.equal(result.outcome, "already_prepared");
  assert.deepEqual(fixture.calls, ["inspect_central", "inspect_provider"]);
});

test("active runs and foreign leases refuse before mutation", async () => {
  for (const [overrides, code] of [
    [{ activeRunId: "10000000-0000-4000-8000-000000000009" },
      "REPLAY_PROVIDER_BUSY"],
    [{ leaseDisposition: "foreign" }, "REPLAY_PROVIDER_LEASE_HELD"],
  ]) {
    const fixture = harness({ providerState: provider(overrides) });
    await assert.rejects(
      prepareClutchpacksDataforrestReplay(fixture.dependencies),
      (error) => error instanceof ClutchpacksReplayPreparationError
        && error.code === code,
    );
    assert.deepEqual(fixture.calls, ["inspect_central", "inspect_provider"]);
  }
});

test("a failed bounded test releases the owned provider lease and masks detail", async () => {
  const fixture = harness({ failTest: true });
  await assert.rejects(
    prepareClutchpacksDataforrestReplay(fixture.dependencies),
    (error) => error instanceof ClutchpacksReplayPreparationError
      && error.code === "REPLAY_V4_TEST_FAILED"
      && !String(error).includes("protected upstream failure"),
  );
  assert.equal(fixture.calls.at(-1), "release_lease");

  const safe = safeClutchpacksReplayPreparationError(
    new Error("secret database URL"),
  );
  assert.equal(safe.code, "CLUTCHPACKS_REPLAY_PREPARATION_FAILED");
  assert.doesNotMatch(String(safe), /secret database URL/u);
});
