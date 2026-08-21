import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRow } from "../api/panel-types.ts";
import {
  ALL_SEVERITIES,
  compileFilter,
  ERRORS_PRESET,
  type FilterSpec,
} from "./filter.ts";
import { createLineFactsCache } from "./line-facts.ts";
import { buildLogView } from "./log-view.ts";

let sequence = 0;

function line(text: string, service = "worker"): LogRow {
  sequence += 1;
  return {
    type: "line",
    id: `line:${service}:1:${sequence * 100}`,
    service,
    generation: 1,
    offset: sequence * 100,
    endOffset: sequence * 100 + text.length + 1,
    text,
    observedAt: "2026-08-20T10:00:00.000Z",
    backfilled: false,
    partial: false,
  };
}

function panelMarker(detail: string): LogRow {
  sequence += 1;
  return {
    type: "marker",
    id: `marker:*:0:0:restarted:client-${sequence}`,
    kind: "restarted",
    reason: "browsing",
    service: "*",
    generation: 0,
    offset: 0,
    observedAt: "2026-08-20T10:00:00.000Z",
    detail,
  };
}

function view(
  rows: readonly LogRow[],
  options: {
    hidden?: ReadonlySet<string>;
    spec?: Partial<FilterSpec>;
    expanded?: ReadonlySet<string>;
  } = {},
) {
  const hidden = options.hidden ?? new Set<string>();
  return buildLogView({
    rows,
    isVisible: (service) => !hidden.has(service),
    filter: compileFilter({
      draft: options.spec?.draft ?? null,
      terms: options.spec?.terms ?? [],
      severities: options.spec?.severities ?? ALL_SEVERITIES,
    }),
    facts: createLineFactsCache().facts,
    expanded: options.expanded ?? new Set(),
  });
}

test("hiding a service takes its stack frames with it", () => {
  const rows = [
    line("ERROR import failed", "worker"),
    line("    at run (/app/worker.ts:14:9)", "worker"),
    line("GET /api/packs 200", "frontend"),
  ];
  const hiddenWorker = view(rows, { hidden: new Set(["worker"]) });
  assert.equal(hiddenWorker.items.length, 1, "no orphaned frame is left behind");
  assert.equal(hiddenWorker.items[0]?.row.service, "frontend");
  assert.equal(hiddenWorker.total, 1, "the count describes what is on screen");
});

test("counts describe lines, and folding does not change them", () => {
  const rows = [
    line("ERROR import failed"),
    line("    at run (/app/worker.ts:14:9)"),
    line("ready"),
  ];
  const collapsed = view(rows);
  const expanded = view(rows, { expanded: new Set([rows[0]!.id]) });
  assert.equal(collapsed.total, 3);
  assert.equal(expanded.total, 3);
  assert.equal(collapsed.items.length, 2, "the trace is one row until asked for");
  assert.equal(expanded.items.length, 3);
});

test("the whole pipeline narrows to the matching event, head included", () => {
  const rows = [
    line("ERROR import failed"),
    line("    at parseRow (/app/quarantine.ts:9:2)"),
    line("ready in 3ms"),
    line("GET /api/packs 200", "frontend"),
  ];
  const narrowed = view(rows, {
    spec: {
      terms: [
        { id: "a", text: "quarantine", negated: false, regex: false, caseSensitive: false },
      ],
      severities: ERRORS_PRESET,
    },
  });
  assert.equal(narrowed.items.length, 1);
  assert.equal(narrowed.items[0]?.severity, "error");
  assert.equal(narrowed.matched, 1, "one line matched");
  assert.equal(narrowed.total, 4, "out of four");
  assert.equal(narrowed.groups.length, 1);
  assert.equal(narrowed.groups[0]?.members.length, 1, "copy still gets the frame");
});

test("a panel-wide marker survives focusing on one service", () => {
  // Focus hides other services' output; a seam belongs to the pane itself, and
  // hiding it would let the reader believe the stream was continuous.
  const result = view([line("worker output"), panelMarker("Returned to live."), line("admin output", "admin")], {
    hidden: new Set(["admin"]),
  });
  assert.deepEqual(
    result.items.map((item) =>
      item.row.type === "marker" ? item.row.detail : item.row.text,
    ),
    ["worker output", "Returned to live."],
  );
});
