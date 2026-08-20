/// <reference types="vite/client" />

import {
  findRepacksByDesiredCollectibleResultSchema,
  getDashboardBundleResultSchema,
  getPublicRepackResultSchema,
  listPublicRepacksResultSchema,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS,
  MOCK_HEAT_DEFAULT_PUBLICATION_CADENCE_MILLISECONDS,
  buildMockHeatFrame,
  type MockHeatFrame,
} from "./mockHeatSimulationFixture";

const modules = import.meta.glob("./**/*.ts");
type HeatTest = TestConvex<typeof schema>;
const startAt = "2027-01-01T12:00:00.000Z";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function enable(environment = "local") {
  vi.useFakeTimers();
  vi.setSystemTime("2027-01-01T12:00:00.000Z");
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", environment);
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  vi.stubEnv("PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED", "1");
}

function controls(frameIndex: number) {
  return {
    seed: "packscout-demo",
    startAt,
    frameIndex,
    frameStepMilliseconds: MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS,
    publicationCadenceMilliseconds:
      MOCK_HEAT_DEFAULT_PUBLICATION_CADENCE_MILLISECONDS,
  };
}

function mutationFrame(frame: MockHeatFrame) {
  return { ...frame, signals: [...frame.signals] };
}

async function seed(t: HeatTest) {
  return await t.mutation(internal.mockDataReleaseSeed.seed, {});
}

async function heatCounts(t: HeatTest) {
  return t.run(async (ctx) => ({
    states: (await ctx.db.query("repackHeatState").collect()).length,
    snapshots: (await ctx.db.query("repackHeatSnapshots").collect()).length,
    signals: (await ctx.db.query("repackHeatSignals").collect()).length,
  }));
}

function expectManifestMismatch(
  details: readonly {
    readonly heat: { readonly status: string; readonly reason?: string };
  }[],
) {
  expect(details.length).toBeGreaterThan(0);
  expect(details.every(({ heat }) =>
    heat.status === "unavailable" && heat.reason === "RELEASE_MISMATCH"
  )).toBe(true);
}

function expectHeatStatus(
  details: readonly {
    readonly heat: { readonly status: string; readonly reason?: string };
  }[],
  status: "current" | "expired" | "unavailable",
  reason?: "NOT_PUBLISHED" | "RELEASE_MISMATCH",
) {
  expect(details.length).toBeGreaterThan(0);
  expect(details.every(({ heat }) =>
    heat.status === status && (reason === undefined || heat.reason === reason)
  )).toBe(true);
}

