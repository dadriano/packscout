/// <reference types="vite/client" />
import {
  packScoutPublicEvV3Schema, type PublicRepackViewDetailV3,
  type PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  buildV3CurrentEv, buildV3Detail, buildV3SoldOutDetail, v3ActivateRequest, v3Body,
  v3RollbackRequest, V3_FIXTURE_NOW, V3_OBSERVED_AT, V3_REPACK_ID_A, V3_REPACK_ID_B,
  V3_SOLD_OUT_AT,
} from "./dataReleaseV3Fixture.test-support";
import {
  activateRetentionRelease, readRetentionDetail, removeDerivedRetentionForLegacyTest,
  retentionReleaseId, stageRetentionRelease, unavailableRetentionDetail,
} from "./dataReleaseV3Retention.test-support";

const modules = import.meta.glob("./**/*.ts");
const muchLater = V3_FIXTURE_NOW + 24 * 60 * 60_000;

function newerValidDetail() {
  const base = buildV3Detail();
  return buildV3Detail({ evEstimates: { ...base.evEstimates,
    packScout: packScoutPublicEvV3Schema.parse({ ...buildV3CurrentEv(9_500),
      calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + 60_000).toISOString(),
      sourceAge: { milliseconds: 60_000, state: "fresh_within_15_minutes" },
    }),
  } });
}

