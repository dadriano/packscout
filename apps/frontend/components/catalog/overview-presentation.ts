import type {
  DashboardKpis,
  DisplayedEvMedianSource,
  DisplayedEvMedianSourcesV3,
  PackScoutDisplayedEvV3,
  PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import {
  formatMoneyMinorUnits,
  isSimulatedRepackListing,
  presentBuybackSummaryV3,
  presentPackScoutEvV3,
  presentRepackPrice,
  presentSignedEvPercentMetric,
  presentTopChaseValue,
  type MetricSemanticState,
  type MetricTone,
  type MetricValuePresentation,
  type PackScoutEvV3Presentation,
} from "@/lib/packscout-ev-presentation";
import { getPublicReasonCopy } from "@/lib/metric-vocabulary";
import type { RepackSummaryGroupV3 } from "@/lib/public-repacks-v3";

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export type KpiPresentation = Readonly<{
  id: "repacks" | "medianEv" | "highestChase";
  label: "Repacks" | "Median EV" | "Highest Chase";
  value: string;
  helper: string;
  accessibleLabel: string;
  state: MetricSemanticState | "plain";
  stateLabel?: "Neutral" | "Negative" | "Unavailable";
  tone?: MetricTone;
  reasonCopy?: string;
}>;

export type OpportunityPresentation = Readonly<{
  rank: number;
  publicRepackId: string;
  name: string;
  category: string;
  vendorDisplayName: string;
  vendorLogoUrl: string | null;
  primaryImage: PublicRepackViewSummaryV3["primaryImage"];
  simulated: boolean;
  packPrice: MetricValuePresentation;
  packScoutEv: PackScoutEvV3Presentation;
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
  sourceLabel: string;
  accessibleLabel: string;
}>;

function countLabel(count: number): string {
  return COUNT_FORMATTER.format(count);
}

function medianSourceLabel(source: DisplayedEvMedianSource | null): string {
  if (source === "provider_reported") return "Platform EV × buyback";
  if (source === "mixed") return "Mixed sources";
  return source === "packscout" ? "PackScout EV" : "Source unavailable";
}

/** Formats the server-materialized dashboard KPIs without browser recomputation. */
export function presentDashboardKpis(
  kpis: DashboardKpis,
  source: DisplayedEvMedianSource | null,
): readonly KpiPresentation[] {
  const median = presentSignedEvPercentMetric(
    kpis.medianPackScoutEvPercent,
    "Median EV %",
    source,
  );
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
      accessibleLabel: `View all repacks: ${countLabel(kpis.totalRepacks)} public repacks matching the applied filters.`,
      state: "plain",
    },
    {
      id: "medianEv",
      label: "Median EV",
      value: median.displayValue,
      helper: `${medianSourceLabel(source)} · ${countLabel(kpis.highConfidenceRepacks)} high confidence`,
      accessibleLabel: `${median.accessibleLabel} ${medianSourceLabel(source)}. ${countLabel(kpis.highConfidenceRepacks)} high-confidence repacks.`,
      state: median.semanticState ?? "plain",
      stateLabel: median.semanticLabel,
      tone: median.tone,
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

/**
 * Presents one server-ranked opportunity row. The rank comes from the
 * server's signed-EV-dollar ordering, and `estimate` is the clock-resolved
 * PackScout estimate for the row (defaults to the served projection).
 */
export function presentOpportunityRow(
  repack: PublicRepackViewSummaryV3,
  rank: number,
  estimate: PackScoutDisplayedEvV3 = repack.evEstimates.packScout,
): OpportunityPresentation {
  return Object.freeze({
    rank,
    publicRepackId: repack.publicRepackId,
    name: repack.name,
    category:
      repack.categories.map(({ label }) => label).join(" · ") || "Uncategorized",
    vendorDisplayName: repack.vendorDisplayName,
    vendorLogoUrl: repack.vendorLogoUrl,
    primaryImage: repack.primaryImage,
    simulated: isSimulatedRepackListing(repack.name),
    packPrice: presentRepackPrice(repack.price),
    packScoutEv: presentPackScoutEvV3({
      estimate,
      price: repack.price,
      availability: repack.availability,
      repackName: repack.name,
    }),
    buyback: presentBuybackSummaryV3(repack.buyback),
    topChaseValue: presentTopChaseValue(repack.topChase),
  });
}

export function resolveOverviewSelection(
  opportunities: readonly Pick<PublicRepackViewSummaryV3, "publicRepackId">[],
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
  summaries: readonly RepackSummaryGroupV3[],
  sources: DisplayedEvMedianSourcesV3["vendors"],
): readonly CatalogSummaryPresentation[] {
  const sourceByKey = new Map(sources.map(({ key, source }) => [key, source]));
  const largestCount = Math.max(
    0,
    ...summaries.map(({ repackCount }) => repackCount),
  );
  return Object.freeze(
    summaries.map((summary) => {
      const source = sourceByKey.get(summary.key) ?? null;
      const median = presentSignedEvPercentMetric(
        summary.medianPackScoutEvPercent,
        "Median EV %",
        source,
      );
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
        sourceLabel: medianSourceLabel(source),
        accessibleLabel: `${summary.label}: ${repacks} repacks. Median EV %: ${median.displayValue}. ${medianSourceLabel(source)}. ${median.semanticLabel ?? "Available"}.${reasonCopy ? ` ${reasonCopy}` : ""}`,
      };
    }),
  );
}
