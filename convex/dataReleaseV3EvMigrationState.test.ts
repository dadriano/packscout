/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { buildV3CurrentEv, buildV3Detail, buildV3SoldOutDetail, buildV3UnavailableEv, V3_FIXTURE_NOW,
  V3_OBSERVED_AT, V3_REPACK_ID_A, V3_REPACK_ID_B, V3_REPACK_ID_C } from "./dataReleaseV3Fixture.test-support";
import { activateRetentionRelease, removeDerivedRetentionForLegacyTest, retentionReleaseId,
  stageRetentionRelease, unavailableRetentionDetail, type RetentionTest } from "./dataReleaseV3Retention.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
beforeEach(() => vi.stubEnv("PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY", "packscout-ev-migration-cursor-test-key-000001"));
afterEach(() => vi.unstubAllEnvs());
const migration = (t: RetentionTest) => t.query(internal.dataReleaseV3EvMigrationState.migrationState, {});

async function clearFacts(t: RetentionTest) {
  await t.run(async (ctx) => {
    for (const table of ["dataReleaseV3EvFactSets", "dataReleaseV3EvFacts"] as const) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(table, row._id);
    }
  });
}

async function backfill(t: RetentionTest, number: number) {
  const state = await migration(t);
  let progress = await t.query(internal.dataReleaseV3EvFactsBackfill.progress,
    { publicReleaseId: retentionReleaseId(number) });
  while (!progress.complete) {
    const page = await t.mutation(internal.dataReleaseV3EvFactsBackfill.backfillActiveReleaseEvFacts, {
      publicReleaseId: progress.publicReleaseId, expectedGeneration: state.expectedGeneration,
      expectedActivePublicReleaseId: state.expectedActivePublicReleaseId,
      expectedPreviousPublicReleaseId: state.expectedPreviousPublicReleaseId,
      afterPublicRepackId: progress.nextCursor,
    });
    progress = { ...progress, ...page };
  }
}

async function initialize(t: RetentionTest, number: number) {
  const state = await t.query(internal.dataReleaseV3Lifecycle.activeState, {});
  return t.mutation(internal.dataReleaseV3EvFactsBackfill.initializeActiveRetention, {
    publicReleaseId: retentionReleaseId(number), expectedGeneration: state.generation,
    expectedActivePublicReleaseId: state.activeRelease?.publicReleaseId ?? null,
    expectedPreviousPublicReleaseId: state.previousRelease?.publicReleaseId ?? null,
  });
}

async function publicViews(t: RetentionTest, number: number, currentTime = V3_FIXTURE_NOW + 86_400_000) {
  return Promise.all([
    t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, { currentTime }),
    t.query(internal.publicRepacksV3.getPublicRepackV3AtTime, { publicReleaseId: retentionReleaseId(number),
      publicRepackId: buildV3Detail().publicRepackId, currentTime }),
    t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, { currentTime }),
  ]);
}

