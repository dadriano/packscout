import assert from "node:assert/strict";
import { test } from "node:test";
import { buildV3UnavailableEv, buildV3ViewDetail } from "./packscout-ev-fixtures.test-support";
import { presentGrossEvV3, presentPackScoutEvV3 } from "./packscout-ev-presentation";

test("source-derived Gross EV has platform attribution and no independent confidence claim", () => {
  for (const [vendorKey, vendorDisplayName] of [
    ["phygitals", "Phygitals"], ["collector_crypt", "Collector Crypt"], ["courtyard", "Courtyard"],
  ]) {
    const detail = buildV3ViewDetail({ vendorKey, vendorDisplayName,
      buyback: { kind: "uniform_rate", rateBasisPoints: 9_000 },
      evEstimates: {
        packScout: buildV3UnavailableEv("SOURCE_EVIDENCE_UNAVAILABLE"),
        vendorReported: { status: "available", sourceMoney: { minorUnits: 10_421, currency: "USD" },
          usdComparison: { status: "available", value: { minorUnits: 10_421, currency: "USD" } },
          observedAt: "2026-08-19T10:00:00.000Z" },
      },
    });
    const independent = presentPackScoutEvV3({ estimate: detail.evEstimates.packScout,
      price: detail.price, availability: detail.availability });
    const gross = presentGrossEvV3(detail, independent);
    assert.equal(gross.source, "vendor_reported");
    assert.equal(gross.grossEvDollars.displayValue, "$93.79");
    assert.equal(gross.grossEvPercent.displayValue, "93.79%");
    assert.equal(gross.evDollars.displayValue, "-$6.21");
    assert.equal(gross.evPercent.displayValue, "-6.21%");
    assert.equal(gross.sourceNote, `Calculated from ${vendorDisplayName}-reported EV × buyback.`);
    assert.ok(gross.grossEvDollars.accessibleLabel.includes(vendorDisplayName));
    assert.equal(independent.grossEvDollars.availability, "unavailable");
    assert.equal(independent.evDollars.availability, "unavailable");
    assert.equal(independent.confidence.availability, "unavailable");
  }
});

test("existing independently validated Gross EV remains unchanged", () => {
  const detail = buildV3ViewDetail({ vendorKey: "phygitals" });
  const independent = presentPackScoutEvV3({ estimate: detail.evEstimates.packScout,
    price: detail.price, availability: detail.availability });
  const gross = presentGrossEvV3(detail, independent);
  assert.equal(gross.source, "packscout");
  assert.equal(gross.grossEvDollars, independent.grossEvDollars);
  assert.equal(gross.grossEvPercent, independent.grossEvPercent);
  assert.equal(gross.evDollars, independent.evDollars);
  assert.equal(gross.evPercent, independent.evPercent);
  assert.equal(gross.sourceNote, null);
});

test("platform-derived positive and break-even returns display without relaxing independent EV policy", () => {
  for (const [underlyingMinor, dollars, percent] of [
    [20_000, "+$100.00", "+100.00%"], [10_000, "$0.00", "0.00%"],
  ] as const) {
    const detail = buildV3ViewDetail({ vendorKey: "phygitals",
      buyback: { kind: "uniform_rate", rateBasisPoints: 10_000 },
      evEstimates: {
        packScout: buildV3UnavailableEv("SOURCE_EVIDENCE_UNAVAILABLE"),
        vendorReported: { status: "available", sourceMoney: { minorUnits: underlyingMinor, currency: "USD" },
          usdComparison: { status: "available", value: { minorUnits: underlyingMinor, currency: "USD" } },
          observedAt: "2026-08-19T10:00:00.000Z" },
      },
    });
    const independent = presentPackScoutEvV3({ estimate: detail.evEstimates.packScout,
      price: detail.price, availability: detail.availability });
    const derived = presentGrossEvV3(detail, independent);
    assert.equal(derived.evDollars.displayValue, dollars);
    assert.equal(derived.evPercent.displayValue, percent);
    assert.equal(independent.confidence.availability, "unavailable");
  }
});
