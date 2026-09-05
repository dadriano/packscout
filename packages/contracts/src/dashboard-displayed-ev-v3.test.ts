import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPackScoutPublicEvCurrentV3,
  buildPackScoutPublicEvSoldOutHistoricalV3,
  buildPackScoutPublicEvUnavailableV3,
  buildPublicDashboardBundleV3,
  buildPublicEvEstimatesV3,
  buildPublicRepackViewDetailV3,
  DATA_RELEASE_V3_OBSERVED_AT,
  DATA_RELEASE_V3_SOLD_OUT_AT,
} from "./__fixtures__/data-release-v3.fixture.ts";
import {
  publicDashboardBundleV3Schema,
  publicRepackViewDetailV3Schema,
  publicRepackViewSummaryV3FromDetail,
  type PublicRepackDetailV3,
  type PublicRepackViewDetailV3,
} from "./data-release-v3.ts";

function sourceDetail(
  vendorKey: string,
  sequence: number,
  reportedMinor = 10_421,
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackViewDetailV3 {
  return buildPublicRepackViewDetailV3({
    publicRepackId: `20000000-0000-5000-8000-${String(sequence).padStart(12, "0")}`,
    vendorKey,
    buyback: { kind: "uniform_rate", rateBasisPoints: 9_000 },
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvUnavailableV3("SOURCE_EVIDENCE_UNAVAILABLE"),
      vendorReported: {
        status: "available",
        sourceMoney: { minorUnits: reportedMinor, currency: "USD" },
        usdComparison: {
          status: "available", value: { minorUnits: reportedMinor, currency: "USD" },
        },
        observedAt: DATA_RELEASE_V3_OBSERVED_AT,
      },
    }),
    ...overrides,
  });
}

function bundleFor(details: PublicRepackViewDetailV3[]) {
  return {
    ...buildPublicDashboardBundleV3(),
    opportunities: details.map(publicRepackViewSummaryV3FromDetail),
    details,
    selectedRepack: details[0] ?? null,
  };
}

test("dashboard accepts mixed-vendor displayed EV without relabeling source estimates as independent", () => {
  const collector = sourceDetail("collector_crypt", 401, 11_000); // -$1.00
  const independent = buildPublicRepackViewDetailV3({
    vendorKey: "clutchpacks",
    evEstimates: buildPublicEvEstimatesV3({ packScout: buildPackScoutPublicEvCurrentV3(9_500) }),
  }); // -$5.00
  const phygitals = sourceDetail("phygitals", 402); // -$6.21
  const bundle = bundleFor([collector, independent, phygitals]);
  const before = structuredClone(bundle);
  const parsed = publicDashboardBundleV3Schema.parse(bundle);
  assert.deepEqual(parsed.opportunities.map(({ vendorKey }) => vendorKey), [
    "collector_crypt", "clutchpacks", "phygitals",
  ]);
  assert.equal(parsed.opportunities[0]?.evEstimates.packScout.status, "unavailable");
  assert.equal(parsed.opportunities[0]?.evEstimates.packScout.metrics, null);
  assert.equal(parsed.opportunities[0]?.evEstimates.packScout.confidence, null);
  assert.deepEqual(bundle, before, "contract validation does not rewrite independent evidence");
  assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([
    independent, collector, phygitals,
  ])).success, false, "ordering must use displayed EV, not independent-only values");
});

test("dashboard source-derived EV keeps positive, neutral, and negative signed values", () => {
  const positive = sourceDetail("collector_crypt", 401, 12_000); // +$8.00
  const neutral = sourceDetail("courtyard", 402, 10_000, {
    buyback: { kind: "uniform_rate", rateBasisPoints: 10_000 },
  });
  const negative = sourceDetail("phygitals", 403);
  assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([
    positive, neutral, negative,
  ])).success, true);
  assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([
    negative, neutral, positive,
  ])).success, false);
});

test("displayed-EV ties across vendors use public id and still require matching detail bytes", () => {
  const first = sourceDetail("collector_crypt", 401);
  const second = sourceDetail("phygitals", 402);
  assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([first, second])).success, true);
  assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([second, first])).success, false);
  const divergent = bundleFor([first, second]);
  divergent.details = [second, first];
  assert.equal(publicDashboardBundleV3Schema.safeParse(divergent).success, false);
});

test("source-derived opportunities, details, and selection must agree on displayed-EV inputs", () => {
  const original = sourceDetail("collector_crypt", 401, 11_000);
  const changedPrice = { minorUnits: 20_000, currency: "USD" as const };
  const changes = [
    { label: "price", override: { price: {
      displayMoney: changedPrice, usdComparison: { status: "available" as const, value: changedPrice },
    } } },
    { label: "buyback", override: { buyback: { kind: "uniform_rate" as const, rateBasisPoints: 5_000 } } },
    { label: "supported vendor", override: { vendorKey: "phygitals" } },
    { label: "unsupported vendor", override: { vendorKey: "unknown_platform" } },
    { label: "vendor-reported EV", override: {
      evEstimates: sourceDetail("collector_crypt", 401, 20_000).evEstimates,
    } },
  ];
  for (const { label, override } of changes) {
    const changed = publicRepackViewDetailV3Schema.parse({ ...original, ...override });
    for (const [surface, bundle] of [
      ["selectedRepack", { ...bundleFor([original]), selectedRepack: changed }],
      ["details", { ...bundleFor([original]), details: [changed] }],
      ["opportunities", { ...bundleFor([original]), opportunities: [publicRepackViewSummaryV3FromDetail(changed)] }],
    ] as const) {
      const parsed = publicDashboardBundleV3Schema.safeParse(bundle);
      assert.equal(parsed.success, false, `${surface} must reject divergent ${label}`);
      if (parsed.success) throw new Error("Expected projection divergence");
      const expected = surface === "selectedRepack"
        ? "data_release_v3.selected_item_divergence"
        : "data_release_v3.summary_detail_divergence";
      assert.ok(parsed.error.issues.some(({ message }) => message === expected), `${surface}: ${label}`);
    }
  }
  const equivalent = structuredClone(original);
  assert.equal(publicDashboardBundleV3Schema.safeParse({
    ...bundleFor([original]), selectedRepack: equivalent,
  }).success, true, "an equivalent source selection remains valid");
});

