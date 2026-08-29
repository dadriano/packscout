import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAllAvailabilityStatesPublicRepackListPageV3,
  buildDataReleaseV3Identity,
  buildDesiredCollectibleRepackResultsV3,
  buildHealthyPublicProviderHealthSummaryV1,
  buildNonPurchasablePublicRepackDetailV3,
  buildPackScoutPublicEvCurrentV3,
  buildPackScoutPublicEvMetricsV3,
  buildPackScoutPublicEvNegativeV3,
  buildPackScoutPublicEvSoldOutHistoricalV3,
  buildPackScoutPublicEvUnavailableV3,
  buildPublicBuybackSummaryV3,
  buildPublicDashboardBundleV3,
  buildPublicEvEstimatesV3,
  buildPublicRepackDetailV3,
  buildPublicRepackListPageV3,
  buildPublicShellStatusV3,
  buildPublicRepackViewDetailV3,
  buildSoldOutPublicRepackDetailV3,
  DATA_RELEASE_V3_EXPIRES_AT,
  DATA_RELEASE_V3_OBSERVED_AT,
  DATA_RELEASE_V3_SECONDARY_REPACK_ID,
} from "./__fixtures__/data-release-v3.fixture.ts";
import {
  dataReleaseV3IdentitySchema,
  desiredCollectibleRepackResultsV3Schema,
  packScoutEvProjectionsAreByteEquivalentV3,
  publicDashboardBundleV3Schema,
  publicRepackDetailV3Schema,
  publicRepackListPageV3Schema,
  publicRepackSummaryV3FromDetail,
  publicRepackViewSummaryV3FromDetail,
  publicRepackViewDetailV3Schema,
  publicShellStatusV3Schema,
  repackEvSortRowV3FromDetail,
  repackEvSortRowV3MatchesDetail,
  repackEvSortRowV3Schema,
  safeParsePublicRepackDetailV3,
  unavailableRepackHeat,
  type PublicRepackDetailV3,
} from "./index.ts";

test("repack details validate every distinguished EV state", () => {
  const current = buildPublicRepackDetailV3();
  assert.equal(current.evEstimates.packScout.status, "current");

  const soldOut = buildSoldOutPublicRepackDetailV3();
  assert.equal(soldOut.availability, "sold_out");
  assert.equal(soldOut.evEstimates.packScout.status, "sold_out_historical");

  const noBuyback = buildPublicRepackDetailV3({
    buyback: buildPublicBuybackSummaryV3("not_documented"),
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvUnavailableV3("BUYBACK_UNAVAILABLE"),
    }),
  });
  assert.equal(noBuyback.evEstimates.packScout.status, "unavailable");
});

test("public metrics must reconcile with the public pack price under half-up rounding", () => {
  const detail = buildPublicRepackDetailV3();
  const current = detail.evEstimates.packScout;
  if (current.status !== "current") throw new Error("unexpected");

  const tamperings: readonly Partial<typeof current.metrics>[] = [
    { grossEvMoney: { minorUnits: 12_001, currency: "USD" } },
    { grossReturnBasisPoints: 12_001, evPercentBasisPoints: 2_001 },
    { evDollars: { minorUnits: 2_001, currency: "USD" } },
  ];
  for (const tampered of tamperings) {
    assert.equal(
      publicRepackDetailV3Schema.safeParse({
        ...detail,
        evEstimates: {
          ...detail.evEstimates,
          packScout: {
            ...current,
            metrics: { ...current.metrics, ...tampered },
          },
        },
      }).success,
      false,
    );
  }

  const goldenNegative = buildPackScoutPublicEvNegativeV3();
  if (goldenNegative.status !== "current") throw new Error("unexpected");
  const halfUp = buildPublicRepackDetailV3({
    price: {
      displayMoney: { minorUnits: 20_000, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: 20_000, currency: "USD" },
      },
    },
    evEstimates: buildPublicEvEstimatesV3({
      packScout: {
        ...goldenNegative,
        metrics: buildPackScoutPublicEvMetricsV3(1, 20_000),
      },
    }),
  });
  const halfUpPackScout = halfUp.evEstimates.packScout;
  if (halfUpPackScout.status !== "current") throw new Error("unexpected");
  assert.equal(
    halfUpPackScout.metrics.grossReturnBasisPoints,
    1,
    "an exact half basis point rounds up",
  );

  assert.equal(
    publicRepackDetailV3Schema.safeParse({
      ...halfUp,
      evEstimates: {
        ...halfUp.evEstimates,
        packScout: {
          ...halfUpPackScout,
          metrics: {
            ...halfUpPackScout.metrics,
            grossReturnBasisPoints: 0,
            evPercentBasisPoints: -10_000,
          },
        },
      },
    }).success,
    false,
    "rounding down the half basis point is rejected",
  );

  assert.equal(
    publicRepackDetailV3Schema.safeParse({
      ...detail,
      price: {
        displayMoney: null,
        usdComparison: {
          status: "unavailable",
          value: null,
          reason: "PRICE_UNAVAILABLE",
        },
      },
    }).success,
    false,
    "an available estimate requires a comparable public pack price",
  );
});

