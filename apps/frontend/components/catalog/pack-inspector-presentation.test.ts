import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PublicEstimatedEv,
  PublicTopChaseDetail,
  SnapshotMetadata,
} from "@packscout/contracts";
import {
  formatPublicTimestamp,
  presentEstimateCoverage,
  presentEstimateTiming,
  presentTopChase,
} from "./pack-inspector-presentation";

function available<T>(value: T) {
  return {
    status: "available" as const,
    value,
    reason: null,
    nullRank: 0 as const,
  };
}

test("keeps the estimate calculation time distinct from the catalog snapshot time", () => {
  const timing = presentEstimateTiming(
    { calculatedAt: "2026-08-10T10:30:00Z" },
    { dataAsOf: "2026-08-11T12:00:00Z" } as SnapshotMetadata,
  );

  assert.equal(
    timing.calculatedLabel,
    "Estimate as of Aug 10, 2026, 10:30 AM UTC",
  );
  assert.equal(
    timing.snapshotLabel,
    "Catalog data as of Aug 11, 2026, 12:00 PM UTC",
  );
  assert.notEqual(timing.calculatedAt, timing.dataAsOf);
  assert.equal(
    formatPublicTimestamp("2026-08-11T12:00:00Z"),
    "Aug 11, 2026, 12:00 PM UTC",
  );
});

test("states complete, partial, unquantified, and unknown evidence coverage plainly", () => {
  assert.equal(
    presentEstimateCoverage({
      evidenceCompleteness: "complete",
      probabilityCoverageBasisPoints: 10_000,
    }),
    "Supported evidence covers 100% of modeled outcomes.",
  );
  assert.equal(
    presentEstimateCoverage({
      evidenceCompleteness: "partial",
      probabilityCoverageBasisPoints: 7_350,
    }),
    "Supported evidence covers 73.5% of modeled outcomes; some evidence is incomplete.",
  );
  assert.equal(
    presentEstimateCoverage({
      evidenceCompleteness: "partial",
      probabilityCoverageBasisPoints: null,
    }),
    "Supported evidence coverage is not quantified.",
  );
  assert.equal(
    presentEstimateCoverage({
      evidenceCompleteness: "unknown",
      probabilityCoverageBasisPoints: null,
    }),
    "Supported evidence coverage is unavailable.",
  );
});

test("presents available top-chase evidence with image and text-only parity", () => {
  const withImage: PublicTopChaseDetail = available({
    publicChaseId: "10000000-0000-5000-8000-000000000001",
    name: "Celestial Nexus",
    displayMoney: { minorUnits: 8_500_000, currency: "USD" },
    usdComparison: available({ minorUnits: 8_500_000, currency: "USD" }),
    primaryImage: {
      url: "https://images.example/celestial-nexus.png",
      alt: "Celestial Nexus collectible",
    },
    evidenceKind: "canonical_asset_value",
    observedAt: "2026-08-11T12:00:00Z",
  });
  const textOnly: PublicTopChaseDetail = available({
    ...withImage.value,
    primaryImage: null,
  });

  const pictured = presentTopChase(withImage);
  const unpictured = presentTopChase(textOnly);

  assert.equal(pictured.availability, "available");
  assert.equal(pictured.displayValue, "$85,000.00");
  assert.equal(pictured.image?.alt, "Celestial Nexus collectible");
  assert.equal(unpictured.availability, "available");
  assert.equal(unpictured.image, null);
  assert.equal(unpictured.name, pictured.name);
  assert.equal(unpictured.displayValue, pictured.displayValue);
});

test("uses stable unavailable copy and never invents a chase value", () => {
  const topChase: PublicTopChaseDetail = {
    status: "unavailable",
    value: null,
    reason: "CHASE_UNAVAILABLE",
    nullRank: 1,
  };
  const presentation = presentTopChase(topChase);

  assert.deepEqual(presentation, {
    availability: "unavailable",
    name: "Top chase unavailable",
    displayValue: "Unavailable",
    accessibleLabel: "Top chase unavailable. Top chase value unavailable.",
    image: null,
    reasonCopy: "Top chase value unavailable.",
  });
  assert.doesNotMatch(JSON.stringify(presentation), /\$0|0\.00/);
});

test("estimate timing names a missing calculation date without borrowing the snapshot time", () => {
  const timing = presentEstimateTiming(
    { calculatedAt: null } as Pick<PublicEstimatedEv, "calculatedAt">,
    { dataAsOf: "2026-08-11T12:00:00Z" } as SnapshotMetadata,
  );

  assert.equal(timing.calculatedLabel, "Estimate date unavailable");
  assert.equal(timing.calculatedAt, null);
  assert.match(timing.snapshotLabel, /^Catalog data as of /);
});
