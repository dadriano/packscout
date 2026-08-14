import assert from "node:assert/strict";
import { test } from "node:test";
import {
  presentConfidenceLimitations,
  PUBLIC_CONFIDENCE_LIMITATION_COPY,
  type PackScoutConfidenceLimitationCode,
} from "./confidence-limitations";

const everyLimitationCode: readonly PackScoutConfidenceLimitationCode[] = [
  "incomplete_outcome_pool",
  "estimated_value_ranges",
  "partial_probability_coverage",
  "sparse_valuation_data",
  "stale_valuation_data",
  "unresolved_collectibles",
  "currency_normalization_applied",
  "vendor_odds_unverified",
  "vendor_probability_inputs",
];

test("maps every public confidence limitation to buyer-facing copy", () => {
  const copy = presentConfidenceLimitations(everyLimitationCode);

  assert.equal(copy.length, everyLimitationCode.length);
  assert.ok(copy.every((value) => /[.!?]$/.test(value)));
  assert.deepEqual(
    Object.keys(PUBLIC_CONFIDENCE_LIMITATION_COPY).sort(),
    [...everyLimitationCode].sort(),
  );
  for (const code of everyLimitationCode) {
    assert.doesNotMatch(copy.join(" "), new RegExp(code));
  }
});
