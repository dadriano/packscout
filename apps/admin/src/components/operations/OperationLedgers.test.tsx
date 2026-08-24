import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { QuarantineEntrySummary } from "@packscout/contracts";
import type { ImportRunSummary } from "../../api/import-operations";
import { QuarantineLedger } from "./QuarantineLedger.tsx";
import { RunLedger } from "./RunLedger.tsx";

const run: ImportRunSummary = {
  id: "00000000-0000-4000-8000-000000000030",
  providerId: "00000000-0000-4000-8000-000000000020",
  providerName: "Fanatics cards",
  platformKey: "fanatics",
  configurationRevisionId: "00000000-0000-4000-8000-000000000021",
  configurationVersion: 2,
  trigger: "manual",
  state: "incomplete",
  requestedAt: "2026-08-06T12:00:00.000Z",
  startedAt: "2026-08-06T12:00:01.000Z",
  finishedAt: "2026-08-06T12:01:00.000Z",
  lastProgressAt: "2026-08-06T12:00:55.000Z",
  reachedProviderHead: false,
  counters: { pages: 2, catalog: 3, pulls: 4, trades: 5, accepted: 9, unchanged: 2, revised: 1, quarantined: 2, resolvedQuarantines: 1 },
  failure: { class: "contract", code: "IMPORT_INVALID_CONTRACT", summary: "Provider response failed validation." },
};

const quarantine: QuarantineEntrySummary = {
  id: "00000000-0000-4000-8000-000000000040",
  providerId: run.providerId,
  configurationRevisionId: run.configurationRevisionId,
  platformKey: "fanatics",
  runId: run.id,
  pageId: "00000000-0000-4000-8000-000000000031",
  recordKind: "catalog",
  recordIndex: 0,
  externalId: "safe-source-42",
  reasonCode: "MAPPING_FAILED",
  fieldPath: "item.value",
  sanitizedSummary: "The item could not be mapped.",
  state: "expired",
  attemptCount: 2,
  firstFailureAt: "2026-08-06T12:00:30.000Z",
  latestFailureAt: "2026-08-06T12:02:30.000Z",
  rawExpiresAt: "2026-08-06T12:02:31.000Z",
  resolvedAt: null,
  resolutionSummary: null,
};

test("run ledger keeps historical outcome separate from current quarantine resolution", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(<MemoryRouter><RunLedger runs={[run]} /></MemoryRouter>);
  assert.match(html, /Incomplete/);
  assert.match(html, /2 created · 1 now resolved/);
  assert.match(html, /Provider response failed validation/);
  assert.match(html, /Provider head/);
  assert.doesNotMatch(html, /rawPayload|walletAddress|username|bearerToken/i);
});

test("expired quarantine evidence remains visible but cannot be selected for retry", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    <MemoryRouter><QuarantineLedger entries={[quarantine]} selectable selected={new Set()} /></MemoryRouter>,
  );
  assert.match(html, /Expired/);
  assert.match(html, /Unavailable for retry/);
  assert.match(html, /type="checkbox" disabled=""/);
  assert.doesNotMatch(html, /raw JSON|walletAddress|username/i);
});