async function queryEveryHeatSurface(t: HeatTest) {
  const fixture = buildMockDataReleaseV2();
  const repack = fixture.repacks[0]!;
  const collectible = fixture.collectibles[0]!;
  const dashboard = await t.query(api.publicRepacks.getDashboardBundle, {
    currentTime: Date.now(),
  });
  const list = await t.query(api.publicRepacks.listPublicRepacks, {
    currentTime: Date.now(),
  });
  expect(getDashboardBundleResultSchema.safeParse(dashboard).success).toBe(true);
  expect(listPublicRepacksResultSchema.safeParse(list).success).toBe(true);
  if (!dashboard.ok || !list.ok) {
    throw new Error("Expected public catalog surfaces to remain readable.");
  }
  const detail = await t.query(api.publicRepacks.getPublicRepack, {
    currentTime: Date.now(),
    publicRepackId: repack.publicRepackId,
    publicReleaseId: list.data.metadata.publicReleaseId,
  });
  const desired = await t.query(
    api.publicRepacks.findRepacksByDesiredCollectible,
    {
      currentTime: Date.now(),
      publicCollectibleId: collectible.publicCollectibleId,
    },
  );
  expect(getPublicRepackResultSchema.safeParse(detail).success).toBe(true);
  expect(
    findRepacksByDesiredCollectibleResultSchema.safeParse(desired).success,
  ).toBe(true);
  if (!detail.ok || !desired.ok) {
    throw new Error("Expected public heat surfaces to remain readable.");
  }
  return {
    dashboard: dashboard.data.details,
    list: list.data.details,
    detail: [detail.data],
    desired: desired.data.matches.map(({ repack: match }) => match),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("mock heat aggregate publisher", () => {
  test("requires the exact local flag and leaves zero heat writes on refusal", async () => {
    enable();
    const t = createTest();
    await seed(t);
    const frame = mutationFrame(await buildMockHeatFrame(controls(0)));
    vi.stubEnv("PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED", "");
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, frame),
    ).rejects.toThrow("MOCK_HEAT_DISABLED");
    await expect(heatCounts(t)).resolves.toEqual({
      states: 0,
      snapshots: 0,
      signals: 0,
    });

    vi.stubEnv("PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED", "1");
    vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "production");
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, frame),
    ).rejects.toThrow("MOCK_HEAT_ENVIRONMENT_UNSAFE");
    await expect(heatCounts(t)).resolves.toEqual({
      states: 0,
      snapshots: 0,
      signals: 0,
    });
  });

  test("publishes idempotently, advances exactly, and retains only two aggregate frames", async () => {
    enable();
    const t = createTest();
    await seed(t);
    const frameZero = mutationFrame(await buildMockHeatFrame(controls(0)));
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, frameZero),
    ).resolves.toMatchObject({ status: "created", sequence: 0, signalCount: 6 });
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, frameZero),
    ).resolves.toMatchObject({ status: "unchanged", sequence: 0 });
    await expect(heatCounts(t)).resolves.toEqual({
      states: 1,
      snapshots: 1,
      signals: 6,
    });

    for (const frameIndex of [1, 2]) {
      await t.mutation(
        internal.mockHeatSimulationPublisher.publishFrame,
        mutationFrame(await buildMockHeatFrame(controls(frameIndex))),
      );
    }
    await expect(heatCounts(t)).resolves.toEqual({
      states: 1,
      snapshots: 2,
      signals: 12,
    });
    const state = await t.run((ctx) => ctx.db.query("repackHeatState").unique());
    expect(state).toMatchObject({
      freshness: "current",
      latestSequence: 2,
      expiresAt: "2027-01-01T12:15:10.000Z",
    });
  });

  test("rejects noncanonical, tampered, and skipped frames atomically", async () => {
    enable();
    const t = createTest();
    await seed(t);
    const frame = mutationFrame(await buildMockHeatFrame(controls(0)));
    const rawAttempt = {
      ...frame,
      observations: [{ kind: "pull", occurredAt: frame.calculatedAt }],
    };
    await expect(
      t.mutation(
        internal.mockHeatSimulationPublisher.publishFrame,
        rawAttempt,
      ),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, {
        ...frame,
        signals: [...frame.signals].reverse(),
      }),
    ).rejects.toThrow("MOCK_HEAT_FRAME_INVALID");
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, {
        ...frame,
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow("MOCK_HEAT_FRAME_INVALID");
    await expect(heatCounts(t)).resolves.toEqual({
      states: 0,
      snapshots: 0,
      signals: 0,
    });
    await expect(
      t.mutation(
        internal.mockHeatSimulationPublisher.publishFrame,
        mutationFrame(await buildMockHeatFrame(controls(1))),
      ),
    ).rejects.toThrow("MOCK_HEAT_SEQUENCE_INVALID");
    await expect(heatCounts(t)).resolves.toEqual({
      states: 0,
      snapshots: 0,
      signals: 0,
    });
  });

  test("rejects stale, future, expired, and overlong frames before writes", async () => {
    enable();
    const t = createTest();
    await seed(t);
    for (const frame of [
      await buildMockHeatFrame({
        ...controls(0),
        startAt: "2027-01-01T11:54:59.999Z",
      }),
      await buildMockHeatFrame({
        ...controls(0),
        startAt: "2027-01-01T12:01:00.001Z",
      }),
      await buildMockHeatFrame({
        ...controls(0),
        startAt: "2027-01-01T11:44:59.999Z",
      }),
    ]) {
      await expect(
        t.mutation(
          internal.mockHeatSimulationPublisher.publishFrame,
          mutationFrame(frame),
        ),
      ).rejects.toThrow("MOCK_HEAT_FRAME_INVALID");
    }
    const frame = await buildMockHeatFrame(controls(0));
    await expect(
      t.mutation(internal.mockHeatSimulationPublisher.publishFrame, {
        ...mutationFrame(frame),
        expiresAt: "2027-01-01T13:00:00.001Z",
      }),
    ).rejects.toThrow("MOCK_HEAT_FRAME_INVALID");
    await expect(heatCounts(t)).resolves.toEqual({
      states: 0,
      snapshots: 0,
      signals: 0,
    });
  });

  test("requires every run to advance the active aggregate timeline", async () => {
    enable();
    const t = createTest();
    await seed(t);
    const first = await buildMockHeatFrame(controls(0));
    await t.mutation(
      internal.mockHeatSimulationPublisher.publishFrame,
      mutationFrame(first),
    );
    const regressedNewRun = await buildMockHeatFrame({
      ...controls(0),
      seed: "replacement-run",
    });
    await expect(
      t.mutation(
        internal.mockHeatSimulationPublisher.publishFrame,
        mutationFrame(regressedNewRun),
      ),
    ).rejects.toThrow("MOCK_HEAT_SEQUENCE_INVALID");
    const advancingNewRun = await buildMockHeatFrame({
      ...controls(0),
      seed: "replacement-run",
      startAt: "2027-01-01T12:00:05.000Z",
    });
    await expect(
      t.mutation(
        internal.mockHeatSimulationPublisher.publishFrame,
        mutationFrame(advancingNewRun),
      ),
    ).resolves.toMatchObject({ status: "created", sequence: 0 });
  });

  test("scheduled expiry is ID-bound: stale work is a no-op and active work expires", async () => {
    enable();
    const t = createTest();
    await seed(t);
    const frameZero = await buildMockHeatFrame(controls(0));
    const frameOne = await buildMockHeatFrame(controls(1));
    await t.mutation(
      internal.mockHeatSimulationPublisher.publishFrame,
      mutationFrame(frameZero),
    );
    await t.mutation(
      internal.mockHeatSimulationPublisher.publishFrame,
      mutationFrame(frameOne),
    );
    vi.stubEnv("PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED", "");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 + 2_000);
    await t.finishInProgressScheduledFunctions();
    const afterStaleExpiry = await t.run((ctx) =>
      ctx.db.query("repackHeatState").unique()
    );
    expect(afterStaleExpiry?.freshness).toBe("current");
    await vi.advanceTimersByTimeAsync(3_000);
    await t.finishInProgressScheduledFunctions();
    const state = await t.run((ctx) => ctx.db.query("repackHeatState").unique());
    expect(state?.freshness).toBe("expired");
  });

  test("publishes current heat and fails closed on manifest, signal, and expiry drift", async () => {
    enable();
    const t = createTest();
    await seed(t);
    for (const details of Object.values(await queryEveryHeatSurface(t))) {
      expectHeatStatus(details, "unavailable", "NOT_PUBLISHED");
    }

    const frame = await buildMockHeatFrame(controls(0));
    await t.mutation(
      internal.mockHeatSimulationPublisher.publishFrame,
      mutationFrame(frame),
    );
    for (const details of Object.values(await queryEveryHeatSurface(t))) {
      expectHeatStatus(details, "current");
    }

    const mismatch = await t.run(async (ctx) => {
      const snapshot = await ctx.db.query("repackHeatSnapshots").first();
      if (snapshot === null) {
        throw new Error("Expected manifest-aligned heat.");
      }
      await ctx.db.patch("repackHeatSnapshots", snapshot._id, {
        manifestAlignment: {
          ...snapshot.manifestAlignment,
          manifestFingerprint: "0".repeat(64),
        },
      });
      return {
        snapshotId: snapshot._id,
        manifestAlignment: snapshot.manifestAlignment,
      };
    });
    for (const details of Object.values(await queryEveryHeatSurface(t))) {
      expectManifestMismatch(details);
    }
    await t.run(async (ctx) => {
      await ctx.db.patch("repackHeatSnapshots", mismatch.snapshotId, {
        manifestAlignment: mismatch.manifestAlignment,
      });
    });

    await t.run(async (ctx) => {
      const signal = await ctx.db.query("repackHeatSignals").first();
      if (signal === null) throw new Error("Expected aggregate signal.");
      await ctx.db.patch("repackHeatSignals", signal._id, {
        detail: {
          ...signal.detail,
          scoreBasisPoints: null,
          signalConfidence: null,
        },
      });
    });
    const malformed = await queryEveryHeatSurface(t);
    expect(
      Object.values(malformed)
        .flat()
        .some(({ heat }) => heat.status === "unavailable"),
    ).toBe(true);

    await t.run(async (ctx) => {
      const snapshot = await ctx.db.query("repackHeatSnapshots").first();
      const state = await ctx.db.query("repackHeatState").unique();
      if (snapshot === null || state === null) {
        throw new Error("Expected aggregate snapshot state.");
      }
      const overlongExpiry = "2027-01-01T13:00:00.001Z";
      await ctx.db.patch("repackHeatSnapshots", snapshot._id, {
        expiresAt: overlongExpiry,
      });
      await ctx.db.patch("repackHeatState", state._id, {
        expiresAt: overlongExpiry,
        freshness: "expired",
      });
    });
    for (const details of Object.values(await queryEveryHeatSurface(t))) {
      expectManifestMismatch(details);
    }

    await t.run(async (ctx) => {
      const snapshot = await ctx.db.query("repackHeatSnapshots").first();
      const state = await ctx.db.query("repackHeatState").unique();
      if (snapshot === null || state === null) {
        throw new Error("Expected aggregate snapshot state.");
      }
      await ctx.db.patch("repackHeatSnapshots", snapshot._id, {
        expiresAt: frame.expiresAt,
      });
      await ctx.db.patch("repackHeatState", state._id, {
        expiresAt: frame.expiresAt,
        freshness: "current",
      });
    });

    await t.mutation(internal.mockHeatSimulationPublisher.expireActiveFrame, {
      publicHeatSnapshotId: frame.publicHeatSnapshotId,
      expectedExpiresAt: frame.expiresAt,
    });
    for (const details of Object.values(await queryEveryHeatSurface(t))) {
      expectHeatStatus(details, "expired");
    }
  });
});
