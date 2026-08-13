import assert from "node:assert/strict";
import test from "node:test";
import { publicConfidenceLimitationsFromPipeline } from "./public-confidence-projection.ts";

test("maps every pipeline EV limitation to bounded public confidence copy codes", () => {
  assert.deepEqual(
    publicConfidenceLimitationsFromPipeline([
      "verified_usd_stablecoin_at_parity",
      "provider_supplied_probabilities",
      "midpoint_value_ranges",
      "incomplete_inventory",
      "midpoint_value_ranges",
    ]),
    [
      "currency_normalization_applied",
      "estimated_value_ranges",
      "incomplete_outcome_pool",
      "vendor_probability_inputs",
    ],
  );
});
