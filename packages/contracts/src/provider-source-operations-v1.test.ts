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

test("an organization without providers receives a valid empty source overview", () => {
  const overview = {
    version: PROVIDER_SOURCE_OPERATIONS_VERSION,
    refreshedAt: "2026-08-21T12:00:00.000Z",
    connectionMode: "none",
    connection: null,
    sources: [],
  };
  assert.deepEqual(providerSourceOperationsOverviewSchema.parse(overview), overview);
  assert.equal(providerSourceOperationsOverviewSchema.safeParse({
    ...overview,
    connectionMode: "shared",
  }).success, false, "empty sources do not bypass connection-mode validation");
  assert.equal(providerSourceOperationsOverviewSchema.safeParse({
    ...overview,
    sources: undefined,
  }).success, false, "the empty source list must still be explicit");
});

test("source overviews retain the fifty-row bound and validate every present row", () => {
  const source = providerSourceOperationsSourceSchema.parse({
    providerId: "8a000000-0000-4000-8000-000000000001",
    provider: "clutchpacks",
    displayName: "ClutchPacks",
    configured: false,
    source: null,
    schedule: null,
    processor: null,
    freshness: { state: "unknown", lastHeadReachedAt: null, lastProgressAt: null },
    quality: {
      state: "unknown", consecutiveFailures: 0, latestFailureCode: null, recoveredAt: null,
    },
    cursor: null,
    progress: {
      pages: 0,
      records: { catalog: 0, pulls: 0, trades: 0, total: 0 },
      dispositions: { inserted: null, revised: null, duplicate: 0, quarantined: 0 },
      throughputRecordsPerSecond: null,
      elapsedMilliseconds: 0,
      openQuarantine: 0,
      total: { kind: "unknown", label: "Total unknown" },
    },
    activeRun: null,
    latestRun: null,
    connectionImpact: { state: "none", safeCode: null, healthGeneration: null },
  });
  const overview = {
    version: PROVIDER_SOURCE_OPERATIONS_VERSION,
    refreshedAt: "2026-08-21T12:00:00.000Z",
    connectionMode: "none",
    connection: null,
    sources: Array.from({ length: 50 }, () => source),
  };
  assert.equal(providerSourceOperationsOverviewSchema.safeParse(overview).success, true);
  assert.equal(providerSourceOperationsOverviewSchema.safeParse({
    ...overview,
    sources: [...overview.sources, source],
  }).success, false);
  assert.equal(providerSourceOperationsOverviewSchema.safeParse({
    ...overview,
    sources: [{ ...source, providerId: "invalid" }],
  }).success, false);
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
