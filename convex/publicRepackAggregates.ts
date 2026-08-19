import type {
  ContextualRepackFacets,
  DashboardKpis,
  PublicRepackFilters,
} from "@packscout/contracts";
import {
  rowMatchesFilters,
  rowMatchesSearch,
  type RepackSearchRow,
} from "./publicRepackValidation";

/**
 * The subset of category detail the facet tree needs. The active provider
 * catalog already carries parent and depth on every category, so callers pass
 * its `categoryByPublicId` map straight through.
 */
export type CategoryHierarchy = ReadonlyMap<
  string,
  Readonly<{ parentPublicCategoryId: string | null; depth: number }>
>;

export function selectionsAreKnown(
  rows: readonly RepackSearchRow[],
  filters: PublicRepackFilters,
): boolean {
  const vendors = new Set(rows.map((row) => row.vendorKey));
  const categories = new Set(rows.flatMap((row) => row.publicCategoryIds));
  const collectibleTypes = new Set(rows.flatMap((row) => row.collectibleTypes));
  return (
    filters.vendors.every((key) => vendors.has(key)) &&
    filters.categories.every((id) => categories.has(id)) &&
    filters.collectibleTypes.every((type) => collectibleTypes.has(type))
  );
}

export function matchingRepackRows(
  rows: readonly RepackSearchRow[],
  filters: PublicRepackFilters,
  search: string,
): RepackSearchRow[] {
  return rows.filter(
    (row) => rowMatchesSearch(row, search) && rowMatchesFilters(row, filters),
  );
}

export function medianPackScoutEvPercent(
  rows: readonly RepackSearchRow[],
): DashboardKpis["medianPackScoutEvPercent"] {
  const values = rows
    .flatMap((row) =>
      row.packScoutEvPercentBasisPoints === null
        ? []
        : [row.packScoutEvPercentBasisPoints],
    )
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return {
      status: "unavailable",
      basisPoints: null,
      reason: "ESTIMATE_UNAVAILABLE",
    };
  }
  const middle = Math.floor(values.length / 2);
  const basisPoints =
    values.length % 2 === 1
      ? values[middle]!
      : Math.round((values[middle - 1]! + values[middle]!) / 2);
  return { status: "available", basisPoints };
}

export function dashboardKpis(
  rows: readonly RepackSearchRow[],
): DashboardKpis {
  const chaseValues = rows.flatMap((row) =>
    row.topChaseValueMinor === null ? [] : [row.topChaseValueMinor],
  );
  return {
    totalRepacks: rows.length,
    positiveEvRepacks: rows.filter(
      (row) =>
        row.packScoutEvDollarsMinor !== null &&
        row.packScoutEvDollarsMinor > 0,
    ).length,
    medianPackScoutEvPercent: medianPackScoutEvPercent(rows),
    highestChaseValueUsdMinor:
      chaseValues.length === 0 ? null : Math.max(...chaseValues),
    highConfidenceRepacks: rows.filter(
      (row) =>
        row.packScoutConfidenceBasisPoints !== null &&
        row.packScoutConfidenceBasisPoints >= 8_000,
    ).length,
  };
}

export function contextualFacets(
  universeRows: readonly RepackSearchRow[],
  countableRows: readonly RepackSearchRow[],
  filters: PublicRepackFilters,
  search: string,
  categoryHierarchy: CategoryHierarchy,
): ContextualRepackFacets {
  const vendorLabels = new Map<string, string>();
  const categoryLabels = new Map<string, string>();
  const collectibleTypeLabels = new Map<string, string>();
  for (const row of universeRows) {
    vendorLabels.set(row.vendorKey, row.vendorDisplayName);
    row.publicCategoryIds.forEach((id, index) =>
      categoryLabels.set(id, row.categoryLabels[index] ?? id),
    );
    row.collectibleTypes.forEach((type) =>
      collectibleTypeLabels.set(
        type,
        type
          .split("_")
          .map((part) => part[0]!.toUpperCase() + part.slice(1))
          .join(" "),
      ),
    );
  }
  const searched = countableRows.filter((row) => rowMatchesSearch(row, search));
  const vendorCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const collectibleTypeCounts = new Map<string, number>();
  for (const row of searched) {
    if (rowMatchesFilters(row, filters, { ignoreVendors: true })) {
      vendorCounts.set(row.vendorKey, (vendorCounts.get(row.vendorKey) ?? 0) + 1);
    }
    if (rowMatchesFilters(row, filters, { ignoreCategories: true })) {
      for (const id of row.publicCategoryIds) {
        categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
      }
    }
    const withoutTypes = {
      ...filters,
      collectibleTypes: [] as typeof filters.collectibleTypes,
    };
    if (rowMatchesFilters(row, withoutTypes)) {
      for (const type of row.collectibleTypes) {
        collectibleTypeCounts.set(
          type,
          (collectibleTypeCounts.get(type) ?? 0) + 1,
        );
      }
    }
  }
  const options = (
    labels: ReadonlyMap<string, string>,
    counts: ReadonlyMap<string, number>,
    selected: readonly string[],
  ) =>
    [...labels]
      .map(([key, label]) => ({
        key,
        label,
        repackCount: counts.get(key) ?? 0,
        selected: selected.includes(key),
      }))
      .filter((option) => option.repackCount > 0 || option.selected)
      .sort((left, right) => left.key.localeCompare(right.key));

  const categories = [...categoryLabels]
    .map(([key, label]) => {
      const node = categoryHierarchy.get(key);
      return {
        key,
        label,
        repackCount: categoryCounts.get(key) ?? 0,
        selected: filters.categories.includes(key),
        parentKey: node?.parentPublicCategoryId ?? null,
        depth: node?.depth ?? 0,
      };
    })
    .filter((option) => option.repackCount > 0 || option.selected)
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    vendors: options(vendorLabels, vendorCounts, filters.vendors),
    categories,
    collectibleTypes: options(
      collectibleTypeLabels,
      collectibleTypeCounts,
      filters.collectibleTypes,
    ),
  };
}

export function repackSummaries(
  rows: readonly RepackSearchRow[],
  group: "vendor" | "category",
) {
  const groups = new Map<
    string,
    { label: string; rows: RepackSearchRow[] }
  >();
  for (const row of rows) {
    if (group === "vendor") {
      const existing = groups.get(row.vendorKey);
      if (existing) existing.rows.push(row);
      else {
        groups.set(row.vendorKey, {
          label: row.vendorDisplayName,
          rows: [row],
        });
      }
      continue;
    }
    row.publicCategoryIds.forEach((categoryId, index) => {
      const existing = groups.get(categoryId);
      if (existing) existing.rows.push(row);
      else {
        groups.set(categoryId, {
          label: row.categoryLabels[index] ?? categoryId,
          rows: [row],
        });
      }
    });
  }
  return [...groups]
    .map(([key, value]) => ({
      key,
      label: value.label,
      repackCount: value.rows.length,
      medianPackScoutEvPercent: medianPackScoutEvPercent(value.rows),
    }))
    .sort(
      (left, right) =>
        right.repackCount - left.repackCount || left.key.localeCompare(right.key),
    )
    .slice(0, 5);
}
