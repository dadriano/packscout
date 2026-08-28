import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLICATION_KEY_IDS_ENV,
  PUBLISHING_KEYS_ENV,
  SIMULATION_KEY_ID,
  assertPublicationKeysAvailable,
  derivePublicationUrl,
  parseSimulationArguments,
  resolveSimulationControls,
  simulateLocalBuybackEv,
  verifyPublicReadBackResult,
} from "./simulate-convex-buyback-ev.mjs";

const SCENARIO_VERSION = "packscout-buyback-ev-simulation-scenarios-v1";
const NOW = "2026-08-19T18:00:00.000Z";

function fakeContracts() {
  return {
    PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION: SCENARIO_VERSION,
    assertPackScoutBuybackEvSimulationLoopbackUrlV1: (url) => {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(parsed.hostname)
      ) {
        throw new Error("NON_LOOPBACK_SERVICE_URL");
      }
      return parsed.origin;
    },
    validatePackScoutBuybackEvSimulationControlsV1: (controls) => controls,
    packScoutBuybackEvSimulationFrameClockV1: (controls, frameIndex) =>
      new Date(
        Date.parse(controls.startAt) +
          frameIndex * controls.frameStepMilliseconds,
      ).toISOString(),
    assertPackScoutBuybackEvSimulationEventTimeV1: (frameClock, wallClock) => {
      if (Date.parse(frameClock) > Date.parse(wallClock)) {
        throw new Error("FUTURE_EVENT_TIME");
      }
    },
  };
}

function frameResult(frameIndex) {
  return {
    scenarioVersion: SCENARIO_VERSION,
    simulationRunId: "1".repeat(64),
    frameIndex,
    readAt: new Date(Date.parse(NOW) - (3 - frameIndex) * 60_000).toISOString(),
    publishOutcome: "activated",
    publicReleaseId: `5eeded00-0000-5000-8000-00000000000${frameIndex}`,
    releaseFingerprint: "2".repeat(64),
    previousPublicReleaseId: null,
    scenarioResults: [],
    publicDetails: [
      {
        publicRepackId: "5eeded00-0000-5000-8000-0000000000aa",
        evEstimates: { packScout: { status: "current" }, vendorReported: {} },
      },
    ],
    frameContentDigest: "3".repeat(64),
  };
}

function harness(overrides = {}) {
  const state = {
    commands: [],
    frames: [],
    logs: [],
    closed: 0,
    ports: [],
  };
  const dependencies = {
    readConfiguration: async () => ({
      childEnvironment: {},
      publicUrl: "http://127.0.0.1:3210",
    }),
    loadModules: async () => ({
      contracts: fakeContracts(),
      runner: {
        openPackScoutBuybackEvSimulationSessionV1: async (input) => ({
          simulationRunId: "run-digest",
          simulator: {
            runFrame: async (frameIndex) => {
              state.frames.push(frameIndex);
              return frameResult(frameIndex);
            },
          },
          close: () => {
            state.closed += 1;
          },
          input,
        }),
      },
    }),
    createPort: async (input) => {
      state.ports.push(input);
      return { kind: "fake-port" };
    },
    runNpx: async (args) => {
      state.commands.push(args);
      if (args[0] === "env" && args[1] === "list") return "";
      if (args[0] === "run") {
        const result = frameResult(state.frames.at(-1) ?? 0);
        return JSON.stringify({
          ok: true,
          data: {
            ...result.publicDetails[0],
            heat: { status: "unavailable", signal: null, reason: "NOT_PUBLISHED" },
          },
        });
      }
      return "";
    },
    wait: async () => {},
    log: (line) => {
      state.logs.push(line);
    },
    now: () => new Date(NOW),
    randomSecret: () => Buffer.alloc(32, 0x61),
    ...overrides,
  };
  return { state, dependencies };
}

test("simulation arguments default to a bounded one-shot with explicit controls", () => {
  const parsed = parseSimulationArguments([]);
  assert.equal(parsed.loop, false);
  assert.equal(parsed.maxFrames, null);
  assert.equal(parsed.frameIndex, 0);
  assert.equal(parsed.skipReadBack, false);
  assert.equal(
    parseSimulationArguments(["--loop", "--max-frames", "5"]).maxFrames,
    5,
  );
  assert.throws(() => parseSimulationArguments(["--max-frames", "5"]));
  assert.throws(() =>
    parseSimulationArguments(["--loop", "--max-frames", "1001"]),
  );
  assert.throws(() => parseSimulationArguments(["--loop", "--loop"]));
  assert.throws(() => parseSimulationArguments(["--unknown"]));
  assert.throws(() => parseSimulationArguments(["--frame", "-1"]));
  assert.throws(() =>
    parseSimulationArguments(["--expected-active", "not-a-uuid"]),
  );
});

