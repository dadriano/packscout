import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PublicBuyback,
  PublicEstimatedEv,
  PublicTopChaseSummary,
} from "@packscout/contracts";
import {
  formatBasisPoints,
  formatMoneyMinorUnits,
  MetricPresentationConsistencyError,
  metricPresentationConsistencyIssues,
  presentBuyback,
  presentEstimatedEv,
  presentSignedEvPercent,
  presentTopChaseValue,
  type EstimatedEvPresentationInput,
} from "./metric-presentation";

function availableEstimateInput(
  priceMinorUnits: number,
  grossMinorUnits: number,
  evPercentBasisPoints: number,
): EstimatedEvPresentationInput {
  return {
    packPrice: {
      status: "available",
      value: { minorUnits: priceMinorUnits, currency: "USD" },
      reason: null,
      nullRank: 0,
    },
    estimatedEv: {
      grossEv: {
        status: "available",
        value: { minorUnits: grossMinorUnits, currency: "USD" },
        reason: null,
        nullRank: 0,
      },
      evDollars: {
        status: "available",
        value: {
          minorUnits: grossMinorUnits - priceMinorUnits,
          currency: "USD",
        },
        reason: null,
        nullRank: 0,
      },
      evPercent: {
        status: "available",
        value: { basisPoints: evPercentBasisPoints },
        reason: null,
        nullRank: 0,
      },
    },
  };
}

