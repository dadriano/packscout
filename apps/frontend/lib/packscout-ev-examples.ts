import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  packScoutPublicEvV3Schema,
  type PackScoutPublicEvV3,
  type PublicBuybackSummaryV3,
  type PublicRepackSummaryV3,
} from "@packscout/contracts";
import {
  formatGrossEvPercent,
  formatMoneyMinorUnits,
  presentBuybackSummaryV3,
  presentPackScoutEvV3,
  type PackScoutEvV3Presentation,
} from "./packscout-ev-presentation";

/**
 * The approved PackScout EV worked examples (task buyback-adjusted-ev/011).
 *
 * Every example is production-side data built as a real contract-parsed
 * public estimate and rendered through the one shared presentation boundary
 * (`presentPackScoutEvV3` and its formatters). Education therefore shows the
 * exact strings the catalog would show for the same values — the displayed
 * numbers derive from the versioned formulas and can never drift into
 * separately maintained hard-coded copy.
 *
 * The examples are hypothetical illustrations only; the fixed observation
 * time exists to satisfy the strict public contract and is never rendered.
 */

const EXAMPLE_OBSERVED_AT = "2026-01-01T12:00:00.000Z" as const;
/** Canonical expiry: exactly 60 minutes after the observation time. */
const EXAMPLE_EXPIRES_AT = "2026-01-01T13:00:00.000Z" as const;

export const PACKSCOUT_EV_WORKED_EXAMPLE_IDS = [
  "canonical_buyback",
  "positive_above_break_even",
  "neutral_break_even",
  "negative_below_break_even",
  "valid_zero_payout",
  "unavailable_no_buyback",
] as const;

export type PackScoutEvWorkedExampleId =
  (typeof PACKSCOUT_EV_WORKED_EXAMPLE_IDS)[number];

export type PackScoutEvExampleRow = Readonly<{
  label: string;
  value: string;
}>;

export type PackScoutEvWorkedExample = Readonly<{
  id: PackScoutEvWorkedExampleId;
  title: string;
  /** The platform-documented scenario, in words. */
  narrative: string;
  /** Scenario facts (stated value, buyback terms) rendered via shared formatters. */
  inputRows: readonly PackScoutEvExampleRow[];
  /** The metrics PackScout would show, straight from the presentation boundary. */
  metricRows: readonly PackScoutEvExampleRow[];
  /** Why the result reads the way it does, composed from presentation values. */
  outcomeNote: string;
  /** The full shared presentation, kept for drift tests and accessible help. */
  presentation: PackScoutEvV3Presentation;
}>;

/** The 100% break-even Gross EV % rendered exactly as the catalog renders it. */
export const BREAK_EVEN_GROSS_EV_PERCENT_LABEL = formatGrossEvPercent(10_000);

// --- contract-parsed example inputs -----------------------------------------

type ExampleUsd = Readonly<{ minorUnits: number; currency: "USD" }>;

function usd(minorUnits: number): ExampleUsd {
  return { minorUnits, currency: "USD" };
}

function usdLabel(minorUnits: number): string {
  return formatMoneyMinorUnits(usd(minorUnits));
}

type PublicPrice = PublicRepackSummaryV3["price"];

function examplePrice(minorUnits: number): PublicPrice {
  const money = usd(minorUnits);
  return {
    displayMoney: money,
    usdComparison: { status: "available", value: money },
  };
}

/**
 * A documented uniform buyback rate applied to a stated-value amount. The
 * multiplication happens here — the example payout is derived, never typed.
 */
function uniformBuybackPayoutMinorUnits(
  statedMinorUnits: number,
  rateBasisPoints: number,
): number {
  const product = statedMinorUnits * rateBasisPoints;
  if (!Number.isSafeInteger(product) || product % 10_000 !== 0) {
    throw new Error(
      "PackScout worked examples must produce exact minor-unit payouts.",
    );
  }
  return product / 10_000;
}

/** Half-up rational rounding, matching the versioned calculation contract. */
function halfUpReturnBasisPoints(
  grossMinorUnits: number,
  priceMinorUnits: number,
): number {
  return Number(
    (BigInt(grossMinorUnits) * 10_000n * 2n + BigInt(priceMinorUnits)) /
      (BigInt(priceMinorUnits) * 2n),
  );
}