test("availability and buyback couplings fail closed", () => {
  assert.equal(
    publicRepackDetailV3Schema.safeParse({
      ...buildPublicRepackDetailV3(),
      evEstimates: buildPublicEvEstimatesV3({
        packScout: buildPackScoutPublicEvSoldOutHistoricalV3(),
      }),
    }).success,
    false,
    "an available repack cannot present a sold-out historical estimate",
  );
  assert.equal(
    publicRepackDetailV3Schema.safeParse({
      ...buildSoldOutPublicRepackDetailV3(),
      evEstimates: buildPublicEvEstimatesV3({
        packScout: buildPackScoutPublicEvNegativeV3(),
      }),
    }).success,
    false,
    "a sold-out repack cannot present a live current estimate",
  );
  assert.equal(
    publicRepackDetailV3Schema.safeParse({
      ...buildPublicRepackDetailV3(),
      buyback: buildPublicBuybackSummaryV3("not_documented"),
    }).success,
    false,
    "no documented buyback forbids a current PackScout estimate",
  );
  const soldOutActionable = {
    ...buildSoldOutPublicRepackDetailV3(),
    actionAvailability: { promo: true, repackLink: true },
    actions: {
      promo: { code: "SCOUT", label: "Use SCOUT" },
      repackLink: {
        listingUrl: "https://vendor.example/repacks/pokemon",
        listingHost: "vendor.example",
        referralParameters: [{ name: "utm_source", value: "packscout" }],
      },
    },
  };
  assert.equal(
    publicRepackDetailV3Schema.safeParse(soldOutActionable).success,
    false,
    "a sold-out repack never exposes an outbound action",
  );
});

