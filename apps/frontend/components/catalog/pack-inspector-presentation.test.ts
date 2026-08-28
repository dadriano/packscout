import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PublicRepackChase,
  PublicRepackSummaryV3,
} from "@packscout/contracts";
import {
  presentEstimateCoverage,
  presentTopChase,
} from "./pack-inspector-presentation";

function contentSummary(
  evidenceCompleteness: PublicRepackSummaryV3["contentSummary"]["evidenceCompleteness"],
  probabilityCoverageBasisPoints: number | null,
): PublicRepackSummaryV3["contentSummary"] {
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

test("presents chase evidence and chase-match confidence separately from EV", () => {
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
  assert.doesNotMatch(pictured.matchConfidenceLabel, /EV/);
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
