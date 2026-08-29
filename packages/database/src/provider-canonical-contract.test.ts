import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confidenceBand,
  normalizeEvidenceKinds,
  normalizeJsonObject,
  normalizeMoneyDecimal,
  normalizeRateDecimal,
  ProviderCanonicalInputError,
  requireCurrency,
} from "./provider-canonical-contract.ts";

test("canonical decimals remain base-10 strings and enforce database bounds", () => {
  assert.equal(
    normalizeMoneyDecimal("12345678901234567890.123456789012345678"),
    "12345678901234567890.123456789012345678",
  );
  assert.equal(normalizeMoneyDecimal("001.2300"), "1.23");
  assert.equal(normalizeRateDecimal("0.123456789012345678"), "0.123456789012345678");
  assert.equal(normalizeRateDecimal("1.000000000000000000"), "1");
  assert.throws(
    () => normalizeMoneyDecimal("1e3"),
    ProviderCanonicalInputError,
  );
  assert.throws(
    () => normalizeMoneyDecimal("123456789012345678901"),
    ProviderCanonicalInputError,
  );
  assert.throws(() => normalizeRateDecimal("1.000000000000000001"), /between 0 and 1/);
});

test("canonical bounded values are normalized without changing array order in JSON", () => {
  assert.equal(requireCurrency("USD"), "USD");
  assert.equal(
    requireCurrency("0x1234567890abcdef1234567890ABCDEF12345678"),
    "0x1234567890abcdef1234567890ABCDEF12345678",
  );
  assert.deepEqual(
    normalizeEvidenceKinds(["vendor_odds", "name_only", "vendor_odds"]),
    ["name_only", "vendor_odds"],
  );
  assert.deepEqual(
    normalizeJsonObject({ z: [2, 1], a: { y: true, x: "value" } }, "attributes"),
    { a: { x: "value", y: true }, z: [2, 1] },
  );
  assert.equal(confidenceBand(4_999), "low");
  assert.equal(confidenceBand(5_000), "medium");
  assert.equal(confidenceBand(8_000), "high");
});
