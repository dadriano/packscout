/// <reference types="vite/client" />

import {
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  type PublicCollectible,
  type PublicRepackChase,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  buildV3Chase,
  buildV3Collectible,
  buildV3CurrentEv,
  buildV3Detail,
  buildV3FixturePlan,
  buildV3SoldOutDetail,
  buildV3UnavailableEv,
  buildV3UnpurchasableDetail,
  v3ActivateRequest,
  v3BatchRequest,
  v3Body,
  v3FinalizeRequest,
  v3StartRequest,
  V3_COLLECTIBLE_ID,
  V3_EXPIRES_AT,
  V3_FIXTURE_NOW,
  V3_REPACK_ID_A,
  V3_REPACK_ID_B,
  V3_REPACK_ID_C,
  type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";

const modules = import.meta.glob("./**/*.ts");
type V3Test = TestConvex<typeof schema>;

const RELEASE_ID_1 = "10000000-0000-4000-8000-000000000001";
const NOW = V3_FIXTURE_NOW;
const AFTER_DEADLINE = Date.parse(V3_EXPIRES_AT) + 1;

function unavailableVendorEv() {
  return {
    status: "unavailable" as const,
    sourceMoney: null,
    usdComparison: null,
    observedAt: null,
    reason: "NOT_REPORTED" as const,
  };
}

/**
 * Fixture set: B ranks first (+$25 EV), A second (+$20 EV), C is sold out
 * with visible history, D is available without an estimate.
 */
const V3_REPACK_ID_D = "00000000-0000-5000-8000-000000000304";
const V3_REPACK_ID_E = "00000000-0000-5000-8000-000000000305";
const V3_REPACK_ID_F = "00000000-0000-5000-8000-000000000306";

/**
 * A second collectible worth far more than the default fixture chase. A pack
 * whose top chase is this collectible outbids every other fixture pack on
 * chase value, so a headline chase KPI that forgets its availability gate
 * reports this value instead of the available pack's.
 */
const V3_GRAIL_COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000202";
const V3_STANDALONE_COLLECTIBLE_ID =
  "00000000-0000-5000-8000-000000000203";
const V3_GRAIL_CHASE_VALUE_MINOR = 250_000;
const V3_DEFAULT_CHASE_VALUE_MINOR = 85_000;

function grailCollectible(): PublicCollectible {
  const base = buildV3Collectible();
  const money = { minorUnits: V3_GRAIL_CHASE_VALUE_MINOR, currency: "USD" as const };
  return publicCollectibleSchema.parse({
    ...base,
    publicCollectibleId: V3_GRAIL_COLLECTIBLE_ID,
    valuation: {
      ...base.valuation!,
      displayMoney: money,
      usdComparison: { status: "available", value: money },
    },
  });
}

function standaloneCollectible(): PublicCollectible {
  const base = buildV3Collectible();
  const name = "Pikachu Illustrator Promo";
  const aliases = ["Pikachu Promo"];
  return publicCollectibleSchema.parse({
    ...base,
    publicCollectibleId: V3_STANDALONE_COLLECTIBLE_ID,
    name,
    normalizedName: normalizePublicSearchText(name),
    aliases,
    normalizedAliases: aliases.map(normalizePublicSearchText),
    subject: "Pikachu",
    searchText: buildPublicCollectibleSearchText({
      name,
      aliases,
      year: base.year,
      brand: base.brand,
      setOrSeries: base.setOrSeries,
      cardNumber: base.cardNumber,
      referenceNumber: base.referenceNumber,
      subject: "Pikachu",
      grade: base.grade,
      grader: base.grader,
    }),
  });
}

function grailChase(publicRepackId: string): PublicRepackChase {
  const collectible = grailCollectible();
  return publicRepackChaseSchema.parse({
    ...buildV3Chase(publicRepackId),
    publicCollectibleId: collectible.publicCollectibleId,
    collectible: {
      publicCollectibleId: collectible.publicCollectibleId,
      name: collectible.name,
      collectibleType: collectible.collectibleType,
      publicCategoryIds: collectible.publicCategoryIds,
      primaryImage: collectible.primaryImage,
      valuation: collectible.valuation,
    },
  });
}

function fixtureDetails() {
  return [
    buildV3Detail({ publicRepackId: V3_REPACK_ID_A }),
    buildV3Detail({
      publicRepackId: V3_REPACK_ID_B,
      name: "Pokemon Value Gacha",
      evEstimates: {
        packScout: buildV3CurrentEv(12_500),
        vendorReported: unavailableVendorEv(),
      },
    }),
    buildV3SoldOutDetail({
      publicRepackId: V3_REPACK_ID_C,
      name: "Pokemon Vault Repack",
    }),
    buildV3Detail({
      publicRepackId: V3_REPACK_ID_D,
      name: "Pokemon Mystery Box",
      buyback: { kind: "not_documented" },
      evEstimates: {
        packScout: buildV3UnavailableEv("BUYBACK_UNAVAILABLE"),
        vendorReported: unavailableVendorEv(),
      },
    }),
  ];
}

async function publishFixture(
  t: V3Test,
  details = fixtureDetails(),
  collectibles: readonly PublicCollectible[] = [buildV3Collectible()],
): Promise<V3FixturePlan> {
  const plan = await buildV3FixturePlan({
    publicReleaseId: RELEASE_ID_1,
    details,
    collectibles,
  });
  await t.mutation(
    internal.dataReleaseV3Lifecycle.start,
    await v3Body(v3StartRequest(plan)),
  );
  for (const batch of plan.batches) {
    await t.mutation(
      internal.dataReleaseV3Lifecycle.applyBatch,
      await v3Body(v3BatchRequest(plan, batch)),
    );
  }
  await t.mutation(
    internal.dataReleaseV3Lifecycle.finalize,
    await v3Body(v3FinalizeRequest(plan)),
  );
  await t.mutation(
    internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(plan, null)),
  );
  return plan;
}