test("formats authoritative minor units and basis points with stable signs", () => {
  assert.equal(
    formatMoneyMinorUnits({ minorUnits: 250_000, currency: "USD" }),
    "$2,500.00",
  );
  assert.equal(
    formatMoneyMinorUnits(
      { minorUnits: 18_455, currency: "USD" },
      { signed: true },
    ),
    "+$184.55",
  );
  assert.equal(
    formatMoneyMinorUnits(
      { minorUnits: -18_455, currency: "USD" },
      { signed: true },
    ),
    "-$184.55",
  );
  assert.equal(
    formatMoneyMinorUnits(
      { minorUnits: 0, currency: "USD" },
      { signed: true },
    ),
    "$0.00",
  );
  assert.equal(
    formatBasisPoints(750, {
      signed: true,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    "+7.50%",
  );
  assert.equal(
    formatBasisPoints(-750, {
      signed: true,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    "-7.50%",
  );
});

test("presents pipeline 107.50% and 92.50% returns as signed EV advantage", () => {
  const positive = presentEstimatedEv(availableEstimateInput(100_00, 107_50, 750));
  const negative = presentEstimatedEv(availableEstimateInput(100_00, 92_50, -750));

  assert.equal(positive.evPercent.displayValue, "+7.50%");
  assert.equal(positive.evDollars.displayValue, "+$7.50");
  assert.equal(positive.semanticState, "positive");
  assert.match(positive.evPercent.accessibleLabel, /Positive/);

  assert.equal(negative.evPercent.displayValue, "-7.50%");
  assert.equal(negative.evDollars.displayValue, "-$7.50");
  assert.equal(negative.semanticState, "negative");
  assert.match(negative.evPercent.accessibleLabel, /Negative/);
});

test("keeps positive, neutral, negative, and unavailable meaning explicit", () => {
  const positive = presentEstimatedEv(availableEstimateInput(100_00, 110_00, 1_000));
  const neutral = presentEstimatedEv(availableEstimateInput(100_00, 100_00, 0));
  const negative = presentEstimatedEv(availableEstimateInput(100_00, 90_00, -1_000));
  const unavailable = presentEstimatedEv({
    packPrice: {
      status: "available",
      value: { minorUnits: 100_00, currency: "USD" },
      reason: null,
      nullRank: 0,
    },
    estimatedEv: {
      grossEv: {
        status: "unavailable",
        value: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
        nullRank: 1,
      },
      evDollars: {
        status: "unavailable",
        value: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
        nullRank: 1,
      },
      evPercent: {
        status: "unavailable",
        value: null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
        nullRank: 1,
      },
    },
  });

  assert.deepEqual(
    [positive, neutral, negative, unavailable].map(
      ({ semanticLabel }) => semanticLabel,
    ),
    ["Positive", "Neutral", "Negative", "Unavailable"],
  );
  assert.equal(neutral.evPercent.displayValue, "0.00%");
  assert.equal(neutral.evDollars.displayValue, "$0.00");
  assert.equal(unavailable.evPercent.displayValue, "Unavailable");
  assert.equal(
    unavailable.reasonCopy,
    "Estimate unavailable: supported evidence is incomplete.",
  );
  assert.doesNotMatch(JSON.stringify(unavailable), /0%|provider-reported/i);
});

test("retains available source values while the derived estimate is unavailable", () => {
  const input: EstimatedEvPresentationInput = {
    packPrice: {
      status: "unavailable",
      value: null,
      reason: "PRICE_UNAVAILABLE",
      nullRank: 1,
    },
    estimatedEv: {
      grossEv: {
        status: "available",
        value: { minorUnits: 85_00, currency: "USD" },
        reason: null,
        nullRank: 0,
      },
      evDollars: {
        status: "unavailable",
        value: null,
        reason: "PRICE_UNAVAILABLE",
        nullRank: 1,
      },
      evPercent: {
        status: "unavailable",
        value: null,
        reason: "PRICE_UNAVAILABLE",
        nullRank: 1,
      },
    },
  };
  const presentation = presentEstimatedEv(input);

  assert.equal(presentation.availability, "unavailable");
  assert.equal(presentation.packPrice.displayValue, "Unavailable");
  assert.equal(presentation.grossEv.displayValue, "$85.00");
  assert.equal(
    presentation.reasonCopy,
    "Estimate unavailable: pack price is unavailable.",
  );
});

test("validates integer EV dollar consistency in development and tests", () => {
  const valid = availableEstimateInput(100_00, 107_50, 750);
  const invalid: EstimatedEvPresentationInput = {
    ...valid,
    estimatedEv: {
      ...valid.estimatedEv,
      evDollars: {
        status: "available",
        value: { minorUnits: 749, currency: "USD" },
        reason: null,
        nullRank: 0,
      },
    },
  };

  assert.deepEqual(metricPresentationConsistencyIssues(valid), []);
  assert.deepEqual(metricPresentationConsistencyIssues(invalid), [
    "EV $ must equal Gross EV minus Pack Price",
  ]);
  assert.throws(
    () => presentEstimatedEv(invalid),
    MetricPresentationConsistencyError,
  );
});

test("presents standalone signed EV and buyback fields without source substitution", () => {
  const median: PublicEstimatedEv["evPercent"] = {
    status: "available",
    value: { basisPoints: 180 },
    reason: null,
    nullRank: 0,
  };
  const buyback: PublicBuyback = {
    status: "available",
    value: { basisPoints: 9_300, sourceKind: "derived" },
    reason: null,
    nullRank: 0,
  };
  const unavailableBuyback: PublicBuyback = {
    status: "unavailable",
    value: null,
    reason: "BUYBACK_UNAVAILABLE",
    nullRank: 1,
  };

  assert.equal(presentSignedEvPercent(median).displayValue, "+1.80%");
  assert.equal(presentBuyback(buyback).displayValue, "93%");
  assert.equal(presentBuyback(unavailableBuyback).displayValue, "Unavailable");
  assert.equal(
    presentBuyback(unavailableBuyback).accessibleLabel,
    "Buyback %: Unavailable. Buyback unavailable: supported coverage is not available.",
  );
});

test("keeps top-chase representative value separate and truthfully unavailable", () => {
  const available: PublicTopChaseSummary = {
    status: "available",
    value: {
      publicChaseId: "10000000-0000-5000-8000-000000000001",
      name: "Celestial Nexus",
      displayMoney: { minorUnits: 8_500_000, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: 8_500_000, currency: "USD" },
        reason: null,
        nullRank: 0,
      },
      primaryImage: null,
    },
    reason: null,
    nullRank: 0,
  };
  const unsupported: PublicTopChaseSummary = {
    ...available,
    value: {
      ...available.value,
      displayMoney: { minorUnits: 8_500_000, currency: "CREDITS" },
      usdComparison: {
        status: "unavailable",
        value: null,
        reason: "CURRENCY_UNSUPPORTED",
        nullRank: 1,
      },
    },
  };

  assert.equal(presentTopChaseValue(available).displayValue, "$85,000.00");
  assert.equal(presentTopChaseValue(unsupported).displayValue, "Unavailable");
  assert.equal(
    presentTopChaseValue(unsupported).accessibleLabel,
    "Top Chase Value: Unavailable. Estimate unavailable: currency is not supported.",
  );
});

test("presentation input is limited to public comparison fields", () => {
  const inputKeys = Object.keys(availableEstimateInput(100_00, 107_50, 750));
  assert.deepEqual(inputKeys, ["packPrice", "estimatedEv"]);

  const forbiddenTerms = /net.?ev|fees|shipping|provider.?reported|probabilit/i;
  assert.doesNotMatch(
    JSON.stringify(presentEstimatedEv(availableEstimateInput(100_00, 107_50, 750))),
    forbiddenTerms,
  );

});
