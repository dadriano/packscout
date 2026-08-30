import assert from "node:assert/strict";
import test from "node:test";
import {
  readProviderManualImportLaneSupervisorConfiguration,
  runProviderManualImportLanesOnce,
  type ProviderManualImportLane,
} from "./provider-manual-import-lane-supervisor.ts";
import { ProviderManualImportLocalError } from
  "./provider-manual-import-local-runtime.ts";

const clutchLane: ProviderManualImportLane = Object.freeze({
  providerId: "00000000-0000-4000-8000-000000000020",
  providerKey: "clutchpacks",
  workerId: "lanes:clutchpacks",
});
const courtyardLane: ProviderManualImportLane = Object.freeze({
  providerId: "00000000-0000-4000-8000-000000000021",
  providerKey: "courtyard",
  workerId: "lanes:courtyard",
});

test("local lane configuration is explicit, bounded, and independent of provider DSNs", () => {
  const configuration = readProviderManualImportLaneSupervisorConfiguration({
    PACKSCOUT_PROVIDER_LANES_JSON: JSON.stringify([
      {
        providerId: clutchLane.providerId,
        providerKey: clutchLane.providerKey,
      },
      {
        providerId: courtyardLane.providerId,
        providerKey: courtyardLane.providerKey,
      },
    ]),
    PACKSCOUT_PROVIDER_LANE_CONCURRENCY: "2",
    PACKSCOUT_PROVIDER_DATABASE_URL:
      "postgresql://must:not-be-read@127.0.0.1/forbidden",
  }, "fixture:lanes");

  assert.deepEqual(configuration, {
    lanes: [
      { ...clutchLane, workerId: "fixture:lanes:lane-1" },
      { ...courtyardLane, workerId: "fixture:lanes:lane-2" },
    ],
    maximumConcurrency: 2,
  });
});

test("lane supervisor rejects ambiguous topology and unsafe concurrency before work", async () => {
  const invalidInputs = [
    {
      lanes: [clutchLane],
      maximumConcurrency: 2,
    },
    {
      lanes: [clutchLane, clutchLane],
      maximumConcurrency: 2,
    },
    {
      lanes: [clutchLane, courtyardLane],
      maximumConcurrency: 1,
    },
    {
      lanes: [clutchLane, courtyardLane],
      maximumConcurrency: 9,
    },
  ];
  for (const input of invalidInputs) {
    let laneCalls = 0;
    await assert.rejects(runProviderManualImportLanesOnce({
      ...input,
      runLane() {
        laneCalls += 1;
        throw new Error("must not run");
      },
    }), (error: unknown) =>
      error instanceof ProviderManualImportLocalError
      && error.code === "PROVIDER_IMPORT_CONFIGURATION_INVALID"
    );
    assert.equal(laneCalls, 0);
  }
});

test("closed capability admission admits Collector Crypt and Phygitals independently", async () => {
  let laneCalls = 0;
  const outcomes = await runProviderManualImportLanesOnce({
    lanes: [
      {
        providerId: "00000000-0000-4000-8000-000000000022",
        providerKey: "collector_crypt",
        workerId: "lanes:collector-crypt",
      },
      {
        providerId: "00000000-0000-4000-8000-000000000023",
        providerKey: "phygitals",
        workerId: "lanes:phygitals",
      },
    ],
    maximumConcurrency: 2,
    runLane(lane) {
      laneCalls += 1;
      assert.ok(["collector_crypt", "phygitals"].includes(lane.providerKey));
      return Promise.resolve({
        kind: "completed" as const,
        runId: "00000000-0000-4000-8000-000000000024",
        pageCount: 1,
        counters: {
          pages: 1,
          catalog: 1,
          pulls: 0,
          marketEvents: 0,
          accepted: 1,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 1,
        },
      });
    },
  });

  assert.equal(laneCalls, 2);
  assert.deepEqual(outcomes, [
    {
      providerId: "00000000-0000-4000-8000-000000000022",
      providerKey: "collector_crypt",
      status: "fulfilled",
      result: {
        kind: "completed",
        runId: "00000000-0000-4000-8000-000000000024",
        pageCount: 1,
        counters: {
          pages: 1,
          catalog: 1,
          pulls: 0,
          marketEvents: 0,
          accepted: 1,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 1,
        },
      },
    },
    {
      providerId: "00000000-0000-4000-8000-000000000023",
      providerKey: "phygitals",
      status: "fulfilled",
      result: {
        kind: "completed",
        runId: "00000000-0000-4000-8000-000000000024",
        pageCount: 1,
        counters: {
          pages: 1, catalog: 1, pulls: 0, marketEvents: 0, accepted: 1,
          duplicate: 0, quarantined: 0, materialChanges: 1,
        },
      },
    },
  ]);
});

test("a rejected lane cannot cancel its simultaneously running sibling", async () => {
  const arrived = new Set<string>();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const outcomes = await runProviderManualImportLanesOnce({
    lanes: [clutchLane, courtyardLane],
    maximumConcurrency: 2,
    async runLane(lane) {
      arrived.add(lane.providerKey);
      if (arrived.size === 2) release();
      await barrier;
      if (lane.providerKey === "clutchpacks") {
        throw new ProviderManualImportLocalError(
          "PROVIDER_IMPORT_DATABASE_UNAVAILABLE",
        );
      }
      return {
        kind: "completed",
        runId: "00000000-0000-4000-8000-000000000031",
        pageCount: 1,
        counters: {
          pages: 1,
          catalog: 0,
          pulls: 0,
          marketEvents: 0,
          accepted: 0,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 0,
        },
      };
    },
  });

  assert.deepEqual(arrived, new Set(["clutchpacks", "courtyard"]));
  assert.deepEqual(outcomes, [
    {
      providerId: clutchLane.providerId,
      providerKey: "clutchpacks",
      status: "rejected",
      failureCode: "PROVIDER_IMPORT_DATABASE_UNAVAILABLE",
    },
    {
      providerId: courtyardLane.providerId,
      providerKey: "courtyard",
      status: "fulfilled",
      result: {
        kind: "completed",
        runId: "00000000-0000-4000-8000-000000000031",
        pageCount: 1,
        counters: {
          pages: 1,
          catalog: 0,
          pulls: 0,
          marketEvents: 0,
          accepted: 0,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 0,
        },
      },
    },
  ]);
});