describe("explicit legacy EV reader cutover", () => {
  test("an empty deployment needs no migration", async () => {
    const t = convexTest(schema, modules);
    expect(await migration(t)).toEqual({ expectedGeneration: 0, expectedActivePublicReleaseId: null,
      expectedPreviousPublicReleaseId: null, activeRelease: null, previousRelease: null, initialized: true });
  });

  test("legacy list, detail, and dashboard preserve values through partial and sealed facts until initialization", async () => {
    const t = convexTest(schema, modules);
    const detail = buildV3Detail();
    const extras = Array.from({ length: 64 }, (_, index) => buildV3Detail({
      publicRepackId: `00000000-0000-5000-8000-${(70_000 + index).toString().padStart(12, "0")}`,
    }));
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [detail, ...extras]), null);
    await removeDerivedRetentionForLegacyTest(t);
    await clearFacts(t);
    const pointer = await t.query(internal.dataReleaseV3Lifecycle.activeState, {});
    const state = await migration(t);
    expect(state).toMatchObject({ initialized: false, expectedGeneration: 1,
      expectedActivePublicReleaseId: retentionReleaseId(1), expectedPreviousPublicReleaseId: null });
    const before = await publicViews(t, 1);
    for (const response of before) expect(response.ok).toBe(true);
    expect(before[1]).toMatchObject({ data: { evEstimates: { packScout: detail.evEstimates.packScout } } });
    await t.mutation(internal.dataReleaseV3EvFactsBackfill.backfillActiveReleaseEvFacts, {
      publicReleaseId: retentionReleaseId(1), expectedGeneration: state.expectedGeneration,
      expectedActivePublicReleaseId: state.expectedActivePublicReleaseId,
      expectedPreviousPublicReleaseId: state.expectedPreviousPublicReleaseId, afterPublicRepackId: null,
    });
    expect(await publicViews(t, 1)).toEqual(before);
    await backfill(t, 1);
    expect(await migration(t)).toEqual(state);
    expect(await publicViews(t, 1)).toEqual(before);
    await initialize(t, 1);
    expect(await migration(t)).toEqual({ ...state, initialized: true });
    const after = await publicViews(t, 1);
    for (const response of after) expect(response.ok).toBe(true);
    expect(after[1]).toMatchObject({ data: { evEstimates: { packScout: {
      status: "last_known", metrics: detail.evEstimates.packScout.metrics,
      calculatedAt: detail.evEstimates.packScout.calculatedAt,
      confidence: { scoreBasisPoints: 0 },
    } } } });
    expect(await t.query(internal.dataReleaseV3Lifecycle.activeState, {})).toEqual(pointer);
    expect(await initialize(t, 1)).toMatchObject({ initialized: true });
    await t.run(async (ctx) => {
      const active = await ctx.db.query("activeDataReleaseV3State").unique();
      await ctx.db.patch("activeDataReleaseV3State", active!._id,
        { retainedEvTransitionId: undefined, retainedEvTransitionDirection: undefined });
    });
    await expect(migration(t)).rejects.toThrow();
    for (const response of await publicViews(t, 1)) expect(response).toMatchObject({ ok: false, code: "RELEASE_UNAVAILABLE" });
  });

  test.each(["phygitals", "courtyard", "collector_crypt"])(
    "%s legacy available snapshots sort source gross and signed EV without initializing retention",
    async (vendorKey) => {
      const t = convexTest(schema, modules);
      const sourceEstimates = (minorUnits: number) => ({
        packScout: buildV3UnavailableEv("SOURCE_EVIDENCE_UNAVAILABLE"),
        vendorReported: {
          status: "available" as const,
          sourceMoney: { minorUnits, currency: "USD" },
          usdComparison: { status: "available" as const, value: { minorUnits, currency: "USD" as const } },
          observedAt: V3_OBSERVED_AT,
        },
      });
      const soldOutId = "00000000-0000-5000-8000-000000000304";
      const zeroId = "00000000-0000-5000-8000-000000000305";
      await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [
        buildV3Detail({ publicRepackId: V3_REPACK_ID_A, vendorKey, evEstimates: {
          packScout: buildV3CurrentEv(8_500), vendorReported: sourceEstimates(50_000).vendorReported } }),
        buildV3Detail({ publicRepackId: V3_REPACK_ID_B, vendorKey,
          buyback: { kind: "uniform_rate", rateBasisPoints: 9_000 }, evEstimates: sourceEstimates(10_421) }),
        buildV3Detail({ publicRepackId: V3_REPACK_ID_C,
          publicVendorId: "00000000-0000-5000-8000-000000000002", evEstimates: sourceEstimates(50_000) }),
        buildV3SoldOutDetail({ publicRepackId: soldOutId, vendorKey, evEstimates: sourceEstimates(100_000) }),
        buildV3Detail({ publicRepackId: zeroId, vendorKey,
          buyback: { kind: "uniform_rate", rateBasisPoints: 0 }, evEstimates: sourceEstimates(20_000) }),
      ]), null);
      await removeDerivedRetentionForLegacyTest(t);
      await clearFacts(t);
      expect((await migration(t)).initialized).toBe(false);
      for (const sort of ["packscout_gross_ev", "packscout_ev_dollars", "packscout_ev_percent"]) {
        for (const direction of ["asc", "desc"] as const) {
          const response = await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
            filters: { availability: "all" }, sort, direction, currentTime: V3_FIXTURE_NOW,
          }) as { ok: boolean; data: { rows: { publicRepackId: string }[] } };
          expect(response.ok).toBe(true);
          const available = direction === "asc"
            ? [zeroId, V3_REPACK_ID_A, V3_REPACK_ID_B]
            : [V3_REPACK_ID_B, V3_REPACK_ID_A, zeroId];
          // Current independent EV wins; the unsupported provider and sold-out
          // source estimate remain unranked for all displayed EV metrics.
          expect(response.data.rows.map(row => row.publicRepackId)).toEqual([...available, V3_REPACK_ID_C, soldOutId]);
        }
      }
      expect((await migration(t)).initialized).toBe(false);
    },
  );

  test("previous valid history beneath an unavailable active snapshot appears atomically at initialization", async () => {
    const t = convexTest(schema, modules);
    const prior = buildV3Detail();
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [prior]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [unavailableRetentionDetail()]), 1);
    await removeDerivedRetentionForLegacyTest(t);
    await clearFacts(t);
    const before = await publicViews(t, 2);
    expect(before[1]).toMatchObject({ ok: true, data: { evEstimates: { packScout: { status: "unavailable" } } } });
    await backfill(t, 1);
    await backfill(t, 2);
    expect(await publicViews(t, 2)).toEqual(before);
    expect((await migration(t)).initialized).toBe(false);
    await initialize(t, 2);
    expect((await migration(t)).initialized).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("dataReleaseV3Releases").collect())
      .map((release) => release.evFactsRequired))).toEqual([true, true]);
    const after = await publicViews(t, 2);
    expect(after[1]).toMatchObject({ ok: true, data: { evEstimates: { packScout: {
      status: "last_known", metrics: prior.evEstimates.packScout.metrics,
      calculatedAt: prior.evEstimates.packScout.calculatedAt,
    } } } });
  });

  test("an earlier markerless backfill initialization cannot reopen snapshot reads after losing its pointer", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await removeDerivedRetentionForLegacyTest(t);
    await clearFacts(t);
    await backfill(t, 1);
    await initialize(t, 1);
    await t.run(async (ctx) => {
      const release = await ctx.db.query("dataReleaseV3Releases").unique();
      const state = await ctx.db.query("activeDataReleaseV3State").unique();
      await ctx.db.patch("dataReleaseV3Releases", release!._id, { evFactsRequired: undefined });
      await ctx.db.patch("activeDataReleaseV3State", state!._id,
        { retainedEvTransitionId: undefined, retainedEvTransitionDirection: undefined });
    });
    await expect(migration(t)).rejects.toThrow();
    for (const response of await publicViews(t, 1)) expect(response).toMatchObject({ ok: false, code: "RELEASE_UNAVAILABLE" });
  });

  test("1000 legacy packs with maximum descriptions remain readable throughout the bounded cutover", async () => {
    const t = convexTest(schema, modules);
    const first = buildV3Detail({ description: "x".repeat(4_000) });
    const details = [first, ...Array.from({ length: 999 }, (_, index) => buildV3Detail({
      publicRepackId: `00000000-0000-5000-8000-${(80_000 + index).toString().padStart(12, "0")}`,
      description: "x".repeat(4_000),
    }))];
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, details), null);
    await removeDerivedRetentionForLegacyTest(t);
    await clearFacts(t);
    const before = await publicViews(t, 1);
    for (const response of before) expect(response.ok).toBe(true);
    await backfill(t, 1);
    expect(await publicViews(t, 1)).toEqual(before);
    await initialize(t, 1);
    expect((await migration(t)).initialized).toBe(true);
    const after = await publicViews(t, 1);
    for (const response of after) expect(response.ok).toBe(true);
    expect(after[1]).toMatchObject({ data: { description: first.description,
      evEstimates: { packScout: { status: "last_known", metrics: first.evEstimates.packScout.metrics } } } });
  }, 30_000);

  test.each(["missing facts", "missing retention", "partial retention", "missing journal", "tampered journal", "unmarked staged facts"])(
    "new releases fail closed instead of taking the legacy path for %s", async (damage) => {
      const t = convexTest(schema, modules);
      await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
      expect((await migration(t)).initialized).toBe(true);
      await t.run(async (ctx) => {
        const release = await ctx.db.query("dataReleaseV3Releases").unique();
        expect(release?.evFactsRequired).toBe(true);
        const state = await ctx.db.query("activeDataReleaseV3State").unique();
        if (damage === "missing facts") {
          for (const row of await ctx.db.query("dataReleaseV3EvFacts").collect())
            await ctx.db.delete("dataReleaseV3EvFacts", row._id);
        } else if (damage === "missing retention" || damage === "partial retention") {
          await ctx.db.patch("activeDataReleaseV3State", state!._id, {
            retainedEvTransitionId: undefined,
            ...(damage === "missing retention" ? { retainedEvTransitionDirection: undefined } : {}),
          });
        } else if (damage === "unmarked staged facts") {
          await ctx.db.patch("dataReleaseV3Releases", release!._id, { evFactsRequired: undefined });
          await ctx.db.patch("activeDataReleaseV3State", state!._id,
            { retainedEvTransitionId: undefined, retainedEvTransitionDirection: undefined });
        } else {
          const transition = await ctx.db.query("dataReleaseV3EvRetentionTransitions").unique();
          if (damage === "missing journal") await ctx.db.delete("dataReleaseV3EvRetentionTransitions", transition!._id);
          else await ctx.db.patch("dataReleaseV3EvRetentionTransitions", transition!._id, { changesSha256: "0".repeat(64) });
        }
      });
      await expect(migration(t)).rejects.toThrow();
      await expect(initialize(t, 1)).rejects.toThrow();
      if (damage !== "tampered journal") {
        for (const response of await publicViews(t, 1)) expect(response).toMatchObject({ ok: false, code: "RELEASE_UNAVAILABLE" });
      }
    });
});
