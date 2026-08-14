import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSimulationArguments,
  resolveSimulationControls,
  simulateLocalMockHeat,
} from "./simulate-convex-repack-heat.mjs";

test("mock heat simulation is one-shot by default with explicit deterministic controls", () => {
  assert.deepEqual(
    parseSimulationArguments([
      "--seed",
      "demo-2",
      "--start-at",
      "2027-01-01T00:00:00.000Z",
      "--frame",
      "7",
      "--frame-step-ms",
      "60000",
      "--tick-ms",
      "1000",
    ]),
    {
      seed: "demo-2",
      startAt: "2027-01-01T00:00:00.000Z",
      frameIndex: 7,
      frameStepMilliseconds: 60000,
      tickMilliseconds: 1000,
      loop: false,
    },
  );
  assert.equal(parseSimulationArguments(["--loop"]).loop, true);
  assert.throws(() => parseSimulationArguments(["--loop", "--loop"]));
  assert.throws(() => parseSimulationArguments(["--unknown"]));
  assert.throws(() => parseSimulationArguments(["--frame", "-1"]));
  assert.throws(() => parseSimulationArguments(["--tick-ms", "60001"]));
});

test("omitted start time resolves once to a canonical reproducible run anchor", () => {
  const options = parseSimulationArguments([]);
  assert.deepEqual(
    resolveSimulationControls(
      options,
      () => new Date("2027-01-01T00:00:00.000Z"),
    ),
    {
      seed: "packscout-demo",
      startAt: "2027-01-01T00:00:00.000Z",
      frameIndex: 0,
      frameStepMilliseconds: 300000,
      publicationCadenceMilliseconds: 5000,
    },
  );
});

test("runner publishes only aggregate frames and always removes the temporary flag", async () => {
  const commands = [];
  let seeded = 0;
  const options = parseSimulationArguments([
    "--start-at",
    "2027-01-01T00:00:00.000Z",
  ]);
  const frame = {
    publicReleaseId: "90000000-0000-4000-8000-000000000002",
    publicHeatSnapshotId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
    simulationRunId: "b".repeat(64),
    sequence: 0,
    sourceKind: "simulated",
    scenarioVersion: "scenario-v1",
    aggregationVersion: "aggregation-v1",
    heatPolicyVersion: "policy-v1",
    calculatedAt: "2027-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:15:00.000Z",
    signals: [{ publicRepackId: "aggregate-only" }],
    contentHash: "c".repeat(64),
  };
  await simulateLocalMockHeat(options, {
    readConfiguration: async () => ({ childEnvironment: {} }),
    seedCatalog: async () => {
      seeded += 1;
    },
    buildFrame: async () => frame,
    log: () => {},
    runNpx: async (args) => {
      commands.push(args);
      return args[0] === "run"
        ? JSON.stringify({
            status: "created",
            publicHeatSnapshotId: frame.publicHeatSnapshotId,
            simulationRunId: frame.simulationRunId,
            sequence: 0,
            signalCount: 1,
          })
        : "";
    },
  });
  assert.equal(seeded, 1);
  const publish = commands.find(([command]) => command === "run");
  assert.ok(publish);
  const payload = JSON.parse(publish[2]);
  assert.deepEqual(payload, frame);
  assert.equal(JSON.stringify(payload).includes("observations"), false);
  assert.equal(JSON.stringify(payload).includes('"kind":"pull"'), false);
  assert.deepEqual(commands.at(-1), [
    "env",
    "remove",
    "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
  ]);
});

test("configuration refusal happens before seed, environment, or publish commands", async () => {
  let seeded = 0;
  let commands = 0;
  await assert.rejects(
    simulateLocalMockHeat(parseSimulationArguments([]), {
      readConfiguration: async () => {
        throw new Error("Refusing a cloud deploy key");
      },
      seedCatalog: async () => {
        seeded += 1;
      },
      runNpx: async () => {
        commands += 1;
        return "";
      },
    }),
    /cloud deploy key/u,
  );
  assert.equal(seeded, 0);
  assert.equal(commands, 0);
});

