import type {
  PublicRepackSort,
  PublicRepackSummary,
} from "@packscout/contracts";
import type { GlossaryFieldKey } from "./metric-vocabulary";

export type CatalogSortDirection = "asc" | "desc";

export type AllRepacksHeader = Readonly<{
  key: GlossaryFieldKey;
  label: string;
  sort?: PublicRepackSort;
}>;

export const ALL_REPACKS_HEADERS: readonly AllRepacksHeader[] = Object.freeze([
  { key: "vendor", label: "Vendor" },
  { key: "category", label: "Category" },
  { key: "repack", label: "Repack", sort: "repack" },
  { key: "heat", label: "Heat" },
  { key: "repackPrice", label: "Repack Price", sort: "repack_price" },
  { key: "evDollars", label: "EV $", sort: "packscout_ev_dollars" },
  { key: "evPercent", label: "EV %", sort: "packscout_ev_percent" },
  { key: "evConfidence", label: "EV Confidence", sort: "packscout_confidence" },
  { key: "vendorReportedEv", label: "Vendor EV %", sort: "vendor_reported_ev_percent" },
  { key: "buybackPercent", label: "Buyback %", sort: "buyback_percent" },
  { key: "grossEv", label: "Gross EV", sort: "packscout_gross_ev" },
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

export function publicRowActions(repack: PublicRepackSummary): Readonly<{
  promo: boolean;
  repackLink: boolean;
}> {
  return Object.freeze({
    promo: repack.actionAvailability.promo,
    repackLink:
      repack.availability === "active" && repack.actionAvailability.repackLink,
  });
}
