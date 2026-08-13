import type {
  DataReleaseMetadata,
  PackScoutEv,
  PublicRepackChase,
  PublicRepackSummary,
} from "@packscout/contracts";
import {
  formatBasisPoints,
  formatMoneyMinorUnits,
} from "@/lib/metric-presentation";
import { getPublicReasonCopy } from "@/lib/metric-vocabulary";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

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

export function formatPublicTimestamp(timestamp: string): string {
  return DATE_FORMATTER.format(new Date(timestamp));
}

export function presentEstimateTiming(
  estimate: PackScoutEv,
  metadata: DataReleaseMetadata,
): Readonly<{
  calculatedLabel: string;
  calculatedAt: string | null;
  releaseLabel: string;
  dataAsOf: string;
}> {
  return Object.freeze({
    calculatedLabel:
      estimate.calculatedAt === null
        ? "Estimate date unavailable"
        : `PackScout EV calculated ${formatPublicTimestamp(estimate.calculatedAt)}`,
    calculatedAt: estimate.calculatedAt,
    releaseLabel: `Repack data as of ${formatPublicTimestamp(metadata.dataAsOf)}`,
    dataAsOf: metadata.dataAsOf,
  });
}

export function presentEstimateCoverage(
  contentSummary: PublicRepackSummary["contentSummary"],
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

export function presentVendorReportedObservation(
  observedAt: string | null,
): Readonly<{ label: string; observedAt: string }> | null {
  if (observedAt === null) return null;
  return Object.freeze({
    label: `Vendor EV observed ${formatPublicTimestamp(observedAt)}`,
    observedAt,
  });
}

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
