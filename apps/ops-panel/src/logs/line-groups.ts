import type { LogRow } from "../api/panel-types.ts";
import type { CompiledFilter } from "./filter.ts";
import type { LogLineFacts } from "./line-facts.ts";
import { maxSeverity, type LogSeverity } from "./severity.ts";

/**
 * Stack traces, folded back into the single events they always were.
 *
 * Grouping happens *per service*, not by adjacency in the pane. The buffer
 * interleaves every service on one timeline, so a worker's stack frames are
 * routinely separated from their head line by unrelated frontend output;
 * attaching a continuation to the last row of its own service is the only
 * reading that survives interleaving. Markers close the open group for their
 * service, because a restart or a gap means the trace above is over — however it
 * ended, the next indented line is not part of it.
 *
 * Two rules make a folded group behave the way an operator expects:
 *
 *  - the head carries the group's *maximum* severity, so a trace whose message
 *    line is bland still reads as the error its frames describe;
 *  - a group is visible when *any* member matches, so searching for a filename
 *    buried at frame nine still surfaces the event, with the head that explains
 *    it — a search that hid the context would be worse than no search.
 */

export interface LogGroup {
  /** The head row's id: stable, since row identity is derived from bytes. */
  id: string;
  head: LogRow;
  /** Continuation rows, in stream order, excluding the head. */
  members: readonly LogRow[];
  /** The worst severity across the head and every member. */
  severity: LogSeverity;
}

export interface VisibleGroup extends LogGroup {
  /** Ids of the rows that matched the filter, head included. */
  matchedIds: ReadonlySet<string>;
  /** True when the head itself matched, rather than only a member. */
  headMatched: boolean;
}

export type FactsLookup = (row: LogRow) => LogLineFacts;

interface OpenGroup {
  head: LogRow;
  members: LogRow[];
  severity: LogSeverity;
}

function sealed(group: OpenGroup): LogGroup {
  return {
    id: group.head.id,
    head: group.head,
    members: group.members,
    severity: group.severity,
  };
}

/**
 * Fold rows into groups, preserving head order.
 *
 * Members may sit far from their head in the source order; emitting groups in
 * head order is what keeps the interleaved timeline readable.
 */
export function groupLogRows(
  rows: readonly LogRow[],
  facts: FactsLookup,
): LogGroup[] {
  const ordered: OpenGroup[] = [];
  const openByService = new Map<string, OpenGroup>();

  for (const row of rows) {
    const { severity, continuation } = facts(row);
    const current = openByService.get(row.service);
    const continues =
      continuation &&
      current !== undefined &&
      current.head.type === "line" &&
      row.type === "line" &&
      current.head.generation === row.generation;

    if (continues) {
      current.members.push(row);
      current.severity = maxSeverity(current.severity, severity);
      continue;
    }

    const started: OpenGroup = { head: row, members: [], severity };
    ordered.push(started);
    // A marker ends whatever was open: the trace above it is over, however it
    // ended, and the next indented line does not belong to it.
    if (row.type === "marker") openByService.delete(row.service);
    else openByService.set(row.service, started);
  }

  return ordered.map(sealed);
}

/**
 * Keep the groups the filter admits.
 *
 * Markers always survive: they report restarts, rotations, and skipped output,
 * and a filter that hid them would let a reader believe a stream was continuous
 * when it was not. That is the one lie a log viewer must never tell, and it
 * costs a handful of rows.
 */
export function filterGroups(
  groups: readonly LogGroup[],
  filter: CompiledFilter,
  facts: FactsLookup,
): VisibleGroup[] {
  const visible: VisibleGroup[] = [];
  for (const group of groups) {
    if (group.head.type === "marker" || !filter.active) {
      visible.push({ ...group, matchedIds: new Set(), headMatched: false });
      continue;
    }

    const matchedIds = new Set<string>();
    // The group's severity is the head's badge, so it is what the facet judges;
    // a bland message line must not hide the error its frames report.
    if (filter.admitsSeverity(group.severity)) {
      for (const row of [group.head, ...group.members]) {
        if (filter.matchesText(facts(row).plainText)) matchedIds.add(row.id);
      }
    }
    if (matchedIds.size === 0) continue;
    visible.push({ ...group, matchedIds, headMatched: matchedIds.has(group.head.id) });
  }
  return visible;
}

export interface GroupCounts {
  /** Lines the filter admits (members included); markers are not counted. */
  matched: number;
  /** Lines present before filtering. */
  total: number;
}

export function countLines(
  groups: readonly LogGroup[],
  visible: readonly VisibleGroup[],
  filterActive: boolean,
): GroupCounts {
  let total = 0;
  for (const group of groups) {
    if (group.head.type === "marker") continue;
    total += 1 + group.members.length;
  }
  if (!filterActive) return { matched: total, total };

  let matched = 0;
  for (const group of visible) {
    if (group.head.type === "marker") continue;
    matched += group.matchedIds.size;
  }
  return { matched, total };
}

/** One rendered row: a standalone line, a fold head, or a revealed member. */
export interface LogDisplayItem {
  /** The row's own id; unique across the whole display list. */
  id: string;
  row: LogRow;
  severity: LogSeverity;
  role: "row" | "head" | "member";
  /** True when this row itself matched, rather than merely belonging. */
  matched: boolean;
  /** Head rows only. */
  memberCount: number;
  matchedMembers: number;
  expanded: boolean;
  /** The id of the head this row belongs to. */
  groupId: string;
}

/**
 * Flatten groups for the virtualiser.
 *
 * Groups collapse by default: a folded trace is one row until someone asks for
 * it. Expansion is held by head id rather than by index, so it survives the rows
 * beneath it shifting as the stream advances.
 */
export function flattenGroups(
  groups: readonly VisibleGroup[],
  expanded: ReadonlySet<string>,
): LogDisplayItem[] {
  const items: LogDisplayItem[] = [];
  for (const group of groups) {
    const matchedMembers = group.members.reduce(
      (count, row) => count + (group.matchedIds.has(row.id) ? 1 : 0),
      0,
    );
    const isOpen = expanded.has(group.id);
    items.push({
      id: group.head.id,
      row: group.head,
      severity: group.severity,
      role: group.members.length === 0 ? "row" : "head",
      matched: group.headMatched,
      memberCount: group.members.length,
      matchedMembers,
      expanded: isOpen,
      groupId: group.id,
    });
    if (!isOpen) continue;
    for (const row of group.members) {
      items.push({
        id: row.id,
        row,
        severity: group.severity,
        role: "member",
        matched: group.matchedIds.has(row.id),
        memberCount: 0,
        matchedMembers: 0,
        expanded: false,
        groupId: group.id,
      });
    }
  }
  return items;
}
