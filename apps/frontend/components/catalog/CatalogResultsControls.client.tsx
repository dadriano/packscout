"use client";

import type { PublicRepackSort } from "@packscout/contracts";
import {
  CATALOG_PAGE_SIZES,
  type CatalogPageSize,
  type CatalogViewLayout,
} from "@/lib/catalog-query-state.client";
import { ALL_REPACKS_HEADERS, type CatalogSortDirection } from "@/lib/all-repacks-table";
import styles from "./CatalogResultsControls.module.css";

type CatalogResultsControlsProps = Readonly<{
  layout: CatalogViewLayout;
  pageSize: CatalogPageSize;
  sort: PublicRepackSort;
  direction: CatalogSortDirection;
  searchActive: boolean;
  desiredSearchActive: boolean;
  pending?: boolean;
  onLayoutChange: (layout: CatalogViewLayout) => void;
  onPageSizeChange: (pageSize: CatalogPageSize) => void;
  onSort: (sort: PublicRepackSort, direction: CatalogSortDirection) => void;
}>;

export function CatalogResultsControls({
  layout,
  pageSize,
  sort,
  direction,
  searchActive,
  desiredSearchActive,
  pending = false,
  onLayoutChange,
  onPageSizeChange,
  onSort,
}: CatalogResultsControlsProps) {
  const sortOptions = ALL_REPACKS_HEADERS.filter(
    (header) => header.sort !== undefined &&
      !(desiredSearchActive && header.sort === "top_chase_value"),
  );
  const sortLabel = searchActive
    ? "Ordered by relevance"
    : `Sorted by ${sortOptions.find((option) => option.sort === sort)?.label ?? "EV $"}, ${direction === "asc" ? "ascending" : "descending"}`;

  return (
    <div className={styles.root}>
      <p aria-live="polite" className={styles.status}>{sortLabel}</p>
      {!searchActive ? (
        <div className={styles.sortControls}>
          <label className={styles.field}>
            <span>Sort</span>
            <select
              disabled={pending}
              onChange={(event) =>
                onSort(event.currentTarget.value as PublicRepackSort, direction)
              }
              value={sort}
            >
              {sortOptions.map((option) => (
                <option key={option.key} value={option.sort}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            aria-label={`Sort ${direction === "asc" ? "descending" : "ascending"}`}
            className={styles.direction}
            disabled={pending}
            onClick={() => onSort(sort, direction === "asc" ? "desc" : "asc")}
            title={`Sort ${direction === "asc" ? "descending" : "ascending"}`}
            type="button"
          >
            <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>
          </button>
        </div>
      ) : null}
      <label className={styles.field}>
        <span>Per page</span>
        <select
          disabled={pending}
          onChange={(event) => onPageSizeChange(Number(event.currentTarget.value) as CatalogPageSize)}
          value={pageSize}
        >
          {CATALOG_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </label>
      <div aria-label="Repack view" className={styles.viewToggle} role="group">
        <button
          aria-pressed={layout === "table"}
          disabled={pending}
          onClick={() => onLayoutChange("table")}
          type="button"
        >
          Table
        </button>
        <button
          aria-pressed={layout === "cards"}
          disabled={pending}
          onClick={() => onLayoutChange("cards")}
          type="button"
        >
          Cards
        </button>
      </div>
    </div>
  );
}
