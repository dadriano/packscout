import assert from "node:assert/strict";
import { test } from "node:test";
import * as publicDomain from "./index.ts";
import * as values from "./public-ev-values-v1.ts";

test("the contracts entry exposes one public EV value domain shared by existing release consumers", () => {
  const existingNames = {
    PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V1: "PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3",
    packScoutPublicEvPolicyVersionV1Schema: "packScoutPublicEvPolicyVersionV3Schema",
    PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V1: "PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3",
    packScoutPublicEvMetricsAreNonpositiveV1: "packScoutPublicEvMetricsAreNonpositiveV3",
    PUBLIC_EV_PROTECTED_FIELD_KEYS_V1: "DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS",
    containsProtectedEvPublicationKeyV1: "containsProtectedEvPublicationKeyV3",
    packScoutPublicEvMetricsV1Schema: "packScoutPublicEvMetricsV3Schema",
    PUBLIC_BUYBACK_SUMMARY_KINDS_V1: "PUBLIC_BUYBACK_SUMMARY_KINDS_V3",
    publicBuybackSummaryV1Schema: "publicBuybackSummaryV3Schema",
    vendorReportedEvV1Schema: "vendorReportedEvV3Schema",
  } as const;
  for (const [name, existingName] of Object.entries(existingNames)) {
    assert.strictEqual(Reflect.get(publicDomain, name), Reflect.get(values, name), name);
    assert.strictEqual(Reflect.get(publicDomain, existingName), Reflect.get(values, name), existingName);
  }
});

test("neutral public values preserve canonical metrics, bounded summaries, and independent vendor money", () => {
  const metrics = {
    grossEvMoney: { minorUnits: 8_500, currency: "USD" },
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" },
    evPercentBasisPoints: -1_500,
  };
  assert.deepEqual(values.packScoutPublicEvMetricsV1Schema.parse(metrics), metrics);
  for (const kind of values.PUBLIC_BUYBACK_SUMMARY_KINDS_V1) {
    const summary = kind === "uniform_rate" ? { kind, rateBasisPoints: 8_500 } : { kind };
    assert.deepEqual(values.publicBuybackSummaryV1Schema.parse(summary), summary);
  }
  const vendor = {
    status: "available",
    sourceMoney: { minorUnits: 20_000, currency: "USD" },
    usdComparison: { status: "available", value: { minorUnits: 20_000, currency: "USD" } },
    observedAt: "2026-08-19T18:00:00.000Z",
  };
  assert.deepEqual(values.vendorReportedEvV1Schema.parse(vendor), vendor);
  const unavailable = { status: "unavailable", sourceMoney: null, usdComparison: null, observedAt: null, reason: "NOT_REPORTED" };
  assert.deepEqual(values.vendorReportedEvV1Schema.parse(unavailable), unavailable);
  for (const [candidate, reason] of [
    [{ ...metrics, evPercentBasisPoints: 0 }, "data_release_v3.ev_percent_inconsistent"],
    [{ ...metrics, grossReturnBasisPoints: 10_001, evPercentBasisPoints: 1 }, "data_release_v3.positive_public_ev_forbidden"],
  ] as const) {
    const parsed = values.packScoutPublicEvMetricsV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.message === reason));
  }
  const mismatch = values.vendorReportedEvV1Schema.safeParse({ ...vendor, sourceMoney: { minorUnits: 20_001, currency: "USD" } });
  assert.equal(mismatch.success, false);
  if (!mismatch.success) assert.equal(mismatch.error.issues[0]?.message, "data_release_v3.vendor_usd_evidence_mismatch");
});

test("neutral public values retain strict protected-field rejection without treating public price as private", () => {
  for (const key of [...publicDomain.PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1.flatMap((path) => path.split(".")), "underlyingOutcomeEvMinorUnits", "drawMultiplier", "providerResponse", "rawPayload"]) {
    assert.equal(values.containsProtectedEvPublicationKeyV1({ nested: [{ [key]: "private-marker" }] }), true, key);
  }
  assert.equal(values.containsProtectedEvPublicationKeyV1({ packPriceMinorUnits: 10_000, price: { minorUnits: 10_000, currency: "USD" } }), false);
  assert.equal(values.publicBuybackSummaryV1Schema.safeParse({ kind: "varies_by_outcome", rateBasisPoints: 8_500 }).success, false);
  assert.equal(values.publicBuybackSummaryV1Schema.safeParse({ kind: "uniform_rate", rateBasisPoints: 8_500, rawPayload: {} }).success, false);
});