test("packs that are not available stay discoverable but never rank or act", () => {
  for (const availability of ["unavailable", "unknown"] as const) {
    const detail = buildNonPurchasablePublicRepackDetailV3(availability);
    assert.equal(detail.availability, availability);
    assert.equal(
      detail.evEstimates.packScout.status,
      "current",
      "pack availability and PackScout EV availability stay independent axes",
    );
    assert.equal(detail.actionAvailability.repackLink, false);

    assert.equal(
      publicRepackDetailV3Schema.safeParse({
        ...detail,
        actionAvailability: { promo: true, repackLink: true },
        actions: {
          promo: { code: "SCOUT", label: "Use SCOUT" },
          repackLink: {
            listingUrl: "https://vendor.example/repacks/pokemon",
            listingHost: "vendor.example",
            referralParameters: [{ name: "utm_source", value: "packscout" }],
          },
        },
      }).success,
      false,
      "a pack that is not available never exposes an outbound action",
    );

    assert.equal(
      publicRepackDetailV3Schema.safeParse({
        ...detail,
        evEstimates: buildPublicEvEstimatesV3({
          packScout: buildPackScoutPublicEvSoldOutHistoricalV3(),
        }),
      }).success,
      false,
      "a frozen sold-out estimate requires the authoritative sold-out state",
    );

    const view = buildPublicRepackViewDetailV3(detail);
    assert.equal(
      publicDashboardBundleV3Schema.safeParse({
        ...buildPublicDashboardBundleV3(),
        opportunities: [publicRepackViewSummaryV3FromDetail(view)],
        details: [view],
        selectedRepack: view,
      }).success,
      false,
      "a current estimate on a pack that cannot be bought never ranks",
    );

    const row = repackEvSortRowV3FromDetail(detail);
    assert.equal(row.availability, availability);
    assert.equal(row.packScoutEvDollarsMinor, null);
    assert.equal(row.packScoutEvDollarsNullRank, 1);
    assert.equal(row.packScoutGrossEvMinor, null);
    assert.equal(row.packScoutConfidenceBand, null);
    assert.equal(row.vendorReportedEvUsdMinor, null);
    assert.equal(row.vendorReportedEvUsdNullRank, 1);
    assert.equal(repackEvSortRowV3MatchesDetail(row, detail), true);

    assert.equal(
      repackEvSortRowV3Schema.safeParse({
        ...repackEvSortRowV3FromDetail(buildPublicRepackDetailV3()),
        availability,
      }).success,
      false,
      "materialized sort values never survive a pack that cannot be bought",
    );
  }

  const page = buildAllAvailabilityStatesPublicRepackListPageV3();
  assert.deepEqual(
    page.rows.map(({ availability }) => availability),
    ["available", "sold_out", "unavailable", "unknown"],
    "every availability state stays discoverable in the complete catalog",
  );
});

test("heat, chase matching, and actions stay independent of EV confidence", () => {
  const unavailableEv = buildPublicRepackViewDetailV3({
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvUnavailableV3("ODDS_UNAVAILABLE"),
    }),
  });
  assert.equal(unavailableEv.evEstimates.packScout.status, "unavailable");
  assert.equal(unavailableEv.topChase?.matchConfidence.band, "high");
  assert.equal(unavailableEv.actionAvailability.repackLink, true);
  assert.deepEqual(unavailableEv.heat, unavailableRepackHeat());

  const expiredHeat = buildPublicRepackViewDetailV3();
  const reheated = {
    ...expiredHeat,
    heat: {
      status: "expired" as const,
      signal: null,
      lastCalculatedAt: "2026-08-19T17:00:00.000Z",
      expiredAt: "2026-08-19T18:00:00.000Z",
    },
  };
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...buildPublicDashboardBundleV3(),
      opportunities: [publicRepackViewSummaryV3FromDetail(reheated)],
      details: [reheated],
      selectedRepack: reheated,
    }).success,
    true,
    "any heat state pairs with any EV state",
  );
});

test("summary and detail projections carry byte-equivalent EV estimates", () => {
  const detail = buildPublicRepackDetailV3();
  const summary = publicRepackSummaryV3FromDetail(detail);
  assert.equal(packScoutEvProjectionsAreByteEquivalentV3(summary, detail), true);

  const divergent = buildPublicRepackDetailV3({
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvCurrentV3(9_000),
    }),
  });
  assert.equal(
    packScoutEvProjectionsAreByteEquivalentV3(summary, divergent),
    false,
    "the validator helper detects EV divergence between projections",
  );
});

