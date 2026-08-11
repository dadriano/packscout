import type {
  CatalogSummary,
  DashboardKpis,
  PublicPackSummary,
  PublicPrice,
} from "@packscout/contracts";
import {
  formatMoneyMinorUnits,
  presentBuyback,
  presentSignedEvPercent,
  presentTopChaseValue,
  type MetricSemanticState,
  type MetricValuePresentation,
} from "@/lib/metric-presentation";
import { getPublicReasonCopy } from "@/lib/metric-vocabulary";

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export type KpiPresentation = Readonly<{
  id: "packs" | "positiveEv" | "medianEv" | "highestChase";
  label: "Packs" | "Positive EV" | "Median EV" | "Highest Chase";
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
  publicPackId: string;
  name: string;
  category: string;
  platformDisplayName: string;
  platformLogoUrl: string | null;
  primaryImage: PublicPackSummary["primaryImage"];
  packPrice: DisplayField;
  evPercent: MetricValuePresentation;
  buyback: MetricValuePresentation;
  topChaseValue: MetricValuePresentation;
}>;

export type CatalogSummaryPresentation = Readonly<{
  key: string;
  label: string;
  packCount: number;
  packCountLabel: string;
  barRatio: number;
  medianEvPercent: MetricValuePresentation;
  accessibleLabel: string;
}>;

function countLabel(count: number): string {
  return COUNT_FORMATTER.format(count);
}

export function presentDashboardKpis(
  kpis: DashboardKpis,
): readonly KpiPresentation[] {
  const median = presentSignedEvPercent(kpis.medianEvPercent);
  const highest = kpis.highestChaseValue;
  const highestValue =
    highest.status === "available"
      ? formatMoneyMinorUnits(highest.value)
      : "Unavailable";
  const highestReason =
    highest.status === "unavailable"
      ? getPublicReasonCopy(highest.reason)
      : undefined;

  return Object.freeze([
    {
      id: "packs",
      label: "Packs",
      value: countLabel(kpis.totalPacks),
      helper: "Active public packs matching the applied filters",
      accessibleLabel: `${countLabel(kpis.totalPacks)} active public packs matching the applied filters.`,
      state: "plain",
    },
    {
      id: "positiveEv",
      label: "Positive EV",
      value: countLabel(kpis.positiveEvPacks),
      helper: "Active estimated packs above break-even",
      accessibleLabel: `${countLabel(kpis.positiveEvPacks)} active estimated packs have Positive EV.`,
      state: "positive",
      stateLabel: "Positive",
    },
    {
      id: "medianEv",
      label: "Median EV",
      value: median.displayValue,
      helper: "Median across estimated active packs",
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
      helper: "Highest eligible current chase value",
      accessibleLabel:
        highest.status === "available"
          ? `Highest Chase: ${highestValue}.`
          : `Highest Chase: Unavailable. ${highestReason}`,
      state: highest.status === "available" ? "plain" : "unavailable",
      ...(highest.status === "unavailable"
        ? { stateLabel: "Unavailable" as const, reasonCopy: highestReason }
        : {}),
    },
  ] satisfies readonly KpiPresentation[]);
}

export function presentPackPrice(price: PublicPrice): DisplayField {
  if (price.displayMoney !== null) {
    const displayValue = formatMoneyMinorUnits(price.displayMoney);
    return Object.freeze({
      availability: "available" as const,
      displayValue,
      accessibleLabel: `Pack Price: ${displayValue}.`,
    });
  }
  if (price.usdComparison.status === "available") {
    const displayValue = formatMoneyMinorUnits(price.usdComparison.value);
    return Object.freeze({
      availability: "available" as const,
      displayValue,
      accessibleLabel: `Pack Price: ${displayValue}.`,
    });
  }
  const reasonCopy = getPublicReasonCopy(price.usdComparison.reason);
  return Object.freeze({
    availability: "unavailable" as const,
    displayValue: "Unavailable",
    reasonCopy,
    accessibleLabel: `Pack Price: Unavailable. ${reasonCopy}`,
  });
}

export function presentOpportunities(
  opportunities: readonly PublicPackSummary[],
): readonly OpportunityPresentation[] {
  return Object.freeze(
    opportunities.map((pack, index) => ({
      rank: index + 1,
      publicPackId: pack.publicPackId,
      name: pack.name,
      category: pack.category,
      platformDisplayName: pack.platformDisplayName,
      platformLogoUrl: pack.platformLogoUrl,
      primaryImage: pack.primaryImage,
      packPrice: presentPackPrice(pack.price),
      evPercent: presentSignedEvPercent(pack.estimatedEv.evPercent),
      buyback: presentBuyback(pack.buyback),
      topChaseValue: presentTopChaseValue(pack.topChase),
    })),
  );
}

export function resolveOverviewSelection(
  opportunities: readonly Pick<PublicPackSummary, "publicPackId">[],
  selectedPublicPackId: string | null | undefined,
): string | null {
  if (
    selectedPublicPackId &&
    opportunities.some(
      ({ publicPackId }) => publicPackId === selectedPublicPackId,
    )
  ) {
    return selectedPublicPackId;
  }
  return opportunities[0]?.publicPackId ?? null;
}

export function presentCatalogSummaries(
  summaries: readonly CatalogSummary[],
): readonly CatalogSummaryPresentation[] {
  const largestCount = Math.max(0, ...summaries.map(({ packCount }) => packCount));
  return Object.freeze(
    summaries.map((summary) => {
      const median = presentSignedEvPercent(summary.medianEvPercent);
      const packs = countLabel(summary.packCount);
      const reasonCopy =
        median.availability === "unavailable" ? median.reasonCopy : undefined;
      return {
        key: summary.key,
        label: summary.label,
        packCount: summary.packCount,
        packCountLabel: packs,
        barRatio: largestCount === 0 ? 0 : summary.packCount / largestCount,
        medianEvPercent: median,
        accessibleLabel: `${summary.label}: ${packs} packs. Median EV: ${median.displayValue}. ${median.semanticLabel ?? "Available"}.${reasonCopy ? ` ${reasonCopy}` : ""}`,
      };
    }),
  );
}
