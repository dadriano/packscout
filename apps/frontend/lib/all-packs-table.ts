import type {
  PublicCatalogSort,
  PublicPackSummary,
} from "@packscout/contracts";
import type { GlossaryFieldKey } from "./metric-vocabulary";

export type CatalogSortDirection = "asc" | "desc";

export type AllPacksHeader = Readonly<{
  key: GlossaryFieldKey;
  label: string;
  sort?: PublicCatalogSort;
}>;

export const ALL_PACKS_HEADERS: readonly AllPacksHeader[] = Object.freeze([
  { key: "platform", label: "Platform" },
  { key: "category", label: "Category" },
  { key: "pack", label: "Pack", sort: "pack" },
  { key: "packPrice", label: "Pack Price", sort: "pack_price" },
  { key: "evDollars", label: "EV $", sort: "ev_dollars" },
  { key: "evPercent", label: "EV %", sort: "ev_percent" },
  { key: "buybackPercent", label: "Buyback %", sort: "buyback_percent" },
  { key: "grossEv", label: "Gross EV", sort: "gross_ev" },
  { key: "topChase", label: "Top Chase" },
  { key: "topChaseValue", label: "Top Chase Value", sort: "top_chase_value" },
  { key: "promoCode", label: "Promo Code" },
  { key: "packLink", label: "Pack Link" },
]);

export function nextCatalogSortDirection(
  currentSort: PublicCatalogSort,
  currentDirection: CatalogSortDirection,
  nextSort: PublicCatalogSort,
): CatalogSortDirection {
  if (currentSort !== nextSort) return nextSort === "pack" ? "asc" : "desc";
  return currentDirection === "asc" ? "desc" : "asc";
}

export function catalogHeaderAriaSort(
  header: AllPacksHeader,
  currentSort: PublicCatalogSort,
  currentDirection: CatalogSortDirection,
  search: string,
): "ascending" | "descending" | "none" | undefined {
  if (!header.sort || search) return undefined;
  if (header.sort !== currentSort) return "none";
  return currentDirection === "asc" ? "ascending" : "descending";
}

export function publicRowActions(pack: PublicPackSummary): Readonly<{
  promo: boolean;
  packLink: boolean;
}> {
  return Object.freeze({
    promo: pack.actionAvailability.promo,
    packLink:
      pack.availability === "active" && pack.actionAvailability.packLink,
  });
}
