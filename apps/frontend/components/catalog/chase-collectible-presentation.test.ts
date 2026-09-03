import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicCollectibleDisplay } from "@packscout/contracts";
import {
  presentChaseCollectible,
  presentChaseInspectStatus,
  presentChasePackListSummary,
  presentCollectibleValuation,
} from "./chase-collectible-presentation";

const collectible: PublicCollectibleDisplay = {
  publicCollectibleId: "00000000-0000-5000-8000-000000000201",
  name: "Celestial Nexus",
  collectibleType: "card",
  publicCategoryIds: [],
  primaryImage: {
    url: "https://images.example/celestial-nexus.png",
    alt: "Celestial Nexus collectible",
  },
  valuation: {
    displayMoney: { minorUnits: 8_500_000, currency: "USD" },
    usdComparison: {
      status: "available",
      value: { minorUnits: 8_500_000, currency: "USD" },
    },
    valuationType: "market_estimate",
    observedAt: "2026-08-11T12:00:00Z",
  },
};

test("presents chase identity, image, and market value together", () => {
  const presented = presentChaseCollectible({
    collectible,
    identity: {
      name: "Celestial Nexus",
      collectibleType: "card",
      year: 2024,
      brand: "Example",
      setOrSeries: "Prism",
      cardNumber: "12",
      referenceNumber: null,
      grade: "10",
      grader: "PSA",
    },
  });

  assert.equal(presented.name, "Celestial Nexus");
  assert.match(presented.identity, /PSA 10/);
  assert.equal(presented.image?.alt, "Celestial Nexus collectible");
  assert.equal(presented.valuationLabel, "$85,000.00");
  assert.equal(presented.valuationTypeLabel, "Market estimate");
  assert.match(presented.accessibleLabel, /Market value \$85,000\.00/);
});

test("keeps a selected chase identity when valuation is unavailable", () => {
  const presented = presentChaseCollectible({
    collectible: { ...collectible, valuation: null },
  });
  const valuation = presentCollectibleValuation(null);

  assert.equal(presented.name, "Celestial Nexus");
  assert.equal(presented.valuationLabel, "Unavailable");
  assert.equal(presented.valuationTypeLabel, null);
  assert.match(valuation.accessibleLabel, /unavailable/i);
});

test("summarizes matching packs without inventing unseen rows", () => {
  assert.equal(
    presentChasePackListSummary(0, 0),
    "No published packs currently include this chase.",
  );
  assert.equal(presentChasePackListSummary(1, 1), "1 matching pack");
  assert.equal(presentChasePackListSummary(3, 3), "3 matching packs");
  assert.equal(
    presentChasePackListSummary(25, 40),
    "Showing 25 of 40 matching packs",
  );
});

test("states chase inspect loading, missing, and failure plainly", () => {
  assert.equal(presentChaseInspectStatus("loading"), "Loading chase details…");
  assert.equal(
    presentChaseInspectStatus("missing"),
    "This chase is no longer available.",
  );
  assert.equal(
    presentChaseInspectStatus("failed"),
    "Chase details are temporarily unavailable.",
  );
});
