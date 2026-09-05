import assert from "node:assert/strict";
import { test } from "node:test";
import * as domain from "@packscout/contracts";
import * as publicServices from "@packscout/services";
import * as calculator from "./buyback-adjusted-ev-calculator.ts";
import * as confidencePolicy from "./buyback-adjusted-ev-confidence.ts";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";
import { BUYBACK_EV_TEST_OBSERVED_AT, buildBuybackEvInput } from "./buyback-adjusted-ev-calculator.test-support.ts";

test("native replay and existing services share the exact neutral EV and confidence core", () => {
  for (const [name, value] of Object.entries({ ...calculator, ...confidencePolicy })) {
    assert.strictEqual(Reflect.get(domain, name), value, name);
    assert.strictEqual(Reflect.get(publicServices, name), value, name);
  }
  const calculation = calculatePackScoutBuybackAdjustedEvV1({ input: buildBuybackEvInput(), calculatedAt: BUYBACK_EV_TEST_OBSERVED_AT });
  assert.equal(calculation.status, "available");
  assert.deepEqual(calculation.grossEvMoney, { minorUnits: 8_500, currency: "USD" });
  assert.deepEqual(calculation.evDollars, { minorUnits: -1_500, currency: "USD" });
  assert.equal(calculation.grossReturnBasisPoints, 8_500);
  assert.equal(calculation.evPercentBasisPoints, -1_500);
  const confidence = evaluatePackScoutBuybackEvConfidenceV1(calculation.confidenceInput);
  assert.equal(confidence.status, "available");
  assert.deepEqual(confidence.confidence, { policyVersion: domain.PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 10_000, band: "high", limitationCodes: [] });
});

test("neutral replay preserves available and unavailable canonical results without mutating evidence", () => {
  for (const input of [buildBuybackEvInput(), { ...buildBuybackEvInput(), vendorReportedEv: 20_000 }]) {
    const request = { input, calculatedAt: BUYBACK_EV_TEST_OBSERVED_AT };
    const captured = structuredClone(request);
    const neutral = domain.calculatePackScoutBuybackAdjustedEvV1(request);
    const existing = publicServices.calculatePackScoutBuybackAdjustedEvV1(request);
    assert.deepEqual(neutral, existing);
    assert.deepEqual(domain.packScoutBuybackEvProtectedCalculationResultV1Schema.parse(neutral), neutral);
    assert.deepEqual(request, captured);
    if ("vendorReportedEv" in input) {
      assert.equal(neutral.status, "unavailable");
      assert.equal(neutral.grossEvMoney, null);
      assert.equal(neutral.evDollars, null);
      assert.equal(neutral.grossReturnBasisPoints, null);
      assert.equal(neutral.evPercentBasisPoints, null);
    } else {
      assert.equal(neutral.status, "available");
      const evaluation = domain.evaluatePackScoutBuybackEvConfidenceV1(neutral.confidenceInput);
      assert.deepEqual(evaluation, publicServices.evaluatePackScoutBuybackEvConfidenceV1(neutral.confidenceInput));
      assert.deepEqual(domain.packScoutBuybackEvConfidenceEvaluationV1Schema.parse(evaluation), evaluation);
    }
  }
});

test("neutral and service callers retain the same stable configuration error class", () => {
  for (const calculate of [domain.calculatePackScoutBuybackAdjustedEvV1, publicServices.calculatePackScoutBuybackAdjustedEvV1]) {
    assert.throws(() => calculate({ input: buildBuybackEvInput(), calculatedAt: "not-a-clock" }), (error: unknown) => {
      assert.ok(error instanceof calculator.PackScoutBuybackAdjustedEvConfigurationError);
      assert.equal(error.code, "INVALID_CALCULATED_AT");
      assert.equal(error.message, "PackScout buyback-adjusted EV requires a canonical UTC millisecond calculation timestamp.");
      return true;
    });
  }
});
