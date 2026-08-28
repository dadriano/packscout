import type {
  ContextualRepackFacets,
  DashboardKpis,
  PublicRepackFilters,
} from "@packscout/contracts";
import {
  coveredCategoryIds,
  rowMatchesFilters,
  rowMatchesSearch,
  type CategoryHierarchy,
  type RepackSearchRow,
} from "./publicRepackValidation";

export type { CategoryHierarchy } from "./publicRepackValidation";

export function selectionsAreKnown(
  rows: readonly RepackSearchRow[],
  filters: PublicRepackFilters,
  categoryHierarchy: CategoryHierarchy,
): boolean {
  const vendors = new Set(rows.map((row) => row.vendorKey));
  const categories = new Set(
    rows.flatMap((row) => [
      ...coveredCategoryIds(row.publicCategoryIds, categoryHierarchy),
    ]),
  );
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
  categoryHierarchy: CategoryHierarchy,
): RepackSearchRow[] {
  return rows.filter(
    (row) =>
      rowMatchesSearch(row, search) &&
      rowMatchesFilters(row, filters, { categoryHierarchy }),
  );
}

export function availableRepackRows(
  rows: readonly RepackSearchRow[],
): RepackSearchRow[] {
  return rows.filter(({ availability }) => availability === "available");
}

export function deterministicVisibleSelection<
  T extends Readonly<{ publicRepackId: string }>,
>(
  rows: readonly T[],
  preferredPublicRepackId: string | null,
): T | null {
  return rows.find(
    ({ publicRepackId }) => publicRepackId === preferredPublicRepackId,
  ) ?? rows[0] ?? null;
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
  const currentRows = availableRepackRows(rows);
  const chaseValues = currentRows.flatMap((row) =>
    row.topChaseValueMinor === null ? [] : [row.topChaseValueMinor],
  );
  return {
    totalRepacks: rows.length,
    positiveEvRepacks: currentRows.filter(
      (row) =>
        row.packScoutEvDollarsMinor !== null &&
        row.packScoutEvDollarsMinor > 0,
    ).length,
    medianPackScoutEvPercent: medianPackScoutEvPercent(currentRows),
    highestChaseValueUsdMinor:
      chaseValues.length === 0 ? null : Math.max(...chaseValues),
    highConfidenceRepacks: currentRows.filter(
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
  const matchOptions = { categoryHierarchy };
  for (const row of searched) {
    if (rowMatchesFilters(row, filters, { ...matchOptions, ignoreVendors: true })) {
      vendorCounts.set(row.vendorKey, (vendorCounts.get(row.vendorKey) ?? 0) + 1);
    }
    if (rowMatchesFilters(row, filters, { ...matchOptions, ignoreCategories: true })) {
      for (const id of coveredCategoryIds(row.publicCategoryIds, categoryHierarchy)) {
        categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
        if (!categoryLabels.has(id)) {
          const node = categoryHierarchy.get(id);
          if (node !== undefined) categoryLabels.set(id, node.name);
        }
      }
    }
    const withoutTypes = {
      ...filters,
      collectibleTypes: [] as typeof filters.collectibleTypes,
    };
    if (rowMatchesFilters(row, withoutTypes, matchOptions)) {
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

  for (const selectedId of filters.categories) {
    if (categoryLabels.has(selectedId)) continue;
    const node = categoryHierarchy.get(selectedId);
    if (node !== undefined) categoryLabels.set(selectedId, node.name);
  }
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
      medianPackScoutEvPercent: medianPackScoutEvPercent(
        availableRepackRows(value.rows),
      ),
    }))
    .sort(
      (left, right) =>
        right.repackCount - left.repackCount || left.key.localeCompare(right.key),
    )
    .slice(0, 5);
}
