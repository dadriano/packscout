import type { CanonicalKindSummary } from "@packscout/contracts";

/**
 * How canonical record kinds and their counts are worded.
 *
 * Presentation only, with no component of its own: the per-kind counts live in
 * the filter bar's options and the freshness line sits with the grid it
 * describes, so there is nothing left for a card to hold.
 */

const KIND_LABELS: Record<string, string> = {
  platform: "Platforms",
  pack: "Packs",
  catalog_asset: "Catalog assets",
  ev_input: "EV inputs",
  pull: "Pulls",
  market_event: "Market events",
  estimated_ev: "Estimated EV",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** A bounded count is a floor and reads as one. */
export function countText(summary: CanonicalKindSummary): string {
  const formatted = summary.count.toLocaleString("en-US");
  return summary.precision === "at_least" ? `${formatted}+` : formatted;
}

export function timestampText(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * The one-line freshness summary shown beside the grid.
 *
 * Says "not computed" rather than showing a dash when the bucket was too large
 * to aggregate collection times — "we did not compute this" and "there is
 * nothing here" are different facts.
 */
export function freshnessLine(summary: CanonicalKindSummary | undefined): string {
  if (!summary) return "";
  if (summary.count === 0) return "No records of this kind";
  const accepted = `accepted ${timestampText(summary.oldestAcceptedAt)} → ${timestampText(summary.newestAcceptedAt)}`;
  const collected = summary.collectedExtremaComplete
    ? `collected ${timestampText(summary.oldestCollectedAt)} → ${timestampText(summary.newestCollectedAt)}`
    : "collected range not computed at this size";
  return `${collected} · ${accepted}`;
}
