import type { PublicAvailabilityReason } from "@packscout/contracts";

export const EXPECTED_VALUE_ARTICLE_HREF = "/learn/expected-value" as const;

export const METRIC_TRUST_COPY = Object.freeze({
  dashboardDisclaimer: "Estimated EV · Not financial advice.",
  estimateLabel: "PackScout Estimated EV",
  financialDisclaimer: "Not financial advice.",
  longRunExplanation:
    "EV is a long-run estimate. It does not predict the contents or outcome of one pack.",
  sourceExplanation:
    "Provider-reported values and PackScout estimates are different sources.",
  unavailableExplanation:
    "Unavailable means PackScout does not have enough supported evidence to show the value.",
});

export const PUBLIC_REASON_COPY = Object.freeze({
  ESTIMATE_INPUT_INCOMPLETE:
    "Estimate unavailable: supported evidence is incomplete.",
  PRICE_UNAVAILABLE: "Estimate unavailable: pack price is unavailable.",
  CURRENCY_UNSUPPORTED: "Estimate unavailable: currency is not supported.",
  BUYBACK_UNAVAILABLE:
    "Buyback unavailable: supported coverage is not available.",
  CHASE_UNAVAILABLE: "Top chase value unavailable.",
} satisfies Readonly<Record<PublicAvailabilityReason, string>>);

export type GlossaryFieldKey =
  | "platform"
  | "category"
  | "pack"
  | "packPrice"
  | "evDollars"
  | "evPercent"
  | "buybackPercent"
  | "grossEv"
  | "topChase"
  | "topChaseValue"
  | "promoCode"
  | "packLink";

export type GlossaryDefinition = Readonly<{
  key: GlossaryFieldKey;
  label: string;
  definition: string;
  enabledByDefault: true;
  learnHref?: typeof EXPECTED_VALUE_ARTICLE_HREF;
}>;

export const COMPARISON_GLOSSARY = Object.freeze([
  {
    key: "platform",
    label: "Platform",
    definition: "The marketplace or provider offering the pack",
    enabledByDefault: true,
  },
  {
    key: "category",
    label: "Category",
    definition: "The collectible family represented by the pack",
    enabledByDefault: true,
  },
  {
    key: "pack",
    label: "Pack",
    definition: "The provider’s public listing name",
    enabledByDefault: true,
  },
  {
    key: "packPrice",
    label: "Pack Price",
    definition: "The amount charged to open or buy the pack",
    enabledByDefault: true,
  },
  {
    key: "evDollars",
    label: "EV $",
    definition: "PackScout Gross EV minus Pack Price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "evPercent",
    label: "EV %",
    definition:
      "The percentage PackScout Gross EV is above or below Pack Price",
    enabledByDefault: true,
    learnHref: EXPECTED_VALUE_ARTICLE_HREF,
  },
  {
    key: "buybackPercent",
    label: "Buyback %",
    definition:
      "Provider-supported buyback coverage relative to Pack Price, supplied directly or derived from documented provider terms",
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
    definition: "A public platform-approved code available to copy",
    enabledByDefault: true,
  },
  {
    key: "packLink",
    label: "Pack Link",
    definition: "The tracked outbound link to the provider listing",
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
  reason: PublicAvailabilityReason,
): string {
  return PUBLIC_REASON_COPY[reason];
}
