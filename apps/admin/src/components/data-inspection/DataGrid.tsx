import type { ReactNode } from "react";

/**
 * The Data section's table shell.
 *
 * Follows the catalog grid the product uses: a bordered region, a heading row
 * carrying the eyebrow and the current ordering, and a real `<table>` inside its
 * own horizontal scroller. Dense rows in columns beat stacked definition lists
 * for the thing an operator actually does here, which is scan many records and
 * spot the one that looks wrong.
 *
 * The scroller owns the overflow so the page itself never scrolls sideways.
 */

export type GridSortDirection = "asc" | "desc";

export interface DataGridColumn<Row> {
  readonly key: string;
  readonly label: string;
  /** Present when the column can be ordered by. */
  readonly sortable?: boolean;
  /** Right-aligns numerics and timestamps so digits line up. */
  readonly numeric?: boolean;
  readonly render: (row: Row) => ReactNode;
}

export function ariaSortFor(
  column: DataGridColumn<unknown>,
  sortedKey: string | null,
  direction: GridSortDirection,
): "ascending" | "descending" | "none" | undefined {
  if (!column.sortable) return undefined;
  if (column.key !== sortedKey) return "none";
  return direction === "asc" ? "ascending" : "descending";
}

export function DataGrid<Row>({
  eyebrow,
  title,
  columns,
  rows,
  rowKey,
  sortedKey = null,
  direction = "asc",
  onSort,
  selectedKey = null,
  onSelect,
  orderStatus,
  minWidth = "60rem",
}: {
  eyebrow: string;
  title: string;
  columns: readonly DataGridColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  sortedKey?: string | null;
  direction?: GridSortDirection;
  onSort?: (key: string, next: GridSortDirection) => void;
  selectedKey?: string | null;
  onSelect?: (row: Row) => void;
  orderStatus?: string;
  minWidth?: string;
}) {
  return (
    <section className="grid-region" aria-labelledby={`${title}-grid`}>
      <div className="grid-region__heading">
        <div>
          <p className="grid-region__eyebrow">{eyebrow}</p>
          <h2 className="grid-region__title" id={`${title}-grid`}>
            {title}
          </h2>
        </div>
        {orderStatus ? (
          <p className="grid-region__order" aria-live="polite">
            {orderStatus}
          </p>
        ) : null}
      </div>

      <div className="grid-scroller" tabIndex={0} role="group" aria-label={`${title} table`}>
        <table className="grid-table" style={{ minWidth }}>
          <thead>
            <tr>
              {columns.map((column) => {
                const sorted = column.key === sortedKey;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-numeric={column.numeric ? "true" : undefined}
                    aria-sort={ariaSortFor(
                      column as DataGridColumn<unknown>,
                      sortedKey,
                      direction,
                    )}
                  >
                    {column.sortable && onSort ? (
                      <button
                        type="button"
                        className="grid-table__sort"
                        onClick={() =>
                          onSort(
                            column.key,
                            // Re-clicking the sorted column flips it; a new
                            // column starts ascending.
                            sorted && direction === "asc" ? "desc" : "asc",
                          )
                        }
                      >
                        {column.label}
                        <span aria-hidden="true" className="grid-table__caret">
                          {sorted ? (direction === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  data-selected={key === selectedKey ? "true" : undefined}
                  onClick={onSelect ? () => onSelect(row) : undefined}
                  data-clickable={onSelect ? "true" : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-numeric={column.numeric ? "true" : undefined}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Position within the result set, not just a page number.
 *
 * The total comes from the kind summary, which knows whether it is exact or a
 * floor — so a bounded count reads "51–75 of 50,000+" rather than claiming a
 * precision the count does not have.
 */
export function GridPagination({
  start,
  end,
  total,
  totalIsFloor,
  hasPrevious,
  hasNext,
  pending = false,
  onPrevious,
  onNext,
}: {
  start: number;
  end: number;
  total: number | null;
  totalIsFloor?: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  pending?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const totalText =
    total === null
      ? null
      : `${total.toLocaleString("en-US")}${totalIsFloor ? "+" : ""}`;
  const label =
    end === 0
      ? "No results"
      : totalText
        ? `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")} of ${totalText}`
        : `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")}`;

  return (
    <nav className="grid-pagination" aria-label="Result pages">
      <p className="grid-pagination__range" aria-live="polite">
        {label}
      </p>
      <div className="grid-pagination__actions">
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={!hasPrevious || pending}
          onClick={onPrevious}
        >
          ← Previous
        </button>
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={!hasNext || pending}
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </nav>
  );
}