function exampleCurrentEstimate(
  grossMinorUnits: number,
  priceMinorUnits: number,
): Readonly<{ estimate: PackScoutPublicEvV3; evPercentBasisPoints: number }> {
  const grossReturnBasisPoints = halfUpReturnBasisPoints(
    grossMinorUnits,
    priceMinorUnits,
  );
  const evPercentBasisPoints = grossReturnBasisPoints - 10_000;
  const estimate = packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: {
      grossEvMoney: usd(grossMinorUnits),
      grossReturnBasisPoints,
      evDollars: usd(grossMinorUnits - priceMinorUnits),
      evPercentBasisPoints,
    },
    confidence: {
      policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      scoreBasisPoints: 10_000,
      band: "high",
      limitationCodes: [],
    },
    calculatedAt: EXAMPLE_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: EXAMPLE_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    expiresAt: EXAMPLE_EXPIRES_AT,
  });
  return { estimate, evPercentBasisPoints };
}

function exampleUnavailableEstimate(
  reason: "BUYBACK_UNAVAILABLE",
): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: EXAMPLE_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: EXAMPLE_OBSERVED_AT },
    reason,
  });
}

function presentExample(
  estimate: PackScoutPublicEvV3,
  priceMinorUnits: number,
): PackScoutEvV3Presentation {
  return presentPackScoutEvV3({
    estimate,
    price: examplePrice(priceMinorUnits),
    availability: "available",
  });
}

// --- shared row and note composition -----------------------------------------

function buybackSummaryRow(
  buyback: PublicBuybackSummaryV3,
): PackScoutEvExampleRow {
  const summary = presentBuybackSummaryV3(buyback);
  return Object.freeze({ label: summary.label, value: summary.displayValue });
}

function uniformBuybackRateLabel(rateBasisPoints: number): string {
  return presentBuybackSummaryV3({ kind: "uniform_rate", rateBasisPoints })
    .displayValue;
}

const STATED_OUTCOME_EV_LABEL = "Stated Outcome EV" as const;

function statedOutcomeEvRow(statedMinorUnits: number): PackScoutEvExampleRow {
  return Object.freeze({
    label: STATED_OUTCOME_EV_LABEL,
    value: usdLabel(statedMinorUnits),
  });
}

function metricRows(
  presentation: PackScoutEvV3Presentation,
): readonly PackScoutEvExampleRow[] {
  return Object.freeze(
    [
      presentation.packPrice,
      presentation.grossEvDollars,
      presentation.grossEvPercent,
      presentation.evDollars,
      presentation.evPercent,
    ].map((metric) =>
      Object.freeze({ label: metric.label, value: metric.displayValue }),
    ),
  );
}

const PERCENTAGE_POINTS_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function percentagePointsLabel(basisPoints: number): string {
  return `${PERCENTAGE_POINTS_FORMATTER.format(Math.abs(basisPoints) / 100)} percentage points`;
}

function breakEvenOutcomeNote(
  presentation: PackScoutEvV3Presentation,
  evPercentBasisPoints: number,
): string {
  if (presentation.availability !== "available") {
    throw new Error("Break-even outcome notes require an available example.");
  }
  const grossPercent = presentation.grossEvPercent.displayValue;
  const evDollars = presentation.evDollars.displayValue;
  const evPercent = presentation.evPercent.displayValue;
  if (evPercentBasisPoints === 0) {
    return `Gross EV % is exactly ${BREAK_EVEN_GROSS_EV_PERCENT_LABEL}: the expected guaranteed payout equals Pack Price, EV $ is ${evDollars} and EV % is ${evPercent} — ${presentation.semanticLabel}.`;
  }
  const relation = evPercentBasisPoints > 0 ? "above" : "below";
  return `Gross EV % is ${grossPercent}, ${percentagePointsLabel(evPercentBasisPoints)} ${relation} the ${BREAK_EVEN_GROSS_EV_PERCENT_LABEL} break-even point, so EV $ is ${evDollars} and EV % is ${evPercent} — ${presentation.semanticLabel}.`;
}

// --- the canonical buyback example -------------------------------------------

const CANONICAL_PACK_PRICE_MINOR = 10_000;
const CANONICAL_STATED_OUTCOME_EV_MINOR = 10_000;
const CANONICAL_UNIFORM_BUYBACK_BASIS_POINTS = 8_500;
const CANONICAL_GROSS_MINOR = uniformBuybackPayoutMinorUnits(
  CANONICAL_STATED_OUTCOME_EV_MINOR,
  CANONICAL_UNIFORM_BUYBACK_BASIS_POINTS,
);

