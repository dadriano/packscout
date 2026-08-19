import type {
  DashboardBundle,
  DashboardKpis,
  PublicRepackHeat,
  PublicRepackViewSummary,
} from "@packscout/contracts";
import {
  formatMoneyMinorUnits,
  formatSignedEvPercent,
  presentBuyback,
  presentPackScoutConfidence,
  presentPackScoutEvPercent,
  presentTopChaseValue,
  semanticStateForSignedBasisPoints,
  type ConfidencePresentation,
  type MetricSemanticState,
  type MetricValuePresentation,
} from "@/lib/metric-presentation";
import { getPublicReasonCopy } from "@/lib/metric-vocabulary";

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

type RepackSummaryGroup = DashboardBundle["vendorSummaries"][number];
type PublicPrice = PublicRepackViewSummary["price"];

export type KpiPresentation = Readonly<{
  id: "repacks" | "positiveEv" | "medianEv" | "highestChase";
  label: "Repacks" | "Positive EV" | "Median EV" | "Highest Chase";
  value: string;
  helper: string;
  accessibleLabel: string;
  state: MetricSemanticState | "plain";
  stateLabel?: "Positive" | "Neutral" | "Negative" | "Unavailable";
  reasonCopy?: string;
}>;

export type DisplayField = Readonly<{
  displayValue: string;
  accessibleLabel: string;
  availability: "available" | "unavailable";
  reasonCopy?: string;
}>;

export type OpportunityPresentation = Readonly<{
  rank: number;
  publicRepackId: string;
  name: string;
  category: string;
  vendorDisplayName: string;
  vendorLogoUrl: string | null;
  primaryImage: PublicRepackViewSummary["primaryImage"];
  heat: PublicRepackHeat;
  repackPrice: DisplayField;
  packScoutEvPercent: MetricValuePresentation;
  packScoutConfidence: ConfidencePresentation;
  buyback: MetricValuePresentation;
  topChaseValue: MetricValuePresentation;
}>;

export type CatalogSummaryPresentation = Readonly<{
  key: string;
  label: string;
  repackCount: number;
  repackCountLabel: string;
  barRatio: number;
  medianEvPercent: MetricValuePresentation;
  accessibleLabel: string;
}>;

function countLabel(count: number): string {
  return COUNT_FORMATTER.format(count);
}

function presentSummaryEvPercent(
  metric: DashboardKpis["medianPackScoutEvPercent"],
): MetricValuePresentation {
  if (metric.status === "unavailable") {
    const reasonCopy = getPublicReasonCopy(metric.reason);
    return {
      availability: "unavailable",
      label: "PackScout EV %",
      displayValue: "Unavailable",
      accessibleLabel: `PackScout EV %: Unavailable. ${reasonCopy}`,
      glossaryKey: "evPercent",
      semanticState: "unavailable",
      semanticLabel: "Unavailable",
      reason: metric.reason,
      reasonCopy,
    };
  }
  const semanticState = semanticStateForSignedBasisPoints(metric.basisPoints);
  const semanticLabel = semanticState === "positive"
    ? "Positive"
    : semanticState === "negative"
      ? "Negative"
      : "Neutral";
  const displayValue = formatSignedEvPercent(metric.basisPoints);
  return {
    availability: "available",
    label: "PackScout EV %",
    displayValue,
    accessibleLabel: `PackScout EV %: ${displayValue}. ${semanticLabel}.`,
    glossaryKey: "evPercent",
    semanticState,
    semanticLabel,
  };
}

