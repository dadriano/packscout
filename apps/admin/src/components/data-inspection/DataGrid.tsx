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
  expandedKey = null,
  onToggleExpand,
  renderExpanded,
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
  /** The row currently expanded in place, if any. */
  expandedKey?: string | null;
  onToggleExpand?: (row: Row) => void;
  /** Rendered in a full-width row directly beneath the expanded row. */
  renderExpanded?: (row: Row) => ReactNode;
  orderStatus?: string;
  minWidth?: string;
}) {
  const expandable = Boolean(onToggleExpand && renderExpanded);
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
              {expandable ? (
                <th scope="col" className="grid-table__expander">
                  <span className="admin-visually-hidden">Expand</span>
                </th>
              ) : null}
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
              const expanded = expandable && key === expandedKey;
              const detailId = `grid-detail-${key}`;
              return [
                <tr
                  key={key}
                  data-selected={expanded ? "true" : undefined}
                  data-clickable={expandable ? "true" : undefined}
                  onClick={
                    onToggleExpand ? () => onToggleExpand(row) : undefined
                  }
                >
                  {expandable ? (
                    <td className="grid-table__expander">
                      {/*
                        A real button carries the expanded state and the
                        keyboard affordance; the row click is a convenience on
                        top of it, not the only way in.
                      */}
                      <button
                        type="button"
                        className="grid-table__toggle"
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleExpand?.(row);
                        }}
                      >
                        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                        <span className="admin-visually-hidden">
                          {expanded ? "Collapse record" : "Expand record"}
                        </span>
                      </button>
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-numeric={column.numeric ? "true" : undefined}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>,
                expanded ? (
                  <tr key={`${key}-detail`} className="grid-table__detail-row">
                    <td colSpan={columns.length + 1} id={detailId}>
                      {/*
                        Sticky to the scroller's left edge so the detail stays
                        readable when the table is scrolled sideways.
                      */}
                      <div className="grid-table__detail">
                        {renderExpanded?.(row)}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * A page index, not just next and previous.
 *
 * Renders a window of page numbers around the current one, with first and last
 * anchors and a direct jump box, so reaching page 400 is one action rather than
 * four hundred. The window keeps the control a fixed width whatever the page
 * count is.
 *
 * `pageCount` is null when the total is a floor rather than a count. The index
 * cannot honestly number pages it cannot count, so it degrades to next and
 * previous and says why, instead of inventing a last page that may not exist.
 */
export function pageWindow(
  current: number,
  pageCount: number,
  span = 2,
): readonly number[] {
  const first = Math.max(1, Math.min(current - span, pageCount - span * 2));
  const last = Math.min(pageCount, Math.max(current + span, span * 2 + 1));
  const pages: number[] = [];
  for (let page = first; page <= last; page += 1) pages.push(page);
  return pages;
}

export function GridPagination({
  page,
  pageSize,
  rowCount,
  total,
  totalIsFloor,
  hasMore,
  depthCapped = false,
  pending = false,
  onPage,
}: {
  page: number;
  pageSize: number;
  rowCount: number;
  total: number | null;
  totalIsFloor?: boolean;
  hasMore: boolean;
  depthCapped?: boolean;
  pending?: boolean;
  onPage: (page: number) => void;
}) {
  const start = (page - 1) * pageSize + 1;
  const end = start + rowCount - 1;
  const totalText =
    total === null
      ? null
      : `${total.toLocaleString("en-US")}${totalIsFloor ? "+" : ""}`;
  const label =
    rowCount === 0
      ? "No results"
      : totalText
        ? `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")} of ${totalText}`
        : `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")}`;

  // Only an exact total can be divided into a known number of pages.
  const pageCount =
    total !== null && !totalIsFloor ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const numbers = pageCount === null ? [] : pageWindow(page, pageCount);

  return (
    <nav className="grid-pagination" aria-label="Result pages">
      <p className="grid-pagination__range" aria-live="polite">
        {label}
        {depthCapped ? (
          <span className="grid-pagination__note">
            {" "}
            · deeper pages are beyond this surface&apos;s scan limit — narrow the
            filters to reach them
          </span>
        ) : null}
        {pageCount === null && rowCount > 0 ? (
          <span className="grid-pagination__note">
            {" "}
            · page numbers need an exact count, and this one is a floor
          </span>
        ) : null}
      </p>

      <div className="grid-pagination__actions">
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={page <= 1 || pending}
          onClick={() => onPage(1)}
          aria-label="First page"
        >
          «
        </button>
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={page <= 1 || pending}
          onClick={() => onPage(page - 1)}
        >
          ← Previous
        </button>

        {numbers.map((number) => (
          <button
            key={number}
            type="button"
            className="admin-button admin-button-secondary grid-pagination__page"
            data-current={number === page ? "true" : undefined}
            aria-current={number === page ? "page" : undefined}
            disabled={pending}
            onClick={() => onPage(number)}
          >
            {number.toLocaleString("en-US")}
          </button>
        ))}

        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={!hasMore || pending}
          onClick={() => onPage(page + 1)}
        >
          Next →
        </button>
        {pageCount !== null ? (
          <button
            type="button"
            className="admin-button admin-button-secondary"
            disabled={page >= pageCount || pending}
            onClick={() => onPage(pageCount)}
            aria-label="Last page"
          >
            »
          </button>
        ) : null}

        {pageCount !== null && pageCount > 1 ? (
          <form
            className="grid-pagination__jump"
            onSubmit={(event) => {
              event.preventDefault();
              const field = new FormData(event.currentTarget).get("page");
              const requested = Number(field);
              if (!Number.isInteger(requested) || requested < 1) return;
              onPage(Math.min(requested, pageCount));
            }}
          >
            <label>
              <span>Go to</span>
              <input
                name="page"
                type="number"
                min={1}
                max={pageCount}
                defaultValue={page}
                aria-label={`Go to page, 1 to ${pageCount}`}
              />
            </label>
            <button
              type="submit"
              className="admin-button admin-button-secondary"
              disabled={pending}
            >
              Go
            </button>
          </form>
        ) : null}
      </div>
    </nav>
  );
}
