import type {
  PublicRepackSort,
  PublicRepackSummaryV3,
} from "@packscout/contracts";
import type { GlossaryFieldKey } from "./metric-vocabulary";
import { presentPackAvailability } from "./pack-availability-presentation";

export type CatalogSortDirection = "asc" | "desc";

export type AllRepacksHeader = Readonly<{
  key: GlossaryFieldKey;
  label: string;
  sort?: PublicRepackSort;
}>;

/**
 * The buyback-adjusted comparison columns. The four PackScout metrics render
 * together in the approved order (Gross EV $, Gross EV %, EV $, EV %), and
 * vendor-reported EV stays a separately labeled, unsortable reported value —
 * the pre-buyback vendor EV percent sort has no honest data_release_v3
 * counterpart and was retired with it.
 */
export const ALL_REPACKS_HEADERS: readonly AllRepacksHeader[] = Object.freeze([
  { key: "vendor", label: "Vendor" },
  { key: "category", label: "Category" },
  { key: "repack", label: "Repack", sort: "repack" },
  { key: "repackPrice", label: "Pack Price", sort: "repack_price" },
  { key: "grossEv", label: "Gross EV $", sort: "packscout_gross_ev" },
  { key: "grossEvPercent", label: "Gross EV %" },
  { key: "evDollars", label: "EV $", sort: "packscout_ev_dollars" },
  { key: "evPercent", label: "EV %", sort: "packscout_ev_percent" },
  { key: "evConfidence", label: "EV Confidence", sort: "packscout_confidence" },
  { key: "buybackPercent", label: "Buyback %", sort: "buyback_percent" },
  { key: "vendorReportedEv", label: "Vendor EV" },
  { key: "topChase", label: "Top Chase" },
  { key: "topChaseValue", label: "Top Chase Value", sort: "top_chase_value" },
  { key: "promoCode", label: "Promo Code" },
  { key: "repackLink", label: "Repack Link" },
]);

export function nextCatalogSortDirection(
  currentSort: PublicRepackSort,
  currentDirection: CatalogSortDirection,
  nextSort: PublicRepackSort,
): CatalogSortDirection {
  if (currentSort !== nextSort) return nextSort === "repack" ? "asc" : "desc";
  return currentDirection === "asc" ? "desc" : "asc";
}

export function catalogHeaderAriaSort(
  header: AllRepacksHeader,
  currentSort: PublicRepackSort,
  currentDirection: CatalogSortDirection,
  search: string,
): "ascending" | "descending" | "none" | undefined {
  if (!header.sort || search) return undefined;
  if (header.sort !== currentSort) return "none";
  return currentDirection === "asc" ? "ascending" : "descending";
}

/**
 * Pack availability gates the outbound purchase link and nothing else. Only
 * `available` opens that link, decided by the shared presenter so a future
 * state is excluded by default. Promos stay governed by `actionAvailability`
 * alone, exactly as the data_release_v3 contract states: a pack that is
 * `unavailable`, `unknown`, or `sold_out` stays discoverable, keeps its promo,
 * and only loses the way to buy it.
 */
export function publicRowActions(repack: PublicRepackSummaryV3): Readonly<{
  promo: boolean;
  repackLink: boolean;
}> {
  return Object.freeze({
    promo: repack.actionAvailability.promo,
    repackLink:
      presentPackAvailability(repack.availability).purchaseActionsAvailable &&
      repack.actionAvailability.repackLink,
  });
}