export function presentDashboardKpis(
  kpis: DashboardKpis,
): readonly KpiPresentation[] {
  const median = presentSummaryEvPercent(kpis.medianPackScoutEvPercent);
  const highestValue = kpis.highestChaseValueUsdMinor === null
    ? "Unavailable"
    : formatMoneyMinorUnits({
        minorUnits: kpis.highestChaseValueUsdMinor,
        currency: "USD",
      });
  const highestReason = kpis.highestChaseValueUsdMinor === null
    ? getPublicReasonCopy("VALUATION_UNAVAILABLE")
    : undefined;

  return Object.freeze([
    {
      id: "repacks",
      label: "Repacks",
      value: countLabel(kpis.totalRepacks),
      helper: "",
      accessibleLabel: `View all repacks: ${countLabel(kpis.totalRepacks)} active public repacks matching the applied filters.`,
      state: "plain",
    },
    {
      id: "positiveEv",
      label: "Positive EV",
      value: countLabel(kpis.positiveEvRepacks),
      helper: "Repacks with positive PackScout EV",
      accessibleLabel: `${countLabel(kpis.positiveEvRepacks)} active repacks have positive PackScout EV.`,
      state: "positive",
      stateLabel: "Positive",
    },
    {
      id: "medianEv",
      label: "Median EV",
      value: median.displayValue,
      helper: `Median PackScout EV · ${countLabel(kpis.highConfidenceRepacks)} high confidence`,
      accessibleLabel: median.accessibleLabel,
      state: median.semanticState ?? "plain",
      stateLabel: median.semanticLabel,
      ...(median.availability === "unavailable"
        ? { reasonCopy: median.reasonCopy }
        : {}),
    },
    {
      id: "highestChase",
      label: "Highest Chase",
      value: highestValue,
      helper: "Highest supported current chase value",
      accessibleLabel: kpis.highestChaseValueUsdMinor === null
        ? `Highest Chase: Unavailable. ${highestReason}`
        : `Highest Chase: ${highestValue}.`,
      state: kpis.highestChaseValueUsdMinor === null ? "unavailable" : "plain",
      ...(kpis.highestChaseValueUsdMinor === null
        ? { stateLabel: "Unavailable" as const, reasonCopy: highestReason }
        : {}),
    },
  ] satisfies readonly KpiPresentation[]);
}

export function presentRepackPrice(price: PublicPrice): DisplayField {
  if (price.displayMoney !== null) {
    const displayValue = formatMoneyMinorUnits(price.displayMoney);
    return Object.freeze({
      availability: "available" as const,
      displayValue,
      accessibleLabel: `Repack Price: ${displayValue}.`,
    });
  }
  if (price.usdComparison.status === "available") {
    const money = price.usdComparison.value;
    const displayValue = formatMoneyMinorUnits(money);
    return Object.freeze({
      availability: "available" as const,
      displayValue,
      accessibleLabel: `Repack Price: ${displayValue}.`,
    });
  }
  const reasonCopy = getPublicReasonCopy(price.usdComparison.reason);
  return Object.freeze({
    availability: "unavailable" as const,
    displayValue: "Unavailable",
    reasonCopy,
    accessibleLabel: `Repack Price: Unavailable. ${reasonCopy}`,
  });
}

export function presentOpportunities(
  opportunities: readonly PublicRepackViewSummary[],
): readonly OpportunityPresentation[] {
  return Object.freeze(
    opportunities.map((repack, index) => ({
      rank: index + 1,
      publicRepackId: repack.publicRepackId,
      name: repack.name,
      category: repack.categories.map(({ label }) => label).join(" · ") || "Uncategorized",
      vendorDisplayName: repack.vendorDisplayName,
      vendorLogoUrl: repack.vendorLogoUrl,
      primaryImage: repack.primaryImage,
      heat: repack.heat,
      repackPrice: presentRepackPrice(repack.price),
      packScoutEvPercent: presentPackScoutEvPercent(repack.evEstimates.packScout),
      packScoutConfidence: presentPackScoutConfidence(
        repack.evEstimates.packScout.status === "available"
          ? repack.evEstimates.packScout.confidence
          : null,
      ),
      buyback: presentBuyback(repack.buyback),
      topChaseValue: presentTopChaseValue(repack.topChase),
    })),
  );
}

export function resolveOverviewSelection(
  opportunities: readonly Pick<PublicRepackViewSummary, "publicRepackId">[],
  selectedPublicRepackId: string | null | undefined,
): string | null {
  if (
    selectedPublicRepackId &&
    opportunities.some(
      ({ publicRepackId }) => publicRepackId === selectedPublicRepackId,
    )
  ) {
    return selectedPublicRepackId;
  }
  return opportunities[0]?.publicRepackId ?? null;
}

export function presentCatalogSummaries(
  summaries: readonly RepackSummaryGroup[],
): readonly CatalogSummaryPresentation[] {
  const largestCount = Math.max(
    0,
    ...summaries.map(({ repackCount }) => repackCount),
  );
  return Object.freeze(
    summaries.map((summary) => {
      const median = presentSummaryEvPercent(summary.medianPackScoutEvPercent);
      const repacks = countLabel(summary.repackCount);
      const reasonCopy =
        median.availability === "unavailable" ? median.reasonCopy : undefined;
      return {
        key: summary.key,
        label: summary.label,
        repackCount: summary.repackCount,
        repackCountLabel: repacks,
        barRatio: largestCount === 0 ? 0 : summary.repackCount / largestCount,
        medianEvPercent: median,
        accessibleLabel: `${summary.label}: ${repacks} repacks. Median EV: ${median.displayValue}. ${median.semanticLabel ?? "Available"}.${reasonCopy ? ` ${reasonCopy}` : ""}`,
      };
    }),
  );
}
