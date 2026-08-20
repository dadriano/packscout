import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
} from "@packscout/contracts";
import { DataReleaseV3PublisherError } from "./buyback-adjusted-ev-release-publisher.ts";
import { InMemoryDataReleaseV3Port } from "./buyback-adjusted-ev-release.test-support.ts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  type DataReleaseV3ActiveState,
  type DataReleaseV3Pointer,
  type DataReleaseV3PublicationPort,
} from "./buyback-adjusted-ev-release-types.ts";
import {
  PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
  PackScoutBuybackEvSimulationGuardError,
  PackScoutBuybackEvSimulationWriteGateV1,
  assertPackScoutBuybackEvSimulationActiveReleaseV1,
  assertPackScoutBuybackEvSimulationEventTimeV1,
  assertPackScoutBuybackEvSimulationFrameSequenceV1,
  assertPackScoutBuybackEvSimulationLoopbackUrlV1,
  assertPackScoutBuybackEvSimulationProtocolVersionsV1,
  assertPackScoutBuybackEvSimulationReleaseIdV1,
  assertPackScoutBuybackEvSimulationSha256V1,
  isPackScoutBuybackEvSimulatedPublicIdV1,
  packScoutBuybackEvSimulatedUuidV1,
  validatePackScoutBuybackEvSimulationControlsV1,
  type PackScoutBuybackEvSimulationControlsV1,
} from "./buyback-adjusted-ev-simulation-contracts.ts";
import {
  PackScoutBuybackEvSimulator,
  openPackScoutBuybackEvSimulationSessionV1,
} from "./buyback-adjusted-ev-simulation-runner.ts";

const LOCAL_ORIGIN = "http://127.0.0.1:3211";

const CONTROLS: PackScoutBuybackEvSimulationControlsV1 = {
  seed: "sim-guards",
  scenarioVersion: PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
  startAt: "2026-08-19T12:00:00.000Z",
  frameStepMilliseconds: 30 * 60_000,
};

const SUPPORTED_VERSIONS = {
  publicationSchemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  scenarioVersion: PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
} as const;

function guardCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof PackScoutBuybackEvSimulationGuardError) {
      return error.code;
    }
    throw error;
  }
}

function pointer(publicReleaseId: string): DataReleaseV3Pointer {
  return {
    publicReleaseId,
    releaseFingerprint: "a".repeat(64),
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    dataAsOf: "2026-08-19T12:00:00.000Z",
    completedAt: "2026-08-19T12:00:01.000Z",
    counts: {
      categories: 1,
      collectibles: 1,
      repacks: 1,
      chases: 1,
      searchShards: 1,
    },
  };
}

function activeState(
  activeRelease: DataReleaseV3Pointer | null,
): DataReleaseV3ActiveState {
  return { generation: 1, activeRelease, previousRelease: null };
}

test("local and cloud service URL guards accept only a root HTTP loopback origin", () => {
  assert.equal(
    assertPackScoutBuybackEvSimulationLoopbackUrlV1("http://127.0.0.1:3211"),
    "http://127.0.0.1:3211",
  );
  assert.equal(
    assertPackScoutBuybackEvSimulationLoopbackUrlV1("http://localhost:3211/"),
    "http://localhost:3211",
  );
  for (const url of [
    "https://127.0.0.1:3211",
    "https://happy-animal-123.convex.cloud",
    "http://packscout.example",
    "http://127.0.0.1:3211/internal",
    "http://user:secret@127.0.0.1:3211",
    "http://127.0.0.1:3211/?debug=1",
    "not-a-url",
  ]) {
    assert.equal(
      guardCode(() => assertPackScoutBuybackEvSimulationLoopbackUrlV1(url)),
      "NON_LOOPBACK_SERVICE_URL",
      url,
    );
  }
});

test("exact protocol versions are required before any simulation write", () => {
  assertPackScoutBuybackEvSimulationProtocolVersionsV1(SUPPORTED_VERSIONS);
  for (const overrides of [
    { publicationSchemaVersion: "data_release_v2" },
    { methodVersion: "packscout-estimated-ev-v1" },
    { confidencePolicyVersion: "some-other-policy" },
    { scenarioVersion: "packscout-buyback-ev-simulation-scenarios-v2" },
  ]) {
    assert.equal(
      guardCode(() =>
        assertPackScoutBuybackEvSimulationProtocolVersionsV1({
          ...SUPPORTED_VERSIONS,
          ...overrides,
        }),
      ),
      "UNSUPPORTED_PROTOCOL_VERSION",
    );
  }
});

