export const EXPECTED_VALUE_ARTICLE_HREF = "/learn/expected-value" as const;

/**
 * Bounded public reasons a metric may be unavailable. The PackScout entries
 * mirror the data_release_v3 public reason vocabulary exactly; the remaining
 * entries cover vendor-reported EV, aggregate medians, price, and chase
 * valuations. Copy never exposes internal evidence.
 */
export type PublicMetricReason =
  | "SOURCE_EVIDENCE_UNAVAILABLE"
  | "PRICE_UNAVAILABLE"
  | "CURRENCY_UNSUPPORTED"
  | "ODDS_UNAVAILABLE"
  | "VALUE_UNAVAILABLE"
  | "BUYBACK_UNAVAILABLE"
  | "SOURCE_DATA_STALE"
  | "CALCULATION_UNAVAILABLE"
  | "ESTIMATE_UNAVAILABLE"
  | "VALUATION_UNAVAILABLE"
  | "NOT_REPORTED";

export const METRIC_TRUST_COPY = Object.freeze({
  estimateLabel: "PackScout Gross EV",
  sourceLine: "PackScout Gross EV — calculated from platform-provided data",
  adviceLine: "Not financial or gambling advice",
  dashboardDisclaimer:
    "PackScout Gross EV — calculated from platform-provided data · Not financial or gambling advice",
  longRunExplanation:
    "EV estimates the average guaranteed buyback payout across many packs. It does not predict what one pack will contain.",
  sourceExplanation:
    "Vendor-reported EV is the vendor’s own number. PackScout shows it separately and never averages or substitutes it into PackScout Gross EV.",
  confidenceExplanation:
    "Confidence measures how solid and recent the evidence behind an estimate is, not how likely a profit is. It drops as source data ages past 60 minutes, while the last-known EV stays visible.",
  unavailableExplanation:
    "Unavailable means a required supported input is missing; PackScout never assumes missing buyback terms. Age alone does not make an estimate unavailable, so the last supported values stay visible with lower confidence.",
});

export const PUBLIC_REASON_COPY = Object.freeze({
  SOURCE_EVIDENCE_UNAVAILABLE:
    "Unavailable: source evidence is incomplete or unsupported.",
  PRICE_UNAVAILABLE: "Unavailable: the public Pack Price is unavailable.",
  CURRENCY_UNSUPPORTED: "Unavailable: the listed currency is not supported.",
  ODDS_UNAVAILABLE: "Unavailable: complete supported odds are unavailable.",
  VALUE_UNAVAILABLE:
    "Unavailable: supported outcome values are unavailable.",
  BUYBACK_UNAVAILABLE:
    "Unavailable: documented buyback terms are unavailable.",
  SOURCE_DATA_STALE:
    "Unavailable: supported source evidence was not retained.",
  CALCULATION_UNAVAILABLE:
    "Unavailable: the calculation could not be completed.",
  ESTIMATE_UNAVAILABLE: "Estimate unavailable.",
  VALUATION_UNAVAILABLE: "Collectible value unavailable.",
  NOT_REPORTED: "The vendor has not reported an EV estimate.",
} satisfies Readonly<Record<PublicMetricReason, string>>);

/** Bounded buyback summaries; a numeric rate is shown only for uniform_rate. */
export const BUYBACK_SUMMARY_COPY = Object.freeze({
  varies_by_outcome: "Varies by outcome",
  fixed_or_final_payout: "Fixed/final payout",
  not_documented: "Not documented",
  unavailable: "Unavailable",
} as const);

export const SOURCE_AGE_COPY = Object.freeze({
  fresh_within_15_minutes: "Source data fresh (within 15 minutes)",
  delayed_over_15_through_30_minutes:
    "Source data delayed (15–30 minutes old)",
  delayed_over_30_through_60_minutes:
    "Source data delayed (30–60 minutes old)",
  delayed_over_60_minutes:
    "Source data over 60 minutes old; last known values retained",
} as const);

export const ESTIMATE_STATUS_COPY = Object.freeze({
  current: "Current estimate",
  last_known: "Last-known estimate",
  sold_out_historical: "Sold out · historical estimate",
  unavailable: "Unavailable",
  simulated: "Simulated data",
  unknownSourceTime: "Source observation time unknown",
} as const);