test("the default start time anchors every frame clock in the past", () => {
  const oneShot = resolveSimulationControls(
    parseSimulationArguments(["--frame-step-ms", "60000"]),
    () => new Date(NOW),
  );
  assert.equal(oneShot.frameCount, 1);
  assert.equal(oneShot.startAt, "2026-08-19T17:59:00.000Z");
  const loop = resolveSimulationControls(
    parseSimulationArguments([
      "--loop",
      "--max-frames",
      "3",
      "--frame",
      "2",
      "--frame-step-ms",
      "60000",
    ]),
    () => new Date(NOW),
  );
  assert.equal(loop.frameCount, 3);
  assert.equal(loop.startAt, "2026-08-19T17:55:00.000Z");
  const explicit = resolveSimulationControls(
    parseSimulationArguments(["--start-at", "2026-08-19T12:00:00.000Z"]),
    () => new Date(NOW),
  );
  assert.equal(explicit.startAt, "2026-08-19T12:00:00.000Z");
});

test("foreign publication keys are never overwritten; only our leftover set is", () => {
  assertPublicationKeysAvailable({});
  assertPublicationKeysAvailable({
    [PUBLISHING_KEYS_ENV]: JSON.stringify({ [SIMULATION_KEY_ID]: "c2VjcmV0" }),
    [PUBLICATION_KEY_IDS_ENV]: JSON.stringify([SIMULATION_KEY_ID]),
  });
  assert.throws(() =>
    assertPublicationKeysAvailable({
      [PUBLISHING_KEYS_ENV]: JSON.stringify({ "worker-key.v1": "c2VjcmV0" }),
      [PUBLICATION_KEY_IDS_ENV]: JSON.stringify(["worker-key.v1"]),
    }),
  );
  assert.throws(() =>
    assertPublicationKeysAvailable({
      [PUBLICATION_KEY_IDS_ENV]: JSON.stringify([SIMULATION_KEY_ID]),
    }),
  );
  assert.throws(() =>
    assertPublicationKeysAvailable({
      [PUBLISHING_KEYS_ENV]: "{not json",
      [PUBLICATION_KEY_IDS_ENV]: "{not json",
    }),
  );
});

test("the publication URL derives from the loopback Convex origin or explicit config", () => {
  assert.equal(
    derivePublicationUrl({
      childEnvironment: {},
      publicUrl: "http://127.0.0.1:3210",
    }),
    "http://127.0.0.1:3211",
  );
  assert.equal(
    derivePublicationUrl({
      childEnvironment: {
        PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "http://127.0.0.1:9999",
      },
      publicUrl: "http://127.0.0.1:3210",
    }),
    "http://127.0.0.1:9999",
  );
});

test("a one-shot run enables, publishes, reads back, and always removes the keys", async () => {
  const { state, dependencies } = harness();
  const result = await simulateLocalBuybackEv(parseSimulationArguments([]), {
    ...dependencies,
  });
  assert.equal(result.frameIndex, 0);
  assert.deepEqual(state.frames, [0]);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.commands[0], ["env", "list"]);
  const setCommands = state.commands.filter(([verb]) => verb === "env");
  assert.deepEqual(
    setCommands.map((command) => command.slice(0, 3)),
    [
      ["env", "list"],
      ["env", "set", "PACKSCOUT_RUNTIME_ENVIRONMENT"],
      ["env", "set", PUBLISHING_KEYS_ENV],
      ["env", "set", PUBLICATION_KEY_IDS_ENV],
      ["env", "remove", PUBLICATION_KEY_IDS_ENV],
      ["env", "remove", PUBLISHING_KEYS_ENV],
    ],
  );
  const readBack = state.commands.find(([verb]) => verb === "run");
  assert.ok(readBack);
  assert.equal(readBack[1], "publicRepacksV3:getPublicRepackV3");
  const readBackArgs = JSON.parse(readBack[2]);
  assert.equal(readBackArgs.publicReleaseId, frameResult(0).publicReleaseId);

  // The reproduction line documents seed, times, and frame identity.
  const reproduction = state.logs.find((line) => line.includes("Reproduce with:"));
  assert.ok(reproduction?.includes("--seed packscout-buyback-ev-demo"));
  assert.ok(state.logs.some((line) => line.includes("run=run-digest")));
  assert.ok(
    state.logs.some((line) => line.includes("cleanup complete")),
    "cleanup state must be documented",
  );
  // The transport secret never reaches the logs.
  const secretBase64 = Buffer.alloc(32, 0x61).toString("base64");
  assert.ok(state.logs.every((line) => !line.includes(secretBase64)));
  assert.deepEqual(state.ports[0]?.keyId, SIMULATION_KEY_ID);
});

test("loop playback is bounded, stoppable, and cleans up on interruption", async () => {
  const abortController = new AbortController();
  const { state, dependencies } = harness();
  const result = await simulateLocalBuybackEv(
    parseSimulationArguments(["--loop", "--max-frames", "5"]),
    {
      ...dependencies,
      abortController,
      onFrame: async ({ frameIndex }) => {
        if (frameIndex === 1) abortController.abort();
      },
    },
  );
  assert.deepEqual(state.frames, [0, 1]);
  assert.equal(result.frameIndex, 1);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.commands.at(-1), ["env", "remove", PUBLISHING_KEYS_ENV]);
});

