import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
  publicReadError,
} from "@packscout/contracts";
import {
  allRepacksCatalogIsEmpty,
  dashboardCatalogIsEmpty,
  parseGetDashboardBundleV3Result,
  parseGetPublicRepackV3Result,
  parseGetPublicShellStatusV3Result,
  parseListPublicRepacksV3Result,
  type DashboardBundleV3,
  type ListPublicRepacksPageV3,
} from "./public-repacks-v3";
import {
  FIXTURE_RELEASE_ID,
  FIXTURE_CURRENT_EVALUATED_AT,
  buildV3ProviderHealthSummary,
  buildV3ReleaseIdentity,
  buildV3ViewDetail,
} from "./packscout-ev-fixtures.test-support";

const DEFAULT_FILTERS = {
  vendors: [],
  categories: [],
  collectibleTypes: [],
  availability: "available",
  price: { mode: "full", minMinor: 100, maxMinor: 1_200_000 },
} as const;

const EMPTY_FACETS = { vendors: [], categories: [], collectibleTypes: [] } as const;

function summaryOf(detail: ReturnType<typeof buildV3ViewDetail>) {
  const summary = Object.fromEntries(
    Object.entries(detail).filter(
      ([key]) => key !== "description" && key !== "actions",
    ),
  );
  return summary;
}

function dashboardPayload() {
  const detail = buildV3ViewDetail();
  return {
    ok: true,
    data: {
      release: buildV3ReleaseIdentity(),
      publicFreshnessPolicyVersion:
        PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
      confidenceEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthSummary: buildV3ProviderHealthSummary(),
      opportunities: [summaryOf(detail)],
      details: [detail],
      selectedRepack: detail,
      kpis: {
        totalRepacks: 1,
        medianPackScoutEvPercent: { status: "available", basisPoints: -1_500 },
        highestChaseValueUsdMinor: 85_000,
        highConfidenceRepacks: 1,
      },
      vendorSummaries: [
        {
          key: "collector_example",
          label: "Collector Example",
          repackCount: 1,
          medianPackScoutEvPercent: { status: "available", basisPoints: -1_500 },
        },
      ],
      categorySummaries: [],
      facets: {
        vendors: [
          {
            key: "collector_example",
            label: "Collector Example",
            repackCount: 1,
            selected: false,
          },
        ],
        categories: [],
        collectibleTypes: [
          { key: "card", label: "Card", repackCount: 1, selected: false },
        ],
      },
      activeFilters: DEFAULT_FILTERS,
    },
  };
}

function listPayload() {
  const detail = buildV3ViewDetail();
  return {
    ok: true,
    data: {
      release: buildV3ReleaseIdentity(),
      publicFreshnessPolicyVersion:
        PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
      confidenceEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthSummary: buildV3ProviderHealthSummary(),
      rows: [summaryOf(detail)],
      details: [detail],
      selectedRepack: detail,
      selectedRepackEligible: true,
      desiredCollectible: null,
      desiredChaseMatches: [],
      facets: EMPTY_FACETS,
      activeQuery: {
        search: "",
        filters: DEFAULT_FILTERS,
        sort: "packscout_ev_dollars",
        direction: "desc",
        pageSize: 25,
        desiredPublicCollectibleId: null,
      },
      queryFingerprint: "a".repeat(64),
      nextCursor: null,
      hasPrevious: false,
      range: { start: 1, end: 1, total: 1 },
      paginationReset: null,
    },
  };
}

test("parses a coherent v3 dashboard bundle and preserves aggregates", () => {
  const result = parseGetDashboardBundleV3Result(dashboardPayload());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.release.publicReleaseId, FIXTURE_RELEASE_ID);
  assert.equal(result.data.opportunities.length, 1);
  assert.equal(result.data.vendorSummaries[0]?.repackCount, 1);
  assert.equal(dashboardCatalogIsEmpty(result.data), false);
});

test("parses a coherent v3 list page and its pagination envelope", () => {
  const result = parseListPublicRepacksV3Result(listPayload());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.rows.length, 1);
  assert.equal(result.data.queryFingerprint, "a".repeat(64));
  assert.equal(result.data.hasPrevious, false);
  assert.equal(result.data.nextCursor, null);
  assert.equal(allRepacksCatalogIsEmpty(result.data), false);
});

