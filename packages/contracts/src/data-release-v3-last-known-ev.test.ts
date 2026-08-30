import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_RELEASE_V3_OBSERVED_AT,
  buildDataReleaseV3Identity,
  buildPackScoutPublicEvDelayedV3,
  buildPackScoutPublicEvNegativeV3,
  buildPackScoutPublicEvSoldOutHistoricalV3,
  buildPackScoutPublicEvUnavailableV3,
  buildPackScoutPublicEvZeroV3,
  buildPublicRepackViewDetailV3,
} from "./__fixtures__/data-release-v3.fixture.ts";
import {
  packScoutDisplayedEvV3Schema,
  packScoutPublicEvLastKnownV3Schema,
  presentLastKnownPackScoutEvV3,
  publicDashboardBundleV3Schema,
  publicRepackViewDetailV3Schema,
  publicRepackViewSummaryV3FromDetail,
  type PackScoutDisplayedEvV3,
} from "./data-release-v3.ts";

const minute = 60_000;
function at(age: number): string {
  return new Date(Date.parse(DATA_RELEASE_V3_OBSERVED_AT) + age).toISOString();
}
function present(age: number, estimate: PackScoutDisplayedEvV3 = buildPackScoutPublicEvNegativeV3()) {
  const output = presentLastKnownPackScoutEvV3({
    estimate, calculationPriceUsdMinor: 10_000, referenceTimeIso: at(age),
  });
  assert.equal(output.status, "last_known");
  if (output.status !== "last_known") throw new Error("expected last-known values");
  return output;
}

test("last known values never disappear at one hour, zero confidence, or many days", () => {
  const original = buildPackScoutPublicEvNegativeV3();
  for (const [age, score] of [
    [15 * minute, 10_000], [15 * minute + 1, 9_000],
    [30 * minute, 9_000], [30 * minute + 1, 7_500],
    [60 * minute, 7_500], [60 * minute + 1, 7_500],
    [90 * minute, 6_250], [120 * minute, 5_000],
    [240 * minute, 0], [365 * 24 * 60 * minute, 0],
  ]) {
    const output = present(age!, original);
    assert.deepEqual(output.metrics, original.metrics);
    assert.equal(output.confidence.scoreBasisPoints, score);
    assert.equal(output.calculatedAt, original.calculatedAt);
    assert.deepEqual(output.dataAsOf, original.dataAsOf);
    assert.equal(output.expiresAt, null);
    assert.equal(output.latestUnavailableReason, null);
  }
});

test("aging always derives from original evidence rather than compounding prior decay", () => {
  const delayed = buildPackScoutPublicEvDelayedV3();
  const once = present(120 * minute, delayed);
  const twice = present(120 * minute, present(75 * minute, delayed));
  assert.deepEqual(twice, once);
  assert.equal(once.confidence.scoreBasisPoints, 5_000);
  assert.deepEqual(once.confidence.limitationCodes, ["source_age_over_60_minutes"]);
});

test("a newer failed calculation keeps the old numbers and sets confidence to zero", () => {
  const original = buildPackScoutPublicEvNegativeV3();
  const retained = presentLastKnownPackScoutEvV3({
    estimate: original, calculationPriceUsdMinor: 10_000,
    referenceTimeIso: at(10 * minute), latestUnavailableReason: "BUYBACK_UNAVAILABLE",
  });
  assert.equal(retained.status, "last_known");
  if (retained.status !== "last_known") return;
  assert.deepEqual(retained.metrics, original.metrics);
  assert.equal(retained.confidence.scoreBasisPoints, 0);
  assert.equal(retained.latestUnavailableReason, "BUYBACK_UNAVAILABLE");
  assert.equal(present(20 * minute, retained).confidence.scoreBasisPoints, 0);
  const cannotClear = presentLastKnownPackScoutEvV3({
    estimate: retained, calculationPriceUsdMinor:10_000,
    referenceTimeIso:at(20 * minute), latestUnavailableReason:null,
  });
  assert.equal(cannotClear.confidence?.scoreBasisPoints, 0);
});