test("a frame failure still removes the temporary keys and closes the session", async () => {
  const { state, dependencies } = harness({
    loadModules: async () => ({
      contracts: fakeContracts(),
      runner: {
        openPackScoutBuybackEvSimulationSessionV1: async () => ({
          simulationRunId: "run-digest",
          simulator: {
            runFrame: async () => {
              throw new Error("PLAN_BLOCKED");
            },
          },
          close: () => {
            state.closed += 1;
          },
        }),
      },
    }),
  });
  await assert.rejects(
    simulateLocalBuybackEv(parseSimulationArguments([]), dependencies),
    /PLAN_BLOCKED/,
  );
  assert.equal(state.closed, 1);
  assert.deepEqual(state.commands.at(-2), ["env", "remove", PUBLICATION_KEY_IDS_ENV]);
  assert.deepEqual(state.commands.at(-1), ["env", "remove", PUBLISHING_KEYS_ENV]);
});

test("foreign keys refuse the run before any enablement write", async () => {
  const { state, dependencies } = harness({
    runNpx: async (args) => {
      state.commands.push(args);
      if (args[0] === "env" && args[1] === "list") {
        return `${PUBLISHING_KEYS_ENV}={"worker-key.v1":"c2VjcmV0"}\n${PUBLICATION_KEY_IDS_ENV}=["worker-key.v1"]\n`;
      }
      return "";
    },
  });
  await assert.rejects(
    simulateLocalBuybackEv(parseSimulationArguments([]), dependencies),
    /foreign data-release publication keys/,
  );
  assert.deepEqual(state.commands, [["env", "list"]]);
  assert.equal(state.frames.length, 0);
});

test("configuration refusal happens before any Convex command", async () => {
  const { state, dependencies } = harness({
    readConfiguration: async () => {
      throw new Error("Refusing a cloud deploy key");
    },
  });
  await assert.rejects(
    simulateLocalBuybackEv(parseSimulationArguments([]), dependencies),
    /cloud deploy key/,
  );
  assert.deepEqual(state.commands, []);
});

test("a future start time refuses before any Convex command", async () => {
  const { state, dependencies } = harness();
  await assert.rejects(
    simulateLocalBuybackEv(
      parseSimulationArguments(["--start-at", "2026-08-19T19:00:00.000Z"]),
      dependencies,
    ),
    /FUTURE_EVENT_TIME/,
  );
  assert.deepEqual(state.commands, []);
});

test("a divergent public read-back fails the run but still cleans up", async () => {
  const { state, dependencies } = harness({
    runNpx: async (args) => {
      state.commands.push(args);
      if (args[0] === "env" && args[1] === "list") return "";
      if (args[0] === "run") {
        return JSON.stringify({
          ok: true,
          data: {
            publicRepackId: "5eeded00-0000-5000-8000-0000000000aa",
            evEstimates: { packScout: { status: "unavailable" } },
            heat: { status: "unavailable", signal: null, reason: "NOT_PUBLISHED" },
          },
        });
      }
      return "";
    },
  });
  await assert.rejects(
    simulateLocalBuybackEv(parseSimulationArguments([]), dependencies),
    /read-back diverged/,
  );
  assert.deepEqual(state.commands.at(-1), ["env", "remove", PUBLISHING_KEYS_ENV]);
});

test("--skip-read-back publishes without querying the public read model", async () => {
  const { state, dependencies } = harness();
  await simulateLocalBuybackEv(
    parseSimulationArguments(["--skip-read-back"]),
    dependencies,
  );
  assert.ok(state.commands.every(([verb]) => verb !== "run"));
});

test("read-back verification pins bytes, identity, and the unavailable heat state", () => {
  const result = frameResult(0);
  const view = {
    ...result.publicDetails[0],
    heat: { status: "unavailable", signal: null, reason: "NOT_PUBLISHED" },
  };
  assert.ok(
    verifyPublicReadBackResult(
      result,
      JSON.stringify({ ok: true, data: view }),
    ),
  );
  assert.throws(
    () => verifyPublicReadBackResult(result, JSON.stringify({ ok: false })),
    /refused/,
  );
  assert.throws(
    () =>
      verifyPublicReadBackResult(
        result,
        JSON.stringify({
          ok: true,
          data: { ...view, evEstimates: { packScout: { status: "unavailable" } } },
        }),
      ),
    /diverged/,
  );
  // An unknown product answered back is a divergence, never a silent pass.
  assert.throws(
    () =>
      verifyPublicReadBackResult(
        result,
        JSON.stringify({
          ok: true,
          data: { ...view, publicRepackId: "5eeded00-0000-5000-8000-0000000000bb" },
        }),
      ),
    /diverged/,
  );
  assert.throws(
    () =>
      verifyPublicReadBackResult(
        result,
        JSON.stringify({
          ok: true,
          data: { ...view, heat: { status: "available" } },
        }),
      ),
    /Heat/,
  );
  assert.throws(() => verifyPublicReadBackResult(result, "not json"), /non-JSON/);
});