test("parses provider health on shell, dashboard, and list responses", () => {
  const providerHealthSummary = buildV3ProviderHealthSummary("delayed");
  const shell = parseGetPublicShellStatusV3Result({
    ok: true,
    data: {
      release: buildV3ReleaseIdentity(),
      publicFreshnessPolicyVersion:
        PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
      confidenceEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthSummary,
    },
  });
  assert.equal(shell.ok, true);
  if (!shell.ok) return;
  assert.deepEqual(shell.data.providerHealthSummary, providerHealthSummary);

  const dashboard = dashboardPayload();
  dashboard.data.providerHealthSummary = providerHealthSummary;
  const parsedDashboard = parseGetDashboardBundleV3Result(dashboard);
  assert.equal(parsedDashboard.ok, true);
  if (!parsedDashboard.ok) return;
  assert.equal(parsedDashboard.data.providerHealthSummary.state, "delayed");
  assert.equal(parsedDashboard.data.opportunities.length, 1);

  const list = listPayload();
  list.data.providerHealthSummary = providerHealthSummary;
  const parsedList = parseListPublicRepacksV3Result(list);
  assert.equal(parsedList.ok, true);
  if (!parsedList.ok) return;
  assert.equal(parsedList.data.providerHealthSummary.state, "delayed");
});

test("rejects payloads carrying protected calculation evidence", () => {
  const payload = dashboardPayload();
  const poisoned = {
    ...payload,
    data: {
      ...payload.data,
      details: [
        {
          ...payload.data.details[0],
          protectedEvidence: { outcomes: [] },
        },
      ],
    },
  };

  assert.deepEqual(
    parseGetDashboardBundleV3Result(poisoned),
    publicReadError("RELEASE_UNAVAILABLE"),
  );
});

test("fails closed on malformed, mixed, or arithmetically inconsistent data", () => {
  assert.deepEqual(
    parseGetDashboardBundleV3Result(undefined),
    publicReadError("RELEASE_UNAVAILABLE"),
  );
  assert.deepEqual(
    parseGetPublicShellStatusV3Result({ ok: true, data: { release: {} } }),
    publicReadError("RELEASE_UNAVAILABLE"),
  );

  const detail = buildV3ViewDetail();
  const inconsistent = {
    ...detail,
    evEstimates: {
      ...detail.evEstimates,
      packScout: {
        ...detail.evEstimates.packScout,
        metrics: {
          ...(detail.evEstimates.packScout.status === "current"
            ? detail.evEstimates.packScout.metrics
            : {}),
          evDollars: { minorUnits: 42, currency: "USD" },
        },
      },
    },
  };
  assert.deepEqual(
    parseGetPublicRepackV3Result({ ok: true, data: inconsistent }),
    publicReadError("RELEASE_UNAVAILABLE"),
  );

  const badRange = listPayload();
  badRange.data.range = { start: 1, end: 2, total: 5 };
  assert.deepEqual(
    parseListPublicRepacksV3Result(badRange),
    publicReadError("RELEASE_UNAVAILABLE"),
  );
});

test("passes through bounded public read errors untouched", () => {
  const error = publicReadError("CURSOR_EXPIRED");
  assert.deepEqual(parseListPublicRepacksV3Result(error), error);
});

test("distinguishes an empty catalog from a filtered-down zero result", () => {
  const emptyDashboard: DashboardBundleV3 = {
    ...(parseGetDashboardBundleV3Result(dashboardPayload()) as {
      ok: true;
      data: DashboardBundleV3;
    }).data,
    opportunities: [],
    details: [],
    selectedRepack: null,
    kpis: {
      totalRepacks: 0,
      medianPackScoutEvPercent: {
        status: "unavailable",
        basisPoints: null,
        reason: "ESTIMATE_UNAVAILABLE",
      },
      highestChaseValueUsdMinor: null,
      highConfidenceRepacks: 0,
    },
    facets: { vendors: [], categories: [], collectibleTypes: [] },
  };
  assert.equal(dashboardCatalogIsEmpty(emptyDashboard), true);

  const filteredDashboard: DashboardBundleV3 = {
    ...emptyDashboard,
    facets: {
      vendors: [
        {
          key: "collector_example",
          label: "Collector Example",
          repackCount: 3,
          selected: false,
        },
      ],
      categories: [],
      collectibleTypes: [],
    },
  };
  assert.equal(dashboardCatalogIsEmpty(filteredDashboard), false);

  const parsedList = parseListPublicRepacksV3Result(listPayload()) as {
    ok: true;
    data: ListPublicRepacksPageV3;
  };
  const emptyList: ListPublicRepacksPageV3 = {
    ...parsedList.data,
    rows: [],
    details: [],
    selectedRepack: null,
    selectedRepackEligible: false,
    range: { start: 0, end: 0, total: 0 },
  };
  assert.equal(allRepacksCatalogIsEmpty(emptyList), true);
  assert.equal(
    allRepacksCatalogIsEmpty({
      ...emptyList,
      activeQuery: { ...emptyList.activeQuery, search: "mythic" },
    }),
    false,
  );
});