test("never-calculated estimates stay unavailable, including when vendor EV exists", () => {
  const unavailable = buildPackScoutPublicEvUnavailableV3();
  assert.deepEqual(presentLastKnownPackScoutEvV3({
    estimate: unavailable, calculationPriceUsdMinor: 10_000, referenceTimeIso: at(24 * 60 * minute),
  }), unavailable);
});

test("last known price basis remains valid after current price and buyback change", () => {
  const original = buildPublicRepackViewDetailV3();
  const retained = present(24 * 60 * minute, original.evEstimates.packScout);
  const changed = publicRepackViewDetailV3Schema.parse({
    ...original,
    price: {displayMoney:{currency:"USD", minorUnits:20_000}, usdComparison:{status:"available",value:{currency:"USD",minorUnits:20_000}}},
    buyback: {kind:"not_documented"},
    evEstimates: {...original.evEstimates, packScout:retained},
  });
  assert.equal(changed.evEstimates.packScout.status, "last_known");
  assert.deepEqual(changed.evEstimates.packScout.metrics, original.evEstimates.packScout.metrics);
  assert.equal(packScoutPublicEvLastKnownV3Schema.safeParse({...retained, calculationPriceUsdMinor:20_000}).success, false);
});

test("old known estimates remain rankable at zero confidence without treating gross zero as missing", () => {
  const original = buildPublicRepackViewDetailV3();
  const detail = publicRepackViewDetailV3Schema.parse({
    ...original, evEstimates:{...original.evEstimates,packScout:present(24 * 60 * minute,buildPackScoutPublicEvZeroV3())},
  });
  assert.equal(publicDashboardBundleV3Schema.safeParse({
    release:buildDataReleaseV3Identity(), opportunities:[publicRepackViewSummaryV3FromDetail(detail)],
    details:[detail], selectedRepack:detail,
  }).success, true);
  assert.equal(detail.evEstimates.packScout.metrics?.grossEvMoney.minorUnits, 0);
});

test("historical sellout and calculation timestamps remain truthful while confidence ages", () => {
  const original = buildPackScoutPublicEvSoldOutHistoricalV3();
  const retained = present(24 * 60 * minute, original);
  assert.equal(original.status, "sold_out_historical");
  if (original.status !== "sold_out_historical") return;
  assert.equal(retained.historicalSoldOutAt, original.soldOutAt);
  assert.equal(retained.calculatedAt, original.calculatedAt);
  assert.equal(retained.confidence.scoreBasisPoints, 0);
});

test("retained projections reject invented confidence, timestamps, price, positive EV, and protected fields", () => {
  const valid = present(120 * minute);
  const candidates = [
    {...valid, confidence:{...valid.confidence,scoreBasisPoints:10_000}},
    {...valid, confidenceEvaluatedAt:at(-1)},
    {...valid, calculatedAt:at(90 * minute)},
    {...valid, historicalSoldOutAt:at(90 * minute)},
    {...valid, sourceAge:{...valid.sourceAge,milliseconds:0}},
    {...valid, calculationPriceUsdMinor:0},
    {...valid, metrics:{...valid.metrics,evDollars:{currency:"USD",minorUnits:1}}},
    {...valid, underlyingOutcomeEvMinorUnits:10_000},
  ];
  for (const candidate of candidates) assert.equal(packScoutDisplayedEvV3Schema.safeParse(candidate).success,false);
  assert.throws(()=>presentLastKnownPackScoutEvV3({estimate:valid,calculationPriceUsdMinor:10_000,referenceTimeIso:at(-1)}));
  assert.throws(()=>presentLastKnownPackScoutEvV3({estimate:valid,calculationPriceUsdMinor:10_000,referenceTimeIso:at(30 * minute)}));
});
