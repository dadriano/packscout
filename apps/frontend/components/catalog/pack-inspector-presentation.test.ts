import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DataReleaseMetadata,
  PackScoutEv,
  PublicRepackChase,
  PublicRepackSummary,
} from "@packscout/contracts";
import {
  formatPublicTimestamp,
  presentEstimateCoverage,
  presentEstimateTiming,
  presentTopChase,
  presentVendorReportedObservation,
} from "./pack-inspector-presentation";

const metadata = {
  dataAsOf: "2026-08-11T12:00:00Z",
} as DataReleaseMetadata;

function estimate(calculatedAt: string | null): PackScoutEv {
  return calculatedAt === null
    ? {
        status: "unavailable",
        metrics: null,
        confidence: null,
        modelVersion: "packscout-ev-v2",
        confidencePolicyVersion: "confidence-v1",
        dataAsOf: null,
        calculatedAt: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
      }
    : {
        status: "available",
        metrics: {
          grossEv: { minorUnits: 108_00, currency: "USD" },
          grossReturnBasisPoints: 10_800,
          evDollars: { minorUnits: 8_00, currency: "USD" },
          evPercentBasisPoints: 800,
        },
        confidence: {
          scoreBasisPoints: 8_500,
          band: "high",
          limitationCodes: [],
        },
        modelVersion: "packscout-ev-v2",
        confidencePolicyVersion: "confidence-v1",
        dataAsOf: "2026-08-10T10:00:00Z",
        calculatedAt,
      };
}

function contentSummary(
  evidenceCompleteness: PublicRepackSummary["contentSummary"]["evidenceCompleteness"],
  probabilityCoverageBasisPoints: number | null,
): PublicRepackSummary["contentSummary"] {
  return {
    knownCollectibleCount: 10,
    chaseCount: 2,
    categoryCount: 1,
    collectibleTypeCount: 1,
    evidenceCompleteness,
    probabilityCoverageBasisPoints,
  };
}

function topChase(primaryImage: PublicRepackChase["collectible"]["primaryImage"]): PublicRepackChase {
  return {
    publicRepackId: "00000000-0000-5000-8000-000000000301",
    publicCollectibleId: "00000000-0000-5000-8000-000000000201",
    role: "top_chase",
    evidenceKinds: ["vendor_inventory"],
    probabilityBasisPoints: 50,
    collectible: {
      publicCollectibleId: "00000000-0000-5000-8000-000000000201",
      name: "Celestial Nexus",
      collectibleType: "card",
      publicCategoryIds: [],
      primaryImage,
      valuation: {
        displayMoney: { minorUnits: 8_500_000, currency: "USD" },
        usdComparison: {
          status: "available",
          value: { minorUnits: 8_500_000, currency: "USD" },
        },
        valuationType: "market_estimate",
        observedAt: "2026-08-11T12:00:00Z",
      },
    },
    matchConfidence: { scoreBasisPoints: 9_500, band: "high" },
    observedAt: "2026-08-11T12:00:00Z",
    displayOrder: 0,
  };
}

test("keeps PackScout calculation time distinct from release data time", () => {
  const timing = presentEstimateTiming(
    estimate("2026-08-10T10:30:00Z"),
    metadata,
  );

  assert.equal(
    timing.calculatedLabel,
    "EV estimate calculated Aug 10, 2026, 10:30 AM UTC",
  );
  assert.equal(
    timing.releaseLabel,
    "Repack data as of Aug 11, 2026, 12:00 PM UTC",
  );
  assert.notEqual(timing.calculatedAt, timing.dataAsOf);
  assert.equal(
    formatPublicTimestamp("2026-08-11T12:00:00Z"),
    "Aug 11, 2026, 12:00 PM UTC",
  );
});

test("states complete, partial, unquantified, and unknown evidence coverage plainly", () => {
  assert.equal(
    presentEstimateCoverage(contentSummary("complete", 10_000)),
    "Supported evidence covers 100% of modeled outcomes.",
  );
  assert.equal(
    presentEstimateCoverage(contentSummary("partial", 7_350)),
    "Supported evidence covers 73.5% of modeled outcomes; some evidence is incomplete.",
  );
  assert.equal(
    presentEstimateCoverage(contentSummary("partial", null)),
    "Supported evidence coverage is not quantified.",
  );
  assert.equal(
    presentEstimateCoverage(contentSummary("unknown", null)),
    "Supported evidence coverage is unavailable.",
  );
});

test("presents chase evidence and chase-match confidence separately", () => {
  const withImage = topChase({
    url: "https://images.example/celestial-nexus.png",
    alt: "Celestial Nexus collectible",
  });
  const pictured = presentTopChase(withImage);
  const textOnly = presentTopChase(topChase(null));

  assert.equal(pictured.availability, "available");
  if (pictured.availability !== "available" || textOnly.availability !== "available") return;
  assert.equal(pictured.valueAvailability, "available");
  assert.equal(pictured.displayValue, "$85,000.00");
  assert.equal(pictured.image?.alt, "Celestial Nexus collectible");
  assert.equal(pictured.evidenceLabel, "Confirmed by vendor evidence");
  assert.equal(pictured.matchConfidenceLabel, "high chase-match confidence");
  assert.equal(textOnly.image, null);
  assert.equal(textOnly.name, pictured.name);
});

test("keeps exact chase identity and evidence when only valuation is unavailable", () => {
  const chase = topChase({
    url: "https://images.example/celestial-nexus.png",
    alt: "Celestial Nexus collectible",
  });
  const withoutValuation: PublicRepackChase = {
    ...chase,
    collectible: {
      ...chase.collectible,
      valuation: null,
    },
  };

  const presentation = presentTopChase(
    withoutValuation,
    "Desired chase match",
    "Desired Chase Value",
  );

  assert.equal(presentation.availability, "available");
  if (presentation.availability !== "available") return;
  assert.equal(presentation.valueAvailability, "unavailable");
  assert.equal(presentation.name, "Celestial Nexus");
  assert.equal(presentation.displayValue, "Unavailable");
  assert.equal(presentation.evidenceLabel, "Confirmed by vendor evidence");
  assert.equal(presentation.matchConfidenceLabel, "high chase-match confidence");
  assert.equal(presentation.image?.alt, "Celestial Nexus collectible");
  assert.match(presentation.accessibleLabel, /desired chase match: celestial nexus/i);
  assert.match(presentation.accessibleLabel, /Desired Chase Value: Unavailable/);
});

test("uses stable unavailable copy and never invents a chase value", () => {
  const presentation = presentTopChase(null);

  assert.deepEqual(presentation, {
    availability: "unavailable",
    name: "Top chase unavailable",
    displayValue: "Unavailable",
    accessibleLabel: "Top chase unavailable. Collectible value unavailable.",
    image: null,
    reasonCopy: "Collectible value unavailable.",
  });
  assert.doesNotMatch(JSON.stringify(presentation), /\$0|0\.00/);
});

test("names a missing PackScout calculation date without borrowing release time", () => {
  const timing = presentEstimateTiming(estimate(null), metadata);

  assert.equal(timing.calculatedLabel, "Estimate date unavailable");
  assert.equal(timing.calculatedAt, null);
  assert.match(timing.releaseLabel, /^Repack data as of /);
});

test("labels vendor-reported EV observation time only when supplied", () => {
  assert.deepEqual(
    presentVendorReportedObservation("2026-08-11T12:00:00Z"),
    {
      label: "Vendor EV observed Aug 11, 2026, 12:00 PM UTC",
      observedAt: "2026-08-11T12:00:00Z",
    },
  );
  assert.equal(presentVendorReportedObservation(null), null);
});
