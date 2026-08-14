export const EXPECTED_VALUE_ARTICLE_HREF = "/learn/expected-value" as const;

export type PublicMetricReason =
  | "PRICE_UNAVAILABLE"
  | "CURRENCY_UNSUPPORTED"
  | "ESTIMATE_INPUT_INCOMPLETE"
  | "ESTIMATE_UNAVAILABLE"
  | "BUYBACK_UNAVAILABLE"
  | "VALUATION_UNAVAILABLE"
  | "NOT_REPORTED";

export const METRIC_TRUST_COPY = Object.freeze({
  dashboardDisclaimer: "PackScout EV · Estimated · Not financial advice.",
  estimateLabel: "PackScout EV",
  financialDisclaimer: "Not financial advice.",
  longRunExplanation:
    "EV is a long-run estimate. It does not predict the contents or outcome of one repack.",
  sourceExplanation:
    "Vendor-reported EV and PackScout EV are separate estimates and are never averaged.",
  confidenceExplanation:
    "Confidence describes the reliability of PackScout's estimate, not whether its EV is positive or negative.",
  unavailableExplanation:
    "Unavailable means PackScout does not have enough supported evidence to show the value.",
});

export const PUBLIC_REASON_COPY = Object.freeze({
  ESTIMATE_INPUT_INCOMPLETE:
    "Estimate unavailable: supported evidence is incomplete.",
  PRICE_UNAVAILABLE: "Estimate unavailable: repack price is unavailable.",
  CURRENCY_UNSUPPORTED: "Estimate unavailable: currency is not supported.",
  ESTIMATE_UNAVAILABLE: "Estimate unavailable.",
  BUYBACK_UNAVAILABLE:
    "Buyback unavailable: supported coverage is not available.",
  VALUATION_UNAVAILABLE: "Collectible value unavailable.",
  NOT_REPORTED: "The vendor has not reported an EV estimate.",
} satisfies Readonly<Record<PublicMetricReason, string>>);

export type GlossaryFieldKey =
  | "vendor"
  | "category"
  | "repack"
  | "heat"
  | "repackPrice"
  | "evDollars"
  | "evPercent"
  | "evConfidence"
  | "vendorReportedEv"
  | "buybackPercent"
  | "grossEv"
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
    label: "Repack Price",
    definition: "The amount charged to open or buy the repack",
    enabledByDefault: true,
  },
  {
    key: "evDollars",
    label: "EV $",
    definition: "PackScout Gross EV minus Repack Price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evPercent",
    label: "EV %",
    definition:
      "The percentage PackScout Gross EV is above or below Repack Price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evConfidence",
    label: "EV Confidence",
    definition:
      "How reliable PackScout considers its EV estimate based on supported evidence; it does not indicate whether EV is positive",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "vendorReportedEv",
    label: "Vendor-reported EV",
    definition:
      "An EV estimate reported by the vendor and kept separate from PackScout EV",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "buybackPercent",
    label: "Buyback %",
    definition:
      "Vendor-supported buyback coverage relative to Repack Price, reported directly or derived by PackScout from documented terms",
    enabledByDefault: true,
  },
  {
    key: "grossEv",
    label: "Gross EV",
    definition:
      "PackScout’s estimated value of contents before fees and shipping",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
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
