import assert from "node:assert/strict";
import { test } from "node:test";
import { displayedEvMedianSourcesV3Schema } from "./displayed-ev-median-sources-v3.ts";

test("median provenance distinguishes independent, reported, mixed, and unavailable sources", () => {
  for (const overall of ["packscout", "provider_reported", "mixed", null]) {
    assert.equal(displayedEvMedianSourcesV3Schema.safeParse({ overall,
      vendors: [{ key: "phygitals", source: overall }], categories: [] }).success, true);
  }
});

test("median provenance rejects unknown source claims and ambiguous group mappings", () => {
  const valid = { overall: "mixed", vendors: [{ key: "phygitals", source: "provider_reported" }], categories: [] };
  assert.equal(displayedEvMedianSourcesV3Schema.safeParse({ ...valid, overall: "verified" }).success, false);
  assert.equal(displayedEvMedianSourcesV3Schema.safeParse({ ...valid, vendors: [...valid.vendors, ...valid.vendors] }).success, false);
  assert.equal(displayedEvMedianSourcesV3Schema.safeParse({ ...valid, fabricatedConfidence: 100 }).success, false);
  assert.equal(displayedEvMedianSourcesV3Schema.safeParse({ overall: "packscout" }).success, false);
});
