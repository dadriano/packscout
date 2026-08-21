import type { LogRow } from "../api/panel-types.ts";
import type { CompiledFilter } from "./filter.ts";
import {
  countLines,
  filterGroups,
  flattenGroups,
  groupLogRows,
  type FactsLookup,
  type LogDisplayItem,
  type VisibleGroup,
} from "./line-groups.ts";
import { isPanelMarker } from "./log-buffer.ts";

/**
 * One buffer to one list of rendered rows.
 *
 * The order of operations is the whole point. Visibility is applied *before*
 * grouping, so a hidden service cannot leave orphaned frames behind; grouping
 * happens before filtering, so a filter judges whole events rather than
 * fragments of them; and flattening happens last, so expansion state never
 * changes what matched.
 *
 * Keeping it here, as one pure function, is what lets the page recompute the
 * view on every keystroke without owning any of the reasoning.
 *
 * Panel-scope markers are the one thing service visibility does not apply to.
 * A dropped connection, a return from history, a buffer that had to refuse rows
 * — none of those belong to a service, and hiding them because one service is in
 * focus would let a reader believe the output above and below a seam was
 * continuous when it was not.
 */

export interface LogViewInput {
  rows: readonly LogRow[];
  /** Service visibility: focus and per-service checkboxes, already resolved. */
  isVisible: (service: string) => boolean;
  filter: CompiledFilter;
  facts: FactsLookup;
  expanded: ReadonlySet<string>;
}

export interface LogView {
  items: LogDisplayItem[];
  /**
   * The admitted groups, whole. Copy and export work from these rather than
   * from `items`, so a folded stack trace copies as the event it is instead of
   * as its first line.
   */
  groups: VisibleGroup[];
  /** Lines the filter admits. */
  matched: number;
  /** Lines available to be filtered, in the visible services. */
  total: number;
}

export function buildLogView({
  rows,
  isVisible,
  filter,
  facts,
  expanded,
}: LogViewInput): LogView {
  const visibleRows = rows.filter(
    (row) => isPanelMarker(row) || isVisible(row.service),
  );
  const groups = groupLogRows(visibleRows, facts);
  const admitted = filterGroups(groups, filter, facts);
  const counts = countLines(groups, admitted, filter.active);
  return {
    items: flattenGroups(admitted, expanded),
    groups: admitted,
    matched: counts.matched,
    total: counts.total,
  };
}
