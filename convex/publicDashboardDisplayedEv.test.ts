/// <reference types="vite/client" />
import { publicDashboardBundleV3Schema, type PublicRepackDetailV3 } from "@packscout/contracts";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  buildV3CurrentEv, buildV3Detail, buildV3UnavailableEv, V3_FIXTURE_NOW, V3_OBSERVED_AT,
} from "./dataReleaseV3Fixture.test-support";
import {
  activateRetentionRelease, removeDerivedRetentionForLegacyTest, stageRetentionRelease,
} from "./dataReleaseV3Retention.test-support";

const modules = import.meta.glob("./**/*.ts");
const id = (number: number) => `00000000-0000-5000-8000-${(900 + number).toString().padStart(12, "0")}`;
const money = (minorUnits: number) => ({ minorUnits, currency: "USD" as const });
const vendorIds = { clutchpacks: id(100), collector_crypt: id(101), phygitals: id(102) };

function sourcePack(number: number, vendorKey: keyof typeof vendorIds,
  price: number, reportedEv: number, buybackRate: number): PublicRepackDetailV3 {
  return buildV3Detail({
    publicRepackId: id(number), publicVendorId: vendorIds[vendorKey], vendorKey,
    name: `${vendorKey} opportunity ${number}`,
    price: { displayMoney: money(price), usdComparison: { status: "available", value: money(price) } },
    buyback: { kind: "uniform_rate", rateBasisPoints: buybackRate },
    evEstimates: {
      packScout: buildV3UnavailableEv("SOURCE_EVIDENCE_UNAVAILABLE"),
      vendorReported: { status: "available", sourceMoney: money(reportedEv),
        usdComparison: { status: "available", value: money(reportedEv) }, observedAt: V3_OBSERVED_AT },
    },
  });
}

function independentPack(number: number, ev: number): PublicRepackDetailV3 {
  const pack = sourcePack(number, "clutchpacks", 10_000, 50_000, 9_000);
  return buildV3Detail({ ...pack,
    evEstimates: { ...pack.evEstimates, packScout: buildV3CurrentEv(10_000 + ev) } });
}

function mixedVendorPacks() {
  const nonPurchasable = (["sold_out", "unavailable", "unknown"] as const).map((availability, index) =>
    buildV3Detail({ ...sourcePack(9 + index, "collector_crypt", 2_500, 500_000, 9_000),
      availability, actionAvailability: { promo: true, repackLink: false },
      actions: { promo: { code: "SCOUT", label: "Use SCOUT" } } }));
  return [
    independentPack(0, -28), independentPack(1, -64),
    sourcePack(2, "collector_crypt", 2_500, 2_750, 8_500), // -$1.62 after half-up rounding.
    sourcePack(3, "collector_crypt", 5_000, 5_250, 9_000), // -$2.75.
    sourcePack(4, "phygitals", 2_500, 2_592, 8_500), // -$2.97, ties independent pack 5.
    independentPack(5, -297), independentPack(6, -567), independentPack(7, -800),
    sourcePack(8, "clutchpacks", 2_500, 500_000, 9_000), // Unsupported vendor-derived source.
    ...nonPurchasable,
    buildV3Detail({ ...sourcePack(12, "phygitals", 2_500, 500_000, 9_000),
      buyback: { kind: "not_documented" } }),
  ];
}

test.each(["retained", "legacy"])(
  "%s dashboard ranks the same displayed EV across vendors without rewriting independent evidence",
  async (mode) => {
    const t = convexTest(schema, modules);
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, mixedVendorPacks()), null);
    if (mode === "legacy") await removeDerivedRetentionForLegacyTest(t);
    const storedBefore = await t.run(ctx => ctx.db.query("dataReleaseV3SearchShards").take(5));
    const query = async (filters = {}, selectedPublicRepackId: string | null = null) => {
      const result = await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
        filters, selectedPublicRepackId, currentTime: V3_FIXTURE_NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      const { kpis: _kpis, vendorSummaries: _vendors, categorySummaries: _categories,
        facets: _facets, activeFilters: _filters, ...bundle } = result.data;
      return publicDashboardBundleV3Schema.parse(bundle);
    };
    const all = await query({ availability: "all" }, id(4));
    expect(all.opportunities.map(row => row.publicRepackId)).toEqual([0, 1, 2, 3, 4, 5].map(id));
    expect(new Set(all.opportunities.map(row => row.vendorKey))).toEqual(new Set(Object.keys(vendorIds)));
    expect(all.details.map(row => row.publicRepackId)).toEqual(all.opportunities.map(row => row.publicRepackId));
    expect(all.selectedRepack?.publicRepackId).toBe(id(4));
    expect(all.opportunities.find(row => row.publicRepackId === id(2))?.evEstimates.packScout)
      .toMatchObject({ status: "unavailable", metrics: null, confidence: null });

    const list = await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      currentTime: V3_FIXTURE_NOW, sort: "packscout_ev_dollars", direction: "desc",
    });
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error(list.code);
    expect(list.data.rows.slice(0, 6).map(row => row.publicRepackId))
      .toEqual(all.opportunities.map(row => row.publicRepackId));
    const collector = await query({ vendors: ["collector_crypt"], availability: "all" }, id(4));
    expect(collector.opportunities.map(row => row.publicRepackId)).toEqual([id(2), id(3)]);
    expect(collector.selectedRepack?.publicRepackId).toBe(id(2));
    const priceFiltered = await query({ price: { mode: "narrowed", minMinor: 2_500, maxMinor: 2_500 } });
    expect(priceFiltered.opportunities.map(row => row.publicRepackId)).toEqual([id(2), id(4)]);
    const empty = await query({ price: { mode: "narrowed", minMinor: 1_000, maxMinor: 2_000 } });
    expect(empty.opportunities).toEqual([]);
    expect(empty.selectedRepack).toBeNull();
    expect(await t.run(ctx => ctx.db.query("dataReleaseV3SearchShards").take(5))).toEqual(storedBefore);
  },
);