test("canonical release targets are refused while simulated lineage is allowed", () => {
  const simulated = packScoutBuybackEvSimulatedUuidV1("release", { n: 1 });
  assert.ok(isPackScoutBuybackEvSimulatedPublicIdV1(simulated));
  assertPackScoutBuybackEvSimulationActiveReleaseV1(
    activeState(null),
    new Set(),
  );
  assertPackScoutBuybackEvSimulationActiveReleaseV1(
    activeState(pointer(simulated)),
    new Set([simulated]),
  );
  assert.equal(
    guardCode(() =>
      assertPackScoutBuybackEvSimulationActiveReleaseV1(
        activeState(pointer("11111111-2222-4333-8444-555555555555")),
        new Set([simulated]),
      ),
    ),
    "CANONICAL_RELEASE_TARGET",
  );
  assert.equal(
    guardCode(() =>
      assertPackScoutBuybackEvSimulationActiveReleaseV1(
        activeState({
          ...pointer(simulated),
          methodVersion:
            "packscout-estimated-ev-v1" as typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        }),
        new Set([simulated]),
      ),
    ),
    "UNSUPPORTED_PROTOCOL_VERSION",
  );
});

test("frame sequence gaps, malformed hashes, and future event time are refused", () => {
  assertPackScoutBuybackEvSimulationFrameSequenceV1(null, 5);
  assertPackScoutBuybackEvSimulationFrameSequenceV1(5, 6);
  assert.equal(
    guardCode(() => assertPackScoutBuybackEvSimulationFrameSequenceV1(5, 7)),
    "FRAME_SEQUENCE_GAP",
  );
  assert.equal(
    guardCode(() => assertPackScoutBuybackEvSimulationFrameSequenceV1(5, 4)),
    "FRAME_SEQUENCE_GAP",
  );
  assert.equal(
    guardCode(() => assertPackScoutBuybackEvSimulationFrameSequenceV1(null, -1)),
    "INVALID_CONTROLS",
  );

  assertPackScoutBuybackEvSimulationSha256V1("f".repeat(64), "fingerprint");
  assert.equal(
    guardCode(() =>
      assertPackScoutBuybackEvSimulationSha256V1("F".repeat(64), "fingerprint"),
    ),
    "MALFORMED_HASH",
  );
  assert.equal(
    guardCode(() =>
      assertPackScoutBuybackEvSimulationReleaseIdV1("not-a-uuid", "release id"),
    ),
    "MALFORMED_HASH",
  );

  assertPackScoutBuybackEvSimulationEventTimeV1(
    "2026-08-19T12:00:00.000Z",
    "2026-08-19T12:00:00.000Z",
  );
  assert.equal(
    guardCode(() =>
      assertPackScoutBuybackEvSimulationEventTimeV1(
        "2026-08-19T12:00:00.001Z",
        "2026-08-19T12:00:00.000Z",
      ),
    ),
    "FUTURE_EVENT_TIME",
  );
});

test("control validation refuses malformed seeds, clocks, steps, and versions", () => {
  validatePackScoutBuybackEvSimulationControlsV1(CONTROLS);
  assert.equal(
    guardCode(() =>
      validatePackScoutBuybackEvSimulationControlsV1({
        ...CONTROLS,
        seed: "bad seed!",
      }),
    ),
    "INVALID_CONTROLS",
  );
  assert.equal(
    guardCode(() =>
      validatePackScoutBuybackEvSimulationControlsV1({
        ...CONTROLS,
        startAt: "2026-08-19T12:00:00Z",
      }),
    ),
    "INVALID_CONTROLS",
  );
  assert.equal(
    guardCode(() =>
      validatePackScoutBuybackEvSimulationControlsV1({
        ...CONTROLS,
        frameStepMilliseconds: 1_000,
      }),
    ),
    "INVALID_CONTROLS",
  );
  assert.equal(
    guardCode(() =>
      validatePackScoutBuybackEvSimulationControlsV1({
        ...CONTROLS,
        scenarioVersion:
          "packscout-buyback-ev-simulation-scenarios-v2" as typeof CONTROLS.scenarioVersion,
      }),
    ),
    "UNSUPPORTED_PROTOCOL_VERSION",
  );
});

test("disabled-state mutation is refused before any publication write", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const calls: string[] = [];
  const observedPort: DataReleaseV3PublicationPort = {
    activeState: () => {
      calls.push("activeState");
      return port.activeState();
    },
    status: (publicReleaseId) => {
      calls.push("status");
      return port.status(publicReleaseId);
    },
    start: (request) => {
      calls.push("start");
      return port.start(request);
    },
    applyBatch: (request) => {
      calls.push("applyBatch");
      return port.applyBatch(request);
    },
    finalize: (request) => {
      calls.push("finalize");
      return port.finalize(request);
    },
    activate: (request) => {
      calls.push("activate");
      return port.activate(request);
    },
    rollback: (request) => {
      calls.push("rollback");
      return port.rollback(request);
    },
  };
  const gate = new PackScoutBuybackEvSimulationWriteGateV1();
  const simulator = new PackScoutBuybackEvSimulator({
    port: observedPort,
    controls: CONTROLS,
    gate,
  });
  await assert.rejects(simulator.runFrame(0), (error: unknown) => {
    assert.ok(error instanceof PackScoutBuybackEvSimulationGuardError);
    assert.equal(error.code, "SIMULATION_WRITES_DISABLED");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("a session enables writes once, publishes, and refuses again after close", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const session = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
  });
  const result = await session.simulator.runFrame(0);
  assert.equal(result.publishOutcome, "activated");
  session.close();
  await assert.rejects(session.simulator.runFrame(1), (error: unknown) => {
    assert.ok(error instanceof PackScoutBuybackEvSimulationGuardError);
    assert.equal(error.code, "SIMULATION_WRITES_DISABLED");
    return true;
  });
});