type AnyResult = { ok: boolean } & Record<string, unknown>;

describe("data_release_v3 public reads", () => {
  test("no reads succeed before activation and shell status carries the release identity after", async () => {
    const t = convexTest(schema, modules);
    const before = (await t.query(api.publicRepacksV3.getPublicShellStatusV3, {})) as AnyResult;
    expect(before.ok).toBe(false);
    expect((before as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
    await publishFixture(t);
    const after = (await t.query(api.publicRepacksV3.getPublicShellStatusV3, {})) as AnyResult;
    expect(after.ok).toBe(true);
    const release = (after.data as { release: Record<string, unknown> }).release;
    expect(release.publicReleaseId).toBe(RELEASE_ID_1);
    expect(release.methodVersion).toBe("packscout-buyback-adjusted-ev-v1");
  });

  test("dashboard ranks by signed EV dollars, excludes ineligible repacks, and aggregates with the same rules", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    const result = (await t.query(api.publicRepacksV3.getDashboardBundleV3, {
      filters: { availability: "all" },
      currentTime: NOW,
    })) as AnyResult;
    expect(result.ok).toBe(true);
    const data = result.data as {
      opportunities: { publicRepackId: string }[];
      kpis: {
        totalRepacks: number;
        positiveEvRepacks: number;
        highConfidenceRepacks: number;
        medianPackScoutEvPercent: { status: string; basisPoints: number | null };
      };
      vendorSummaries: {
        repackCount: number;
        medianPackScoutEvPercent: { basisPoints: number | null };
      }[];
      selectedRepack: { publicRepackId: string } | null;
    };
    // B (+$25) outranks A (+$20); sold-out C and unavailable D never rank.
    expect(data.opportunities.map(({ publicRepackId }) => publicRepackId)).toEqual([
      V3_REPACK_ID_B,
      V3_REPACK_ID_A,
    ]);
    expect(data.selectedRepack?.publicRepackId).toBe(V3_REPACK_ID_B);
    expect(data.kpis.totalRepacks).toBe(4);
    // Positive-EV counts admit only available repacks with a current estimate.
    expect(data.kpis.positiveEvRepacks).toBe(2);
    // Median excludes unavailable and sold-out estimates: (2000+2500)/2.
    expect(data.kpis.medianPackScoutEvPercent).toEqual({
      status: "available",
      basisPoints: 2_250,
    });
    expect(data.vendorSummaries[0]?.repackCount).toBe(4);
    expect(data.vendorSummaries[0]?.medianPackScoutEvPercent.basisPoints).toBe(
      2_250,
    );
  });

  test("EV-dollar ties rank deterministically by public id", async () => {
    const t = convexTest(schema, modules);
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: [
        buildV3Detail({ publicRepackId: V3_REPACK_ID_B, name: "Second Pack" }),
        buildV3Detail({ publicRepackId: V3_REPACK_ID_A }),
      ],
    });
    await t.mutation(
      internal.dataReleaseV3Lifecycle.start,
      await v3Body(v3StartRequest(plan)),
    );
    for (const batch of plan.batches) {
      await t.mutation(
        internal.dataReleaseV3Lifecycle.applyBatch,
        await v3Body(v3BatchRequest(plan, batch)),
      );
    }
    await t.mutation(
      internal.dataReleaseV3Lifecycle.finalize,
      await v3Body(v3FinalizeRequest(plan)),
    );
    await t.mutation(
      internal.dataReleaseV3Lifecycle.activate,
      await v3Body(v3ActivateRequest(plan, null)),
    );
    const result = (await t.query(api.publicRepacksV3.getDashboardBundleV3, {
      currentTime: NOW,
    })) as AnyResult;
    expect(result.ok).toBe(true);
    const data = result.data as { opportunities: { publicRepackId: string }[] };
    expect(data.opportunities.map(({ publicRepackId }) => publicRepackId)).toEqual([
      V3_REPACK_ID_A,
      V3_REPACK_ID_B,
    ]);
  });

  test("the list keeps sold-out history visible without ranking or action and keeps unavailable reasons public", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    const result = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      filters: { availability: "all" },
      sort: "packscout_ev_dollars",
      direction: "desc",
      currentTime: NOW,
    })) as AnyResult;
    expect(result.ok).toBe(true);
    const data = result.data as {
      rows: { publicRepackId: string }[];
      details: {
        publicRepackId: string;
        availability: string;
        actions?: { repackLink?: unknown };
        evEstimates: {
          packScout: Record<string, unknown> & { status: string };
        };
      }[];
      range: { total: number };
    };
    // Null EV ranks last on a desc EV sort; ties break by public id.
    expect(data.rows.map(({ publicRepackId }) => publicRepackId)).toEqual([
      V3_REPACK_ID_B,
      V3_REPACK_ID_A,
      V3_REPACK_ID_C,
      V3_REPACK_ID_D,
    ]);
    const soldOut = data.details.find(
      ({ publicRepackId }) => publicRepackId === V3_REPACK_ID_C,
    )!;
    expect(soldOut.availability).toBe("sold_out");
    expect(soldOut.evEstimates.packScout.status).toBe("sold_out_historical");
    expect(soldOut.evEstimates.packScout.metrics).toBeDefined();
    expect(soldOut.actions?.repackLink).toBeUndefined();
    const unavailable = data.details.find(
      ({ publicRepackId }) => publicRepackId === V3_REPACK_ID_D,
    )!;
    expect(unavailable.evEstimates.packScout.status).toBe("unavailable");
    expect(unavailable.evEstimates.packScout.reason).toBe("BUYBACK_UNAVAILABLE");
    // Null EV rows also rank last on ascending sorts.
    const ascending = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      filters: { availability: "all" },
      sort: "packscout_ev_dollars",
      direction: "asc",
      currentTime: NOW,
    })) as AnyResult;
    const ascendingRows = (ascending.data as { rows: { publicRepackId: string }[] }).rows;
    expect(ascendingRows.map(({ publicRepackId }) => publicRepackId)).toEqual([
      V3_REPACK_ID_A,
      V3_REPACK_ID_B,
      V3_REPACK_ID_C,
      V3_REPACK_ID_D,
    ]);
    // The v3 contract has no vendor-reported percent projection to sort by.
    const unsupported = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      sort: "vendor_reported_ev_percent",
      currentTime: NOW,
    })) as AnyResult;
    expect((unsupported as { code?: string }).code).toBe("INVALID_QUERY");
  });

  test("the availability filter admits only available packs and keeps the other three states discoverable", async () => {
    const t = convexTest(schema, modules);
    // Every non-available pack here carries a *current* PackScout estimate, so
    // only the availability guard itself can keep them out of the filtered
    // list, the opportunity ranking, and the positive-EV count. All three also
    // out-chase the available pack, so any headline KPI that reads an ungated
    // row reports their number instead of the available pack's.
    await publishFixture(
      t,
      [
        buildV3Detail({ publicRepackId: V3_REPACK_ID_A }),
        buildV3SoldOutDetail({
          publicRepackId: V3_REPACK_ID_C,
          name: "Pokemon Vault Repack",
          topChase: grailChase(V3_REPACK_ID_C),
        }),
        buildV3UnpurchasableDetail("unavailable", {
          publicRepackId: V3_REPACK_ID_E,
          name: "Pokemon Paused Repack",
          topChase: grailChase(V3_REPACK_ID_E),
        }),
        buildV3UnpurchasableDetail("unknown", {
          publicRepackId: V3_REPACK_ID_F,
          name: "Pokemon Unverified Repack",
          topChase: grailChase(V3_REPACK_ID_F),
        }),
      ],
      [buildV3Collectible(), grailCollectible()],
    );

    // The default filter is "available": nothing else may appear.
    const filtered = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      currentTime: NOW,
    })) as AnyResult;
    expect(filtered.ok).toBe(true);
    const filteredData = filtered.data as {
      rows: { publicRepackId: string }[];
      range: { total: number };
    };
    expect(filteredData.rows.map(({ publicRepackId }) => publicRepackId)).toEqual(
      [V3_REPACK_ID_A],
    );
    expect(filteredData.range.total).toBe(1);

    // "all" is the only way the other three states become visible, each
    // presented with its exact public availability value.
    const everything = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      filters: { availability: "all" },
      currentTime: NOW,
    })) as AnyResult;
    expect(everything.ok).toBe(true);
    const everythingData = everything.data as {
      rows: { publicRepackId: string }[];
      details: {
        publicRepackId: string;
        availability: string;
        actions?: { repackLink?: unknown };
      }[];
      range: { total: number };
    };
    expect(everythingData.range.total).toBe(4);
    expect(
      Object.fromEntries(
        everythingData.details.map(({ publicRepackId, availability }) => [
          publicRepackId,
          availability,
        ]),
      ),
    ).toEqual({
      [V3_REPACK_ID_A]: "available",
      [V3_REPACK_ID_C]: "sold_out",
      [V3_REPACK_ID_E]: "unavailable",
      [V3_REPACK_ID_F]: "unknown",
    });
    // Only an available pack may expose an outbound purchase action.
    for (const detail of everythingData.details) {
      expect(
        detail.actions?.repackLink === undefined,
        `${detail.publicRepackId} (${detail.availability}) action exposure`,
      ).toBe(detail.availability !== "available");
    }

    // Ranking and the positive-EV KPI admit the available pack alone.
    const dashboard = (await t.query(api.publicRepacksV3.getDashboardBundleV3, {
      filters: { availability: "all" },
      currentTime: NOW,
    })) as AnyResult;
    expect(dashboard.ok).toBe(true);
    const dashboardData = dashboard.data as {
      opportunities: { publicRepackId: string }[];
      kpis: {
        totalRepacks: number;
        positiveEvRepacks: number;
        highestChaseValueUsdMinor: number | null;
      };
    };
    expect(
      dashboardData.opportunities.map(({ publicRepackId }) => publicRepackId),
    ).toEqual([V3_REPACK_ID_A]);
    // The catalog total stays ungated: all four states remain discoverable.
    expect(dashboardData.kpis.totalRepacks).toBe(4);
    expect(dashboardData.kpis.positiveEvRepacks).toBe(1);
    // The headline chase value reports the available pack's chase, never the
    // richer chase sitting inside a sold_out, unavailable, or unknown pack.
    expect(dashboardData.kpis.highestChaseValueUsdMinor).toBe(
      V3_DEFAULT_CHASE_VALUE_MINOR,
    );
  });

  test("a current estimate past its deadline fails closed at read time without any new transition", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    const result = (await t.query(api.publicRepacksV3.getDashboardBundleV3, {
      filters: { availability: "all" },
      currentTime: AFTER_DEADLINE,
    })) as AnyResult;
    expect(result.ok).toBe(true);
    const data = result.data as {
      opportunities: unknown[];
      kpis: {
        positiveEvRepacks: number;
        medianPackScoutEvPercent: { status: string };
      };
    };
    expect(data.opportunities).toEqual([]);
    expect(data.kpis.positiveEvRepacks).toBe(0);
    expect(data.kpis.medianPackScoutEvPercent.status).toBe("unavailable");

    const detail = (await t.query(api.publicRepacksV3.getPublicRepackV3, {
      publicRepackId: V3_REPACK_ID_A,
      publicReleaseId: RELEASE_ID_1,
      currentTime: AFTER_DEADLINE,
    })) as AnyResult;
    expect(detail.ok).toBe(true);
    const packScout = (detail.data as {
      evEstimates: {
        packScout: { status: string; reason?: string; dataAsOf?: unknown };
      };
    }).evEstimates.packScout;
    expect(packScout.status).toBe("unavailable");
    expect(packScout.reason).toBe("SOURCE_DATA_STALE");
    expect(packScout.dataAsOf).toEqual({
      state: "known",
      observedAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    // At the exact deadline the estimate is still presentable.
    const atDeadline = (await t.query(api.publicRepacksV3.getPublicRepackV3, {
      publicRepackId: V3_REPACK_ID_A,
      publicReleaseId: RELEASE_ID_1,
      currentTime: Date.parse(V3_EXPIRES_AT),
    })) as AnyResult;
    expect(
      (atDeadline.data as { evEstimates: { packScout: { status: string } } })
        .evEstimates.packScout.status,
    ).toBe("current");
  });

  test("desired-collectible matching binds rows to chases and search stays bounded", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t, fixtureDetails(), [
      buildV3Collectible(),
      standaloneCollectible(),
    ]);
    const list = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      desiredPublicCollectibleId: V3_COLLECTIBLE_ID,
      currentTime: NOW,
    })) as AnyResult;
    expect(list.ok).toBe(true);
    const data = list.data as {
      rows: { publicRepackId: string }[];
      desiredChaseMatches: { publicRepackId: string }[];
      desiredCollectible: { publicCollectibleId: string } | null;
    };
    // Available-only default filter: A, B, D chase it; C is sold out.
    expect(data.rows.map(({ publicRepackId }) => publicRepackId)).toEqual([
      V3_REPACK_ID_B,
      V3_REPACK_ID_A,
      V3_REPACK_ID_D,
    ]);
    expect(data.desiredCollectible?.publicCollectibleId).toBe(V3_COLLECTIBLE_ID);
    expect(
      data.desiredChaseMatches.map(({ publicRepackId }) => publicRepackId).sort(),
    ).toEqual([V3_REPACK_ID_A, V3_REPACK_ID_B, V3_REPACK_ID_D].sort());

    const found = (await t.query(api.publicRepacksV3.findRepacksByDesiredCollectibleV3, {
      publicCollectibleId: V3_COLLECTIBLE_ID,
      currentTime: NOW,
    })) as AnyResult;
    expect(found.ok).toBe(true);
    const matches = (found.data as {
      matches: { repack: { publicRepackId: string } }[];
      total: number;
    });
    expect(matches.total).toBe(3);
    expect(matches.matches.length).toBe(3);

    const searched = (await t.query(api.publicRepacksV3.searchPublicCollectiblesV3, {
      search: "charizard",
    })) as AnyResult;
    expect(searched.ok).toBe(true);
    expect(
      (searched.data as { matches: { publicCollectibleId: string }[] }).matches[0]
        ?.publicCollectibleId,
    ).toBe(V3_COLLECTIBLE_ID);

    const standaloneSearch = (await t.query(
      api.publicRepacksV3.searchPublicCollectiblesV3,
      { search: "pikachu illustrator promo" },
    )) as AnyResult;
    expect(standaloneSearch.ok).toBe(true);
    expect(
      (
        standaloneSearch.data as {
          matches: { publicCollectibleId: string }[];
        }
      ).matches[0]?.publicCollectibleId,
    ).toBe(V3_STANDALONE_COLLECTIBLE_ID);

    const noRepackMatches = (await t.query(
      api.publicRepacksV3.findRepacksByDesiredCollectibleV3,
      {
        publicCollectibleId: V3_STANDALONE_COLLECTIBLE_ID,
        currentTime: NOW,
      },
    )) as AnyResult;
    expect(noRepackMatches.ok).toBe(true);
    expect(noRepackMatches.data).toMatchObject({ matches: [], total: 0 });
  });

  test("pagination is bounded, fingerprinted, and survives release changes explicitly", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    const first = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      filters: { availability: "all" },
      pageSize: 2,
      currentTime: NOW,
    })) as AnyResult;
    expect(first.ok).toBe(true);
    const firstPage = first.data as {
      rows: { publicRepackId: string }[];
      nextCursor: string | null;
      queryFingerprint: string;
      range: { start: number; end: number; total: number };
    };
    expect(firstPage.rows.length).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.range).toEqual({ start: 1, end: 2, total: 4 });
    const second = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      filters: { availability: "all" },
      pageSize: 2,
      cursor: firstPage.nextCursor,
      queryFingerprint: firstPage.queryFingerprint,
      currentTime: NOW,
    })) as AnyResult;
    expect(second.ok).toBe(true);
    const secondPage = second.data as {
      rows: { publicRepackId: string }[];
      range: { start: number; end: number; total: number };
      hasPrevious: boolean;
    };
    expect(secondPage.rows.length).toBe(2);
    expect(secondPage.hasPrevious).toBe(true);
    expect(secondPage.range).toEqual({ start: 3, end: 4, total: 4 });
    // A cursor from a foreign fingerprint is refused.
    const mismatched = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      pageSize: 2,
      cursor: firstPage.nextCursor,
      queryFingerprint: firstPage.queryFingerprint,
      currentTime: NOW,
    })) as AnyResult;
    expect((mismatched as { code?: string }).code).toBe("INVALID_QUERY");
  });

  test("tampered stored details or search rows fail every dependent read closed", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    await t.run(async (ctx) => {
      const repacks = await ctx.db.query("dataReleaseV3Repacks").collect();
      const target = repacks.find(
        ({ publicRepackId }) => publicRepackId === V3_REPACK_ID_B,
      )!;
      const detail = target.detail;
      if (detail.evEstimates.packScout.status !== "current") {
        throw new Error("unexpected fixture");
      }
      await ctx.db.patch("dataReleaseV3Repacks", target._id, {
        detail: {
          ...detail,
          evEstimates: {
            ...detail.evEstimates,
            packScout: {
              ...detail.evEstimates.packScout,
              metrics: {
                ...detail.evEstimates.packScout.metrics,
                evDollars: {
                  ...detail.evEstimates.packScout.metrics.evDollars,
                  minorUnits: 999_999,
                },
              },
            },
          },
        },
      });
    });
    const dashboard = (await t.query(api.publicRepacksV3.getDashboardBundleV3, {
      currentTime: NOW,
    })) as AnyResult;
    expect(dashboard.ok).toBe(false);
    expect((dashboard as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
    const detail = (await t.query(api.publicRepacksV3.getPublicRepackV3, {
      publicRepackId: V3_REPACK_ID_B,
      publicReleaseId: RELEASE_ID_1,
      currentTime: NOW,
    })) as AnyResult;
    expect((detail as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
  });

  test("an incomplete or internally inconsistent active release fails reads safely", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    await t.run(async (ctx) => {
      const shards = await ctx.db.query("dataReleaseV3SearchShards").collect();
      await ctx.db.delete("dataReleaseV3SearchShards", shards[0]!._id);
    });
    const result = (await t.query(api.publicRepacksV3.listPublicRepacksV3, {
      currentTime: NOW,
    })) as AnyResult;
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
  });
});