describe("activation-owned last valid EV", () => {
  test("unavailable publications retain exact values, timestamps, price basis and rank at zero confidence", async () => {
    const t = convexTest(schema, modules);
    const original = buildV3Detail();
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [original]), null);
    const first = (await readRetentionDetail(t, 1, muchLater)).evEstimates.packScout;
    expect(first).toMatchObject({ status: "last_known", metrics: original.evEstimates.packScout.metrics,
      calculatedAt: V3_OBSERVED_AT, confidence: { scoreBasisPoints: 0 },
      latestUnavailableReason: null, calculationPriceUsdMinor: 10_000, expiresAt: null });
    const changedPrice = { displayMoney: { minorUnits: 20_000, currency: "USD" as const },
      usdComparison: { status: "available" as const, value: { minorUnits: 20_000, currency: "USD" as const } } };
    for (const number of [2, 3]) {
      const failed = unavailableRetentionDetail({ price: changedPrice, buyback: { kind: "not_documented" } });
      failed.evEstimates.packScout = packScoutPublicEvV3Schema.parse({ ...failed.evEstimates.packScout,
        calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + number * 60_000).toISOString() });
      await activateRetentionRelease(t, await stageRetentionRelease(t, number, [failed]), number - 1);
      const detail = await readRetentionDetail(t, number, muchLater);
      expect(detail.price).toEqual(changedPrice);
      expect(detail.evEstimates.packScout).toMatchObject({ status: "last_known",
        metrics: original.evEstimates.packScout.metrics, calculatedAt: V3_OBSERVED_AT,
        dataAsOf: original.evEstimates.packScout.dataAsOf, calculationPriceUsdMinor: 10_000,
        confidence: { scoreBasisPoints: 0 }, latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE" });
      const dashboard = await t.query(api.publicRepacksV3.getDashboardBundleV3,
        { currentTime: muchLater }) as { ok: boolean; data: { opportunities: unknown[]; kpis: Record<string, unknown> } };
      expect(dashboard.ok).toBe(true);
      expect(dashboard.data.opportunities).toHaveLength(1);
      expect(dashboard.data.kpis).toMatchObject({ highConfidenceRepacks: 0,
        medianPackScoutEvPercent: { status: "available", basisPoints: -1_500 } });
    }
    const stored = await t.run((ctx) => ctx.db.query("dataReleaseV3Repacks")
      .withIndex("by_release_id_and_public_repack_id").collect());
    expect(stored.map((row) => row.detail.evEstimates.packScout.status)).toEqual(["current", "unavailable", "unavailable"]);
  });

  test("removal and reappearance preserve history but vendor identity cannot borrow it", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2,
      [unavailableRetentionDetail({ publicRepackId: V3_REPACK_ID_B })]), 1);
    const otherVendor = unavailableRetentionDetail({ vendorKey: "other_provider",
      publicVendorId: "00000000-0000-5000-8000-000000000002" });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [otherVendor]), 2);
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout.status).toBe("unavailable");
    await activateRetentionRelease(t, await stageRetentionRelease(t, 4, [unavailableRetentionDetail()]), 3);
    expect((await readRetentionDetail(t, 4)).evEstimates.packScout).toMatchObject({
      status: "last_known", metrics: { evDollars: { minorUnits: -1_500 } },
    });
  });

  test("newer valid calculations replace history and older valid calculations cannot replace it", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [newerValidDetail()]), 1);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [buildV3Detail()]), 2);
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout).toMatchObject({
      status: "last_known", metrics: { evDollars: { minorUnits: -500 } },
      calculatedAt: newerValidDetail().evEstimates.packScout.calculatedAt,
    });
  });

  test("older valid evidence cannot clear a newer failed attempt; a genuinely newer valid calculation can", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    const failed = unavailableRetentionDetail();
    failed.evEstimates.packScout = packScoutPublicEvV3Schema.parse({ ...failed.evEstimates.packScout,
      calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + 3 * 60_000).toISOString() });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [failed]), 1);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [newerValidDetail()]), 2);
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout).toMatchObject({
      metrics: { evDollars: { minorUnits: -500 } }, confidence: { scoreBasisPoints: 0 },
      latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE",
    });
    const fresh = newerValidDetail();
    fresh.evEstimates.packScout = packScoutPublicEvV3Schema.parse({ ...fresh.evEstimates.packScout,
      calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + 4 * 60_000).toISOString(),
      sourceAge: { milliseconds: 4 * 60_000, state: "fresh_within_15_minutes" } });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 4, [fresh]), 3);
    expect((await readRetentionDetail(t, 4)).evEstimates.packScout).toMatchObject({
      confidence: { scoreBasisPoints: 10_000 }, latestUnavailableReason: null,
    });
    await t.mutation(internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(retentionReleaseId(4), retentionReleaseId(3))));
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout).toMatchObject({
      confidence: { scoreBasisPoints: 0 }, latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE",
    });
  });

  test("timestamp ties preserve the original value and cannot clear a tied failed attempt", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    const equal = buildV3Detail({ evEstimates: { ...buildV3Detail().evEstimates, packScout: buildV3CurrentEv(9_500) } });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [equal]), 1);
    expect((await readRetentionDetail(t, 2)).evEstimates.packScout).toMatchObject({ metrics: { evDollars: { minorUnits: -1_500 } } });
    const failed = unavailableRetentionDetail();
    failed.evEstimates.packScout = packScoutPublicEvV3Schema.parse({ ...failed.evEstimates.packScout,
      calculatedAt: newerValidDetail().evEstimates.packScout.calculatedAt });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [failed]), 2);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 4, [newerValidDetail()]), 3);
    expect((await readRetentionDetail(t, 4)).evEstimates.packScout).toMatchObject({
      metrics: { evDollars: { minorUnits: -1_500 } }, confidence: { scoreBasisPoints: 0 },
      latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE",
    });
  });

  test("an older unavailable attempt cannot suppress confidence in a newer valid retained value", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [newerValidDetail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [unavailableRetentionDetail()]), 1);
    expect((await readRetentionDetail(t, 2)).evEstimates.packScout).toMatchObject({
      confidence: { scoreBasisPoints: 10_000 }, latestUnavailableReason: null,
      calculatedAt: newerValidDetail().evEstimates.packScout.calculatedAt,
    });
  });

  test("complete but unactivated and failed CAS releases never enter history", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [unavailableRetentionDetail()]), null);
    const staged = await stageRetentionRelease(t, 2, [newerValidDetail()]);
    expect((await readRetentionDetail(t, 1)).evEstimates.packScout.status).toBe("unavailable");
    await expect(t.mutation(internal.dataReleaseV3Lifecycle.activate,
      await v3Body(v3ActivateRequest(staged, null)))).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3RetainedEv").collect())).toEqual([]);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [unavailableRetentionDetail()]), 1);
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout.status).toBe("unavailable");
  });

  test("rollback restores the prior history and a later branch never sees discarded future calculations", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [newerValidDetail()]), 1);
    await t.mutation(internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(retentionReleaseId(2), retentionReleaseId(1))));
    expect((await readRetentionDetail(t, 1)).evEstimates.packScout).toMatchObject({
      metrics: { evDollars: { minorUnits: -1_500 } },
    });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [unavailableRetentionDetail()]), 1);
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout).toMatchObject({
      metrics: { evDollars: { minorUnits: -1_500 } },
    });
  });

  test("repeated rollback toggles restore or remove introduced values exactly", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [unavailableRetentionDetail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [buildV3Detail()]), 1);
    for (const [index, [from, to]] of [[2, 1], [1, 2], [2, 1]].entries()) {
      const request = v3RollbackRequest(retentionReleaseId(from!), retentionReleaseId(to!));
      await t.mutation(internal.dataReleaseV3Lifecycle.rollback,
        await v3Body({ ...request, operationId: `${request.operationId}:${index}`,
          idempotencyKey: `${request.idempotencyKey}:${index}` }));
      expect((await readRetentionDetail(t, to!)).evEstimates.packScout.status)
        .toBe(to === 1 ? "unavailable" : "last_known");
    }
  });

  test("legacy active valid values are visible immediately and seed the first next activation", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await removeDerivedRetentionForLegacyTest(t);
    expect((await readRetentionDetail(t, 1, muchLater)).evEstimates.packScout.status).toBe("last_known");
    expect(await t.run((ctx) => ctx.db.query("dataReleaseV3RetainedEv").collect())).toEqual([]);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [unavailableRetentionDetail()]), 1);
    expect((await readRetentionDetail(t, 2, muchLater)).evEstimates.packScout.status).toBe("last_known");
    await t.mutation(internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(retentionReleaseId(2), retentionReleaseId(1))));
    expect((await readRetentionDetail(t, 1, muchLater)).evEstimates.packScout.status).toBe("last_known");
  });

  test("sold-out history remains visible after expiry without becoming an opportunity", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3SoldOutDetail()]), null);
    const ev = (await readRetentionDetail(t, 1, muchLater)).evEstimates.packScout;
    expect(ev).toMatchObject({ status: "last_known", confidence: { scoreBasisPoints: 0 } });
    if (ev.status !== "last_known") throw new Error("expected retained history");
    expect(ev.historicalSoldOutAt).not.toBeNull();
    const dashboard = await t.query(api.publicRepacksV3.getDashboardBundleV3,
      { currentTime: muchLater, filters: { availability: "all" } }) as { data: { opportunities: unknown[] } };
    expect(dashboard.data.opportunities).toEqual([]);
  });

  test("restocked packs keep sold-out EV visible but unranked until a newer valid calculation", async () => {
    const t = convexTest(schema, modules);
    const soldOut = buildV3SoldOutDetail();
    const eligible = buildV3Detail({ publicRepackId: V3_REPACK_ID_B,
      evEstimates: { ...buildV3Detail().evEstimates, packScout: buildV3CurrentEv(8_000) } });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [soldOut, eligible]), null);

    const restocked = unavailableRetentionDetail({ availability: "available" });
    restocked.evEstimates.packScout = packScoutPublicEvV3Schema.parse({
      ...restocked.evEstimates.packScout,
      calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + 4 * 60_000).toISOString(),
    });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [restocked, eligible]), 1);
    const detail = await readRetentionDetail(t, 2);
    expect(detail.availability).toBe("available");
    expect(detail.evEstimates.packScout).toMatchObject({ status: "last_known",
      metrics: soldOut.evEstimates.packScout.metrics, calculatedAt: V3_OBSERVED_AT,
      historicalSoldOutAt: V3_SOLD_OUT_AT, confidence: { scoreBasisPoints: 0 },
      latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE" });
    expect((await readRetentionDetail(t, 2, muchLater)).evEstimates.packScout).toMatchObject({
      status: "last_known", metrics: soldOut.evEstimates.packScout.metrics,
      calculatedAt: V3_OBSERVED_AT, historicalSoldOutAt: V3_SOLD_OUT_AT, expiresAt: null,
    });

    const dashboard = await t.query(api.publicRepacksV3.getDashboardBundleV3,
      { currentTime: V3_FIXTURE_NOW }) as { ok: boolean; data: {
        opportunities: PublicRepackViewSummaryV3[]; kpis: Record<string, unknown>;
        vendorSummaries: { medianPackScoutEvPercent: unknown }[];
        categorySummaries: { medianPackScoutEvPercent: unknown }[];
      } };
    expect(dashboard.ok).toBe(true);
    expect(dashboard.data.opportunities.map(({ publicRepackId }) => publicRepackId)).toEqual([V3_REPACK_ID_B]);
    expect(dashboard.data.kpis).toMatchObject({ totalRepacks: 2, highConfidenceRepacks: 1,
      medianPackScoutEvPercent: { status: "available", basisPoints: -2_000 } });
    for (const summary of [...dashboard.data.vendorSummaries, ...dashboard.data.categorySummaries]) {
      expect(summary.medianPackScoutEvPercent).toEqual({ status: "available", basisPoints: -2_000 });
    }
    for (const sort of ["packscout_ev_dollars", "packscout_ev_percent", "packscout_gross_ev", "packscout_confidence"]) {
      for (const direction of ["asc", "desc"]) {
        const list = await t.query(api.publicRepacksV3.listPublicRepacksV3,
          { currentTime: V3_FIXTURE_NOW, sort, direction }) as { ok: boolean; data: {
            rows: PublicRepackViewSummaryV3[]; details: PublicRepackViewDetailV3[];
          } };
        expect(list.ok).toBe(true);
        expect(list.data.rows.map(({ publicRepackId }) => publicRepackId), `${sort} ${direction}`)
          .toEqual([V3_REPACK_ID_B, V3_REPACK_ID_A]);
        expect(list.data.rows[1]?.evEstimates.packScout).toEqual(detail.evEstimates.packScout);
        expect(list.data.details[1]?.evEstimates.packScout).toEqual(detail.evEstimates.packScout);
      }
    }

    const recovered = newerValidDetail();
    recovered.evEstimates.packScout = packScoutPublicEvV3Schema.parse({ ...recovered.evEstimates.packScout,
      calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + 4.5 * 60_000).toISOString(),
      sourceAge: { milliseconds: 4.5 * 60_000, state: "fresh_within_15_minutes" },
    });
    await activateRetentionRelease(t, await stageRetentionRelease(t, 3, [recovered, eligible]), 2);
    expect((await readRetentionDetail(t, 3)).evEstimates.packScout).toMatchObject({
      status: "last_known", metrics: recovered.evEstimates.packScout.metrics,
      calculatedAt: recovered.evEstimates.packScout.calculatedAt,
      historicalSoldOutAt: null, latestUnavailableReason: null, confidence: { scoreBasisPoints: 10_000 },
    });
    const restoredDashboard = await t.query(api.publicRepacksV3.getDashboardBundleV3,
      { currentTime: V3_FIXTURE_NOW }) as typeof dashboard;
    expect(restoredDashboard.ok).toBe(true);
    expect(restoredDashboard.data.opportunities.map(({ publicRepackId }) => publicRepackId))
      .toEqual([V3_REPACK_ID_A, V3_REPACK_ID_B]);
    expect(restoredDashboard.data.kpis).toMatchObject({ totalRepacks: 2, highConfidenceRepacks: 2,
      medianPackScoutEvPercent: { status: "available", basisPoints: -1_250 } });
  });

  test("corrupt rollback proof fails without moving pointer or retained values", async () => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, [buildV3Detail()]), null);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 2, [newerValidDetail()]), 1);
    await t.run(async (ctx) => {
      const state = await ctx.db.query("activeDataReleaseV3State").unique();
      await ctx.db.patch("dataReleaseV3EvRetentionTransitions", state!.retainedEvTransitionId!,
        { changesSha256: "0".repeat(64) });
    });
    await expect(t.mutation(internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(retentionReleaseId(2), retentionReleaseId(1))))).rejects.toThrow();
    expect((await readRetentionDetail(t, 2)).evEstimates.packScout).toMatchObject({
      metrics: { evDollars: { minorUnits: -500 } },
    });
  });
});
