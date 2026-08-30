/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { buildV3Detail, v3Body, v3RollbackRequest, V3_FIXTURE_NOW } from "./dataReleaseV3Fixture.test-support";
import { activateRetentionRelease, removeDerivedRetentionForLegacyTest, retentionReleaseId,
  stageRetentionRelease, unavailableRetentionDetail, type RetentionTest } from "./dataReleaseV3Retention.test-support";

const modules = import.meta.glob("./**/*.ts");

async function immutableReleases(t: RetentionTest) {
  return t.run(async (ctx) => (await ctx.db.query("dataReleaseV3Releases").collect()).map((release) => {
    const immutable = { ...release };
    delete immutable.evFactsRequired;
    return immutable;
  }));
}

async function simulateLegacyFacts(t: RetentionTest) {
  await removeDerivedRetentionForLegacyTest(t);
  await t.run(async (ctx) => {
    for (const table of ["dataReleaseV3EvFacts", "dataReleaseV3EvFactSets"] as const) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(table, row._id);
    }
  });
}

async function progress(t: RetentionTest, number = 1) {
  return t.query(internal.dataReleaseV3EvFactsBackfill.progress,
    { publicReleaseId: retentionReleaseId(number) });
}

async function page(t: RetentionTest, status: Awaited<ReturnType<typeof progress>>) {
  return t.mutation(internal.dataReleaseV3EvFactsBackfill.backfillActiveReleaseEvFacts, {
    publicReleaseId: status.publicReleaseId, expectedGeneration: status.expectedGeneration,
    expectedActivePublicReleaseId: status.expectedActivePublicReleaseId,
    expectedPreviousPublicReleaseId: status.expectedPreviousPublicReleaseId,
    afterPublicRepackId: status.nextCursor,
  });
}

