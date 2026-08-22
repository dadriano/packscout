import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRow } from "../api/panel-types.ts";
import {
  createLineFactsCache,
  logRowPlainText,
  readLineFacts,
} from "./line-facts.ts";

const ESC = String.fromCharCode(27);
const ARRIVAL = "2026-08-20T10:00:00.000Z";

function line(text: string, offset = 0): LogRow {
  return {
    type: "line",
    id: `line:worker:1:${offset}`,
    service: "worker",
    generation: 1,
    offset,
    endOffset: offset + text.length + 1,
    text,
    observedAt: ARRIVAL,
    backfilled: false,
    partial: false,
  };
}

test("facts are read from the canonical plain text, not the styled bytes", () => {
  const facts = readLineFacts(line(`${ESC}[31mERROR${ESC}[0m import failed`));
  assert.equal(facts.plainText, "ERROR import failed");
  assert.equal(facts.severity, "error");
  assert.equal(facts.continuation, false);
});

test("a stack frame is a continuation with no severity of its own", () => {
  const facts = readLineFacts(line("    at run (/app/worker.ts:14:9)"));
  assert.equal(facts.continuation, true);
  assert.equal(facts.severity, "unknown");
});

test("a line without its own stamp falls back to arrival, marked approximate", () => {
  assert.deepEqual(readLineFacts(line("plain output")).time, {
    at: ARRIVAL,
    approximate: true,
    source: "arrival",
  });
  assert.deepEqual(readLineFacts(line("2026-08-20T09:59:00Z started")).time, {
    at: "2026-08-20T09:59:00.000Z",
    approximate: false,
    source: "line",
  });
});

test("a marker reports the stream, so it carries no severity", () => {
  const marker: LogRow = {
    type: "marker",
    id: "marker:worker:2:0",
    kind: "restarted",
    reason: "truncated",
    service: "worker",
    generation: 2,
    offset: 0,
    observedAt: ARRIVAL,
    detail: "worker.log was truncated; following the new file.",
  };
  const facts = readLineFacts(marker);
  assert.equal(facts.severity, "unknown");
  assert.equal(facts.continuation, false);
  assert.equal(facts.plainText, "--- worker.log was truncated; following the new file. ---");
  assert.equal(logRowPlainText(marker), facts.plainText);
});

test("facts are computed once per row and reused", () => {
  const cache = createLineFactsCache();
  const row = line("ERROR boom");
  assert.equal(cache.facts(row), cache.facts(row));
  assert.equal(cache.size(), 1);
});

test("the cache is bounded, evicting the oldest rows first", () => {
  const cache = createLineFactsCache(2);
  cache.facts(line("one", 0));
  cache.facts(line("two", 10));
  cache.facts(line("three", 20));
  assert.equal(cache.size(), 2);
  cache.clear();
  assert.equal(cache.size(), 0);
});
