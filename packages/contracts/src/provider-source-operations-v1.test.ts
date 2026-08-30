import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_SOURCE_OPERATIONS_VERSION,
  providerSourceDiagnosticEventSchema,
  providerSourceOperationsConnectionModeSchema,
  providerSourceOperationsOverviewSchema,
  providerSourceOperationsSourceSchema,
} from "./provider-source-operations-v1.ts";

test("unmeasured insert and revision counts stay explicitly unavailable", () => {
  const schema = providerSourceOperationsSourceSchema.shape.progress.shape.dispositions;
  const dispositions = { inserted: null, revised: null, duplicate: 3, quarantined: 2 };
  assert.equal(schema.safeParse(dispositions).success, true);
  assert.equal(schema.safeParse({ ...dispositions, inserted: 0, revised: 0 }).success, true);
  assert.equal(schema.safeParse({ ...dispositions, inserted: 0 }).success, false);
  assert.equal(schema.safeParse({ ...dispositions, revised: 0 }).success, false);
});

test("operations overview requires exactly four registered source rows", () => {
  const parsed = providerSourceOperationsOverviewSchema.safeParse({
    version: PROVIDER_SOURCE_OPERATIONS_VERSION,
    refreshedAt: "2026-08-21T12:00:00.000Z",
    connectionMode: "none",
    connection: null,
    sources: [],
  });
  assert.equal(parsed.success, false);
});

test("operations overview exposes explicit connection presentation modes", () => {
  assert.deepEqual(providerSourceOperationsConnectionModeSchema.options, [
    "none",
    "shared",
    "split",
  ]);
});

test("diagnostic events reject raw payload, cursor, and correlation fields", () => {
  const safe = {
    scope: "source",
    scopeLabel: "Selected source",
    eventKind: "source_page",
    severity: "info",
    phase: "commit",
    safeCode: "PAGE_COMMITTED",
    occurredAt: "2026-08-21T12:00:00.000Z",
    durationMilliseconds: 20,
    responseBytes: 512,
    retryDelayMilliseconds: null,
    continuation: { kind: "continue" },
    cursorFingerprint: "a".repeat(64),
    counters: { records: 2 },
    references: [],
  };
  assert.equal(providerSourceDiagnosticEventSchema.safeParse(safe).success, true);
  for (const protectedField of [
    "rawPayload",
    "cursor",
    "vendorCursor",
    "correlationId",
  ]) {
    assert.equal(providerSourceDiagnosticEventSchema.safeParse({
      ...safe,
      [protectedField]: "protected-value",
    }).success, false);
  }
});
