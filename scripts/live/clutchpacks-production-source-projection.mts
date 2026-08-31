import type { ClutchpacksProductionSourceCatalog } from "./clutchpacks-production-source-catalog.mts";
import { clutchpacksPublicValuationFields } from "../local/distributed-clutchpacks-content-snapshot.mts";

/** The complete provider catalog is distinct from its current pack memberships. */
export function clutchpacksProductionSourceProjection(source: Pick<ClutchpacksProductionSourceCatalog, "facts" | "canonicalCatalog">) {
  const catalog = source.canonicalCatalog;
  const categoryNames = new Map(catalog.categories.map(row => [row.id, row.display_name]));
  const category = (id: string | null) => {
    if (id === null) return null;
    const value = categoryNames.get(id);
    if (value === undefined) throw new Error("CLUTCHPACKS_PRODUCTION_CATEGORY_REFERENCE_INVALID");
    return value;
  };
  const aliases = new Map<string, string[]>();
  for (const row of catalog.aliases) aliases.set(row.collectible_id, [...(aliases.get(row.collectible_id) ?? []), row.display_name]);
  return {
    snapshot: { facts: { ...source.facts, contentCatalog: { ...source.facts.contentCatalog,
      collectibles: catalog.collectibles.map(row => ({
        id: row.id, rowVersion: row.row_version, collectibleKey: row.collectible_key, collectibleType: row.collectible_type,
        displayName: row.display_name, aliases: aliases.get(row.id) ?? [], year: row.year, brand: row.brand,
        setOrSeries: row.set_or_series, cardNumber: row.card_number, referenceNumber: row.reference_number,
        subject: row.subject, grade: row.grade, grader: row.grader, primaryImageUrl: row.primary_image_url,
        primaryImageAlt: row.primary_image_alt, valuationAmount: row.valuation_amount?.toString() ?? null,
        valuationCurrency: row.valuation_currency, valuationUsdAmount: row.valuation_usd_amount?.toString() ?? null,
        ...clutchpacksPublicValuationFields({ valuationType: row.valuation_type, valuationUnavailableReason: row.valuation_unavailable_reason }),
        valuationObservedAt: row.valuation_observed_at, dataAsOf: row.data_as_of,
      })),
      aliasRows: catalog.aliases.map(row => ({ id: row.id, rowVersion: row.row_version,
        collectibleId: row.collectible_id, displayName: row.display_name })),
    } } },
    categoryEvidence: {
      packs: new Map(catalog.packs.map(row => [row.pack_key, category(row.category_id)])),
      collectibles: new Map(catalog.collectibles.map(row => [row.collectible_key, category(row.category_id)])),
    },
  };
}
