import type { DashboardKpis, DisplayedEvMedianSource, PackScoutDisplayedEvV3 } from "@packscout/contracts";
import {
  displayedEvMetricFromDataReleaseV3SearchRow,
  type DataReleaseV3SearchRow,
} from "./dataReleaseV3Search";

export type DisplayedEvMedianContext = Readonly<{
  evByPublicId: ReadonlyMap<string, PackScoutDisplayedEvV3>;
  legacyEvSnapshot: boolean;
}>;

/** Uses the same displayed EV as pack sorting; callers supply purchasable rows. */
export function medianDisplayedEvPercent(
  rows: readonly DataReleaseV3SearchRow[],
  context: DisplayedEvMedianContext,
): Readonly<{ metric: DashboardKpis["medianPackScoutEvPercent"]; source: DisplayedEvMedianSource | null }> {
  const sources = new Set<DisplayedEvMedianSource>();
  const values = rows.flatMap((row) => {
    const value = displayedEvMetricFromDataReleaseV3SearchRow(
      row, "packScoutEvPercentBasisPoints",
      context.evByPublicId.get(row.publicRepackId), context.legacyEvSnapshot,
    );
    if (value === null) return [];
    sources.add(row.packScoutEvPercentBasisPoints === null ? "provider_reported" : "packscout");
    return [value];
  }).sort((left, right) => left - right);
  if (values.length === 0) {
    return { metric: { status: "unavailable", basisPoints: null, reason: "ESTIMATE_UNAVAILABLE" }, source: null };
  }
  const middle = Math.floor(values.length / 2);
  const basisPoints = values.length % 2 === 1 ? values[middle]!
    : Math.round((values[middle - 1]! + values[middle]!) / 2);
  return { metric: { status: "available", basisPoints },
    source: sources.size > 1 ? "mixed" : sources.has("packscout") ? "packscout" : "provider_reported" };
}