test("dashboard opportunities stay eligible, ranked, and byte-aligned", () => {
  const bundle = buildPublicDashboardBundleV3();
  assert.equal(bundle.opportunities.length, 2);

  const reversed = {
    ...bundle,
    opportunities: [...bundle.opportunities].reverse(),
    details: [...bundle.details].reverse(),
  };
  assert.equal(
    publicDashboardBundleV3Schema.safeParse(reversed).success,
    false,
    "default ranking is signed buyback-adjusted EV dollars descending",
  );

  const soldOut = buildPublicRepackViewDetailV3({
    publicRepackId: DATA_RELEASE_V3_SECONDARY_REPACK_ID,
    availability: "sold_out",
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvSoldOutHistoricalV3(),
    }),
    actionAvailability: { promo: true, repackLink: false },
    actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
  });
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...bundle,
      opportunities: [publicRepackViewSummaryV3FromDetail(soldOut)],
      details: [soldOut],
      selectedRepack: soldOut,
    }).success,
    false,
    "a sold-out historical estimate never ranks as an opportunity",
  );

  const divergentDetail = buildPublicRepackViewDetailV3({
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvCurrentV3(9_000),
    }),
  });
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...bundle,
      selectedRepack: divergentDetail,
    }).success,
    false,
    "a selected item with divergent EV bytes is rejected",
  );
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...bundle,
      details: [divergentDetail, bundle.details[1]],
    }).success,
    false,
    "an opportunity summary must byte-match its detail",
  );
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...bundle,
      selectedRepack: null,
    }).success,
    false,
    "a populated dashboard requires a selected item",
  );
});

test("dynamic views bind last-known EV and distinct confidence and health clocks", () => {
  const confidenceEvaluatedAt = "2026-08-20T19:00:00.000Z";
  const lastKnown = buildPublicRepackViewDetailV3(
    {},
    { confidenceEvaluatedAt },
  );
  assert.equal(lastKnown.evEstimates.packScout.status, "current");
  assert.equal(lastKnown.packScoutEvPresentation.status, "last_known");
  assert.equal(
    lastKnown.packScoutEvPresentation.confidence?.scoreBasisPoints,
    3_750,
  );

  const baseline = buildPublicDashboardBundleV3();
  const oneLastKnownOpportunity = {
    ...baseline,
    confidenceEvaluatedAt,
    providerHealthEvaluatedAt: "2026-08-20T19:10:00.000Z",
    providerHealthSummary: {
      state: "healthy" as const,
      observedAt: "2026-08-20T19:10:00.000Z",
      freshThrough: "2026-08-20T20:00:00.000Z",
      totalProviderCount: 1,
      delayedProviderCount: 0,
      nextHealthEvaluationAt: "2026-08-20T20:00:00.000Z",
    },
    opportunities: [publicRepackViewSummaryV3FromDetail(lastKnown)],
    details: [lastKnown],
    selectedRepack: lastKnown,
  };
  assert.equal(
    publicDashboardBundleV3Schema.safeParse(oneLastKnownOpportunity).success,
    true,
    "age alone does not exclude a healthy last-known estimate",
  );
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...oneLastKnownOpportunity,
      providerHealthEvaluatedAt: "2026-08-20T18:59:59.999Z",
    }).success,
    false,
    "provider health cannot be evaluated before cursor-pinned confidence",
  );
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...oneLastKnownOpportunity,
      confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    }).success,
    false,
    "response and live presentation clocks cannot diverge",
  );
  const tamperedPresentation = structuredClone(lastKnown);
  if (tamperedPresentation.packScoutEvPresentation.status === "unavailable") {
    throw new Error("unexpected unavailable fixture");
  }
  tamperedPresentation.packScoutEvPresentation.confidence.scoreBasisPoints -= 1;
  assert.equal(
    publicRepackViewDetailV3Schema.safeParse(tamperedPresentation).success,
    false,
    "the presentation overlay must remain derived from stored V3",
  );

  const delayed = buildPublicRepackViewDetailV3(
    {},
    {
      confidenceEvaluatedAt,
      providerHealth: {
        state: "delayed",
        observedAt: DATA_RELEASE_V3_OBSERVED_AT,
        statusReason: "PROVIDER_OBSERVATION_STALE",
      },
    },
  );
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...oneLastKnownOpportunity,
      opportunities: [publicRepackViewSummaryV3FromDetail(delayed)],
      details: [delayed],
      selectedRepack: delayed,
    }).success,
    true,
    "provider delay remains informational and does not block ranking",
  );
  assert.equal(
    publicDashboardBundleV3Schema.safeParse({
      ...baseline,
      providerHealthSummary: {
        state: "delayed",
        observedAt: DATA_RELEASE_V3_OBSERVED_AT,
        freshThrough: DATA_RELEASE_V3_EXPIRES_AT,
        totalProviderCount: 1,
        delayedProviderCount: 1,
        nextHealthEvaluationAt: null,
      },
      opportunities: [],
      details: [],
      selectedRepack: null,
    }).success,
    true,
    "an ordinary no-match opportunity list remains valid during provider delay",
  );

  const list = buildPublicRepackListPageV3();
  assert.equal(list.providerHealthSummary.state, "healthy");
  assert.equal(list.publicFreshnessPolicyVersion, baseline.publicFreshnessPolicyVersion);
  assert.equal(publicShellStatusV3Schema.safeParse(buildPublicShellStatusV3()).success, true);
  assert.equal(
    publicShellStatusV3Schema.safeParse({
      release: buildDataReleaseV3Identity(),
      publicFreshnessPolicyVersion: baseline.publicFreshnessPolicyVersion,
      confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    }).success,
    false,
  );
  assert.equal(
    buildHealthyPublicProviderHealthSummaryV1().state,
    "healthy",
  );
});

