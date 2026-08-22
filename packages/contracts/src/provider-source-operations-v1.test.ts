import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_SOURCE_OPERATIONS_VERSION,
  providerSourceDiagnosticEventSchema,
  providerSourceOperationsOverviewSchema,
} from "./provider-source-operations-v1.ts";

test("operations overview requires exactly four registered source rows", () => {
  const parsed = providerSourceOperationsOverviewSchema.safeParse({
    version: PROVIDER_SOURCE_OPERATIONS_VERSION,
    refreshedAt: "2026-08-21T12:00:00.000Z",
    connection: null,
    sources: [],
  });
  assert.equal(parsed.success, false);
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
    checkpointFingerprint: "a".repeat(64),
    counters: { records: 2 },
    references: [],
  };
  assert.equal(providerSourceDiagnosticEventSchema.safeParse(safe).success, true);
  for (const protectedField of [
    "rawPayload",
    "checkpoint",
    "vendorCursor",
    "correlationId",
  ]) {
    assert.equal(providerSourceDiagnosticEventSchema.safeParse({
      ...safe,
      [protectedField]: "protected-value",
    }).success, false);
  }
});
