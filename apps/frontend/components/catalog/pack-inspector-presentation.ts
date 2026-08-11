import type {
  PublicEstimatedEv,
  PublicTopChaseDetail,
  SnapshotMetadata,
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
      name: string;
      displayValue: string;
      accessibleLabel: string;
      image: NonNullable<
        Extract<PublicTopChaseDetail, { status: "available" }>["value"]["primaryImage"]
      > | null;
      observedAt: string;
    }>
  | Readonly<{
      availability: "unavailable";
      name: "Top chase unavailable";
      displayValue: "Unavailable";
      accessibleLabel: string;
      image: null;
      reasonCopy: string;
    }>;

export function formatPublicTimestamp(timestamp: string): string {
  return DATE_FORMATTER.format(new Date(timestamp));
}

export function presentEstimateTiming(
  estimatedEv: Pick<PublicEstimatedEv, "calculatedAt">,
  metadata: SnapshotMetadata,
): Readonly<{
  calculatedLabel: string;
  calculatedAt: string | null;
  snapshotLabel: string;
  dataAsOf: string;
}> {
  return Object.freeze({
    calculatedLabel:
      estimatedEv.calculatedAt === null
        ? "Estimate date unavailable"
        : `Estimate as of ${formatPublicTimestamp(estimatedEv.calculatedAt)}`,
    calculatedAt: estimatedEv.calculatedAt,
    snapshotLabel: `Catalog data as of ${formatPublicTimestamp(metadata.dataAsOf)}`,
    dataAsOf: metadata.dataAsOf,
  });
}

export function presentEstimateCoverage(
  coverage: PublicEstimatedEv["coverage"],
): string {
  if (coverage.probabilityCoverageBasisPoints === null) {
    return coverage.evidenceCompleteness === "unknown"
      ? "Supported evidence coverage is unavailable."
      : "Supported evidence coverage is not quantified.";
  }
  const coverageLabel = formatBasisPoints(
    coverage.probabilityCoverageBasisPoints,
    { minimumFractionDigits: 0, maximumFractionDigits: 2 },
  );
  if (coverage.evidenceCompleteness === "complete") {
    return `Supported evidence covers ${coverageLabel} of modeled outcomes.`;
  }
  if (coverage.evidenceCompleteness === "partial") {
    return `Supported evidence covers ${coverageLabel} of modeled outcomes; some evidence is incomplete.`;
  }
  return `Supported evidence coverage is ${coverageLabel}; completeness is unknown.`;
}

export function presentTopChase(
  topChase: PublicTopChaseDetail,
): TopChasePresentation {
  if (topChase.status === "unavailable") {
    const reasonCopy = getPublicReasonCopy(topChase.reason);
    return Object.freeze({
      availability: "unavailable" as const,
      name: "Top chase unavailable" as const,
      displayValue: "Unavailable" as const,
      accessibleLabel: `Top chase unavailable. ${reasonCopy}`,
      image: null,
      reasonCopy,
    });
  }

  const value = topChase.value;
  const money =
    value.displayMoney ??
    (value.usdComparison.status === "available"
      ? value.usdComparison.value
      : null);
  if (!money) {
    const reasonCopy =
      value.usdComparison.status === "unavailable"
        ? getPublicReasonCopy(value.usdComparison.reason)
        : getPublicReasonCopy("CHASE_UNAVAILABLE");
    return Object.freeze({
      availability: "unavailable" as const,
      name: "Top chase unavailable" as const,
      displayValue: "Unavailable" as const,
      accessibleLabel: `Top chase unavailable. ${reasonCopy}`,
      image: null,
      reasonCopy,
    });
  }

  const displayValue = formatMoneyMinorUnits(money);
  return Object.freeze({
    availability: "available" as const,
    name: value.name,
    displayValue,
    accessibleLabel: `Top chase: ${value.name}. Supported representative value ${displayValue}.`,
    image: value.primaryImage,
    observedAt: value.observedAt,
  });
}