test("list pages keep rows, details, selection, and desired matches aligned", () => {
  const page = buildPublicRepackListPageV3();
  assert.equal(page.rows.length, 2);

  const divergentDetail = buildPublicRepackViewDetailV3({
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvCurrentV3(9_000),
    }),
  });
  assert.equal(
    publicRepackListPageV3Schema.safeParse({
      ...page,
      details: [divergentDetail, page.details[1]],
    }).success,
    false,
    "a row must byte-match its detail",
  );
  assert.equal(
    publicRepackListPageV3Schema.safeParse({
      ...page,
      selectedRepack: null,
    }).success,
    false,
    "selection eligibility must match the selected item",
  );

  const desired = buildDesiredCollectibleRepackResultsV3();
  assert.equal(desired.matches.length, 1);
  assert.equal(
    publicRepackListPageV3Schema.safeParse({
      ...page,
      desiredCollectible: desired.desiredCollectible,
      desiredChaseMatches: [],
    }).success,
    false,
    "an active desired filter requires one chase match per row",
  );

  assert.equal(
    desiredCollectibleRepackResultsV3Schema.safeParse({
      ...desired,
      desiredCollectible: {
        ...desired.desiredCollectible,
        name: "A Different Collectible",
      },
    }).success,
    false,
    "desired-collectible identity must match every chase byte-for-byte",
  );
  assert.equal(
    desiredCollectibleRepackResultsV3Schema.safeParse({
      ...desired,
      total: 0,
    }).success,
    false,
  );
});

test("sort rows materialize only bounded values with honest null ranks", () => {
  const current = repackEvSortRowV3FromDetail(buildPublicRepackDetailV3());
  assert.equal(current.packScoutEvDollarsMinor, -1_500);
  assert.equal(current.packScoutEvDollarsNullRank, 0);
  assert.equal(current.packScoutGrossEvMinor, 8_500);
  assert.equal(current.packScoutConfidenceBand, "high");
  assert.equal(current.vendorReportedEvUsdMinor, 8_500);
  assert.equal(
    repackEvSortRowV3MatchesDetail(current, buildPublicRepackDetailV3()),
    true,
  );

  const historical = repackEvSortRowV3FromDetail(
    buildSoldOutPublicRepackDetailV3(),
  );
  assert.equal(historical.packScoutEvDollarsMinor, null);
  assert.equal(historical.packScoutEvDollarsNullRank, 1);
  assert.equal(historical.vendorReportedEvUsdMinor, null);

  const unavailable = repackEvSortRowV3FromDetail(
    buildPublicRepackDetailV3({
      evEstimates: buildPublicEvEstimatesV3({
        packScout: buildPackScoutPublicEvUnavailableV3("ODDS_UNAVAILABLE"),
      }),
    }),
  );
  assert.equal(unavailable.packScoutEvDollarsMinor, null);
  assert.equal(unavailable.packScoutConfidenceBand, null);

  assert.equal(
    repackEvSortRowV3Schema.safeParse({
      ...current,
      packScoutEvDollarsMinor: null,
    }).success,
    false,
    "a null value requires its null rank",
  );
  assert.equal(
    repackEvSortRowV3Schema.safeParse({
      ...current,
      packScoutConfidenceBand: "low",
    }).success,
    false,
  );
  assert.equal(
    repackEvSortRowV3Schema.safeParse({
      ...historical,
      packScoutEvDollarsMinor: -1_500,
      packScoutEvDollarsNullRank: 0,
    }).success,
    false,
    "a sold-out repack is never rankable",
  );
});