export type GlossaryFieldKey =
  | "vendor"
  | "category"
  | "repack"
  | "heat"
  | "repackPrice"
  | "grossEv"
  | "grossEvPercent"
  | "evDollars"
  | "evPercent"
  | "evConfidence"
  | "vendorReportedEv"
  | "buybackPercent"
  | "topChase"
  | "topChaseValue"
  | "promoCode"
  | "repackLink";

export type GlossaryDefinition = Readonly<{
  key: GlossaryFieldKey;
  label: string;
  definition: string;
  enabledByDefault: true;
  learnHref?: typeof EXPECTED_VALUE_ARTICLE_HREF;
}>;

export const COMPARISON_GLOSSARY = Object.freeze([
  {
    key: "vendor",
    label: "Vendor",
    definition: "The vendor selling this repack.",
    enabledByDefault: true,
  },
  {
    key: "category",
    label: "Category",
    definition: "The kind of collectibles inside the repack.",
    enabledByDefault: true,
  },
  {
    key: "repack",
    label: "Repack",
    definition: "The vendor’s public name for this repack or gacha listing.",
    enabledByDefault: true,
  },
  {
    key: "heat",
    label: "Heat",
    definition:
      "How busy this repack is right now compared with its own normal pace. Heat is not profit, EV, or a prediction.",
    enabledByDefault: true,
  },
  {
    key: "repackPrice",
    label: "Pack Price",
    definition:
      "The listed price to open one pack, before any discounts or promo codes.",
    enabledByDefault: true,
  },
  {
    key: "grossEv",
    label: "Gross EV $",
    definition:
      "The average guaranteed buyback payout for one pack, weighting each outcome by its odds.",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "grossEvPercent",
    label: "Gross EV %",
    definition:
      "Gross EV $ as a share of Pack Price. 100% means the average buyback pays back the full price.",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evDollars",
    label: "EV $",
    definition:
      "Gross EV $ minus Pack Price. Below $0, the average buyback pays less than the pack costs.",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evPercent",
    label: "EV %",
    definition:
      "Gross EV % minus 100%. 0% is break-even; below 0%, the average buyback pays less than the price.",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evConfidence",
    label: "EV Confidence",
    definition:
      "How solid and recent the evidence behind this estimate is; it drops as source data ages past 60 minutes. It is not a profit forecast.",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "vendorReportedEv",
    label: "Vendor-reported EV",
    definition:
      "The vendor’s own EV number, shown for comparison only. PackScout never blends it into PackScout Gross EV.",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "buybackPercent",
    label: "Buyback %",
    definition:
      "Share of a collectible’s value the vendor guarantees to pay when you sell it back. Shown as one number only when the same rate covers every outcome.",
    enabledByDefault: true,
  },
  {
    key: "topChase",
    label: "Top Chase",
    definition:
      "The most valuable collectible PackScout has matched to this repack.",
    enabledByDefault: true,
  },
  {
    key: "topChaseValue",
    label: "Top Chase Value",
    definition:
      "PackScout’s reference value for that collectible.",
    enabledByDefault: true,
  },
  {
    key: "promoCode",
    label: "Promo Code",
    definition: "A public vendor code you can copy and use at checkout.",
    enabledByDefault: true,
  },
  {
    key: "repackLink",
    label: "Repack Link",
    definition: "Opens the vendor’s listing in a new tab.",
    enabledByDefault: true,
  },
] as const satisfies readonly GlossaryDefinition[]);

const glossaryByKey = new Map<GlossaryFieldKey, GlossaryDefinition>(
  COMPARISON_GLOSSARY.map((entry) => [entry.key, entry]),
);

export function getGlossaryDefinition(
  key: GlossaryFieldKey,
): GlossaryDefinition {
  const definition = glossaryByKey.get(key);
  if (!definition) {
    throw new Error(`Missing glossary definition for ${key}.`);
  }
  return definition;
}

export function getPublicReasonCopy(
  reason: PublicMetricReason,
): string {
  return PUBLIC_REASON_COPY[reason];
}