test("malformed source-derived selections return structured validation failures without throwing", () => {
  const original = sourceDetail("collector_crypt", 401, 11_000);
  const malformedSelections = [
    ...[-1, 10_001, 5_000.5, "9000"].map(rateBasisPoints => ({
      ...original, buyback: { kind: "uniform_rate", rateBasisPoints },
    })),
    { ...original, vendorKey: "" },
    { ...original, price: {
      displayMoney: { minorUnits: -1, currency: "USD" },
      usdComparison: { status: "available", value: { minorUnits: -1, currency: "USD" } },
    } },
    { ...original, evEstimates: { ...original.evEstimates, vendorReported: {
      status: "available", sourceMoney: { minorUnits: -1, currency: "USD" },
      usdComparison: { status: "available", value: { minorUnits: -1, currency: "USD" } },
      observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    } } },
  ];
  for (const selectedRepack of malformedSelections) {
    assert.doesNotThrow(() => {
      const result = publicDashboardBundleV3Schema.safeParse({
        ...bundleFor([original]), selectedRepack,
      });
      assert.equal(result.success, false);
      if (result.success) throw new Error("Expected malformed selection rejection");
      assert.ok(result.error.issues.some(({ path }) => path[0] === "selectedRepack"));
    });
  }
});

test("current and last-known independent EV takes precedence over a higher source-derived value", () => {
  const source = sourceDetail("phygitals", 402); // -$6.21
  const base = sourceDetail("collector_crypt", 401, 20_000); // source alone is +$80
  const current = publicRepackViewDetailV3Schema.parse({
    ...base,
    evEstimates: { ...base.evEstimates, packScout: buildPackScoutPublicEvCurrentV3(8_500) },
  }); // independent -$15
  const lastKnown = buildPublicRepackViewDetailV3({
    vendorKey: "collector_crypt",
    evEstimates: buildPublicEvEstimatesV3({ vendorReported: base.evEstimates.vendorReported }),
  });
  for (const independent of [current, lastKnown]) {
    assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([source, independent])).success, true);
    assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([independent, source])).success, false);
  }
});

test("unsupported or insufficient source evidence never becomes an opportunity", () => {
  const baseline = sourceDetail("collector_crypt", 401);
  const candidates = [
    sourceDetail("new_platform", 402),
    sourceDetail("clutchpacks", 403),
    sourceDetail("collector_crypt", 404, 10_421, { buyback: { kind: "not_documented" } }),
    sourceDetail("collector_crypt", 405, 10_421, { buyback: { kind: "varies_by_outcome" } }),
    sourceDetail("collector_crypt", 406, 10_421, {
      price: { displayMoney: null, usdComparison: {
        status: "unavailable", value: null, reason: "PRICE_UNAVAILABLE",
      } },
    }),
    publicRepackViewDetailV3Schema.parse({
      ...baseline,
      evEstimates: { ...baseline.evEstimates, vendorReported: {
        status: "unavailable", sourceMoney: null, usdComparison: null,
        observedAt: null, reason: "NOT_REPORTED",
      } },
    }),
  ];
  for (const detail of candidates) {
    assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([detail])).success, false);
  }
});

test("source-derived EV never admits non-purchasable packs or resurrects frozen sellout economics", () => {
  for (const availability of ["sold_out", "unavailable", "unknown"] as const) {
    const detail = sourceDetail("collector_crypt", 401, 20_000, {
      availability,
      actionAvailability: { promo: false, repackLink: false },
      actions: {},
    });
    assert.equal(publicDashboardBundleV3Schema.safeParse(bundleFor([detail])).success, false, availability);
  }
  const source = sourceDetail("collector_crypt", 401, 20_000);
  const historical = buildPublicRepackViewDetailV3({
    availability: "sold_out",
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvSoldOutHistoricalV3(),
      vendorReported: source.evEstimates.vendorReported,
    }),
    actionAvailability: { promo: false, repackLink: false },
    actions: {},
  }, { confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT });
  const restocked = publicRepackViewDetailV3Schema.parse({
    ...historical, availability: "available", vendorKey: "collector_crypt",
  });
  assert.equal(restocked.evEstimates.packScout.status, "last_known");
  const bundle = {
    ...bundleFor([restocked]),
    confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT,
    providerHealthEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT,
  };
  assert.equal(publicDashboardBundleV3Schema.safeParse(bundle).success, false);
});