test("a session refuses to open over a foreign active release", async () => {
  const port = new InMemoryDataReleaseV3Port();
  port.state = {
    generation: 3,
    activeRelease: pointer("11111111-2222-4333-8444-555555555555"),
    previousRelease: null,
  };
  await assert.rejects(
    openPackScoutBuybackEvSimulationSessionV1({
      port,
      controls: CONTROLS,
      publicationOrigin: LOCAL_ORIGIN,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PackScoutBuybackEvSimulationGuardError);
      assert.equal(error.code, "CANONICAL_RELEASE_TARGET");
      return true;
    },
  );
});

test("an explicitly named active release may be replaced; lineage continues", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const first = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
  });
  const frame0 = await first.simulator.runFrame(0);
  first.close();

  // A fresh process resuming without naming the active release is refused.
  await assert.rejects(
    openPackScoutBuybackEvSimulationSessionV1({
      port,
      controls: CONTROLS,
      publicationOrigin: LOCAL_ORIGIN,
    }),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvSimulationGuardError &&
      error.code === "CANONICAL_RELEASE_TARGET",
  );

  const resumed = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
    allowedActiveReleaseIds: [frame0.publicReleaseId],
  });
  const replay = await resumed.simulator.runFrame(0);
  assert.equal(replay.publishOutcome, "unchanged");
  assert.equal(replay.publicReleaseId, frame0.publicReleaseId);
  const frame1 = await resumed.simulator.runFrame(1);
  assert.equal(frame1.publishOutcome, "activated");
  assert.equal(frame1.previousPublicReleaseId, frame0.publicReleaseId);
  resumed.close();
});

test("a canonical takeover between frames is refused before staging", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const session = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
  });
  await session.simulator.runFrame(0);
  port.state = {
    ...port.state,
    activeRelease: pointer("11111111-2222-4333-8444-555555555555"),
  };
  await assert.rejects(session.simulator.runFrame(1), (error: unknown) => {
    assert.ok(error instanceof PackScoutBuybackEvSimulationGuardError);
    assert.equal(error.code, "CANONICAL_RELEASE_TARGET");
    return true;
  });
  session.close();
});

test("a tampered receipt fails the publish with a receipt-integrity refusal", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const session = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
  });
  port.tamperNextReceipt = true;
  await assert.rejects(session.simulator.runFrame(0), (error: unknown) => {
    assert.ok(error instanceof DataReleaseV3PublisherError);
    assert.equal(error.code, "RECEIPT_INTEGRITY_FAILED");
    return true;
  });
  session.close();
});

test("a mid-publish failure never activates and a rerun converges", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const session = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
  });
  port.failNextApplyBatch = true;
  await assert.rejects(session.simulator.runFrame(0), (error: unknown) => {
    assert.ok(error instanceof DataReleaseV3PublisherError);
    assert.equal(error.stage, "apply_batch");
    return true;
  });
  assert.equal(port.state.activeRelease, null);
  const recovered = await session.simulator.runFrame(0);
  assert.equal(recovered.publishOutcome, "activated");
  session.close();
});

test("frame sequence gaps and future frame clocks refuse inside the runner", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const session = await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
  });
  await session.simulator.runFrame(0);
  await assert.rejects(session.simulator.runFrame(2), (error: unknown) => {
    assert.ok(error instanceof PackScoutBuybackEvSimulationGuardError);
    assert.equal(error.code, "FRAME_SEQUENCE_GAP");
    return true;
  });
  session.close();

  const clocked = await openPackScoutBuybackEvSimulationSessionV1({
    port: new InMemoryDataReleaseV3Port(),
    controls: CONTROLS,
    publicationOrigin: LOCAL_ORIGIN,
    wallClock: () => new Date("2026-08-19T12:15:00.000Z"),
  });
  await clocked.simulator.runFrame(0);
  await assert.rejects(clocked.simulator.runFrame(1), (error: unknown) => {
    assert.ok(error instanceof PackScoutBuybackEvSimulationGuardError);
    assert.equal(error.code, "FUTURE_EVENT_TIME");
    return true;
  });
  clocked.close();
});

test("malformed operator-supplied release ids are refused at construction", () => {
  const gate = new PackScoutBuybackEvSimulationWriteGateV1();
  assert.equal(
    guardCode(
      () =>
        new PackScoutBuybackEvSimulator({
          port: new InMemoryDataReleaseV3Port(),
          controls: CONTROLS,
          gate,
          allowedActiveReleaseIds: ["deadbeef"],
        }),
    ),
    "MALFORMED_HASH",
  );
});
