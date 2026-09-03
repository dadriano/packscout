import type {
  PublicRepackChase,
  PublicRepackSummaryV3,
} from "@packscout/contracts";
import {
  formatBasisPoints,
  formatMoneyMinorUnits,
} from "@/lib/packscout-ev-presentation";
import { getPublicReasonCopy } from "@/lib/metric-vocabulary";

export type TopChasePresentation =
  | Readonly<{
      availability: "available";
      valueAvailability: "available" | "unavailable";
      name: string;
      displayValue: string;
      accessibleLabel: string;
      image: PublicRepackChase["collectible"]["primaryImage"];
      observedAt: string;
      evidenceLabel: string;
      matchConfidenceLabel: string;
      reasonCopy?: string;
    }>
  | Readonly<{
      availability: "unavailable";
      name: string;
      displayValue: "Unavailable";
      accessibleLabel: string;
      image: null;
      reasonCopy: string;
    }>;

export function presentEstimateCoverage(
  contentSummary: PublicRepackSummaryV3["contentSummary"],
): string {
  if (contentSummary.probabilityCoverageBasisPoints === null) {
    return contentSummary.evidenceCompleteness === "unknown"
      ? "Supported evidence coverage is unavailable."
      : "Supported evidence coverage is not quantified.";
  }
  const coverageLabel = formatBasisPoints(
    contentSummary.probabilityCoverageBasisPoints,
    { minimumFractionDigits: 0, maximumFractionDigits: 2 },
  );
  if (contentSummary.evidenceCompleteness === "complete") {
    return `Supported evidence covers ${coverageLabel} of modeled outcomes.`;
  }
  if (contentSummary.evidenceCompleteness === "partial") {
    return `Supported evidence covers ${coverageLabel} of modeled outcomes; some evidence is incomplete.`;
  }
  return `Supported evidence coverage is ${coverageLabel}; completeness is unknown.`;
}

/**
 * Chase-match confidence is semantically separate from PackScout EV
 * confidence: it describes how confidently a collectible was matched, never
 * the reliability or direction of an EV estimate.
 */
export function presentChaseMatchEvidence(
  chase: PublicRepackChase,
): Readonly<{
  evidenceLabel: string;
  matchConfidenceLabel: string;
  accessibleLabel: string;
}> {
  let label: string;
  if (
    chase.evidenceKinds.includes("vendor_inventory") ||
    chase.evidenceKinds.includes("vendor_odds") ||
    chase.evidenceKinds.includes("vendor_featured_chase")
  ) {
    label = "Confirmed by vendor evidence";
  } else if (chase.evidenceKinds.includes("historical_pull_inference")) {
    label = "Inferred from historical pulls";
  } else if (chase.evidenceKinds.includes("packscout_resolved")) {
    label = "Resolved by PackScout";
  } else {
    label = "Possible match based on name evidence";
  }
  const matchConfidenceLabel = `${chase.matchConfidence.band} chase-match confidence`;
  return Object.freeze({
    evidenceLabel: label,
    matchConfidenceLabel,
    accessibleLabel: `${label}. ${matchConfidenceLabel}.`,
  });
}

export function presentTopChase(
  topChase: PublicRepackChase | null,
  label = "Top chase",
  valueLabel = "Top Chase Value",
): TopChasePresentation {
  const valuation = topChase?.collectible.valuation;
  const money = valuation?.displayMoney ??
    (valuation?.usdComparison.status === "available"
      ? valuation.usdComparison.value
      : null);
  if (topChase === null) {
    const reasonCopy = getPublicReasonCopy("VALUATION_UNAVAILABLE");
    return Object.freeze({
      availability: "unavailable" as const,
      name: `${label} unavailable`,
      displayValue: "Unavailable" as const,
      accessibleLabel: `${label} unavailable. ${reasonCopy}`,
      image: null,
      reasonCopy,
    });
  }

  const match = presentChaseMatchEvidence(topChase);
  if (money === null) {
    const reasonCopy = getPublicReasonCopy(
      valuation?.usdComparison.status === "unavailable"
        ? valuation.usdComparison.reason
        : "VALUATION_UNAVAILABLE",
    );
    return Object.freeze({
      availability: "available" as const,
      valueAvailability: "unavailable" as const,
      name: topChase.collectible.name,
      displayValue: "Unavailable" as const,
      accessibleLabel: `${label}: ${topChase.collectible.name}. ${valueLabel}: Unavailable. ${reasonCopy} ${match.accessibleLabel}`,
      image: topChase.collectible.primaryImage,
      observedAt: topChase.observedAt,
      evidenceLabel: match.evidenceLabel,
      matchConfidenceLabel: match.matchConfidenceLabel,
      reasonCopy,
    });
  }

  const displayValue = formatMoneyMinorUnits(money);
  return Object.freeze({
    availability: "available" as const,
    valueAvailability: "available" as const,
    name: topChase.collectible.name,
    displayValue,
    accessibleLabel: `${label}: ${topChase.collectible.name}. ${valueLabel}: ${displayValue}. ${match.accessibleLabel}`,
    image: topChase.collectible.primaryImage,
    observedAt: topChase.observedAt,
    evidenceLabel: match.evidenceLabel,
    matchConfidenceLabel: match.matchConfidenceLabel,
  });
}