test("loop interruption expires the last aggregate before removing its flag", async () => {
  const commands = [];
  const abortController = new AbortController();
  const frame = {
    publicReleaseId: "90000000-0000-4000-8000-000000000002",
    publicHeatSnapshotId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
    simulationRunId: "b".repeat(64),
    sequence: 0,
    sourceKind: "simulated",
    scenarioVersion: "scenario-v1",
    aggregationVersion: "aggregation-v1",
    heatPolicyVersion: "policy-v1",
    calculatedAt: "2027-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:15:00.000Z",
    signals: [{ publicRepackId: "aggregate-only" }],
    contentHash: "c".repeat(64),
  };
  const result = await simulateLocalMockHeat(
    parseSimulationArguments([
      "--loop",
      "--start-at",
      "2027-01-01T00:00:00.000Z",
    ]),
    {
      abortController,
      readConfiguration: async () => ({ childEnvironment: {} }),
      seedCatalog: async () => {},
      buildFrame: async () => frame,
      log: () => {},
      wait: async () => {
        abortController.abort();
      },
      runNpx: async (args) => {
        commands.push(args);
        if (args[1] === "mockHeatSimulationPublisher:publishFrame") {
          return JSON.stringify({
            status: "created",
            publicHeatSnapshotId: frame.publicHeatSnapshotId,
            simulationRunId: frame.simulationRunId,
            sequence: 0,
            signalCount: 1,
          });
        }
        return "";
      },
    },
  );
  assert.equal(result.status, "created");
  assert.deepEqual(commands.at(-2)?.slice(0, 2), [
    "run",
    "mockHeatSimulationPublisher:expireActiveFrame",
  ]);
  assert.deepEqual(JSON.parse(commands.at(-2)[2]), {
    publicHeatSnapshotId: frame.publicHeatSnapshotId,
    expectedExpiresAt: frame.expiresAt,
  });
  assert.deepEqual(commands.at(-1), [
    "env",
    "remove",
    "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
  ]);
});

test("loop schedules frames on an absolute cadence instead of accumulating publish time", async () => {
  const abortController = new AbortController();
  const waits = [];
  let currentTime = Date.parse("2027-01-01T00:00:00.000Z");
  const frameFor = ({ frameIndex }) => ({
    publicReleaseId: "90000000-0000-4000-8000-000000000002",
    publicHeatSnapshotId: `${String(frameIndex).padStart(8, "0")}-aaaa-5aaa-8aaa-aaaaaaaaaaaa`,
    simulationRunId: "b".repeat(64),
    sequence: frameIndex,
    sourceKind: "simulated",
    scenarioVersion: "scenario-v1",
    aggregationVersion: "aggregation-v1",
    heatPolicyVersion: "policy-v1",
    calculatedAt: new Date(
      Date.parse("2027-01-01T00:00:00.000Z") + frameIndex * 5_000,
    ).toISOString(),
    expiresAt: new Date(
      Date.parse("2027-01-01T00:15:00.000Z") + frameIndex * 5_000,
    ).toISOString(),
    signals: [{ publicRepackId: "aggregate-only" }],
    contentHash: "c".repeat(64),
  });
  await simulateLocalMockHeat(
    parseSimulationArguments([
      "--loop",
      "--start-at",
      "2027-01-01T00:00:00.000Z",
    ]),
    {
      abortController,
      now: () => new Date(currentTime),
      readConfiguration: async () => ({ childEnvironment: {} }),
      seedCatalog: async () => {},
      buildFrame: async (controls) => frameFor(controls),
      log: () => {},
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds;
      },
      onFrame: ({ frame }) => {
        if (frame.sequence === 1) abortController.abort();
      },
      runNpx: async (args) => {
        if (args[1] === "mockHeatSimulationPublisher:publishFrame") {
          const frame = JSON.parse(args[2]);
          currentTime += 2_000;
          return JSON.stringify({
            status: "created",
            publicHeatSnapshotId: frame.publicHeatSnapshotId,
            simulationRunId: frame.simulationRunId,
            sequence: frame.sequence,
            signalCount: frame.signals.length,
          });
        }
        return "";
      },
    },
  );
  assert.deepEqual(waits, [3_000]);
});

test("abort during an in-flight publish exits cleanly and still removes the flag", async () => {
  const abortController = new AbortController();
  const commands = [];
  const result = await simulateLocalMockHeat(
    parseSimulationArguments([
      "--loop",
      "--start-at",
      "2027-01-01T00:00:00.000Z",
    ]),
    {
      abortController,
      readConfiguration: async () => ({ childEnvironment: {} }),
      seedCatalog: async () => {},
      buildFrame: async () => ({
        simulationRunId: "b".repeat(64),
        signals: [],
      }),
      log: () => {},
      runNpx: async (args) => {
        commands.push(args);
        if (args[0] === "run") {
          abortController.abort();
          throw new Error("terminated");
        }
        return "";
      },
    },
  );
  assert.equal(result, null);
  assert.deepEqual(commands.at(-1), [
    "env",
    "remove",
    "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
  ]);
});

test("runner removes the temporary flag when publishing fails", async () => {
  const commands = [];
  const options = parseSimulationArguments([
    "--start-at",
    "2027-01-01T00:00:00.000Z",
  ]);
  await assert.rejects(
    simulateLocalMockHeat(options, {
      readConfiguration: async () => ({ childEnvironment: {} }),
      seedCatalog: async () => {},
      buildFrame: async () => ({ signals: [] }),
      log: () => {},
      runNpx: async (args) => {
        commands.push(args);
        if (args[0] === "run") throw new Error("publish failed");
        return "";
      },
    }),
    /publish failed/u,
  );
  assert.deepEqual(commands.at(-1), [
    "env",
    "remove",
    "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
  ]);
});
