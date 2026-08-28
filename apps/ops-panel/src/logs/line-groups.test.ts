import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRow } from "../api/panel-types.ts";
import {
  ALL_SEVERITIES,
  compileFilter,
  ERRORS_PRESET,
  type FilterSpec,
  type FilterTerm,
} from "./filter.ts";
import { createLineFactsCache } from "./line-facts.ts";
import {
  countLines,
  filterGroups,
  flattenGroups,
  groupLogRows,
} from "./line-groups.ts";

const ARRIVAL = "2026-08-20T10:00:00.000Z";

let sequence = 0;

function line(text: string, service = "worker", generation = 1): LogRow {
  sequence += 1;
  const offset = sequence * 100;
  return {
    type: "line",
    id: `line:${service}:${generation}:${offset}`,
    service,
    generation,
    offset,
    endOffset: offset + text.length + 1,
    text,
    observedAt: ARRIVAL,
    backfilled: false,
    partial: false,
  };
}

function marker(service = "worker"): LogRow {
  sequence += 1;
  return {
    type: "marker",
    id: `marker:${service}:2:${sequence}`,
    kind: "restarted",
    reason: "truncated",
    service,
    generation: 2,
    offset: sequence,
    observedAt: ARRIVAL,
    detail: `${service}.log restarted`,
  };
}

function facts() {
  return createLineFactsCache().facts;
}

function filterFor(terms: readonly FilterTerm[], severities = ALL_SEVERITIES) {
  const spec: FilterSpec = { draft: null, terms, severities };
  return compileFilter(spec);
}

function term(text: string, overrides: Partial<FilterTerm> = {}): FilterTerm {
  return {
    id: overrides.id ?? `t-${text}`,
    text,
    negated: overrides.negated ?? false,
    regex: overrides.regex ?? false,
    caseSensitive: overrides.caseSensitive ?? false,
  };
}

test("a stack trace folds into one group under its head", () => {
  const rows = [
    line("ERROR import failed"),
    line("    at run (/app/worker.ts:14:9)"),
    line("    at main (/app/index.ts:2:1)"),
    line("... 3 more"),
    line("ready"),
  ];
  const groups = groupLogRows(rows, facts());
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.members.length, 3);
  assert.equal(groups[1]?.members.length, 0);
});

test("the head carries the group's worst severity", () => {
  const groups = groupLogRows(
    [
      line("Traceback (most recent call last):"),
      line('  File "run.py", line 42, in main'),
      line("  ValueError: bad row"),
    ],
    facts(),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.severity, "error");
});

test("continuations attach to their own service, not to whatever printed last", () => {
  const head = line("ERROR import failed", "worker");
  const noise = line("GET /api/packs 200", "frontend");
  const frame = line("    at run (/app/worker.ts:14:9)", "worker");
  const groups = groupLogRows([head, noise, frame], facts());
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.head.id, head.id);
  assert.deepEqual(
    groups[0]?.members.map((row) => row.id),
    [frame.id],
  );
  assert.equal(groups[1]?.head.id, noise.id);
});

test("a marker closes the trace above it", () => {
  const groups = groupLogRows(
    [line("ERROR boom"), marker(), line("    at run (/app/worker.ts:1:1)")],
    facts(),
  );
  assert.equal(groups.length, 3, "the frame after a restart starts its own group");
});

test("a continuation with nothing above it stands on its own", () => {
  const groups = groupLogRows([line("    at run (/app/worker.ts:14:9)")], facts());
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.members.length, 0);
});

test("a group is visible when any member matches, head included", () => {
  const lookup = facts();
  const head = line("ERROR import failed");
  const frame = line("    at parseRow (/app/quarantine.ts:9:2)");
  const other = line("ready");
  const groups = groupLogRows([head, frame, other], lookup);

  const visible = filterGroups(groups, filterFor([term("quarantine.ts")]), lookup);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.head.id, head.id);
  assert.equal(visible[0]?.headMatched, false, "the head is shown for context");
  assert.deepEqual([...(visible[0]?.matchedIds ?? [])], [frame.id]);
});

test("the facet judges a group by its head's badge, not by each frame", () => {
  const lookup = facts();
  const groups = groupLogRows(
    [line("ERROR import failed"), line("    at run (/app/worker.ts:14:9)"), line("ready in 3ms")],
    lookup,
  );
  const visible = filterGroups(groups, filterFor([], ERRORS_PRESET), lookup);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.severity, "error");
  assert.equal(
    visible[0]?.matchedIds.size,
    2,
    "the frames match too, so expanding shows them highlighted",
  );
});

test("an exclude vetoes a group even when another member matched", () => {
  const lookup = facts();
  const groups = groupLogRows(
    [line("ERROR import failed"), line("    at poller (/app/poller.ts:3:1)")],
    lookup,
  );
  const visible = filterGroups(
    groups,
    filterFor([term("import"), term("poller", { negated: true })]),
    lookup,
  );
  assert.equal(visible.length, 1);
  assert.deepEqual(
    [...(visible[0]?.matchedIds ?? [])],
    [groups[0]?.head.id],
    "the vetoed frame is not counted as a match",
  );
});

test("markers survive every filter, because a hidden gap is a lie", () => {
  const lookup = facts();
  const groups = groupLogRows([line("ready"), marker()], lookup);
  const visible = filterGroups(groups, filterFor([term("nothing matches this")]), lookup);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.head.type, "marker");
});

test("counts report matched lines against every line, markers excluded", () => {
  const lookup = facts();
  const rows = [
    line("ERROR import failed"),
    line("    at run (/app/worker.ts:14:9)"),
    line("ready"),
    marker(),
  ];
  const groups = groupLogRows(rows, lookup);

  const unfiltered = compileFilter({ draft: null, terms: [], severities: ALL_SEVERITIES });
  assert.deepEqual(
    countLines(groups, filterGroups(groups, unfiltered, lookup), unfiltered.active),
    { matched: 3, total: 3 },
  );

  const narrowed = filterFor([term("import")]);
  assert.deepEqual(
    countLines(groups, filterGroups(groups, narrowed, lookup), narrowed.active),
    { matched: 1, total: 3 },
  );
});

test("groups collapse by default and expand in place", () => {
  const lookup = facts();
  const head = line("ERROR import failed");
  const frame = line("    at run (/app/worker.ts:14:9)");
  const groups = filterGroups(
    groupLogRows([head, frame], lookup),
    filterFor([term("worker.ts")]),
    lookup,
  );

  const collapsed = flattenGroups(groups, new Set());
  assert.deepEqual(
    collapsed.map((item) => [item.id, item.role, item.memberCount, item.matchedMembers]),
    [[head.id, "head", 1, 1]],
  );
  assert.equal(collapsed[0]?.matched, false, "the head itself did not match");

  const expanded = flattenGroups(groups, new Set([head.id]));
  assert.deepEqual(
    expanded.map((item) => [item.id, item.role, item.matched]),
    [
      [head.id, "head", false],
      [frame.id, "member", true],
    ],
  );
  assert.equal(expanded[1]?.groupId, head.id);
});

test("a group with no members renders as an ordinary row", () => {
  const lookup = facts();
  const groups = filterGroups(groupLogRows([line("ready")], lookup), filterFor([]), lookup);
  const items = flattenGroups(groups, new Set());
  assert.equal(items[0]?.role, "row");
  assert.equal(items[0]?.memberCount, 0);
});
