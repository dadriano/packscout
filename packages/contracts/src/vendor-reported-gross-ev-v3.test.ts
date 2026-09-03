import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPublicRepackDetailV3 } from "./__fixtures__/data-release-v3.fixture.ts";
import {
  calculateVendorReportedGrossEvV3,
  vendorReportedGrossEvV3,
  type VendorReportedGrossEvCalculationV3Input,
} from "./vendor-reported-gross-ev-v3.ts";

const input: VendorReportedGrossEvCalculationV3Input = {
  vendorKey: "phygitals", priceUsdMinor: 10_000,
  vendorReportedEvUsdMinor: 10_421, buybackRateBasisPoints: 9_000,
};

test("reviewed platforms calculate Gross EV from underlying reported EV and buyback", () => {
  for (const vendorKey of ["phygitals", "collector_crypt", "courtyard"]) {
    assert.deepEqual(calculateVendorReportedGrossEvV3({ ...input, vendorKey }), {
      grossEvMoney: { minorUnits: 9_379, currency: "USD" },
      grossReturnBasisPoints: 9_379,
      evDollarsMoney: { minorUnits: -621, currency: "USD" }, evPercentBasisPoints: -621,
    });
  }
});

test("Gross EV rounds half-up to cents before calculating percentage of pack price", () => {
  assert.deepEqual(calculateVendorReportedGrossEvV3({ ...input,
    vendorReportedEvUsdMinor: 10_005, buybackRateBasisPoints: 5_000,
    priceUsdMinor: 20_000,
  }), {
    grossEvMoney: { minorUnits: 5_003, currency: "USD" },
    grossReturnBasisPoints: 2_502,
    evDollarsMoney: { minorUnits: -14_997, currency: "USD" }, evPercentBasisPoints: -7_498,
  });
});

test("zero buyback and zero underlying EV remain valid zero payouts", () => {
  for (const overrides of [{ buybackRateBasisPoints: 0 }, { vendorReportedEvUsdMinor: 0 }]) {
    assert.deepEqual(calculateVendorReportedGrossEvV3({ ...input, ...overrides }), {
      grossEvMoney: { minorUnits: 0, currency: "USD" }, grossReturnBasisPoints: 0,
      evDollarsMoney: { minorUnits: -10_000, currency: "USD" }, evPercentBasisPoints: -10_000,
    });
  }
});

test("missing, invalid, and unreviewed inputs do not fabricate Gross EV", () => {
  const invalid: Partial<VendorReportedGrossEvCalculationV3Input>[] = [
    { priceUsdMinor: null }, { priceUsdMinor: 0 }, { priceUsdMinor: -1 },
    { vendorReportedEvUsdMinor: null }, { vendorReportedEvUsdMinor: -1 },
    { vendorReportedEvUsdMinor: Number.NaN }, { vendorReportedEvUsdMinor: Number.MAX_SAFE_INTEGER + 1 },
    { buybackRateBasisPoints: null }, { buybackRateBasisPoints: -1 },
    { buybackRateBasisPoints: 10_001 }, { buybackRateBasisPoints: 8_500.5 },
    { vendorKey: "clutchpacks" }, { vendorKey: "new_platform" },
  ];
  for (const overrides of invalid) {
    assert.equal(calculateVendorReportedGrossEvV3({ ...input, ...overrides }), null);
  }
});

test("platform-derived above-price Gross EV is not capped into independent PackScout policy", () => {
  assert.deepEqual(calculateVendorReportedGrossEvV3({ ...input, vendorReportedEvUsdMinor: 20_000 }), {
    grossEvMoney: { minorUnits: 18_000, currency: "USD" }, grossReturnBasisPoints: 18_000,
    evDollarsMoney: { minorUnits: 8_000, currency: "USD" }, evPercentBasisPoints: 8_000,
  });
});

test("public detail calculation requires comparable money and documented uniform buyback", () => {
  const detail = buildPublicRepackDetailV3({ vendorKey: "phygitals" });
  const expected = vendorReportedGrossEvV3(detail);
  assert.ok(expected);
  assert.equal(expected.observedAt, detail.evEstimates.vendorReported.observedAt);
  for (const buyback of [
    { kind: "not_documented" }, { kind: "unavailable" },
    { kind: "varies_by_outcome" }, { kind: "fixed_or_final_payout" },
  ] as const) assert.equal(vendorReportedGrossEvV3({ ...detail, buyback }), null);
  assert.equal(vendorReportedGrossEvV3({ ...detail, evEstimates: {
    ...detail.evEstimates,
    vendorReported: { status: "unavailable", sourceMoney: null, usdComparison: null,
      observedAt: null, reason: "NOT_REPORTED" },
  } }), null);
  assert.equal(vendorReportedGrossEvV3({ ...detail, price: {
    displayMoney: null, usdComparison: { status: "unavailable", value: null, reason: "PRICE_UNAVAILABLE" },
  } }), null);
});
