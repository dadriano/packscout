import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalProjectionValidationError,
  normalizeCanonicalMoney,
} from "./canonical-projection-validation.ts";

test("canonical money rounds decimal half ties without binary floating-point drift", () => {
  assert.deepEqual(normalizeCanonicalMoney(
    { amount: 1.005, currency: "USD" },
    "price",
  ), {
    amountMinor: 101,
    currency: "USD",
    minorUnitExponent: 2,
  });
  assert.equal(
    normalizeCanonicalMoney({ amount: 2.675, currency: "USD" }, "price")
      ?.amountMinor,
    268,
  );
  assert.equal(
    normalizeCanonicalMoney({ amount: 0.0000005, currency: "USDC" }, "price")
      ?.amountMinor,
    1,
  );
  assert.equal(
    normalizeCanonicalMoney({ amount: 0.0000004, currency: "USDC" }, "price")
      ?.amountMinor,
    0,
  );
});

test("canonical money rejects unsupported, negative, and unsafe amounts", () => {
  for (const value of [
    { amount: 1, currency: "EUR" },
    { amount: -0.01, currency: "USD" },
    { amount: Number.MAX_VALUE, currency: "USDC" },
  ]) {
    assert.throws(
      () => normalizeCanonicalMoney(value, "price"),
      (error: unknown) =>
        error instanceof CanonicalProjectionValidationError &&
        error.code === "INVALID_MONEY",
    );
  }
});
