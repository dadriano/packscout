import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  publicPriceFilterSchema,
} from "./public-repacks-query.ts";

test("the public repack price contract spans $1 through $12,000", () => {
  assert.equal(PUBLIC_REPACK_PRICE_MIN_MINOR, 100);
  assert.equal(PUBLIC_REPACK_PRICE_MAX_MINOR, 1_200_000);
  assert.equal(publicPriceFilterSchema.safeParse({
    mode: "full",
    minMinor: 100,
    maxMinor: 1_200_000,
  }).success, true);
  assert.equal(publicPriceFilterSchema.safeParse({
    mode: "full",
    minMinor: 1_000,
    maxMinor: 1_200_000,
  }).success, false);
});

test("the public repack price contract rejects out-of-range and inverted bounds", () => {
  const invalid = [
    { mode: "narrowed", minMinor: 99, maxMinor: 10_000 },
    { mode: "narrowed", minMinor: 100, maxMinor: 1_200_001 },
    { mode: "narrowed", minMinor: 10_000, maxMinor: 9_999 },
    { mode: "narrowed", minMinor: 100, maxMinor: 1_200_000 },
  ];
  for (const price of invalid) {
    assert.equal(publicPriceFilterSchema.safeParse(price).success, false);
  }
  assert.equal(publicPriceFilterSchema.safeParse({
    mode: "narrowed",
    minMinor: 100,
    maxMinor: 10_000,
  }).success, true);
});
