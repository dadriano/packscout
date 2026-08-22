import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRow } from "../api/panel-types.ts";
import {
  exportFileName,
  renderExportDocument,
  renderGroupText,
  renderVisibleText,
} from "./export.ts";
import { readLineFacts } from "./line-facts.ts";
import type { VisibleGroup } from "./line-groups.ts";

function line(service: string, offset: number, text: string): LogRow {
  return {
    type: "line",
    id: `line:${service}:1:${offset}`,
    service,
    generation: 1,
    offset,
    endOffset: offset + text.length + 1,
    text,
    observedAt: "2026-08-19T12:00:00.000Z",
    backfilled: false,
    partial: false,
  };
}

function group(head: LogRow, members: LogRow[] = []): VisibleGroup {
  return {
    id: head.id,
    head,
    members,
    severity: "error",
    matchedIds: new Set([head.id]),
    headMatched: true,
  };
}

const facts = readLineFacts;

const trace = group(line("worker", 0, "Error: boom"), [
  line("worker", 20, "    at claim (worker.ts:12)"),
  line("worker", 60, "    at run (worker.ts:40)"),
]);

test("a folded group copies whole, not just the line that is on screen", () => {
  assert.equal(
    renderGroupText(trace, facts, { prefixService: false }),
    ["Error: boom", "    at claim (worker.ts:12)", "    at run (worker.ts:40)"].join(
      "\n",
    ),
  );
});

test("the unified view prefixes each line with the service that wrote it", () => {
  assert.equal(
    renderGroupText(group(line("admin", 0, "listening")), facts, {
      prefixService: true,
    }),
    "admin  listening",
  );
});

test("terminal colour never reaches an export", () => {
  const coloured = group(line("worker", 0, "[31mred alert[0m"));
  assert.equal(
    renderGroupText(coloured, facts, { prefixService: false }),
    "red alert",
  );
});

test("visible lines export in display order, groups intact", () => {
  const text = renderVisibleText([trace, group(line("admin", 5, "ready"))], facts, {
    prefixService: true,
  });
  assert.deepEqual(text.split("\n"), [
    "worker  Error: boom",
    "worker      at claim (worker.ts:12)",
    "worker      at run (worker.ts:40)",
    "admin  ready",
  ]);
});

test("an exported file says what it covers and whether anything was hidden", () => {
  const document = renderExportDocument({
    groups: [trace],
    facts,
    scope: "worker",
    at: new Date("2026-08-19T09:30:00.000Z"),
    filterActive: true,
    matched: 3,
    total: 812,
  });
  const lines = document.split("\n");
  assert.equal(lines[0], "# PackScout log export — worker");
  assert.equal(lines[1], "# Taken 2026-08-19T09:30:00.000Z");
  assert.equal(lines[2], "# Filtered: 3 of 812 buffered lines matched.");
  assert.equal(lines[3], "");
  assert.equal(lines[4], "Error: boom");
  assert.ok(document.endsWith("\n"));
});

test("an unfiltered export does not imply a filter was applied", () => {
  const document = renderExportDocument({
    groups: [trace],
    facts,
    scope: null,
    at: new Date("2026-08-19T09:30:00.000Z"),
    filterActive: false,
    matched: 3,
    total: 3,
  });
  assert.match(document, /# Unfiltered: 3 buffered lines\./u);
  assert.match(document, /^worker {2}Error: boom$/mu);
});

test("an export is named by its scope and the moment it was taken", () => {
  const at = new Date(2026, 7, 19, 14, 5, 9);
  assert.equal(exportFileName("worker", at), "packscout-worker-20260819-140509.log");
  assert.equal(exportFileName(null, at), "packscout-all-services-20260819-140509.log");
});