test("the release identity requires data_release_v3 and the exact versions", () => {
  const identity = buildDataReleaseV3Identity();
  assert.equal(identity.schemaVersion, "data_release_v3");
  assert.equal(identity.publicEvPolicyVersion, "packscout-public-ev-nonpositive-v1");
  assert.equal(
    dataReleaseV3IdentitySchema.safeParse({
      ...identity,
      schemaVersion: "data_release_v2",
    }).success,
    false,
  );
  assert.equal(
    dataReleaseV3IdentitySchema.safeParse({
      ...identity,
      methodVersion: "packscout-ev-v2",
    }).success,
    false,
    "the pre-buyback method version cannot enter the new release",
  );
  assert.equal(
    dataReleaseV3IdentitySchema.safeParse({
      ...identity,
      confidencePolicyVersion: "confidence-v1",
    }).success,
    false,
  );
  assert.equal(
    dataReleaseV3IdentitySchema.safeParse({
      ...identity,
      publicEvPolicyVersion: "packscout-public-ev-positive-v1",
    }).success,
    false,
  );
});

test("fail-closed detail parsing guards protected keys and the expiry clock", () => {
  const detail = buildPublicRepackDetailV3();
  const accepted = safeParsePublicRepackDetailV3(
    detail,
    DATA_RELEASE_V3_EXPIRES_AT,
  );
  assert.equal(accepted.success, true);

  const pastDeadline = safeParsePublicRepackDetailV3(
    detail,
    "2026-08-19T19:00:00.001Z",
  );
  assert.deepEqual(pastDeadline, {
    success: false,
    reason: "current_past_deadline",
  });

  const historicalPastDeadline = safeParsePublicRepackDetailV3(
    buildSoldOutPublicRepackDetailV3(),
    "2030-01-01T00:00:00.000Z",
  );
  assert.equal(
    historicalPastDeadline.success,
    true,
    "historical estimates never expire into live-unavailable",
  );

  const leakedActions: PublicRepackDetailV3 = structuredClone(detail);
  (leakedActions.actions as Record<string, unknown>)["provenance"] = {
    sourceRevisionId: "leak",
  };
  assert.deepEqual(
    safeParsePublicRepackDetailV3(leakedActions, DATA_RELEASE_V3_EXPIRES_AT),
    { success: false, reason: "protected_field_present" },
  );

  const leakedRaw = structuredClone(detail);
  (leakedRaw.contentSummary as Record<string, unknown>)["rawPayload"] = "leak";
  assert.deepEqual(
    safeParsePublicRepackDetailV3(leakedRaw, DATA_RELEASE_V3_EXPIRES_AT),
    { success: false, reason: "protected_field_present" },
  );

  assert.deepEqual(
    safeParsePublicRepackDetailV3(
      { ...detail, unknownField: true },
      DATA_RELEASE_V3_EXPIRES_AT,
    ),
    { success: false, reason: "schema_invalid" },
  );
});
