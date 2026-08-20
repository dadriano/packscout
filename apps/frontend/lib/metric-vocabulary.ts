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
    "EV is a probability-weighted estimate of the guaranteed buyback payout. It does not predict the contents or outcome of one repack.",
  sourceExplanation:
    "Vendor-reported EV and PackScout Gross EV are separate estimates and are never averaged or substituted.",
  confidenceExplanation:
    "Confidence describes how reliable and fresh PackScout's supporting evidence is, not profit likelihood or whether EV is positive.",
  unavailableExplanation:
    "Unavailable means PackScout does not have complete supported evidence. PackScout never assumes missing buyback terms.",
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
  SOURCE_DATA_STALE: "Expired: source data is older than 60 minutes.",
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
} as const);

export const ESTIMATE_STATUS_COPY = Object.freeze({
  current: "Current estimate",
  sold_out_historical: "Sold out · historical estimate",
  unavailable: "Unavailable",
  expired: "Expired",
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
    definition: "The vendor offering the repack",
    enabledByDefault: true,
  },
  {
    key: "category",
    label: "Category",
    definition: "A subject branch represented by the repack",
    enabledByDefault: true,
  },
  {
    key: "repack",
    label: "Repack",
    definition: "The vendor’s public repack or gacha listing name",
    enabledByDefault: true,
  },
  {
    key: "heat",
    label: "Heat",
    definition:
      "A timing signal comparing recent activity with this repack’s own baseline. Heat does not mean profit, positive EV, or a predicted outcome.",
    enabledByDefault: true,
  },
  {
    key: "repackPrice",
    label: "Pack Price",
    definition:
      "The current public listed price before personalized, membership, or promo discounts",
    enabledByDefault: true,
  },
  {
    key: "grossEv",
    label: "Gross EV $",
    definition:
      "The expected guaranteed buyback payout: each supported outcome’s final guaranteed buyback payout weighted by its probability",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "grossEvPercent",
    label: "Gross EV %",
    definition:
      "The expected guaranteed buyback payout divided by the public Pack Price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evDollars",
    label: "EV $",
    definition:
      "PackScout Gross EV $ minus Pack Price, signed above or below the price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evPercent",
    label: "EV %",
    definition:
      "PackScout Gross EV % minus 100 percentage points, signed above or below Pack Price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evConfidence",
    label: "EV Confidence",
    definition:
      "How reliable and fresh PackScout’s supporting evidence is; it never describes profit likelihood or a predicted outcome",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "vendorReportedEv",
    label: "Vendor-reported EV",
    definition:
      "An EV value reported by the vendor, shown separately and never merged with or substituted for PackScout Gross EV",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "buybackPercent",
    label: "Buyback %",
    definition:
      "The documented uniform buyback rate when one rate governs every eligible outcome; otherwise a bounded summary such as Varies by outcome",
    enabledByDefault: true,
  },
  {
    key: "topChase",
    label: "Top Chase",
    definition:
      "The highest-valued eligible related collectible currently identified",
    enabledByDefault: true,
  },
  {
    key: "topChaseValue",
    label: "Top Chase Value",
    definition:
      "The supported canonical representative value attached to that collectible",
    enabledByDefault: true,
  },
  {
    key: "promoCode",
    label: "Promo Code",
    definition: "A public vendor-approved code available to copy",
    enabledByDefault: true,
  },
  {
    key: "repackLink",
    label: "Repack Link",
    definition: "The tracked outbound link to the vendor listing",
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