/**
 * The one shared buyback explanation, derived end to end: stated Outcome EV
 * and the uniform rate render through the shared formatters and the payout is
 * the computed product, so the sentence cannot disagree with the formula.
 */
export const CANONICAL_BUYBACK_EQUATION = `${usdLabel(CANONICAL_STATED_OUTCOME_EV_MINOR)} stated Outcome EV × ${uniformBuybackRateLabel(CANONICAL_UNIFORM_BUYBACK_BASIS_POINTS)} buyback = ${usdLabel(CANONICAL_GROSS_MINOR)} Gross EV $`;

function buildCanonicalExample(): PackScoutEvWorkedExample {
  const { estimate, evPercentBasisPoints } = exampleCurrentEstimate(
    CANONICAL_GROSS_MINOR,
    CANONICAL_PACK_PRICE_MINOR,
  );
  const presentation = presentExample(estimate, CANONICAL_PACK_PRICE_MINOR);
  return Object.freeze({
    id: "canonical_buyback" as const,
    title: "How buyback converts stated value",
    narrative: `A pack sells for ${usdLabel(CANONICAL_PACK_PRICE_MINOR)} and its probability-weighted stated value is ${usdLabel(CANONICAL_STATED_OUTCOME_EV_MINOR)}. The platform documents one uniform ${uniformBuybackRateLabel(CANONICAL_UNIFORM_BUYBACK_BASIS_POINTS)} buyback rate for every eligible outcome, so ${CANONICAL_BUYBACK_EQUATION}. PackScout compares that ${usdLabel(CANONICAL_GROSS_MINOR)} guaranteed payout — never the ${usdLabel(CANONICAL_STATED_OUTCOME_EV_MINOR)} stated value — with Pack Price.`,
    inputRows: Object.freeze([
      statedOutcomeEvRow(CANONICAL_STATED_OUTCOME_EV_MINOR),
      buybackSummaryRow({
        kind: "uniform_rate",
        rateBasisPoints: CANONICAL_UNIFORM_BUYBACK_BASIS_POINTS,
      }),
    ]),
    metricRows: metricRows(presentation),
    outcomeNote: breakEvenOutcomeNote(presentation, evPercentBasisPoints),
    presentation,
  });
}

// --- companion examples --------------------------------------------------------

function buildUniformRateExample(options: {
  id: PackScoutEvWorkedExampleId;
  title: string;
  packPriceMinor: number;
  statedOutcomeEvMinor: number;
  uniformRateBasisPoints: number;
  narrative: (derived: Readonly<{
    price: string;
    stated: string;
    rate: string;
    gross: string;
  }>) => string;
}): PackScoutEvWorkedExample {
  const grossMinor = uniformBuybackPayoutMinorUnits(
    options.statedOutcomeEvMinor,
    options.uniformRateBasisPoints,
  );
  const { estimate, evPercentBasisPoints } = exampleCurrentEstimate(
    grossMinor,
    options.packPriceMinor,
  );
  const presentation = presentExample(estimate, options.packPriceMinor);
  return Object.freeze({
    id: options.id,
    title: options.title,
    narrative: options.narrative({
      price: usdLabel(options.packPriceMinor),
      stated: usdLabel(options.statedOutcomeEvMinor),
      rate: uniformBuybackRateLabel(options.uniformRateBasisPoints),
      gross: usdLabel(grossMinor),
    }),
    inputRows: Object.freeze([
      statedOutcomeEvRow(options.statedOutcomeEvMinor),
      buybackSummaryRow({
        kind: "uniform_rate",
        rateBasisPoints: options.uniformRateBasisPoints,
      }),
    ]),
    metricRows: metricRows(presentation),
    outcomeNote: breakEvenOutcomeNote(presentation, evPercentBasisPoints),
    presentation,
  });
}