describe("one-time bounded compact EV migration", () => {
  test("stable 32-row pages preserve legacy reads and switch only after retention initialization", async () => {
    const t = convexTest(schema, modules);
    const details = Array.from({ length: 65 }, (_, index) => buildV3Detail({
      publicRepackId: `00000000-0000-5000-8000-${(40_000 + index).toString().padStart(12, "0")}`,
    }));
    const plan = await stageRetentionRelease(t, 1, details);
    await activateRetentionRelease(t, plan, null);
    await simulateLegacyFacts(t);
    const before = await immutableReleases(t);
    const legacy = await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: V3_FIXTURE_NOW + 24 * 60 * 60_000 });
    expect(legacy.ok).toBe(true);
    const initial = await progress(t);
    expect(initial).toMatchObject({ complete: false, count: 0, nextCursor: null });
    const first = await page(t, initial);
    expect(first).toMatchObject({ complete: false, count: 32 });
    expect(await page(t, initial)).toEqual(first);
    expect(await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: V3_FIXTURE_NOW + 24 * 60 * 60_000 })).toEqual(legacy);
    const second = await page(t, await progress(t));
    expect(second).toMatchObject({ complete: false, count: 64 });
    expect(await page(t, await progress(t))).toMatchObject({ complete: true, count: 65 });
    const ready = await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: V3_FIXTURE_NOW + 24 * 60 * 60_000 }) as {
        ok: boolean; data: { opportunities: { evEstimates: { packScout: { status: string } } }[] } };
    expect(ready.ok).toBe(true);
    expect(ready.data.opportunities).toHaveLength(6);
    expect(ready.data.opportunities[0]!.evEstimates.packScout.status).toBe("current");
    expect(ready).toEqual(legacy);
    expect(await immutableReleases(t)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3RetainedEv").collect())).toEqual([]);
    const status = await progress(t);
    await t.mutation(internal.dataReleaseV3EvFactsBackfill.initializeActiveRetention, {
      publicReleaseId: status.publicReleaseId, expectedGeneration: status.expectedGeneration,
      expectedActivePublicReleaseId: status.expectedActivePublicReleaseId,
      expectedPreviousPublicReleaseId: status.expectedPreviousPublicReleaseId,
    });
    const migrated = await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: V3_FIXTURE_NOW + 24 * 60 * 60_000 });
    expect(migrated).toMatchObject({ ok: true, data: { opportunities: [
      { evEstimates: { packScout: { status: "last_known" } } },
      ...Array(5).fill({}),
    ] } });
    expect(await immutableReleases(t)).toEqual(before);
  });

  test("pointer changes, out-of-scope releases, and invalid cursors cannot mutate migration state", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await simulateLegacyFacts(t);
    const initial = await progress(t);
    await expect(page(t, { ...initial, expectedGeneration: initial.expectedGeneration + 1 })).rejects.toThrow();
    await expect(page(t, { ...initial, nextCursor: "00000000-0000-5000-8000-000000000999" })).rejects.toThrow();
    await expect(progress(t, 3)).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3EvFacts").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3EvFactSets").collect())).toEqual([]);
    await page(t, initial);
  });

  test("tampered immutable detail/search proof prevents the entire page from publishing", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await simulateLegacyFacts(t);
    await t.run(async (ctx) => {
      const shard = await ctx.db.query("dataReleaseV3SearchShards").unique();
      await ctx.db.patch("dataReleaseV3SearchShards", shard!._id, {
        rows: shard!.rows.map((row) => ({ ...row, packScoutEvDollarsMinor: -999 })),
      });
    });
    await expect(page(t, await progress(t))).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3EvFacts").collect())).toEqual([]);
  });

  test("a missing compact projection blocks activation until the exact prior release is backfilled", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await simulateLegacyFacts(t);
    const next = await stageRetentionRelease(t, 2, [buildV3Detail()]);
    await expect(activateRetentionRelease(t, next, 1)).rejects.toThrow();
    expect((await progress(t)).expectedActivePublicReleaseId).toBe(retentionReleaseId(1));
    await page(t, await progress(t));
    await activateRetentionRelease(t, next, 1);
    expect((await progress(t, 2)).expectedActivePublicReleaseId).toBe(retentionReleaseId(2));
  });

  test("migration restores previous valid history beneath an unavailable active release and supports rollback", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [unavailableRetentionDetail()]), 1);
    await simulateLegacyFacts(t);
    const immutableBefore = await immutableReleases(t);
    const pointerBefore = await t.query(internal.dataReleaseV3Lifecycle.activeState, {});
    await page(t, await progress(t, 1));
    await page(t, await progress(t, 2));
    const status = await progress(t, 2);
    const args = { publicReleaseId: status.publicReleaseId, expectedGeneration: status.expectedGeneration,
      expectedActivePublicReleaseId: status.expectedActivePublicReleaseId,
      expectedPreviousPublicReleaseId: status.expectedPreviousPublicReleaseId };
    const first = await t.mutation(internal.dataReleaseV3EvFactsBackfill.initializeActiveRetention, args);
    expect(await t.mutation(internal.dataReleaseV3EvFactsBackfill.initializeActiveRetention, args)).toEqual(first);
    expect(await t.query(internal.dataReleaseV3Lifecycle.activeState, {})).toEqual(pointerBefore);
    expect(await immutableReleases(t)).toEqual(immutableBefore);
    const dashboard = await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, { currentTime: V3_FIXTURE_NOW }) as {
      data: { opportunities: { evEstimates: { packScout: { status: string } } }[] } };
    expect(dashboard.data.opportunities[0]!.evEstimates.packScout.status).toBe("last_known");
    await t.mutation(internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(retentionReleaseId(2), retentionReleaseId(1))));
    const afterRollback = await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, { currentTime: V3_FIXTURE_NOW }) as {
      data: { opportunities: unknown[] } };
    expect(afterRollback.data.opportunities).toHaveLength(1);
  });

  test("legacy rollback heads cannot seed values from their displaced future previous release", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [unavailableRetentionDetail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [buildV3Detail()]), 1);
    await t.mutation(internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(retentionReleaseId(2), retentionReleaseId(1))));
    await simulateLegacyFacts(t);
    await page(t, await progress(t, 1));
    await page(t, await progress(t, 2));
    const status = await progress(t, 1);
    await expect(t.mutation(internal.dataReleaseV3EvFactsBackfill.initializeActiveRetention, {
      publicReleaseId: status.publicReleaseId, expectedGeneration: status.expectedGeneration,
      expectedActivePublicReleaseId: status.expectedActivePublicReleaseId,
      expectedPreviousPublicReleaseId: status.expectedPreviousPublicReleaseId,
    })).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3RetainedEv").collect())).toEqual([]);
  });

  test("tampered compact facts fail their sealed hash before public ranking", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await t.run(async (ctx) => {
      const facts = await ctx.db.query("dataReleaseV3EvFacts").unique();
      await ctx.db.patch("dataReleaseV3EvFacts", facts!._id, { vendorKey: "wrong_provider" });
    });
    expect(await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, { currentTime: V3_FIXTURE_NOW }))
      .toMatchObject({ ok: false, code: "RELEASE_UNAVAILABLE" });
  });
});
