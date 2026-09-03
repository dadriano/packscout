/// <reference types="vite/client" />

import {
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackViewDetailV3,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_DATA_RELEASE_V3_REPACKS } from "./dataReleaseV3Search";
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
  V3_OBSERVED_AT,
  V3_REPACK_ID_A,
  V3_REPACK_ID_B,
  V3_REPACK_ID_C,
  V3_VENDOR_ID,
  type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";

const modules = import.meta.glob("./**/*.ts");
type V3Test = TestConvex<typeof schema>;

const RELEASE_ID_1 = "10000000-0000-4000-8000-000000000001";
const NOW = V3_FIXTURE_NOW;
const AFTER_DEADLINE = Date.parse(V3_EXPIRES_AT) + 1;
const CURSOR_HMAC_KEY = "packscout-v3-cursor-test-key-000000000000000001";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function tamperCursorEvaluationTime(cursor: string): string {
  const base64 = cursor.replace(/-/gu, "+").replace(/_/gu, "/");
  const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const envelope = JSON.parse(decoded) as {
    confidenceEvaluatedAtMillis: number;
  };
  envelope.confidenceEvaluatedAtMillis -= 1;
  return btoa(JSON.stringify(envelope))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

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
 * Fixture set: B ranks first (-$5 EV), A second (-$15 EV), C is sold out
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
        packScout: buildV3CurrentEv(9_500),
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
  options: Readonly<{
    dataAsOf?: string;
    chases?: readonly PublicRepackChase[];
  }> = {},
): Promise<V3FixturePlan> {
  const plan = await buildV3FixturePlan({
    publicReleaseId: RELEASE_ID_1,
    dataAsOf: options.dataAsOf,
    details,
    collectibles,
    chases: options.chases,
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
  await seedHealthyProviderObservations(t, plan);
  return plan;
}

async function seedHealthyProviderObservations(
  t: V3Test,
  plan: V3FixturePlan,
): Promise<void> {
  await t.run(async (ctx) => {
    const release = await ctx.db
      .query("dataReleaseV3Releases")
      .withIndex("by_public_release_id", (index) =>
        index.eq("publicReleaseId", plan.publicReleaseId),
      )
      .unique();
    if (release === null) throw new Error("missing fixture release");
    const shards = await ctx.db
      .query("dataReleaseV3SearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", release._id),
      )
      .collect();
    const vendors = new Map<string, string>();
    for (const row of shards.flatMap(({ rows }) => rows)) {
      vendors.set(row.publicVendorId, row.vendorKey);
    }
    const observedAt = new Date(NOW).toISOString();
    const freshThrough = new Date(NOW + 24 * 60 * 60_000).toISOString();
    for (const [publicVendorId, vendorKey] of vendors) {
      await ctx.db.insert("dataReleaseV3ProviderObservations", {
        releaseId: release._id,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        publicVendorId,
        vendorKey,
        observationSequence: 1,
        observedAt,
        freshThrough,
        lastHeadReachedAt: observedAt,
        sourceHeadSequence: "100",
        settledSequence: "100",
        sourceLifecycle: "active",
        connectionState: "healthy",
        qualityState: "healthy",
        releaseAlignment: "aligned",
      });
    }
  });
}

type AnyResult = { ok: boolean } & Record<string, unknown>;

describe("data_release_v3 public reads", () => {
  test("no reads succeed before activation and shell status carries the release identity after", async () => {
    const t = convexTest(schema, modules);
    const before = (await t.query(internal.publicRepacksV3.getPublicShellStatusV3AtTime, {
      currentTime: NOW,
    })) as AnyResult;
    expect(before.ok).toBe(false);
    expect((before as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
    await publishFixture(t);
    const after = (await t.query(internal.publicRepacksV3.getPublicShellStatusV3AtTime, {
      currentTime: NOW,
    })) as AnyResult;
    expect(after.ok).toBe(true);
    const release = (after.data as { release: Record<string, unknown> }).release;
    expect(release.publicReleaseId).toBe(RELEASE_ID_1);
    expect(release.methodVersion).toBe("packscout-buyback-adjusted-ev-v1");
    expect(release.publicEvPolicyVersion).toBe(
      "packscout-public-ev-nonpositive-v1",
    );
  });

  test("record update status selects the newest collectible, repack, or chase timestamp", async () => {
    const empty = convexTest(schema, modules);
    const before = (await empty.query(
      internal.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3AtTime,
      { currentTime: NOW },
    )) as AnyResult;
    expect(before.ok).toBe(false);

    const latestRecordUpdatedAt = new Date(NOW - 60_000).toISOString();
    const snapshotAt = new Date(NOW).toISOString();
    const oldCollectible = publicCollectibleSchema.parse({
      ...buildV3Collectible(),
      dataAsOf: V3_OBSERVED_AT,
    });
    const oldChase = publicRepackChaseSchema.parse({
      ...buildV3Chase(V3_REPACK_ID_A),
      observedAt: V3_OBSERVED_AT,
    });
    const latestChase = publicRepackChaseSchema.parse({
      ...oldChase,
      observedAt: latestRecordUpdatedAt,
    });
    const cases = [
      {
        name: "collectible",
        collectible: publicCollectibleSchema.parse({
          ...oldCollectible,
          dataAsOf: latestRecordUpdatedAt,
        }),
        detail: buildV3Detail({
          sourceUpdatedAt: V3_OBSERVED_AT,
          topChase: oldChase,
        }),
      },
      {
        name: "repack",
        collectible: oldCollectible,
        detail: buildV3Detail({
          sourceUpdatedAt: latestRecordUpdatedAt,
          topChase: oldChase,
        }),
      },
      {
        name: "chase",
        collectible: oldCollectible,
        detail: buildV3Detail({
          sourceUpdatedAt: V3_OBSERVED_AT,
          topChase: latestChase,
        }),
      },
    ] as const;

    for (const recordCase of cases) {
      const t = convexTest(schema, modules);
      await publishFixture(t, [recordCase.detail], [recordCase.collectible], {
        dataAsOf: snapshotAt,
      });
      const after = (await t.query(
        internal.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3AtTime,
        { currentTime: NOW },
      )) as AnyResult;
      expect(after.ok, recordCase.name).toBe(true);
      expect(after.data, recordCase.name).toMatchObject({
        schemaVersion: "data_release_v3",
        publicReleaseId: RELEASE_ID_1,
        latestCatalogRecordUpdatedAt: latestRecordUpdatedAt,
        evaluatedAt: snapshotAt,
      });
    }

    const offsetTimestamp = new Date(
      Date.parse(latestRecordUpdatedAt) - 7 * 60 * 60_000,
    ).toISOString().replace(/Z$/u, "-07:00");
    const offset = convexTest(schema, modules);
    await publishFixture(
      offset,
      [
        buildV3Detail({
          sourceUpdatedAt: V3_OBSERVED_AT,
          topChase: oldChase,
        }),
      ],
      [
        publicCollectibleSchema.parse({
          ...oldCollectible,
          dataAsOf: offsetTimestamp,
        }),
      ],
      { dataAsOf: snapshotAt },
    );
    const normalized = (await offset.query(
      internal.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3AtTime,
      { currentTime: NOW },
    )) as AnyResult;
    expect(normalized.ok).toBe(true);
    expect(normalized.data).toMatchObject({
      latestCatalogRecordUpdatedAt: latestRecordUpdatedAt,
    });
  });

  test("record update status fails closed for a legacy or category-only release", async () => {
    const legacy = convexTest(schema, modules);
    await publishFixture(legacy);
    await legacy.run(async (ctx) => {
      const release = await ctx.db
        .query("dataReleaseV3Releases")
        .withIndex("by_public_release_id", (index) =>
          index.eq("publicReleaseId", RELEASE_ID_1),
        )
        .unique();
      if (release === null) throw new Error("missing fixture release");
      const {
        _id,
        _creationTime: _ignoredCreationTime,
        latestCatalogRecordUpdatedAt: _ignoredUpdateTime,
        ...legacyRelease
      } = release;
      await ctx.db.replace(_id, legacyRelease);
    });
    const legacyResult = await legacy.query(
      internal.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3AtTime,
      { currentTime: NOW },
    );
    expect(legacyResult.ok).toBe(false);

    const categoryOnly = convexTest(schema, modules);
    await publishFixture(categoryOnly, [], [], {
      dataAsOf: new Date(NOW).toISOString(),
      chases: [],
    });
    const categoryOnlyResult = await categoryOnly.query(
      internal.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3AtTime,
      { currentTime: NOW },
    );
    expect(categoryOnlyResult.ok).toBe(false);
  });

  test("dashboard ranks by signed EV dollars, excludes ineligible repacks, and aggregates with the same rules", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    const result = (await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
      filters: { availability: "all" },
      currentTime: NOW,
    })) as AnyResult;
    expect(result.ok).toBe(true);
    const data = result.data as {
      opportunities: { publicRepackId: string }[];
      kpis: {
        totalRepacks: number;
        highConfidenceRepacks: number;
        medianPackScoutEvPercent: { status: string; basisPoints: number | null };
      };
      vendorSummaries: {
        repackCount: number;
        medianPackScoutEvPercent: { basisPoints: number | null };
      }[];
      selectedRepack: { publicRepackId: string } | null;
    };
    // B (-$5) outranks A (-$15); sold-out C and unavailable D never rank.
    expect(data.opportunities.map(({ publicRepackId }) => publicRepackId)).toEqual([
      V3_REPACK_ID_B,
      V3_REPACK_ID_A,
    ]);
    expect(data.selectedRepack?.publicRepackId).toBe(V3_REPACK_ID_B);
    expect(data.kpis.totalRepacks).toBe(4);
    // Median excludes unavailable and sold-out estimates: (-1500+-500)/2.
    expect(data.kpis.medianPackScoutEvPercent).toEqual({
      status: "available",
      basisPoints: -1_000,
    });
    expect(data.vendorSummaries[0]?.repackCount).toBe(4);
    expect(data.vendorSummaries[0]?.medianPackScoutEvPercent.basisPoints).toBe(
      -1_000,
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
    await seedHealthyProviderObservations(t, plan);
    const result = (await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
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
    const result = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
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
    expect(soldOut.evEstimates.packScout.status).toBe("last_known");
    expect(soldOut.evEstimates.packScout.historicalSoldOutAt).toBeDefined();
    expect(soldOut.evEstimates.packScout.metrics).toBeDefined();
    expect(soldOut.actions?.repackLink).toBeUndefined();
    const unavailable = data.details.find(
      ({ publicRepackId }) => publicRepackId === V3_REPACK_ID_D,
    )!;
    expect(unavailable.evEstimates.packScout.status).toBe("unavailable");
    expect(unavailable.evEstimates.packScout.reason).toBe("BUYBACK_UNAVAILABLE");
    // Null EV rows also rank last on ascending sorts.
    const ascending = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
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
    const unsupported = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      sort: "vendor_reported_ev_percent",
      currentTime: NOW,
    })) as AnyResult;
    expect((unsupported as { code?: string }).code).toBe("INVALID_QUERY");
  });

  test("the availability filter admits only available packs and keeps the other three states discoverable", async () => {
    const t = convexTest(schema, modules);
    // Every non-available pack here carries a *current* PackScout estimate, so
    // only the availability guard itself can keep them out of the filtered
    // list and the opportunity ranking. They also out-chase the available
    // pack, so any headline KPI that reads an ungated
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
    const filtered = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
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
    const everything = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
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

    // Ranking admits the available pack alone.
    const dashboard = (await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
      filters: { availability: "all" },
      currentTime: NOW,
    })) as AnyResult;
    expect(dashboard.ok).toBe(true);
    const dashboardData = dashboard.data as {
      opportunities: { publicRepackId: string }[];
      kpis: {
        totalRepacks: number;
        highestChaseValueUsdMinor: number | null;
      };
    };
    expect(
      dashboardData.opportunities.map(({ publicRepackId }) => publicRepackId),
    ).toEqual([V3_REPACK_ID_A]);
    // The catalog total stays ungated: all four states remain discoverable.
    expect(dashboardData.kpis.totalRepacks).toBe(4);
    // The headline chase value reports the available pack's chase, never the
    // richer chase sitting inside a sold_out, unavailable, or unknown pack.
    expect(dashboardData.kpis.highestChaseValueUsdMinor).toBe(
      V3_DEFAULT_CHASE_VALUE_MINOR,
    );
  });

  test("last valid values remain after the source deadline while confidence decays without new publication", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    const result = (await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
      filters: { availability: "all" },
      currentTime: AFTER_DEADLINE,
    })) as AnyResult;
    expect(result.ok).toBe(true);
    const data = result.data as {
      opportunities: unknown[];
      kpis: {
        medianPackScoutEvPercent: { status: string };
      };
    };
    expect(data.opportunities).toHaveLength(2);
    expect(data.kpis.medianPackScoutEvPercent.status).toBe("available");

    const detail = (await t.query(internal.publicRepacksV3.getPublicRepackV3AtTime, {
      publicRepackId: V3_REPACK_ID_A,
      publicReleaseId: RELEASE_ID_1,
      currentTime: AFTER_DEADLINE,
    })) as AnyResult;
    expect(detail.ok).toBe(true);
    const packScout = (detail.data as PublicRepackViewDetailV3).evEstimates.packScout;
    expect(packScout.status).toBe("last_known");
    if (packScout.status !== "last_known") throw new Error("missing retained EV");
    expect(packScout.latestUnavailableReason).toBeNull();
    expect(packScout.confidence.scoreBasisPoints).toBe(7_500);
    expect(packScout.expiresAt).toBeNull();
    expect(packScout.calculatedAt).toBe(new Date(NOW - 5 * 60_000).toISOString());
    expect(packScout.dataAsOf).toEqual({
      state: "known",
      observedAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    expect(packScout.metrics).toBeDefined();
    // The one retained projection keeps its metrics at the exact boundary.
    const atDeadline = (await t.query(internal.publicRepacksV3.getPublicRepackV3AtTime, {
      publicRepackId: V3_REPACK_ID_A,
      publicReleaseId: RELEASE_ID_1,
      currentTime: Date.parse(V3_EXPIRES_AT),
    })) as AnyResult;
    expect(
      (atDeadline.data as { evEstimates: { packScout: { status: string } } })
        .evEstimates.packScout.status,
    ).toBe("last_known");
  });

  test("the public detail action evaluates freshness from the trusted server clock", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_DEADLINE);

    const detail = (await t.action(api.publicRepacksV3.getPublicRepackV3, {
      publicRepackId: V3_REPACK_ID_A,
      publicReleaseId: RELEASE_ID_1,
    })) as AnyResult;

    expect(detail.ok).toBe(true);
    expect(
      (detail.data as PublicRepackViewDetailV3).evEstimates.packScout,
    ).toMatchObject({
      status: "last_known",
      confidenceEvaluatedAt: new Date(AFTER_DEADLINE).toISOString(),
    });
  });

  test("provider health remains informational without hiding or excluding EV", async () => {
    const scenarios = [
      {
        name: "missing",
        reason: "PROVIDER_HEALTH_UNAVAILABLE",
        summaryState: "unavailable",
      },
      {
        name: "paused",
        reason: "PROVIDER_PAUSED",
        summaryState: "delayed",
      },
      {
        name: "unhealthy",
        reason: "PROVIDER_UNHEALTHY",
        summaryState: "delayed",
      },
      {
        name: "behind",
        reason: "PROVIDER_BEHIND",
        summaryState: "delayed",
      },
      {
        name: "stale",
        reason: "PROVIDER_OBSERVATION_STALE",
        summaryState: "delayed",
      },
      {
        name: "fresh_boundary",
        reason: "PROVIDER_OBSERVATION_STALE",
        summaryState: "delayed",
      },
      {
        name: "future_observation",
        reason: "PROVIDER_UNHEALTHY",
        summaryState: "delayed",
      },
      {
        name: "corrupt_timestamp",
        reason: "PROVIDER_HEALTH_UNAVAILABLE",
        summaryState: "unavailable",
      },
      {
        name: "release_mismatch",
        reason: "RELEASE_MISMATCH",
        summaryState: "delayed",
      },
    ] as const;

    for (const scenario of scenarios) {
      const t = convexTest(schema, modules);
      await publishFixture(t);
      await t.run(async (ctx) => {
        const observation = await ctx.db
          .query("dataReleaseV3ProviderObservations")
          .unique();
        if (observation === null) throw new Error("missing provider fixture");
        switch (scenario.name) {
          case "missing":
            await ctx.db.delete(
              "dataReleaseV3ProviderObservations",
              observation._id,
            );
            break;
          case "paused":
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              { sourceLifecycle: "paused" },
            );
            break;
          case "unhealthy":
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              { connectionState: "degraded" },
            );
            break;
          case "behind":
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              { releaseAlignment: "behind" },
            );
            break;
          case "stale": {
            const observedAt = new Date(NOW - 10 * 60_000).toISOString();
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              {
                observedAt,
                freshThrough: new Date(NOW - 1).toISOString(),
                lastHeadReachedAt: observedAt,
              },
            );
            break;
          }
          case "fresh_boundary":
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              { freshThrough: new Date(NOW).toISOString() },
            );
            break;
          case "future_observation": {
            const observedAt = new Date(NOW + 60_000).toISOString();
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              {
                observedAt,
                lastHeadReachedAt: observedAt,
              },
            );
            break;
          }
          case "corrupt_timestamp":
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              { observedAt: "not-a-timestamp" },
            );
            break;
          case "release_mismatch":
            await ctx.db.patch(
              "dataReleaseV3ProviderObservations",
              observation._id,
              { releaseFingerprint: "f".repeat(64) },
            );
            break;
        }
      });

      const dashboard = (await t.query(
        internal.publicRepacksV3.getDashboardBundleV3AtTime,
        { currentTime: NOW },
      )) as AnyResult;
      expect(dashboard.ok, scenario.name).toBe(true);
      const dashboardData = dashboard.data as {
        opportunities: unknown[];
        providerHealthSummary: { state: string };
        kpis: { medianPackScoutEvPercent: { status: string } };
      };
      expect(dashboardData.opportunities, scenario.name).toHaveLength(2);
      expect(dashboardData.providerHealthSummary.state, scenario.name).toBe(
        scenario.summaryState,
      );
      expect(
        dashboardData.kpis.medianPackScoutEvPercent.status,
        scenario.name,
      ).toBe("available");

      const list = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
        currentTime: NOW,
      })) as AnyResult;
      expect(list.ok, scenario.name).toBe(true);
      const detail = (
        list.data as { details: PublicRepackViewDetailV3[] }
      ).details.find(({ publicRepackId }) => publicRepackId === V3_REPACK_ID_A)!;
      expect(detail.providerHealth, scenario.name).toMatchObject({
        state: scenario.summaryState,
        statusReason: scenario.reason,
      });
      expect(detail.evEstimates.packScout.status, scenario.name).toBe(
        "last_known",
      );
      expect(detail.evEstimates.packScout.metrics, scenario.name).not.toBeNull();
    }
  });

  test("provider health deadlines refresh without gating opportunity ranking", async () => {
    const t = convexTest(schema, modules);
    const secondVendorId = "00000000-0000-5000-8000-000000000009";
    await publishFixture(t, [
      buildV3Detail({ publicRepackId: V3_REPACK_ID_A }),
      buildV3Detail({
        publicRepackId: V3_REPACK_ID_B,
        publicVendorId: secondVendorId,
        vendorKey: "second_vendor",
        vendorDisplayName: "Second Vendor",
      }),
    ]);
    const nextHealthEvaluationAt = new Date(NOW + 60_000).toISOString();
    await t.run(async (ctx) => {
      const observations = await ctx.db
        .query("dataReleaseV3ProviderObservations")
        .collect();
      const first = observations.find(
        ({ publicVendorId }) => publicVendorId === V3_VENDOR_ID,
      );
      const second = observations.find(
        ({ publicVendorId }) => publicVendorId === secondVendorId,
      );
      if (first === undefined || second === undefined) {
        throw new Error("missing provider observations");
      }
      const delayedObservedAt = new Date(NOW - 10 * 60_000).toISOString();
      await ctx.db.patch("dataReleaseV3ProviderObservations", first._id, {
        sourceLifecycle: "paused",
        observedAt: delayedObservedAt,
        lastHeadReachedAt: delayedObservedAt,
        freshThrough: new Date(NOW - 1).toISOString(),
      });
      await ctx.db.patch("dataReleaseV3ProviderObservations", second._id, {
        freshThrough: nextHealthEvaluationAt,
      });
    });

    const beforeBoundary = (await t.query(
      internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: NOW },
    )) as AnyResult;
    expect(beforeBoundary.ok).toBe(true);
    expect(beforeBoundary.data).toMatchObject({
      providerHealthSummary: {
        state: "delayed",
        freshThrough: new Date(NOW - 1).toISOString(),
        nextHealthEvaluationAt,
      },
      opportunities: [
        { publicRepackId: V3_REPACK_ID_A },
        { publicRepackId: V3_REPACK_ID_B },
      ],
    });

    const atBoundary = (await t.query(
      internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: NOW + 60_000 },
    )) as AnyResult;
    expect(atBoundary.ok).toBe(true);
    expect(atBoundary.data).toMatchObject({
      providerHealthSummary: {
        state: "delayed",
        nextHealthEvaluationAt: null,
      },
      opportunities: [
        { publicRepackId: V3_REPACK_ID_A },
        { publicRepackId: V3_REPACK_ID_B },
      ],
    });
  });

  test("retained V6 rows without static confidence metadata hydrate exactly", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t);
    await t.run(async (ctx) => {
      const shards = await ctx.db.query("dataReleaseV3SearchShards").collect();
      for (const shard of shards) {
        await ctx.db.patch("dataReleaseV3SearchShards", shard._id, {
          rows: shard.rows.map((row) => {
            const {
              packScoutStaticConfidencePenaltyBasisPoints: _omitted,
              ...retainedRow
            } = row;
            return retainedRow;
          }),
        });
      }
    });

    const dashboard = (await t.query(
      internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: AFTER_DEADLINE },
    )) as AnyResult;
    expect(dashboard.ok).toBe(true);
    expect(
      (dashboard.data as { kpis: { highConfidenceRepacks: number } }).kpis
        .highConfidenceRepacks,
    ).toBe(0);

    const list = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      sort: "packscout_confidence",
      direction: "desc",
      currentTime: AFTER_DEADLINE,
    })) as AnyResult;
    expect(list.ok).toBe(true);
    const presented = (
      list.data as { details: PublicRepackViewDetailV3[] }
    ).details.find(({ publicRepackId }) => publicRepackId === V3_REPACK_ID_A)!;
    expect(presented.evEstimates.packScout.status).toBe("last_known");
    expect(
      presented.evEstimates.packScout.confidence?.scoreBasisPoints,
    ).toBeLessThanOrEqual(7_500);
  });

  test("compact retained confidence supports the full release bound and rejects tampered sealed facts", async () => {
    const details = Array.from(
      { length: MAX_DATA_RELEASE_V3_REPACKS },
      (_, index) =>
        buildV3Detail({
          publicRepackId:
            `00000000-0000-5000-8000-${String(index + 1_000).padStart(12, "0")}`,
          name: `Capacity Pack ${index + 1}`,
          // This capacity case exercises EV facts, not chase reconciliation.
          // Full pack+chase publication remains covered by the retention bounds tests.
          topChase: null,
        }),
    );

    const t = convexTest(schema, modules);
    await publishFixture(t, details);
    const currentDashboard = (await t.query(
      internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: AFTER_DEADLINE },
    )) as AnyResult;
    expect(currentDashboard.ok).toBe(true);

    await t.run(async (ctx) => {
      const shards = await ctx.db.query("dataReleaseV3SearchShards").collect();
      for (const shard of shards) {
        await ctx.db.patch("dataReleaseV3SearchShards", shard._id, {
          rows: shard.rows.map((row) => {
            const {
              packScoutStaticConfidencePenaltyBasisPoints: _omitted,
              ...retainedRow
            } = row;
            return retainedRow;
          }),
        });
      }
    });
    const retainedDashboard = (await t.query(
      internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: AFTER_DEADLINE },
    )) as AnyResult;
    expect(retainedDashboard.ok).toBe(true);
    expect(
      (retainedDashboard.data as { kpis: { totalRepacks: number } }).kpis
        .totalRepacks,
    ).toBe(MAX_DATA_RELEASE_V3_REPACKS);

    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("dataReleaseV3EvFacts")
        .withIndex("by_release_id_and_public_repack_id")
        .order("desc")
        .first();
      if (stored === null) throw new Error("missing capacity detail");
      await ctx.db.patch("dataReleaseV3EvFacts", stored._id, {
        calculationPriceUsdMinor: 1,
      });
    });
    const mismatchedDashboard = (await t.query(
      internal.publicRepacksV3.getDashboardBundleV3AtTime,
      { currentTime: AFTER_DEADLINE },
    )) as AnyResult;
    expect(mismatchedDashboard).toMatchObject({
      ok: false,
      code: "RELEASE_UNAVAILABLE",
    });
  }, 15_000);

  test("desired-collectible matching binds rows to chases and search stays bounded", async () => {
    const t = convexTest(schema, modules);
    await publishFixture(t, fixtureDetails(), [
      buildV3Collectible(),
      standaloneCollectible(),
    ]);
    const list = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
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

    const found = (await t.query(internal.publicRepacksV3.findRepacksByDesiredCollectibleV3AtTime, {
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
      internal.publicRepacksV3.findRepacksByDesiredCollectibleV3AtTime,
      {
        publicCollectibleId: V3_STANDALONE_COLLECTIBLE_ID,
        currentTime: NOW,
      },
    )) as AnyResult;
    expect(noRepackMatches.ok).toBe(true);
    expect(noRepackMatches.data).toMatchObject({ matches: [], total: 0 });
  });

  test("pagination is bounded, fingerprinted, and survives release changes explicitly", async () => {
    vi.stubEnv("PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY", CURSOR_HMAC_KEY);
    const t = convexTest(schema, modules);
    await publishFixture(t);
    await t.run(async (ctx) => {
      const observations = await ctx.db
        .query("dataReleaseV3ProviderObservations")
        .collect();
      for (const observation of observations) {
        await ctx.db.patch("dataReleaseV3ProviderObservations", observation._id, {
          freshThrough: V3_EXPIRES_AT,
        });
      }
    });
    const firstEvaluationTime = Date.parse(V3_EXPIRES_AT) - 5 * 60_000;
    const laterWallTime = firstEvaluationTime + 10 * 60_000;
    const first = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      filters: { availability: "all" },
      sort: "packscout_confidence",
      direction: "desc",
      pageSize: 2,
      currentTime: firstEvaluationTime,
    })) as AnyResult;
    expect(first.ok).toBe(true);
    const firstPage = first.data as {
      rows: { publicRepackId: string }[];
      nextCursor: string | null;
      queryFingerprint: string;
      confidenceEvaluatedAt: string;
      providerHealthEvaluatedAt: string;
      providerHealthSummary: {
        state: string;
        nextHealthEvaluationAt: string | null;
      };
      range: { start: number; end: number; total: number };
    };
    expect(firstPage.rows.length).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.range).toEqual({ start: 1, end: 2, total: 4 });
    expect(firstPage.confidenceEvaluatedAt).toBe(
      new Date(firstEvaluationTime).toISOString(),
    );
    expect(firstPage.providerHealthEvaluatedAt).toBe(
      new Date(firstEvaluationTime).toISOString(),
    );
    expect(firstPage.providerHealthSummary).toMatchObject({
      state: "healthy",
      nextHealthEvaluationAt: V3_EXPIRES_AT,
    });

    // The stable query fingerprint identifies release + query, not a wall
    // clock. A fresh first page gets a new response clock without URL churn.
    const refreshedFirst = (await t.query(
      internal.publicRepacksV3.listPublicRepacksV3AtTime,
      {
        filters: { availability: "all" },
        sort: "packscout_confidence",
        direction: "desc",
        pageSize: 2,
        currentTime: firstEvaluationTime + 20 * 60_000,
      },
    )) as AnyResult;
    expect(refreshedFirst.ok).toBe(true);
    expect(
      (refreshedFirst.data as { queryFingerprint: string }).queryFingerprint,
    ).toBe(firstPage.queryFingerprint);
    expect(
      (refreshedFirst.data as { confidenceEvaluatedAt: string })
        .confidenceEvaluatedAt,
    ).toBe(new Date(firstEvaluationTime + 20 * 60_000).toISOString());

    const second = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      filters: { availability: "all" },
      sort: "packscout_confidence",
      direction: "desc",
      pageSize: 2,
      cursor: firstPage.nextCursor,
      queryFingerprint: firstPage.queryFingerprint,
      currentTime: laterWallTime,
    })) as AnyResult;
    expect(second.ok).toBe(true);
    const secondPage = second.data as {
      rows: { publicRepackId: string }[];
      range: { start: number; end: number; total: number };
      hasPrevious: boolean;
      confidenceEvaluatedAt: string;
      providerHealthEvaluatedAt: string;
      providerHealthSummary: {
        state: string;
        nextHealthEvaluationAt: string | null;
      };
      details: PublicRepackViewDetailV3[];
    };
    expect(secondPage.rows.length).toBe(2);
    expect(secondPage.hasPrevious).toBe(true);
    expect(secondPage.range).toEqual({ start: 3, end: 4, total: 4 });
    expect(secondPage.confidenceEvaluatedAt).toBe(
      firstPage.confidenceEvaluatedAt,
    );
    const known = secondPage.details.map(detail => detail.evEstimates.packScout)
      .filter(estimate => estimate.status === "last_known");
    expect(known.length).toBeGreaterThan(0);
    for (const estimate of known) {
      expect(estimate.confidenceEvaluatedAt).toBe(firstPage.confidenceEvaluatedAt);
      expect(estimate.sourceAge.milliseconds).toBe(
        firstEvaluationTime - Date.parse(estimate.dataAsOf.observedAt),
      );
    }
    expect(secondPage.providerHealthEvaluatedAt).toBe(
      new Date(laterWallTime).toISOString(),
    );
    expect(secondPage.providerHealthSummary).toMatchObject({
      state: "delayed",
      nextHealthEvaluationAt: null,
    });
    expect(
      secondPage.details.every(
        ({ providerHealth }) => providerHealth.state === "delayed",
      ),
    ).toBe(true);
    const firstIds = new Set(
      firstPage.rows.map(({ publicRepackId }) => publicRepackId),
    );
    const secondIds = new Set(
      secondPage.rows.map(({ publicRepackId }) => publicRepackId),
    );
    expect([...firstIds].filter((id) => secondIds.has(id))).toEqual([]);
    expect([...firstIds, ...secondIds].sort()).toEqual(
      [V3_REPACK_ID_A, V3_REPACK_ID_B, V3_REPACK_ID_C, V3_REPACK_ID_D].sort(),
    );

    for (const invalidClock of [
      firstEvaluationTime - 1,
      firstEvaluationTime + 15 * 60_000 + 1,
    ]) {
      const expired = (await t.query(
        internal.publicRepacksV3.listPublicRepacksV3AtTime,
        {
          filters: { availability: "all" },
          sort: "packscout_confidence",
          direction: "desc",
          pageSize: 2,
          cursor: firstPage.nextCursor,
          queryFingerprint: firstPage.queryFingerprint,
          currentTime: invalidClock,
        },
      )) as AnyResult;
      expect((expired as { code?: string }).code).toBe("CURSOR_EXPIRED");
    }
    // The cursor is well-formed JSON and retains its original signature, but
    // changing the pinned clock invalidates the HMAC before any offset is used.
    const forgedCursor = tamperCursorEvaluationTime(firstPage.nextCursor!);
    const forged = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      filters: { availability: "all" },
      sort: "packscout_confidence",
      direction: "desc",
      pageSize: 2,
      cursor: forgedCursor,
      queryFingerprint: firstPage.queryFingerprint,
      currentTime: laterWallTime,
    })) as AnyResult;
    expect((forged as { code?: string }).code).toBe("INVALID_QUERY");
    // A cursor from a foreign fingerprint is refused.
    const mismatched = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      pageSize: 2,
      cursor: firstPage.nextCursor,
      queryFingerprint: firstPage.queryFingerprint,
      currentTime: laterWallTime,
    })) as AnyResult;
    expect((mismatched as { code?: string }).code).toBe("INVALID_QUERY");
  });

  test("beta-off reads stay available but pagination fails closed without a cursor key", async () => {
    vi.stubEnv("PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY", "");
    vi.stubEnv("PACKSCOUT_CATALOG_READ_TOKEN", "");
    const t = convexTest(schema, modules);
    await publishFixture(t);

    const complete = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      currentTime: NOW,
    })) as AnyResult;
    expect(complete.ok).toBe(true);
    const requiresCursor = (await t.query(
      internal.publicRepacksV3.listPublicRepacksV3AtTime,
      { pageSize: 2, currentTime: NOW },
    )) as AnyResult;
    expect(requiresCursor).toMatchObject({
      ok: false,
      code: "RELEASE_UNAVAILABLE",
    });
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
    const dashboard = (await t.query(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
      currentTime: NOW,
    })) as AnyResult;
    expect(dashboard.ok).toBe(false);
    expect((dashboard as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
    const detail = (await t.query(internal.publicRepacksV3.getPublicRepackV3AtTime, {
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
    const result = (await t.query(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      currentTime: NOW,
    })) as AnyResult;
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("RELEASE_UNAVAILABLE");
  });
});