function buildValidZeroExample(): PackScoutEvWorkedExample {
  const packPriceMinor = 2_500;
  const statedOutcomeEvMinor = 4_000;
  const { estimate, evPercentBasisPoints } = exampleCurrentEstimate(
    0,
    packPriceMinor,
  );
  const presentation = presentExample(estimate, packPriceMinor);
  if (presentation.zeroPayoutNote === null || evPercentBasisPoints !== -10_000) {
    throw new Error("The valid-zero example must carry the zero-payout note.");
  }
  return Object.freeze({
    id: "valid_zero_payout" as const,
    title: `A valid ${usdLabel(0)} Gross EV`,
    narrative: `The platform documents buyback terms for a ${usdLabel(packPriceMinor)} pack holding ${usdLabel(statedOutcomeEvMinor)} of stated value, and every supported outcome is explicitly ineligible, so each contributes a ${usdLabel(0)} guaranteed payout. That is documented evidence of a zero payout — not missing evidence — so the estimate stays available instead of Unavailable.`,
    inputRows: Object.freeze([
      statedOutcomeEvRow(statedOutcomeEvMinor),
      Object.freeze({
        label: "Buyback eligibility",
        value: "Documented: no outcome is eligible",
      }),
    ]),
    metricRows: metricRows(presentation),
    outcomeNote: `${presentation.zeroPayoutNote} EV $ is ${presentation.evDollars.displayValue} and EV % is ${presentation.evPercent.displayValue} — ${presentation.semanticLabel}.`,
    presentation,
  });
}

function buildUnavailableExample(): PackScoutEvWorkedExample {
  const packPriceMinor = 10_000;
  const statedOutcomeEvMinor = 10_000;
  const estimate = exampleUnavailableEstimate("BUYBACK_UNAVAILABLE");
  const presentation = presentExample(estimate, packPriceMinor);
  if (presentation.availability !== "unavailable" || !presentation.reasonCopy) {
    throw new Error("The unavailable example must present as unavailable.");
  }
  return Object.freeze({
    id: "unavailable_no_buyback" as const,
    title: "No documented buyback means Unavailable",
    narrative: `The platform lists a ${usdLabel(packPriceMinor)} Pack Price, complete odds, and ${usdLabel(statedOutcomeEvMinor)} of stated value — but no documented buyback terms. Without documented terms there is no guaranteed payout to weight, so PackScout Gross EV is Unavailable rather than the stated value.`,
    inputRows: Object.freeze([
      statedOutcomeEvRow(statedOutcomeEvMinor),
      buybackSummaryRow({ kind: "not_documented" }),
    ]),
    metricRows: metricRows(presentation),
    outcomeNote: `${presentation.reasonCopy} PackScout never assumes a 100% buyback rate, and Unavailable is not zero.`,
    presentation,
  });
}

export const PACKSCOUT_EV_WORKED_EXAMPLES = Object.freeze([
  buildCanonicalExample(),
  buildUniformRateExample({
    id: "positive_above_break_even",
    title: "Above break-even (positive EV)",
    packPriceMinor: 10_000,
    statedOutcomeEvMinor: 12_000,
    uniformRateBasisPoints: 9_000,
    narrative: ({ price, stated, rate, gross }) =>
      `A richer documented pool: ${stated} of probability-weighted stated value with a uniform ${rate} buyback on a ${price} pack. The expected guaranteed payout is ${gross}, which is more than the pack costs.`,
  }),
  buildUniformRateExample({
    id: "neutral_break_even",
    title: "Exactly break-even (neutral EV)",
    packPriceMinor: 10_000,
    statedOutcomeEvMinor: 12_500,
    uniformRateBasisPoints: 8_000,
    narrative: ({ price, stated, rate, gross }) =>
      `A pack can carry ${stated} of stated value and still only break even: at a uniform ${rate} buyback the expected guaranteed payout is ${gross}, exactly the ${price} Pack Price.`,
  }),
  buildUniformRateExample({
    id: "negative_below_break_even",
    title: "Below break-even (negative EV)",
    packPriceMinor: 5_000,
    statedOutcomeEvMinor: 6_000,
    uniformRateBasisPoints: 7_500,
    narrative: ({ price, stated, rate, gross }) =>
      `A cheaper pack with weaker terms: ${stated} of stated value at a uniform ${rate} buyback pays an expected ${gross} against a ${price} Pack Price.`,
  }),
  buildValidZeroExample(),
  buildUnavailableExample(),
] as const satisfies readonly PackScoutEvWorkedExample[]);

const examplesById = new Map<PackScoutEvWorkedExampleId, PackScoutEvWorkedExample>(
  PACKSCOUT_EV_WORKED_EXAMPLES.map((example) => [example.id, example]),
);

export function getPackScoutEvWorkedExample(
  id: PackScoutEvWorkedExampleId,
): PackScoutEvWorkedExample {
  const example = examplesById.get(id);
  if (!example) {
    throw new Error(`Missing PackScout EV worked example for ${id}.`);
  }
  return example;
}
