import assert from "node:assert/strict";
import { test } from "node:test";
import { packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1 } from "./buyback-ev-published-probability.ts";

test("published percentages recover exact rational odds after numeric percent-to-ratio division", () => {
  for (const [percent, expected] of [
    [33.333, { numerator: 33_333, denominator: 100_000 }],
    [66.667, { numerator: 66_667, denominator: 100_000 }],
    [33.33, { numerator: 3_333, denominator: 10_000 }],
    [66.67, { numerator: 6_667, denominator: 10_000 }],
    [99.9, { numerator: 999, denominator: 1_000 }],
    [0.1, { numerator: 1, denominator: 1_000 }],
    [1.1, { numerator: 11, denominator: 1_000 }],
    [0, { numerator: 0, denominator: 1 }],
    [100, { numerator: 1, denominator: 1 }],
  ] as const) {
    assert.deepEqual(
      packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1(percent / 100),
      expected,
      String(percent),
    );
  }
});

test("published probability recovery refuses invalid or unrepresentable odds instead of rounding them", () => {
  for (const value of [null, undefined, NaN, Infinity, -0.1, 1.1, 1 / 3, 0.1234567891]) {
    assert.equal(packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1(value), null, String(value));
  }
  assert.deepEqual(
    packScoutBuybackEvProbabilityFromNormalizedPercentRatioV1(0.123456789),
    { numerator: 123_456_789, denominator: 1_000_000_000 },
  );
});
